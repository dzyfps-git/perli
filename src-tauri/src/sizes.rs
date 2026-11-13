//! Folder totals, which Windows keeps nowhere, so a thread adds them up. Only runs when asked.

use std::collections::HashMap;
use std::fs;
use std::mem;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex, PoisonError, RwLock};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::folder::Entry;
use crate::ops::sys::{self, Stat};
use crate::session;

const REPORT_GAP: Duration = Duration::from_secs(1);
/// The disk map hears of the folders weighed so far this often.
const MAP_GAP: Duration = Duration::from_millis(200);

// ponytail: grows with every folder looked at and each total stays until the next scan. Dropping
// the least recently used would cap it.
static KNOWN: LazyLock<RwLock<HashMap<PathBuf, u64>>> = LazyLock::new(|| RwLock::new(load()));

/// Where totals wait between sessions.
const SAVED: &str = "folder-sizes.json";

/// The last session's totals, which stand until a scan adds those folders up again. Tests start
/// from none, and leave the user's own alone.
fn load() -> HashMap<PathBuf, u64> {
    let text = session::data_file(SAVED).filter(|_| !cfg!(test)).and_then(|file| fs::read_to_string(file).ok());
    text.and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default()
}

fn save() {
    let Some(file) = session::data_file(SAVED).filter(|_| !cfg!(test)) else { return };
    // The first scan can come before anything else made Perli's folder.
    if let Some(folder) = file.parent() {
        let _ = fs::create_dir_all(folder);
    }
    if let Ok(text) = serde_json::to_string(&*KNOWN.read().unwrap_or_else(PoisonError::into_inner)) {
        let _ = fs::write(file, text);
    }
}

fn key(path: &Path) -> PathBuf {
    path.to_string_lossy().to_lowercase().into()
}

/// True once any folder has a total.
pub fn any() -> bool {
    !KNOWN.read().unwrap_or_else(PoisonError::into_inner).is_empty()
}

pub fn of(path: &Path) -> Option<u64> {
    KNOWN.read().unwrap_or_else(PoisonError::into_inner).get(&key(path)).copied()
}

pub fn forget() {
    KNOWN.write().unwrap_or_else(PoisonError::into_inner).clear();
    if let Some(file) = session::data_file(SAVED).filter(|_| !cfg!(test)) {
        let _ = fs::remove_file(file);
    }
}

/// Calls `visit` for each entry of `folder`, with whether it is a real folder to walk into. A
/// folder that can't be read counts as empty, which is no reason to stop.
fn each_item(folder: &Path, mut visit: impl FnMut(Entry, bool)) {
    let _ = sys::each_entry(&sys::extended(&folder.join("*")), |data| {
        if let Some(entry) = Entry::from_find_data(data) {
            visit(entry, Stat::from_find_data(data).is_folder());
        }
    });
}

/// All the file bytes under `folder`, or nothing if `stop` is set first. Links stay unfollowed,
/// because one could lead back around or count another drive.
fn total(folder: &Path, stop: &AtomicBool) -> Option<u64> {
    let mut waiting = vec![folder.to_path_buf()];
    let mut bytes = 0;
    while let Some(next) = waiting.pop() {
        if stop.load(Ordering::SeqCst) {
            return None;
        }
        each_item(&next, |entry, is_folder| {
            if is_folder {
                waiting.push(next.join(entry.file_name()));
            } else {
                bytes += entry.size();
            }
        });
    }
    Some(bytes)
}

fn scan(folder: &Path, stop: &AtomicBool, report: impl Fn()) {
    let mut folders = Vec::new();
    each_item(folder, |entry, is_folder| {
        if is_folder {
            folders.push(folder.join(entry.file_name()));
        }
    });
    let mut reported = Instant::now();
    for found in folders {
        let Some(bytes) = total(&found, stop) else {
            return;
        };
        {
            let mut known = KNOWN.write().unwrap_or_else(PoisonError::into_inner);
            // Checked under the lock: `forget` stops scans before it clears, so no total lands after.
            if stop.load(Ordering::SeqCst) {
                return;
            }
            known.insert(key(&found), bytes);
        }
        if reported.elapsed() >= REPORT_GAP {
            report();
            reported = Instant::now();
        }
    }
    report();
    save();
}

/// One thing right inside a folder, with all the bytes under it, for the disk map.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Cell {
    pub name: String,
    pub bytes: u64,
    pub folder: bool,
}

/// The one disk map being measured.
static MAPPING: LazyLock<Mutex<Arc<AtomicBool>>> = LazyLock::new(Mutex::default);

pub fn stop_map() {
    MAPPING.lock().unwrap_or_else(PoisonError::into_inner).store(true, Ordering::SeqCst);
}

/// Weighs everything right inside `folder` on a thread of its own, in place of any map before it.
/// `report` hears the cells that are new or have grown, and whether those were the last.
pub fn map(folder: PathBuf, report: impl Fn(Vec<Cell>, bool) + Send + 'static) {
    let stop = Arc::new(AtomicBool::new(false));
    mem::replace(&mut *MAPPING.lock().unwrap_or_else(PoisonError::into_inner), stop.clone()).store(true, Ordering::SeqCst);
    thread::spawn(move || weigh(&folder, &stop, report));
}

/// Files are known at once, and folders come first as empty cells that fill as each is added up.
fn weigh(folder: &Path, stop: &AtomicBool, report: impl Fn(Vec<Cell>, bool)) {
    let mut cells = Vec::new();
    each_item(folder, |entry, is_folder| {
        let name = entry.file_name().to_string_lossy().into_owned();
        cells.push(Cell { name, bytes: if is_folder { 0 } else { entry.size() }, folder: is_folder });
    });
    let folders: Vec<String> = cells.iter().filter(|cell| cell.folder).map(|cell| cell.name.clone()).collect();
    report(cells, folders.is_empty());

    let mut ready = Vec::new();
    let mut reported = Instant::now();
    for (at, name) in folders.iter().enumerate() {
        let Some(bytes) = total(&folder.join(name), stop) else {
            return;
        };
        ready.push(Cell { name: name.clone(), bytes, folder: true });
        let last = at + 1 == folders.len();
        if last || reported.elapsed() >= MAP_GAP {
            report(mem::take(&mut ready), last);
            reported = Instant::now();
        }
    }
}

/// The running scan of each view that has one.
#[derive(Default)]
pub struct Scans(Mutex<HashMap<u32, Arc<AtomicBool>>>);

impl Scans {
    /// Replaces the view's scan. `report` hears when more totals are in.
    pub fn start(&self, view: u32, folder: PathBuf, report: impl Fn() + Send + 'static) {
        let stop = Arc::new(AtomicBool::new(false));
        let old = self.0.lock().unwrap_or_else(PoisonError::into_inner).insert(view, stop.clone());
        if let Some(old) = old {
            old.store(true, Ordering::SeqCst);
        }
        thread::spawn(move || scan(&folder, &stop, report));
    }

    pub fn stop(&self, view: u32) {
        let old = self.0.lock().unwrap_or_else(PoisonError::into_inner).remove(&view);
        if let Some(old) = old {
            old.store(true, Ordering::SeqCst);
        }
    }

    pub fn stop_all(&self) {
        for (_, stop) in mem::take(&mut *self.0.lock().unwrap_or_else(PoisonError::into_inner)) {
            stop.store(true, Ordering::SeqCst);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::windows::fs::symlink_dir;
    use std::process::Command;
    use std::sync::mpsc;

    use super::*;
    use crate::folder::{Listing, Order, SortKey};

    struct Tree(PathBuf);

    impl Tree {
        fn new(name: &str) -> Self {
            let root = std::env::temp_dir().join(format!("perli-sizes-{name}-{}", std::process::id()));
            fs::create_dir_all(root.join(r"top\inner")).unwrap();
            fs::create_dir_all(root.join("empty")).unwrap();
            fs::write(root.join("loose.bin"), [0; 9]).unwrap();
            fs::write(root.join(r"top\a.bin"), [0; 100]).unwrap();
            fs::write(root.join(r"top\inner\b.bin"), [0; 20]).unwrap();
            Self(root)
        }
    }

    impl Drop for Tree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn scanned(tree: &Tree) {
        let (told, heard) = mpsc::channel();
        scan(&tree.0, &AtomicBool::new(false), move || told.send(()).unwrap());
        heard.recv().unwrap();
    }

    #[test]
    fn a_scan_adds_up_everything_under_each_folder() {
        let tree = Tree::new("adds");
        scanned(&tree);
        assert_eq!(of(&tree.0.join("TOP")), Some(120), "case does not matter");
        assert_eq!(of(&tree.0.join("empty")), Some(0));
        assert_eq!(of(&tree.0.join("loose.bin")), None);
    }

    #[test]
    fn a_junction_is_neither_followed_nor_counted() {
        let tree = Tree::new("links");
        let outside = Tree::new("outside");
        let junction = tree.0.join(r"top\link");
        let made = Command::new("cmd")
            .args(["/C", "mklink", "/J", junction.to_str().unwrap(), outside.0.to_str().unwrap()])
            .output()
            .unwrap();
        assert!(made.status.success(), "{made:?}");
        let _ = symlink_dir(&outside.0, tree.0.join("may-need-rights"));

        scanned(&tree);

        assert_eq!(of(&tree.0.join("top")), Some(120));
        assert_eq!(of(&junction), None);
        assert_eq!(of(&tree.0.join("may-need-rights")), None);
    }

    #[test]
    fn a_total_is_what_the_list_shows_and_sorts_by() {
        let tree = Tree::new("list");
        scanned(&tree);
        let order = Order { key: SortKey::Size, descending: true, ..Order::default() };

        let listing = Listing::read(tree.0.to_str().unwrap(), order).unwrap();

        assert_eq!(listing.names(&[0, 1]), ["top", "empty"]);
        assert_eq!(listing.encode_rows(0, 1)[8..16], 120u64.to_le_bytes());
    }

    #[test]
    fn a_map_weighs_each_thing_in_the_folder() {
        let tree = Tree::new("map");
        let heard = Mutex::new(Vec::new());
        weigh(&tree.0, &AtomicBool::new(false), |cells, done| heard.lock().unwrap().push((cells, done)));
        let heard = heard.into_inner().unwrap();

        let cell = |name: &str, bytes, folder| Cell { name: name.into(), bytes, folder };
        let mut first = heard[0].0.clone();
        first.sort_by(|a, b| a.name.cmp(&b.name));
        assert_eq!(first, [cell("empty", 0, true), cell("loose.bin", 9, false), cell("top", 0, true)]);
        assert!(!heard[0].1, "the folders are still to come");
        let mut grown: Vec<Cell> = heard[1..].iter().flat_map(|(cells, _)| cells.clone()).collect();
        grown.sort_by(|a, b| a.name.cmp(&b.name));
        assert_eq!(grown, [cell("empty", 0, true), cell("top", 120, true)]);
        assert!(heard.last().unwrap().1);

        let stopped = Mutex::new(0);
        weigh(&tree.0, &AtomicBool::new(true), |_, _| *stopped.lock().unwrap() += 1);
        assert_eq!(stopped.into_inner().unwrap(), 1, "only what was known at once");
        fs::remove_dir_all(tree.0.join("top")).unwrap();
        fs::remove_dir_all(tree.0.join("empty")).unwrap();
        weigh(&tree.0, &AtomicBool::new(false), |cells, done| assert!(done && cells.len() == 1));
    }

    #[test]
    fn a_stopped_scan_gives_nothing() {
        let tree = Tree::new("stop");
        assert_eq!(total(&tree.0, &AtomicBool::new(true)), None);
        assert_eq!(total(&tree.0, &AtomicBool::new(false)), Some(129));
    }

    #[test]
    fn a_new_scan_stops_the_old_one() {
        let tree = Tree::new("again");
        let scans = Scans::default();
        scans.start(7, tree.0.clone(), || ());
        let first = scans.0.lock().unwrap()[&7].clone();
        let (told, heard) = mpsc::channel();
        scans.start(7, tree.0.clone(), move || told.send(()).unwrap());

        assert!(first.load(Ordering::SeqCst));
        heard.recv_timeout(Duration::from_secs(5)).unwrap();
        scans.stop(7);
        assert!(scans.0.lock().unwrap().is_empty());
    }
}
