#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod folder;

use std::sync::RwLock;
use std::time::Instant;

use serde::Serialize;
use tauri::{async_runtime, ipc::Response, State};

#[derive(Default)]
struct OpenFolder(RwLock<Vec<folder::Entry>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Opened {
    count: usize,
    load_ms: f64,
}

/// The folder passed on the command line, otherwise the user's home folder.
#[tauri::command]
fn start_folder() -> Result<String, String> {
    std::env::args()
        .nth(1)
        .or_else(|| std::env::var("USERPROFILE").ok())
        .ok_or_else(|| "No start folder found".to_string())
}

#[tauri::command]
async fn open_folder(path: String, state: State<'_, OpenFolder>) -> Result<Opened, String> {
    let started = Instant::now();
    let entries = async_runtime::spawn_blocking(move || folder::read(&path))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.message())?;

    let opened = Opened {
        count: entries.len(),
        load_ms: started.elapsed().as_secs_f64() * 1000.0,
    };
    *state.0.write().unwrap_or_else(|error| error.into_inner()) = entries;
    Ok(opened)
}

#[tauri::command]
async fn rows(start: usize, count: usize, state: State<'_, OpenFolder>) -> Result<Response, String> {
    let entries = state.0.read().unwrap_or_else(|error| error.into_inner());
    Ok(Response::new(folder::encode_rows(&entries, start, count)))
}

fn main() {
    tauri::Builder::default()
        .manage(OpenFolder::default())
        .invoke_handler(tauri::generate_handler![start_folder, open_folder, rows])
        .run(tauri::generate_context!())
        .expect("failed to start Perli");
}
