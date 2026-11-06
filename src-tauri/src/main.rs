#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod folder;
mod shell;

use std::collections::HashMap;
use std::sync::{Mutex, RwLock};
use std::thread::{self, JoinHandle};
use std::time::Instant;

use serde::Serialize;
use tauri::{async_runtime, ipc::Response, State};

/// A folder's rows, named by the open request that read them.
struct Snapshot {
    request: u64,
    entries: Vec<folder::Entry>,
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

    fn finish(&mut self, request: u64, entries: Vec<folder::Entry>) {
        if request == self.latest {
            self.snapshots.push(Snapshot { request, entries });
        }
    }

    fn entries(&self, request: u64) -> &[folder::Entry] {
        self.snapshots
            .iter()
            .find(|snapshot| snapshot.request == request)
            .map_or(&[], |snapshot| &snapshot.entries)
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

/// The start folder, read while WebView2 loads so that opening it costs no extra wait.
struct Preload(Mutex<Option<(String, JoinHandle<ReadResult>)>>);

type ReadResult = windows::core::Result<Vec<folder::Entry>>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Opened {
    /// Names this folder's rows in later `rows` calls.
    request: u64,
    path: String,
    count: usize,
    load_ms: f64,
}

/// The folder passed on the command line, otherwise the user's home folder.
fn first_folder() -> Option<String> {
    std::env::args()
        .nth(1)
        .or_else(|| std::env::var("USERPROFILE").ok())
}

#[tauri::command]
fn start_folder() -> Result<String, String> {
    first_folder().ok_or_else(|| "No start folder found".to_string())
}

#[tauri::command]
async fn open_folder(
    view: u32,
    request: u64,
    shown: u64,
    path: String,
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
        .take()
        .filter(|(preloaded, _)| *preloaded == path);
    let resolved = folder::resolve(&path).map_err(|error| error.message())?;
    let entries = async_runtime::spawn_blocking(move || match waiting {
        Some((_, reader)) => reader.join().unwrap_or_else(|_| folder::read(&path)),
        None => folder::read(&path),
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.message())?;

    let opened = Opened {
        request,
        path: resolved,
        count: entries.len(),
        load_ms: started.elapsed().as_secs_f64() * 1000.0,
    };
    let mut views = views.0.write().unwrap_or_else(|error| error.into_inner());
    if let Some(current) = views.get_mut(&view) {
        current.finish(request, entries);
    }
    Ok(opened)
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
    let entries = current.map_or(&[][..], |current| current.entries(request));
    let bytes = folder::encode_rows(entries, start, count);
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

#[tauri::command]
async fn close_view(view: u32, views: State<'_, Views>) -> Result<(), String> {
    views
        .0
        .write()
        .unwrap_or_else(|error| error.into_inner())
        .remove(&view);
    Ok(())
}

#[tauri::command]
fn show_snap_layouts() -> Result<(), String> {
    shell::show_snap_layouts().map_err(|error| error.message())
}

#[tauri::command]
async fn open_file(path: String) -> Result<(), String> {
    async_runtime::spawn_blocking(move || shell::open(&path))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.message())
}

fn main() {
    let preload = first_folder().map(|path| {
        let reader = path.clone();
        (path, thread::spawn(move || folder::read(&reader)))
    });

    tauri::Builder::default()
        .manage(Views::default())
        .manage(Preload(Mutex::new(preload)))
        .invoke_handler(tauri::generate_handler![
            start_folder,
            open_folder,
            rows,
            close_view,
            show_snap_layouts,
            open_file
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
        view.finish(1, Vec::new());

        // B finishes, but the UI starts C before accepting it, and C fails.
        view.begin(2, 1);
        view.finish(2, Vec::new());
        view.begin(3, 1);

        assert_eq!(held(&view), [1]);
    }

    #[test]
    fn slower_older_read_is_not_stored() {
        let mut view = View::default();
        view.begin(1, 0);
        view.begin(2, 0);
        view.finish(2, Vec::new());
        view.finish(1, Vec::new());

        assert_eq!(held(&view), [2]);
    }

    #[test]
    fn old_snapshot_stays_until_rows_of_the_new_one_are_asked_for() {
        let mut view = View::default();
        view.begin(1, 0);
        view.finish(1, Vec::new());
        view.begin(2, 1);
        view.finish(2, Vec::new());

        assert!(!view.replaced_by(1));
        assert!(view.replaced_by(2));

        view.drop_older_than(2);
        assert_eq!(held(&view), [2]);
    }
}
