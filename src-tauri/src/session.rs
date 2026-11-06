//! Remembers the open tabs between runs, in a file Rust can read before WebView2 loads,
//! so that the first folder is already being read while the window appears.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::folder::Order;

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

fn file() -> Option<PathBuf> {
    let data = std::env::var_os("LOCALAPPDATA")?;
    Some(Path::new(&data).join("com.dzyfps.perli").join("session.json"))
}

pub fn read() -> Option<String> {
    fs::read_to_string(file()?).ok()
}

pub fn start(text: &str) -> Option<(String, Order)> {
    let saved: Saved = serde_json::from_str(text).ok()?;
    Some((saved.start.path, saved.start.order))
}

pub fn save(text: &str) -> io::Result<()> {
    let file = file().ok_or(io::ErrorKind::NotFound)?;
    write(&file, text)
}

/// Replaces the file in one step, so a crash mid-write cannot lose the last session.
/// The partial file is per process, because two Perli windows can save at the same time.
fn write(file: &Path, text: &str) -> io::Result<()> {
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
}
