#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod clipboard;
mod folder;
mod jobs;
mod ops;
mod places;
mod session;
mod shell;
mod snap;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, RwLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{async_runtime, ipc::Response, AppHandle, State, WebviewWindow, WindowEvent};

use jobs::{Jobs, Plan};
use ops::{Job, Reply};

/// How long the UI gets to finish closing before the window goes anyway.
const CLOSE_LIMIT: Duration = Duration::from_secs(1);

/// A folder's rows, named by the request that made them.
struct Snapshot {
    request: u64,
    listing: folder::Listing,
}

#[derive(Default)]
struct View {
    /// The newest open request. A slower, older read must not replace its result.
    latest: u64,
    /// The snapshot the UI shows, plus any newer one it has not accepted yet, oldest first.
    /// The UI can discard a result or fail a later open, so it picks when the shown one goes.
    snapshots: Vec<Snapshot>,
}

impl View {
    fn begin(&mut self, request: u64, shown: u64) {
        self.latest = self.latest.max(request);
        self.snapshots.retain(|snapshot| snapshot.request == shown);
    }

    fn finish(&mut self, request: u64, listing: folder::Listing) {
        if request == self.latest {
            self.snapshots.push(Snapshot { request, listing });
        }
    }

    fn listing(&self, request: u64) -> Option<&folder::Listing> {
        self.snapshots
            .iter()
            .find(|snapshot| snapshot.request == request)
            .map(|snapshot| &snapshot.listing)
    }

    /// The UI only asks for rows of a snapshot it accepted, so older ones are finished with.
    fn replaced_by(&self, request: u64) -> bool {
        self.snapshots
            .first()
            .is_some_and(|snapshot| snapshot.request < request)
    }

    fn drop_older_than(&mut self, request: u64) {
        self.snapshots
            .retain(|snapshot| snapshot.request >= request);
    }
}

/// Every open folder view, by the id the UI gave it.
#[derive(Default)]
struct Views(RwLock<HashMap<u32, View>>);

impl Views {
    /// Reads what the selected rows stand for. Rust does this, so file paths never cross to the
    /// UI and back, and odd names survive.
    fn read<T>(
        &self,
        selection: &Selection,
        read: impl FnOnce(&folder::Listing, &[u32]) -> T,
    ) -> Result<T, String> {
        let views = self.0.read().unwrap_or_else(|error| error.into_inner());
        let listing = views
            .get(&selection.view)
            .and_then(|view| view.listing(selection.request))
            .ok_or("This folder is no longer open")?;
        Ok(read(listing, &selection.rows))
    }
}

/// Rows of one snapshot.
#[derive(Deserialize)]
struct Selection {
    view: u32,
    request: u64,
    rows: Vec<u32>,
}

/// What the UI can ask of the file engine.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "kind")]
enum Task {
    Copy { selection: Selection, folder: String },
    Move { selection: Selection, folder: String },
    Rename { selection: Selection, name: String },
    New { folder: String, directory: bool },
    Paste { folder: String },
    Recycle { selection: Selection },
    Delete { selection: Selection },
    Restore { selection: Selection },
    Purge { selection: Selection },
    Empty,
}

impl Task {
    /// The job to run, if there is anything to do.
    fn plan(self, views: &Views) -> Result<Option<Plan>, String> {
        let target = |folder: String| -> Result<PathBuf, String> {
            Ok(folder::resolve(&folder).map_err(|error| error.message())?.into())
        };
        let paths = |selection: &Selection| views.read(selection, folder::Listing::paths);
        let items = |selection: &Selection| views.read(selection, folder::Listing::bin_items);
        let job = match self {
            Self::Copy { selection, folder } => Job::Copy {
                sources: paths(&selection)?,
                folder: target(folder)?,
            },
            Self::Move { selection, folder } => Job::Move {
                sources: paths(&selection)?,
                folder: target(folder)?,
            },
            Self::Rename { selection, name } => {
                let path = paths(&selection)?.pop().ok_or("Nothing to rename")?;
                ops::check_rename(&path, &name)?;
                Job::Rename { path, name }
            }
            Self::New { folder, directory } => Job::New {
                folder: target(folder)?,
                directory,
            },
            Self::Paste { folder } => return paste(target(folder)?),
            Self::Recycle { selection } => Job::Recycle {
                paths: paths(&selection)?,
            },
            Self::Delete { selection } => Job::Delete {
                paths: paths(&selection)?,
            },
            Self::Restore { selection } => Job::Restore {
                items: items(&selection)?,
            },
            Self::Purge { selection } => Job::Purge {
                items: items(&selection)?,
            },
            Self::Empty => Job::Empty,
        };
        Ok(Some(job.into()))
    }
}

/// Pastes the files on the clipboard. A cut moves them, a copy copies them.
fn paste(folder: PathBuf) -> Result<Option<Plan>, String> {
    let sequence = clipboard::sequence();
    let Some(files) = clipboard::read().map_err(|error| error.message())? else {
        return Ok(None);
    };
    let sources = files.paths;
    let job = if files.cut {
        Job::Move { sources, folder }
    } else {
        Job::Copy { sources, folder }
    };
    Ok(Some(Plan {
        cut: files.cut.then_some(sequence),
        ..job.into()
    }))
}

/// The start folder, read while WebView2 loads so that opening it costs no extra wait.
struct Preload(Mutex<Option<(String, JoinHandle<ReadResult>)>>);

type ReadResult = windows::core::Result<folder::Listing>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Opened {
    /// Names this folder's rows in later `rows` calls.
    request: u64,
    path: String,
    count: usize,
    hidden_count: usize,
    load_ms: f64,
}

#[derive(Serialize)]
struct Arranged {
    count: usize,
    /// The rows the UI had selected, at their new positions.
    selected: Vec<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Reloaded {
    count: usize,
    hidden_count: usize,
    /// The rows to select in the new read.
    selected: Vec<u32>,
}

#[derive(Serialize)]
struct Measured {
    items: u64,
    bytes: u64,
}

#[derive(Serialize)]
struct Clipped {
    /// The names on the clipboard, which the UI fades while they wait to move.
    names: Vec<String>,
    sequence: u32,
}

/// What the app starts with. A folder from the command line replaces the saved session.
#[derive(Clone, Serialize)]
struct Start {
    folder: Option<String>,
    session: Option<String>,
    home: Option<String>,
}

impl Start {
    fn read() -> Self {
        let folder = std::env::args().nth(1);
        let session = folder.is_none().then(session::read).flatten();
        let home = std::env::var("USERPROFILE").ok();
        Self {
            folder,
            session,
            home,
        }
    }

    /// The folder most likely to be opened first, and its order.
    fn first_folder(&self) -> Option<(String, folder::Order)> {
        let plain = |path: &String| (path.clone(), folder::Order::default());
        self.folder
            .as_ref()
            .map(plain)
            .or_else(|| self.session.as_deref().and_then(session::start))
            .or_else(|| self.home.as_ref().map(plain))
    }
}

#[tauri::command]
fn start_state(start: State<'_, Start>) -> Start {
    start.inner().clone()
}

#[tauri::command]
async fn save_session(text: String) -> Result<(), String> {
    async_runtime::spawn_blocking(move || session::save(&text))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn list_places() -> Result<places::Places, String> {
    async_runtime::spawn_blocking(places::read)
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.message())
}

#[tauri::command]
async fn open_folder(
    view: u32,
    request: u64,
    shown: u64,
    path: String,
    order: folder::Order,
    views: State<'_, Views>,
    preload: State<'_, Preload>,
) -> Result<Opened, String> {
    let started = Instant::now();
    views
        .0
        .write()
        .unwrap_or_else(|error| error.into_inner())
        .entry(view)
        .or_default()
        .begin(request, shown);

    let waiting = preload
        .0
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .take_if(|(preloaded, _)| *preloaded == path);
    let resolved = folder::resolve(&path).map_err(|error| error.message())?;
    let listing = async_runtime::spawn_blocking(move || match waiting {
        Some((_, reader)) => reader
            .join()
            .unwrap_or_else(|_| folder::Listing::read(&path, order))
            .map(|listing| listing.arranged(order)),
        None => folder::Listing::read(&path, order),
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.message())?;

    let opened = Opened {
        request,
        path: resolved,
        count: listing.len(),
        hidden_count: listing.hidden_count(),
        load_ms: started.elapsed().as_secs_f64() * 1000.0,
    };
    let mut views = views.0.write().unwrap_or_else(|error| error.into_inner());
    if let Some(current) = views.get_mut(&view) {
        current.finish(request, listing);
    }
    Ok(opened)
}

/// Puts the shown folder in a new order as a new snapshot, the same way an open would.
#[tauri::command]
async fn arrange_view(
    view: u32,
    request: u64,
    shown: u64,
    order: folder::Order,
    selected: Vec<u32>,
    views: State<'_, Views>,
) -> Result<Arranged, String> {
    let before = {
        let mut views = views.0.write().unwrap_or_else(|error| error.into_inner());
        let current = views.entry(view).or_default();
        current.begin(request, shown);
        current.listing(shown).cloned()
    }
    .ok_or("This folder is no longer open")?;

    let (listing, arranged) = async_runtime::spawn_blocking(move || {
        let listing = before.clone().arranged(order);
        let arranged = Arranged {
            count: listing.len(),
            selected: listing.carried_rows(&before, &selected),
        };
        (listing, arranged)
    })
    .await
    .map_err(|error| error.to_string())?;

    let mut views = views.0.write().unwrap_or_else(|error| error.into_inner());
    if let Some(current) = views.get_mut(&view) {
        current.finish(request, listing);
    }
    Ok(arranged)
}

/// Reads the shown folder again as a new snapshot, the same way an open would. Rows named in
/// `select` become the selection, and without any the `selected` rows follow their files.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn reload_view(
    view: u32,
    request: u64,
    shown: u64,
    path: String,
    order: folder::Order,
    selected: Vec<u32>,
    select: Vec<String>,
    views: State<'_, Views>,
) -> Result<Reloaded, String> {
    let names = {
        let mut views = views.0.write().unwrap_or_else(|error| error.into_inner());
        let current = views.entry(view).or_default();
        current.begin(request, shown);
        match current.listing(shown) {
            Some(listing) if select.is_empty() => listing.names(&selected),
            _ => select,
        }
    };

    let (listing, reloaded) = async_runtime::spawn_blocking(move || {
        folder::Listing::read(&path, order).map(|listing| {
            let reloaded = Reloaded {
                count: listing.len(),
                hidden_count: listing.hidden_count(),
                selected: listing.rows_named(&names),
            };
            (listing, reloaded)
        })
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.message())?;

    let mut views = views.0.write().unwrap_or_else(|error| error.into_inner());
    if let Some(current) = views.get_mut(&view) {
        current.finish(request, listing);
    }
    Ok(reloaded)
}

#[tauri::command]
async fn start_job(
    task: Task,
    origin: Option<u32>,
    app: AppHandle,
    views: State<'_, Views>,
) -> Result<(), String> {
    match task.plan(&views)? {
        Some(plan) => jobs::start(&app, Plan { origin, ..plan }),
        None => Ok(()),
    }
}

#[tauri::command]
async fn undo_job(origin: Option<u32>, app: AppHandle) -> Result<(), String> {
    jobs::undo(&app, origin)
}

#[tauri::command]
fn pause_job(id: u64, jobs: State<'_, Jobs>) {
    jobs.pause(id);
}

#[tauri::command]
fn resume_job(id: u64, jobs: State<'_, Jobs>) {
    jobs.resume(id);
}

#[tauri::command]
fn cancel_job(id: u64, jobs: State<'_, Jobs>) {
    jobs.cancel(id);
}

#[tauri::command]
fn answer_job(id: u64, reply: Reply, jobs: State<'_, Jobs>) {
    jobs.answer(id, reply);
}

/// Counts everything under the selected rows, for the delete confirmation.
#[tauri::command]
async fn measure_selection(
    selection: Selection,
    views: State<'_, Views>,
) -> Result<Measured, String> {
    let paths = views.read(&selection, folder::Listing::paths)?;
    let worker = thread::Builder::new()
        .stack_size(jobs::STACK_BYTES)
        .spawn(move || ops::measure(&paths))
        .map_err(|error| error.to_string())?;
    let (items, bytes) = async_runtime::spawn_blocking(move || worker.join())
        .await
        .map_err(|error| error.to_string())?
        .map_err(|_| "Could not measure these items")?;
    Ok(Measured { items, bytes })
}

#[tauri::command]
async fn bin_summary() -> Result<Measured, String> {
    let items = async_runtime::spawn_blocking(ops::read_bin)
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.message())?;
    Ok(Measured {
        items: items.len() as u64,
        bytes: items.iter().map(|item| item.size).sum(),
    })
}

#[tauri::command]
async fn set_clipboard(
    selection: Selection,
    cut: bool,
    views: State<'_, Views>,
    app: AppHandle,
) -> Result<Clipped, String> {
    let (paths, names) = views.read(&selection, |listing, rows| {
        (listing.paths(rows), listing.names(rows))
    })?;
    clipboard::write(&paths, cut, jobs::owner(&app)).map_err(|error| error.message())?;
    Ok(Clipped {
        names,
        sequence: clipboard::sequence(),
    })
}

/// Takes a cut back, unless something else was copied since.
#[tauri::command]
fn cancel_cut(sequence: u32) -> Result<(), String> {
    clipboard::clear_if_unchanged(sequence).map_err(|error| error.message())
}

#[tauri::command]
fn clipboard_sequence() -> u32 {
    clipboard::sequence()
}

#[tauri::command]
fn clipboard_has_files() -> bool {
    clipboard::has_files()
}

#[tauri::command]
async fn rows(
    view: u32,
    request: u64,
    start: usize,
    count: usize,
    views: State<'_, Views>,
) -> Result<Response, String> {
    let readable = views.0.read().unwrap_or_else(|error| error.into_inner());
    let current = readable.get(&view);
    let bytes = current
        .and_then(|current| current.listing(request))
        .map_or_else(
            || folder::Listing::default().encode_rows(0, 0),
            |listing| listing.encode_rows(start, count),
        );
    let replaced = current.is_some_and(|current| current.replaced_by(request));
    drop(readable);

    if replaced {
        let mut views = views.0.write().unwrap_or_else(|error| error.into_inner());
        if let Some(current) = views.get_mut(&view) {
            current.drop_older_than(request);
        }
    }
    Ok(Response::new(bytes))
}

/// The first row at or after `start` whose name starts with `prefix`, for type to jump.
#[tauri::command]
async fn find_row(
    view: u32,
    request: u64,
    prefix: String,
    start: usize,
    views: State<'_, Views>,
) -> Result<Option<usize>, String> {
    let readable = views.0.read().unwrap_or_else(|error| error.into_inner());
    Ok(readable
        .get(&view)
        .and_then(|current| current.listing(request))
        .and_then(|listing| listing.find(&prefix, start)))
}

#[tauri::command]
async fn close_view(view: u32, views: State<'_, Views>) -> Result<(), String> {
    views
        .0
        .write()
        .unwrap_or_else(|error| error.into_inner())
        .remove(&view);
    Ok(())
}

/// Runs off the main thread because a network drive can take a long time to answer.
#[tauri::command]
async fn drive_space(path: String) -> Result<places::DriveSpace, String> {
    async_runtime::spawn_blocking(move || places::drive_space(&path))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.message())
}

#[tauri::command]
async fn type_names(extensions: Vec<String>) -> Result<HashMap<String, String>, String> {
    async_runtime::spawn_blocking(move || shell::type_names(extensions))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.message())
}

#[tauri::command]
fn expand_path(text: String) -> String {
    shell::expand_path(&text)
}

#[tauri::command]
async fn is_file(path: String) -> Result<bool, String> {
    async_runtime::spawn_blocking(move || {
        std::fs::metadata(path).is_ok_and(|metadata| metadata.is_file())
    })
    .await
    .map_err(|error| error.to_string())
}

/// Not async, so it runs on the main thread, which must own the area's window.
#[tauri::command]
fn place_snap_area(
    window: WebviewWindow,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Result<(), String> {
    snap::place(&window, x, y, width, height).map_err(|error| error.message())
}

#[tauri::command]
async fn open_file(path: String) -> Result<(), String> {
    async_runtime::spawn_blocking(move || shell::open(&path))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.message())
}

#[tauri::command]
async fn clipboard_text() -> Result<String, String> {
    async_runtime::spawn_blocking(shell::clipboard_text)
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.message())
}

fn main() {
    let start = Start::read();
    let preload = start.first_folder().map(|(path, order)| {
        let reader = path.clone();
        (
            path,
            thread::spawn(move || folder::Listing::read(&reader, order)),
        )
    });

    tauri::Builder::default()
        // The UI saves the session and then closes the window, unless it is frozen.
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::CloseRequested { .. }) {
                let window = window.clone();
                thread::spawn(move || {
                    thread::sleep(CLOSE_LIMIT);
                    let _ = window.destroy();
                });
            }
        })
        .manage(start)
        .manage(Views::default())
        .manage(Jobs::default())
        .manage(Preload(Mutex::new(preload)))
        .invoke_handler(tauri::generate_handler![
            start_state,
            save_session,
            list_places,
            drive_space,
            type_names,
            expand_path,
            is_file,
            open_folder,
            arrange_view,
            reload_view,
            start_job,
            undo_job,
            pause_job,
            resume_job,
            cancel_job,
            answer_job,
            measure_selection,
            bin_summary,
            set_clipboard,
            cancel_cut,
            clipboard_sequence,
            clipboard_has_files,
            rows,
            find_row,
            close_view,
            place_snap_area,
            open_file,
            clipboard_text
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Perli");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn held(view: &View) -> Vec<u64> {
        view.snapshots
            .iter()
            .map(|snapshot| snapshot.request)
            .collect()
    }

    #[test]
    fn shown_snapshot_survives_a_dropped_result_and_a_failed_open() {
        let mut view = View::default();
        view.begin(1, 0);
        view.finish(1, folder::Listing::default());

        // B finishes, but the UI starts C before accepting it, and C fails.
        view.begin(2, 1);
        view.finish(2, folder::Listing::default());
        view.begin(3, 1);

        assert_eq!(held(&view), [1]);
    }

    #[test]
    fn slower_older_read_is_not_stored() {
        let mut view = View::default();
        view.begin(1, 0);
        view.begin(2, 0);
        view.finish(2, folder::Listing::default());
        view.finish(1, folder::Listing::default());

        assert_eq!(held(&view), [2]);
    }

    #[test]
    fn old_snapshot_stays_until_rows_of_the_new_one_are_asked_for() {
        let mut view = View::default();
        view.begin(1, 0);
        view.finish(1, folder::Listing::default());
        view.begin(2, 1);
        view.finish(2, folder::Listing::default());

        assert!(!view.replaced_by(1));
        assert!(view.replaced_by(2));

        view.drop_older_than(2);
        assert_eq!(held(&view), [2]);
    }
}
