//! Tells the UI when something outside Perli changes a shown folder or the set of drives.
//!
//! This lists each watched folder about once a second instead of holding a change notification
//! open. A notification keeps a handle on the folder, and Windows then refuses to rename or move
//! any folder above it, and a drive can't be ejected. Perli must never get in the way like that.
//! A listing also sees what a folder's own modified time misses: a file that grows in place, and
//! any change at all on FAT and exFAT, which never update that time.
//
// ponytail: NTFS writes a growing file's new size into the folder when the writer closes it or
// flushes, so a file still being written shows its size in steps. A folder that takes long to
// list is looked at less often, up to LOOK_SHARE of the time, rather than through a smarter feed.

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::Storage::FileSystem::GetLogicalDrives;

use crate::ops::sys;

const CHECK_GAP: Duration = Duration::from_secs(1);
/// A slow folder waits this many times as long as its last look took, so watching costs about
/// one part in this many of a drive's time.
const LOOK_SHARE: u32 = 20;

/// The folders one view shows: its own, and each one opened in place, each with a stamp of
/// every name, size and time it held when last looked at. None if it couldn't be listed.
#[derive(Clone, Debug)]
pub struct Watch {
    folders: Vec<(PathBuf, Option<u64>)>,
}

impl Watch {
    /// Lists each folder, so it may wait on a slow drive. Must run before the folders are read,
    /// so a change during the read still shows up.
    pub fn new(folders: impl IntoIterator<Item = PathBuf>) -> Self {
        Self { folders: folders.into_iter().map(|folder| { let seen = stamp(&folder); (folder, seen) }).collect() }
    }

    pub fn same_folders(&self, other: &Watch) -> bool {
        self.folders.len() == other.folders.len()
            && self.folders.iter().zip(&other.folders).all(|((a, _), (b, _))| a == b)
    }
}

fn stamp(folder: &Path) -> Option<u64> {
    let entries = sys::read_dir(folder).ok()?;
    let mut hasher = DefaultHasher::new();
    for (name, stat) in entries {
        // NTFS moves a folder's time in its parent a while after something inside changed,
        // which would read the folder twice for one change. What is inside has its own watch.
        let time = if stat.is_dir() { 0 } else { stat.modified };
        (name, stat.size, time, stat.is_dir()).hash(&mut hasher);
    }
    Some(hasher.finish())
}

struct Watched {
    watch: Watch,
    /// Which `set` made it, so a look that started before a newer one can't overwrite it.
    made: u64,
    next: Instant,
}

/// The folders each view shows.
#[derive(Default)]
pub struct Watches(Mutex<(HashMap<u32, Watched>, u64)>);

impl Watches {
    /// Moves a view to `watch`. With none it stops, as the Recycle Bin and a search have no
    /// folder to ask about.
    pub fn set(&self, view: u32, watch: Option<Watch>) {
        let mut guard = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        let (watches, made) = &mut *guard;
        *made += 1;
        match watch {
            Some(watch) => watches.insert(view, Watched { watch, made: *made, next: Instant::now() }),
            None => watches.remove(&view),
        };
    }

    /// Keeps the view on `shown`, the rows the UI has on screen. A newer read the UI dropped
    /// may have moved the watch away from them. The same folders keep their newer looks.
    pub fn follow(&self, view: u32, shown: Option<Watch>) {
        let same = {
            let guard = self.0.lock().unwrap_or_else(PoisonError::into_inner);
            match (guard.0.get(&view), &shown) {
                (Some(current), Some(shown)) => current.watch.same_folders(shown),
                (None, None) => true,
                _ => false,
            }
        };
        if !same {
            self.set(view, shown);
        }
    }

    pub fn stop(&self, view: u32) {
        self.set(view, None);
    }

    /// The views whose folders changed since the last look.
    fn changed(&self) -> Vec<u32> {
        // A slow network drive must not hold the lock, so the folders are read outside it.
        let due: Vec<(u32, Watch, u64)> = {
            let guard = self.0.lock().unwrap_or_else(PoisonError::into_inner);
            let now = Instant::now();
            guard.0.iter().filter(|(_, watched)| watched.next <= now).map(|(&view, watched)| (view, watched.watch.clone(), watched.made)).collect()
        };
        let mut changed = Vec::new();
        for (view, mut watch, made) in due {
            let started = Instant::now();
            let mut moved = false;
            for (folder, seen) in &mut watch.folders {
                let now = stamp(folder);
                moved |= now != *seen;
                *seen = now;
            }
            let took = started.elapsed() * LOOK_SHARE;
            let mut guard = self.0.lock().unwrap_or_else(PoisonError::into_inner);
            // The view may have moved on while the folders were read.
            if let Some(watched) = guard.0.get_mut(&view).filter(|watched| watched.made == made) {
                watched.watch = watch;
                watched.next = if took > CHECK_GAP { Instant::now() + took } else { started };
                if moved {
                    changed.push(view);
                }
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
    use std::io::Write;

    fn sandbox(name: &str) -> PathBuf {
        let folder = std::env::temp_dir().join(format!("perli-watch-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&folder);
        fs::create_dir_all(&folder).unwrap();
        folder
    }

    #[test]
    fn a_new_file_changes_the_folder_once() {
        let folder = sandbox("new");
        let watches = Watches::default();
        watches.set(1, Some(Watch::new([folder.clone()])));
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
        fs::remove_dir_all(&folder).unwrap();
    }

    #[test]
    fn a_file_growing_in_place_and_a_folder_opened_in_place_are_seen() {
        let folder = sandbox("grow");
        let inner = folder.join("inner");
        fs::create_dir(&inner).unwrap();
        fs::write(folder.join("log.txt"), "a").unwrap();
        let watches = Watches::default();
        watches.set(1, Some(Watch::new([folder.clone(), inner.clone()])));
        assert!(watches.changed().is_empty());

        // The folder's own modified time stays put for this.
        let modified = || fs::metadata(&folder).unwrap().modified().unwrap();
        let before = modified();
        fs::OpenOptions::new().append(true).open(folder.join("log.txt")).unwrap().write_all(b"more").unwrap();
        assert_eq!(modified(), before);
        assert_eq!(watches.changed(), [1]);

        fs::write(inner.join("new.txt"), "").unwrap();
        assert_eq!(watches.changed(), [1]);
        assert!(watches.changed().is_empty());
        fs::remove_dir_all(&folder).unwrap();
    }

    #[test]
    fn a_change_before_the_first_look_still_shows() {
        let folder = sandbox("early");
        fs::write(folder.join("log.txt"), "a").unwrap();
        let watches = Watches::default();
        watches.set(1, Some(Watch::new([folder.clone()])));
        fs::write(folder.join("log.txt"), "a longer text").unwrap();
        assert_eq!(watches.changed(), [1]);
        fs::remove_dir_all(&folder).unwrap();
    }

    #[test]
    fn the_watch_follows_the_rows_on_screen() {
        let (shown, dropped) = (sandbox("shown"), sandbox("dropped"));
        let watches = Watches::default();
        watches.set(1, Some(Watch::new([shown.clone()])));
        assert!(watches.changed().is_empty());
        // A read the UI then dropped moved the watch, and the next open failed.
        watches.set(1, Some(Watch::new([dropped.clone()])));
        watches.follow(1, Some(Watch::new([shown.clone()])));

        thread::sleep(Duration::from_millis(50));
        fs::write(shown.join("new.txt"), "").unwrap();
        assert_eq!(watches.changed(), [1]);
        fs::write(dropped.join("new.txt"), "").unwrap();
        assert!(watches.changed().is_empty());
        fs::remove_dir_all(&shown).unwrap();
        fs::remove_dir_all(&dropped).unwrap();
    }
}
