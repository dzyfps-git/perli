//! Tells the UI when something outside Perli changes a shown folder or the set of drives.
//!
//! This asks about each folder once a second instead of holding a change notification open.
//! A notification keeps a handle on the folder, and Windows then refuses to rename or move any
//! folder above it, and a drive can't be ejected. Perli must never get in the way like that.
//
// ponytail: a folder's modified time misses a file growing in place, and FAT and exFAT don't
// update it at all, so those need F5. A subtree watch on the drive root could cover both, if it
// also lets go when the drive asks to be ejected.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, PoisonError};
use std::thread;
use std::time::{Duration, SystemTime};

use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::Storage::FileSystem::GetLogicalDrives;

const CHECK_GAP: Duration = Duration::from_secs(1);

struct Watch {
    folder: PathBuf,
    seen: Option<SystemTime>,
}

impl Watch {
    /// Must run before the folder is read, so a change during the read still shows up.
    fn new(folder: PathBuf) -> Self {
        let seen = modified(&folder);
        Self { folder, seen }
    }
}

fn modified(folder: &PathBuf) -> Option<SystemTime> {
    std::fs::metadata(folder).and_then(|data| data.modified()).ok()
}

/// The folder each view shows.
#[derive(Default)]
pub struct Watches(Mutex<HashMap<u32, Watch>>);

impl Watches {
    pub fn follow(&self, view: u32, folder: &str) {
        let watch = Watch::new(folder.into());
        self.0.lock().unwrap_or_else(PoisonError::into_inner).insert(view, watch);
    }

    /// The Recycle Bin has no folder to ask about, so a view on it stops here.
    pub fn stop(&self, view: u32) {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).remove(&view);
    }

    /// The views whose folder changed since the last look.
    fn changed(&self) -> Vec<u32> {
        // A slow network drive must not hold the lock, so the folders are read outside it.
        let folders: Vec<(u32, PathBuf, Option<SystemTime>)> = {
            let watches = self.0.lock().unwrap_or_else(PoisonError::into_inner);
            watches.iter().map(|(&view, watch)| (view, watch.folder.clone(), watch.seen)).collect()
        };
        let mut changed = Vec::new();
        for (view, folder, seen) in folders {
            let now = modified(&folder);
            if now == seen {
                continue;
            }
            let mut watches = self.0.lock().unwrap_or_else(PoisonError::into_inner);
            // The view may have moved on while the folder was read.
            if let Some(watch) = watches.get_mut(&view).filter(|watch| watch.folder == folder) {
                watch.seen = now;
                changed.push(view);
            }
        }
        changed
    }
}

/// Runs for the life of the app.
pub fn start(app: AppHandle) {
    thread::spawn(move || {
        let mut drives = unsafe { GetLogicalDrives() };
        loop {
            thread::sleep(CHECK_GAP);
            let now = unsafe { GetLogicalDrives() };
            if now != drives {
                drives = now;
                let _ = app.emit("drives-changed", ());
            }
            for view in app.state::<Watches>().changed() {
                let _ = app.emit("folder-changed", view);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn a_new_file_changes_the_folder_once() {
        let folder = std::env::temp_dir().join(format!("perli-watch-{}", std::process::id()));
        fs::create_dir_all(&folder).unwrap();
        let watches = Watches::default();
        watches.follow(1, folder.to_str().unwrap());
        assert!(watches.changed().is_empty());

        // Modified times only move with the clock's tick.
        thread::sleep(Duration::from_millis(50));
        fs::write(folder.join("new.txt"), "").unwrap();

        assert_eq!(watches.changed(), [1]);
        assert!(watches.changed().is_empty());

        watches.stop(1);
        thread::sleep(Duration::from_millis(50));
        fs::remove_file(folder.join("new.txt")).unwrap();
        assert!(watches.changed().is_empty());
        fs::remove_dir(&folder).unwrap();
    }
}
