//! Files the user picks in Perli's own picker to keep settings, palettes, icon themes and keys in.

use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

/// The most a file of settings may hold. A real one is a few thousand bytes.
const MOST_BYTES: u64 = 4 * 1024 * 1024;

fn is_json(path: &Path) -> bool {
    path.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("json"))
}

/// The text of a file of settings.
pub fn read(path: &Path) -> Result<String, String> {
    if !is_json(path) {
        return Err("Perli keeps these in .json files".to_string());
    }
    let facts = fs::metadata(path).map_err(|error| error.to_string())?;
    if !facts.is_file() {
        return Err("That is not a file".to_string());
    }
    if facts.len() > MOST_BYTES {
        return Err("This file is too big to be Perli settings".to_string());
    }
    fs::read_to_string(path).map_err(|error| error.to_string())
}

static SAVING: AtomicU64 = AtomicU64::new(0);

/// A file of this save's own beside `path`, where the text waits until it is whole. It is made
/// new, so a file already there, another save's included, is never written over.
fn staged(path: &Path) -> std::io::Result<(PathBuf, fs::File)> {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    loop {
        let number = SAVING.fetch_add(1, Ordering::Relaxed);
        let waiting = path.with_file_name(format!(".{name}.{}-{number}.perli-saving", std::process::id()));
        match fs::OpenOptions::new().write(true).create_new(true).open(&waiting) {
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            opened => return opened.map(|file| (waiting, file)),
        }
    }
}

/// Saves `text` as `path`. A file already there is kept unless `replace` says the user agreed,
/// and then it gives way only once the new text is whole, so a crash never leaves half of one.
pub fn write(path: &Path, text: &str, replace: bool) -> Result<(), String> {
    if !is_json(path) {
        return Err("Perli keeps these in .json files".to_string());
    }
    if !path.parent().is_some_and(Path::is_dir) {
        return Err("That folder is no longer there".to_string());
    }
    if path.is_dir() {
        return Err("A folder already has that name".to_string());
    }
    if !replace {
        // Made new or not at all, so a file that turned up meanwhile is never written over.
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                "A file already has that name".to_string()
            } else {
                error.to_string()
            }
        })?;
        return file.write_all(text.as_bytes()).and_then(|()| file.sync_all()).map_err(|error| error.to_string());
    }
    let (waiting, mut file) = staged(path).map_err(|error| error.to_string())?;
    let written = file.write_all(text.as_bytes()).and_then(|()| file.sync_all());
    // Windows renames only a closed file.
    drop(file);
    let written = written.and_then(|()| fs::rename(&waiting, path));
    if written.is_err() {
        let _ = fs::remove_file(&waiting);
    }
    written.map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempFolder(PathBuf);

    impl TempFolder {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!("perli-picked-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempFolder {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_new_file_is_written_and_read_back() {
        let folder = TempFolder::new("new");
        let path = folder.0.join("Perli keys.json");
        write(&path, "{\"a\":1}", false).unwrap();
        assert_eq!(read(&path).unwrap(), "{\"a\":1}");
    }

    #[test]
    fn a_file_already_there_stays_unless_replace_is_asked() {
        let folder = TempFolder::new("taken");
        let path = folder.0.join("old.JSON");
        fs::write(&path, "old").unwrap();
        assert_eq!(write(&path, "new", false).unwrap_err(), "A file already has that name");
        assert_eq!(fs::read_to_string(&path).unwrap(), "old");
        write(&path, "new", true).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "new");
        // Nothing is left waiting beside it.
        assert_eq!(fs::read_dir(&folder.0).unwrap().count(), 1);
    }

    #[test]
    fn a_save_writes_over_no_file_but_its_own() {
        let folder = TempFolder::new("beside");
        let path = folder.0.join("backup.json");
        fs::write(&path, "old").unwrap();
        let other = folder.0.join(".backup.json.perli-saving");
        fs::write(&other, "someone else's").unwrap();
        write(&path, "new", true).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "new");
        assert_eq!(fs::read_to_string(&other).unwrap(), "someone else's");
        assert_eq!(fs::read_dir(&folder.0).unwrap().count(), 2);
        // Two saves at once wait in files of their own.
        let (one, _one) = staged(&path).unwrap();
        let (two, _two) = staged(&path).unwrap();
        assert_ne!(one, two);
    }

    #[test]
    fn only_json_files_in_a_real_folder_are_written_or_read() {
        let folder = TempFolder::new("refused");
        let text = folder.0.join("notes.txt");
        fs::write(&text, "hi").unwrap();
        assert!(write(&text, "x", true).is_err());
        assert!(read(&text).is_err());
        assert_eq!(fs::read_to_string(&text).unwrap(), "hi");
        assert!(write(&folder.0.join("gone").join("a.json"), "x", false).is_err());
        let named = folder.0.join("box.json");
        fs::create_dir(&named).unwrap();
        assert!(write(&named, "x", true).is_err());
        assert!(read(&named).is_err());
    }
}
