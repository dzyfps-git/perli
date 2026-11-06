#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod folder;
mod shell;

use std::collections::HashMap;
use std::sync::{Mutex, RwLock};
use std::thread::{self, JoinHandle};
use std::time::Instant;

use serde::Serialize;
use tauri::{async_runtime, ipc::Response, State};

#[derive(Default)]
struct View {
    /// The newest open request. A slower, older read must not replace its result.
    request: u64,
    entries: Vec<folder::Entry>,
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
        .request = request;

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
        path: resolved,
        count: entries.len(),
        load_ms: started.elapsed().as_secs_f64() * 1000.0,
    };
    let mut views = views.0.write().unwrap_or_else(|error| error.into_inner());
    if let Some(current) = views.get_mut(&view).filter(|current| current.request == request) {
        current.entries = entries;
    }
    Ok(opened)
}

#[tauri::command]
async fn rows(
    view: u32,
    start: usize,
    count: usize,
    views: State<'_, Views>,
) -> Result<Response, String> {
    let views = views.0.read().unwrap_or_else(|error| error.into_inner());
    let entries = views.get(&view).map_or(&[][..], |view| &view.entries);
    Ok(Response::new(folder::encode_rows(entries, start, count)))
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
            open_file
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Perli");
}
