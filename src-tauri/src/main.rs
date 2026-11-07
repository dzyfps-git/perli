#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod clipboard;
mod default_app;
mod drag;
mod folder;
mod jobs;
mod menus;
mod network;
mod ops;
mod parts;
mod places;
mod registry;
mod search;
mod session;
mod shell;
mod snap;
mod templates;
mod thumbs;
mod watch;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, RwLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{
    async_runtime, ipc::Response, AppHandle, Emitter, Manager, State, WebviewWindow, WindowEvent,
};

use drag::Drags;
use jobs::{Jobs, Plan};
use ops::{Job, Reply};
use search::Searches;
use watch::Watches;

/// How long the UI gets to answer a close request before the window goes anyway, so a frozen
/// UI can't keep it open.
const CLOSE_LIMIT: Duration = Duration::from_secs(1);
/// How long cancelled jobs get to clean up their partial files before Perli closes anyway.
const CANCEL_LIMIT: Duration = Duration::from_secs(5);
const CANCEL_CHECK: Duration = Duration::from_millis(50);

/// Close requests so far, and the newest one the UI held back.
#[derive(Default)]
struct Closing {
    asked: AtomicU64,
    held: AtomicU64,
}

impl Closing {
    fn ask(&self) -> u64 {
        self.asked.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// An answer names its request, so a late one can't speak for a newer request.
    fn hold(&self, request: u64) {
        self.held.fetch_max(request, Ordering::SeqCst);
    }

    fn holds(&self, request: u64) -> bool {
        self.held.load(Ordering::SeqCst) >= request
    }
}

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

/// Runs blocking work off the main thread.
async fn off_main<T: Send + 'static>(
    work: impl FnOnce() -> windows::core::Result<T> + Send + 'static,
) -> Result<T, String> {
    async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.message())
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
    Template { folder: String, extension: String },
    Paste { folder: String },
    /// The last files dropped on the window landed on `folder`.
    Drop { folder: String },
    Recycle { selection: Selection },
    Delete { selection: Selection },
    Restore { selection: Selection },
    Purge { selection: Selection },
    Empty,
}

impl Task {
    /// The job to run, if there is anything to do.
    fn plan(self, views: &Views, drags: &Drags) -> Result<Option<Plan>, String> {
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
            Self::Template { folder, extension } => Job::Template {
                folder: target(folder)?,
                template: templates::template(&extension)?,
            },
            Self::Paste { folder } => return paste(target(folder)?),
            Self::Drop { folder } => return Ok(drags.job(Path::new(&target(folder)?)).map(Plan::from)),
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

/// More rows of a view's search are ready.
#[derive(Clone, Serialize)]
struct SearchGrew {
    view: u32,
    walk: search::Walk,
}

/// What the app starts with. A folder from the command line replaces the saved session.
#[derive(Clone, Serialize)]
struct Start {
    folder: Option<String>,
    session: Option<String>,
    home: Option<String>,
}

/// Windows quotes a drive as `"C:\"`, and the backslash then escapes the closing quote.
fn folder_argument(text: String) -> String {
    let text = text.strip_suffix('"').unwrap_or(&text);
    if text.ends_with(':') {
        format!(r"{text}\")
    } else {
        text.to_string()
    }
}

impl Start {
    fn read() -> Self {
        let folder = std::env::args().nth(1).map(folder_argument);
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
    watches: State<'_, Watches>,
    searches: State<'_, Searches>,
    app: AppHandle,
) -> Result<Opened, String> {
    let started = Instant::now();
    searches.stop(view);
    follow(&watches, view, &path);
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
    let listing = async_runtime::spawn_blocking(move || {
        let read = || folder::Listing::read(&path, order);
        let first = match waiting {
            Some((_, reader)) => reader
                .join()
                .unwrap_or_else(|_| read())
                .map(|listing| listing.arranged(order)),
            None => read(),
        };
        first.or_else(|failure| {
            if network::reconnect(&path, &failure, jobs::owner(&app)) {
                read()
            } else {
                Err(failure)
            }
        })
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

/// Watches what a view is about to read. A failed open leaves the view's old folder on screen,
/// and the next look finds nothing new about the wrong one, so that does no harm.
fn follow(watches: &Watches, view: u32, path: &str) {
    if path == folder::BIN_PATH {
        watches.stop(view);
    } else if let Ok(resolved) = folder::resolve(path) {
        watches.follow(view, &resolved);
    }
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
    searches: State<'_, Searches>,
) -> Result<Arranged, String> {
    searches.arranged(view, order);
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

fn find(app: &AppHandle, view: u32, asked: search::Asked, path: &str, order: folder::Order) -> ReadResult {
    let events = app.clone();
    app.state::<Searches>().rows(view, asked, path, order, move |walk| {
        let _ = events.emit("search-grew", SearchGrew { view, walk });
    })
}

/// Reads the shown folder again as a new snapshot, the same way an open would. Rows named in
/// `select` become the selection, and without any the `selected` rows follow their files. With
/// `search`, the rows are the results of a search of the folder, which live refresh leaves alone.
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
    search: Option<search::Asked>,
    views: State<'_, Views>,
    watches: State<'_, Watches>,
    searches: State<'_, Searches>,
    app: AppHandle,
) -> Result<Reloaded, String> {
    if search.is_some() {
        watches.stop(view);
    } else {
        searches.stop(view);
        follow(&watches, view, &path);
    }
    let keys = {
        let mut views = views.0.write().unwrap_or_else(|error| error.into_inner());
        let current = views.entry(view).or_default();
        current.begin(request, shown);
        match current.listing(shown) {
            Some(listing) if select.is_empty() => listing.keys(&selected),
            _ => select.iter().map(|name| name.encode_utf16().collect()).collect(),
        }
    };

    let (listing, reloaded) = async_runtime::spawn_blocking(move || {
        let listing = match search {
            Some(asked) => find(&app, view, asked, &path, order),
            None => folder::Listing::read(&path, order),
        };
        listing.map(|listing| {
            let reloaded = Reloaded {
                count: listing.len(),
                hidden_count: listing.hidden_count(),
                selected: listing.rows_keyed(&keys),
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
    drags: State<'_, Arc<Drags>>,
) -> Result<(), String> {
    match task.plan(&views, &drags)? {
        Some(plan) => jobs::start(&app, Plan { origin, ..plan }),
        None => Ok(()),
    }
}

#[tauri::command]
async fn undo_job(origin: Option<u32>, step: Option<u64>, app: AppHandle) -> Result<(), String> {
    jobs::undo(&app, origin, step)
}

#[tauri::command]
async fn redo_job(origin: Option<u32>, app: AppHandle) -> Result<(), String> {
    jobs::redo(&app, origin)
}

/// Waits for the saved undo log, which can be slow to read, so it stays off the main thread.
#[tauri::command]
async fn undo_state(app: AppHandle) -> Result<jobs::Undoable, String> {
    async_runtime::spawn_blocking(move || app.state::<Jobs>().undoable())
        .await
        .map_err(|error| error.to_string())
}

/// With jobs running, this keeps the window open so the user can choose. True if it did.
#[tauri::command]
fn hold_close(request: u64, closing: State<'_, Closing>, jobs: State<'_, Jobs>) -> bool {
    let running = jobs.running();
    if running {
        closing.hold(request);
    }
    running
}

#[tauri::command]
async fn cancel_jobs_and_close(window: WebviewWindow) -> Result<(), String> {
    let app = window.app_handle().clone();
    async_runtime::spawn_blocking(move || {
        let jobs = app.state::<Jobs>();
        jobs.cancel_all();
        let end = Instant::now() + CANCEL_LIMIT;
        while jobs.running() && Instant::now() < end {
            thread::sleep(CANCEL_CHECK);
        }
    })
    .await
    .map_err(|error| error.to_string())?;
    window.destroy().map_err(|error| error.to_string())
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
    searches: State<'_, Searches>,
) -> Result<Response, String> {
    searches.reached(view, start + count);
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
async fn close_view(
    view: u32,
    views: State<'_, Views>,
    watches: State<'_, Watches>,
    searches: State<'_, Searches>,
) -> Result<(), String> {
    watches.stop(view);
    searches.stop(view);
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
async fn apps_for(
    selection: Selection,
    views: State<'_, Views>,
) -> Result<Vec<menus::App>, String> {
    let paths = views.read(&selection, folder::Listing::paths)?;
    off_main(move || menus::apps_for(paths)).await
}

#[tauri::command]
async fn open_with(selection: Selection, app: String, views: State<'_, Views>) -> Result<(), String> {
    let paths = views.read(&selection, folder::Listing::paths)?;
    off_main(move || menus::open_with(paths, app)).await
}

#[tauri::command]
async fn choose_app(selection: Selection, views: State<'_, Views>) -> Result<(), String> {
    let path = views
        .read(&selection, folder::Listing::paths)?
        .pop()
        .ok_or("Nothing is selected")?;
    off_main(move || menus::choose_app(path)).await
}

#[tauri::command]
async fn send_targets() -> Result<Vec<menus::SendTarget>, String> {
    off_main(menus::send_targets).await
}

#[tauri::command]
async fn send_to(selection: Selection, target: PathBuf, views: State<'_, Views>) -> Result<(), String> {
    let paths = views.read(&selection, folder::Listing::paths)?;
    off_main(move || menus::send_to(paths, target)).await
}

/// Rows, or with none the folder itself, for what Windows offers on either.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
enum ShellTarget {
    Rows { selection: Selection },
    Folder { path: String },
}

impl ShellTarget {
    fn read(self, views: &Views) -> Result<menus::Target, String> {
        Ok(match self {
            Self::Rows { selection } => {
                menus::Target::Items(views.read(&selection, folder::Listing::paths)?)
            }
            Self::Folder { path } => menus::Target::Folder(path.into()),
        })
    }
}

/// `x` and `y` are physical pixels inside the window, here and in `show_properties`.
#[tauri::command]
async fn show_shell_menu(
    target: ShellTarget,
    x: i32,
    y: i32,
    views: State<'_, Views>,
    app: AppHandle,
) -> Result<Option<String>, String> {
    let target = target.read(&views)?;
    let main = jobs::owner(&app);
    off_main(move || menus::show_menu(target, main, x, y)).await
}

#[tauri::command]
async fn show_properties(
    target: ShellTarget,
    x: i32,
    y: i32,
    views: State<'_, Views>,
    app: AppHandle,
) -> Result<(), String> {
    let target = target.read(&views)?;
    let main = jobs::owner(&app);
    off_main(move || menus::show_properties(target, main, x, y)).await
}

#[tauri::command]
async fn open_terminal(path: String) -> Result<(), String> {
    async_runtime::spawn_blocking(move || shell::open_terminal(&path))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn new_types() -> Result<Vec<templates::NewType>, String> {
    off_main(|| Ok(templates::new_types())).await
}

/// The apps holding the selected files.
#[tauri::command]
async fn file_users(selection: Selection, views: State<'_, Views>) -> Result<Vec<String>, String> {
    let paths = views.read(&selection, folder::Listing::paths)?;
    off_main(move || Ok(ops::sys::users_of(&paths))).await
}

/// The picture of one row, in the format `thumbs::read` describes.
#[tauri::command]
async fn thumbnail(view: u32, request: u64, row: u32, views: State<'_, Views>) -> Result<Response, String> {
    let selection = Selection { view, request, rows: vec![row] };
    let path = views.read(&selection, folder::Listing::paths)?.pop();
    let path = path.ok_or("That row is gone")?;
    Ok(Response::new(thumbs::read(path).await))
}

#[tauri::command]
async fn set_drop_target(folder: Option<PathBuf>, drags: State<'_, Arc<Drags>>) -> Result<(), String> {
    drags.aim(folder);
    Ok(())
}

/// Windows' drag loop must run on the main thread, and not inside this call from the web view.
#[tauri::command]
async fn start_drag(selection: Selection, views: State<'_, Views>, app: AppHandle) -> Result<(), String> {
    let paths = views.read(&selection, folder::Listing::paths)?;
    let main = jobs::owner(&app);
    let (finished, result) = mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = finished.send(drag::start(&paths, main));
    })
    .map_err(|error| error.to_string())?;
    off_main(move || result.recv().unwrap_or(Ok(()))).await
}

#[tauri::command]
async fn clipboard_text() -> Result<String, String> {
    async_runtime::spawn_blocking(shell::clipboard_text)
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.message())
}

/// Windows' dialog, which runs until the user closes it.
#[tauri::command]
async fn map_drive(app: AppHandle) -> Result<(), String> {
    let owner = jobs::owner(&app);
    off_main(move || network::map_drive(owner)).await
}

/// Windows' dialog, which runs until the user closes it.
#[tauri::command]
async fn disconnect_drive(app: AppHandle) -> Result<(), String> {
    let owner = jobs::owner(&app);
    off_main(move || network::disconnect_drive(owner)).await
}

/// The `names` that fit `query`, best first, by the matcher a folder search uses.
#[tauri::command]
fn rank_names(query: String, names: Vec<String>) -> Vec<u32> {
    search::rank(&query, &names)
}

#[tauri::command]
fn is_default_app() -> bool {
    default_app::is_on()
}

#[tauri::command]
async fn set_default_app(on: bool) -> Result<(), String> {
    off_main(move || default_app::set(on)).await
}

fn main() {
    if std::env::args().nth(1).as_deref() == Some(default_app::RESTORE_ARGUMENT) {
        let _ = default_app::set(false);
        return;
    }
    thread::spawn(parts::sweep);
    let start = Start::read();
    let preload = start.first_folder().map(|(path, order)| {
        let reader = path.clone();
        (
            path,
            thread::spawn(move || folder::Listing::read(&reader, order)),
        )
    });

    tauri::Builder::default()
        // The UI saves the session and then closes the window, unless it holds the close back
        // because jobs are running. A frozen UI does neither, so the window goes anyway.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let request = window.state::<Closing>().ask();
                let _ = window.emit("close-asked", request);
                let window = window.clone();
                thread::spawn(move || {
                    thread::sleep(CLOSE_LIMIT);
                    if !window.state::<Closing>().holds(request) {
                        let _ = window.destroy();
                    }
                });
            }
        })
        .manage(start)
        .manage(Views::default())
        .manage(Jobs::loading_history())
        .manage(Closing::default())
        .manage(Watches::default())
        .manage(Arc::new(Drags::default()))
        .manage(Searches::default())
        .manage(Preload(Mutex::new(preload)))
        .setup(|app| {
            watch::start(app.handle().clone());
            let (events, drags) = (app.handle().clone(), app.state::<Arc<Drags>>().inner().clone());
            drag::attach(jobs::owner(app.handle()), drags, move |event| {
                let _ = events.emit("file-drag", event);
            });
            Ok(())
        })
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
            redo_job,
            undo_state,
            hold_close,
            cancel_jobs_and_close,
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
            apps_for,
            open_with,
            choose_app,
            send_targets,
            send_to,
            show_shell_menu,
            show_properties,
            open_terminal,
            new_types,
            file_users,
            thumbnail,
            set_drop_target,
            start_drag,
            clipboard_text,
            map_drive,
            disconnect_drive,
            rank_names,
            is_default_app,
            set_default_app
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Perli");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_folder_argument_survives_the_way_windows_quotes_a_drive() {
        assert_eq!(folder_argument("C:\"".into()), r"C:\");
        assert_eq!(folder_argument(r"C:\".into()), r"C:\");
        assert_eq!(folder_argument(r"D:\Some Folder".into()), r"D:\Some Folder");
    }

    #[test]
    fn an_answer_holds_only_its_own_request_and_older_ones() {
        let closing = Closing::default();
        let (older, newer) = (closing.ask(), closing.ask());

        closing.hold(older);
        assert!(closing.holds(older));
        assert!(!closing.holds(newer));

        closing.hold(newer);
        closing.hold(older);
        assert!(closing.holds(newer));
    }

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
