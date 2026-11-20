//! Remembers the open tabs between runs, in a file Rust can read before WebView2 loads,
//! so that the first folder is already being read while the window appears.
//!
//! The first window keeps `session.json`; each more window keeps a file of its own in `windows`.
//! Like a browser, the windows open when Perli stops come back, and a window closed while others
//! stay open is forgotten, though the latest few can be reopened.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use windows::core::HSTRING;
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Threading::{CreateMutexW, OpenMutexW, SYNCHRONIZATION_SYNCHRONIZE};

use crate::folder::Order;

const SESSION_FILE: &str = "session.json";
const WINDOWS: &str = "windows";
const CLOSED: &str = "closed-windows";
/// How many closed windows can be reopened.
const MOST_CLOSED: usize = 5;

#[derive(Deserialize)]
struct Saved {
    start: Start,
}

/// The folder on screen when the session was saved. The UI owns the rest of the file.
#[derive(Deserialize)]
struct Start {
    path: String,
    order: Order,
}

/// `name` in the folder Perli keeps its own files in.
pub fn data_file(name: &str) -> Option<PathBuf> {
    let data = std::env::var_os("LOCALAPPDATA")?;
    Some(Path::new(&data).join("com.dzyfps.perli").join(name))
}

/// The first window's file.
pub fn first_file() -> Option<PathBuf> {
    data_file(SESSION_FILE)
}

/// The first window's tabs. When that window was closed while others stayed open, the newest
/// window left from the last run takes its place.
pub fn read() -> Option<String> {
    let file = first_file()?;
    if !file.exists() {
        if let Some(left) = left_in(&data_file(WINDOWS)?).into_iter().next() {
            let _ = fs::rename(left, &file);
        }
    }
    fs::read_to_string(file).ok()
}

fn stamp() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|since| since.as_nanos()).unwrap_or_default()
}

/// A new file for one more window's tabs.
pub fn window_file() -> Option<PathBuf> {
    Some(data_file(WINDOWS)?.join(format!("{}.json", stamp())))
}

fn lock_name(file: &Path) -> HSTRING {
    HSTRING::from(format!(r"Local\perli-window-{}", file.file_stem().unwrap_or_default().to_string_lossy()))
}

/// Marks `file` as this window's for as long as it runs, so no start opens it a second time.
/// Windows lets the mark go when the process ends, however it ends.
pub fn hold(file: &Path) {
    // The handle stays open on purpose: the mark lasts as long as the process.
    let _ = unsafe { CreateMutexW(None, false, &lock_name(file)) };
}

fn held(file: &Path) -> bool {
    unsafe { OpenMutexW(SYNCHRONIZATION_SYNCHRONIZE, false, &lock_name(file)) }
        .map(|handle| unsafe {
            let _ = CloseHandle(handle);
        })
        .is_ok()
}

/// The saved windows in `folder`, the newest first.
fn newest_first(folder: &Path) -> Vec<PathBuf> {
    let mut files: Vec<(u128, PathBuf)> = fs::read_dir(folder)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let stamp = path.extension().filter(|kind| *kind == "json").and(path.file_stem())?.to_str()?.parse().ok()?;
            Some((stamp, path))
        })
        .collect();
    files.sort_by_key(|one| std::cmp::Reverse(one.0));
    files.into_iter().map(|(_, path)| path).collect()
}

/// Windows open when Perli last stopped, which no window holds now.
fn left_in(folder: &Path) -> Vec<PathBuf> {
    newest_first(folder).into_iter().filter(|file| !held(file)).collect()
}

/// The windows to open again at the start, as files that hold their tabs. A file with no folder
/// to start from is damaged, and goes.
pub fn left_windows() -> Vec<PathBuf> {
    let Some(folder) = data_file(WINDOWS) else { return Vec::new() };
    left_in(&folder)
        .into_iter()
        .filter(|file| {
            let usable = fs::read_to_string(file).ok().as_deref().and_then(start).is_some();
            if !usable {
                let _ = fs::remove_file(file);
            }
            usable
        })
        .collect()
}

/// A window closed while others stay open: with the closed windows to reopen, or gone when its
/// tabs went to another window.
pub fn forget(file: &Path, reopenable: bool) -> io::Result<()> {
    // A window closed before its first folder opened never wrote one.
    if !file.exists() {
        return Ok(());
    }
    if !reopenable {
        return fs::remove_file(file);
    }
    forget_in(file, &data_file(CLOSED).ok_or(io::ErrorKind::NotFound)?)
}

fn forget_in(file: &Path, closed: &Path) -> io::Result<()> {
    fs::create_dir_all(closed)?;
    fs::rename(file, closed.join(format!("{}.json", stamp())))?;
    for old in newest_first(closed).into_iter().skip(MOST_CLOSED) {
        let _ = fs::remove_file(old);
    }
    Ok(())
}

/// The window closed last, as the file of a window to open now.
pub fn reopen() -> Option<PathBuf> {
    reopen_in(&data_file(CLOSED)?, &window_file()?)
}

fn reopen_in(closed: &Path, file: &Path) -> Option<PathBuf> {
    let latest = newest_first(closed).into_iter().next()?;
    fs::create_dir_all(file.parent()?).ok()?;
    fs::rename(latest, file).ok()?;
    Some(file.to_path_buf())
}

pub fn start(text: &str) -> Option<(String, Order)> {
    let saved: Saved = serde_json::from_str(text).ok()?;
    Some((saved.start.path, saved.start.order))
}

/// Replaces the file in one step, so a crash mid-write cannot lose the last session.
/// The partial file is per process, because two Perli windows can save at the same time.
pub fn write(file: &Path, text: &str) -> io::Result<()> {
    if let Some(folder) = file.parent() {
        fs::create_dir_all(folder)?;
    }
    let partial = file.with_extension(format!("{}.tmp", std::process::id()));
    let written = fs::write(&partial, text).and_then(|()| fs::rename(&partial, file));
    if written.is_err() {
        let _ = fs::remove_file(&partial);
    }
    written
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_start_folder_and_ignores_the_rest() {
        let text = r#"{"start":{"path":"C:\\Users","order":{"key":"size","descending":true,
            "group":"mixed","showHidden":false}},"tabs":[]}"#;
        let (path, order) = start(text).unwrap();
        assert_eq!(path, r"C:\Users");
        assert!(order != Order::default());
    }

    #[test]
    fn damaged_text_starts_fresh() {
        assert!(start("").is_none());
        assert!(start(r#"{"start":{"path":3}}"#).is_none());
    }

    #[test]
    fn write_replaces_the_file_and_leaves_no_partial() {
        let folder = std::env::temp_dir().join(format!("perli-session-{}", std::process::id()));
        let file = folder.join("session.json");
        write(&file, "one").unwrap();
        write(&file, "two").unwrap();

        assert_eq!(fs::read_to_string(&file).unwrap(), "two");
        assert_eq!(fs::read_dir(&folder).unwrap().count(), 1);
        fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn closed_windows_keep_the_latest_few_and_reopen_the_newest() {
        let folder = std::env::temp_dir().join(format!("perli-closed-{}", std::process::id()));
        let (open, closed) = (folder.join("windows"), folder.join("closed"));
        fs::create_dir_all(&open).unwrap();
        for at in 0..MOST_CLOSED + 2 {
            let file = open.join(format!("{at}.json"));
            fs::write(&file, at.to_string()).unwrap();
            forget_in(&file, &closed).unwrap();
        }
        assert_eq!(newest_first(&closed).len(), MOST_CLOSED);
        assert_eq!(fs::read_dir(&open).unwrap().count(), 0);

        let back = reopen_in(&closed, &open.join("9.json")).unwrap();
        assert_eq!(fs::read_to_string(back).unwrap(), (MOST_CLOSED + 1).to_string());
        assert_eq!(newest_first(&closed).len(), MOST_CLOSED - 1);
        fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn a_window_still_open_is_not_left_over() {
        let folder = std::env::temp_dir().join(format!("perli-left-{}", std::process::id()));
        fs::create_dir_all(&folder).unwrap();
        let open = folder.join(format!("{}.json", stamp()));
        let left = folder.join("1.json");
        fs::write(&open, "{}").unwrap();
        fs::write(&left, "{}").unwrap();
        fs::write(folder.join("notes.txt"), "").unwrap();
        hold(&open);

        assert_eq!(left_in(&folder), [left]);
        fs::remove_dir_all(folder).unwrap();
    }
}
