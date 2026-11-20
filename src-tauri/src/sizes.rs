//! Folder totals, which Windows keeps nowhere, so a thread adds them up. Only runs when asked.

use std::collections::HashMap;
use std::fs;
use std::mem;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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

/// Each total with when it was added up, by a count that only grows, so the oldest go first.
static KNOWN: LazyLock<RwLock<HashMap<PathBuf, (u64, u64)>>> = LazyLock::new(|| RwLock::new(load()));
static ADDED: AtomicU64 = AtomicU64::new(1);
/// Past this many totals the oldest quarter goes, so the map can't grow without end.
const MOST_KNOWN: usize = 100_000;
/// A running scan writes its totals to disk no more often than this. The end of a scan always does.
const SAVE_GAP: Duration = Duration::from_secs(30);

/// Where totals wait between sessions.
const SAVED: &str = "folder-sizes.json";

/// The last session's totals, which stand until a scan adds those folders up again. Tests start
/// from none, and leave the user's own alone.
fn load() -> HashMap<PathBuf, (u64, u64)> {
    let text = session::data_file(SAVED).filter(|_| !cfg!(test)).and_then(|file| fs::read_to_string(file).ok());
    let saved: HashMap<PathBuf, u64> = text.and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default();
    // Saved totals count as older than any added up in this session.
    saved.into_iter().map(|(path, bytes)| (path, (bytes, 0))).collect()
}

/// Keeps `bytes` as the total of `path`, dropping the oldest quarter when there are too many.
fn keep(known: &mut HashMap<PathBuf, (u64, u64)>, path: PathBuf, bytes: u64) {
    known.insert(path, (bytes, ADDED.fetch_add(1, Ordering::Relaxed)));
    if known.len() > MOST_KNOWN {
        // Down to three quarters exactly, even where ages tie, as every total loaded from last
        // time does.
        let going = known.len() - MOST_KNOWN * 3 / 4;
        let mut ages: Vec<(u64, PathBuf)> = known.iter().map(|(path, &(_, at))| (at, path.clone())).collect();
        ages.select_nth_unstable(going);
        for (_, path) in &ages[..going] {
            known.remove(path);
        }
    }
}

/// Where `save` writes. Tests write to a file of their own and leave the user's alone.
fn saved_file() -> Option<PathBuf> {
    if cfg!(test) {
        Some(std::env::temp_dir().join(format!("perli-test-{}-{SAVED}", std::process::id())))
    } else {
        session::data_file(SAVED)
    }
}

/// Writes under the lock, so a `forget` can't land between reading the totals and writing them.
/// No totals means forgotten, so there is no file to bring back.
fn save() {
    let Some(file) = saved_file() else { return };
    let known = KNOWN.read().unwrap_or_else(PoisonError::into_inner);
    if known.is_empty() {
        return;
    }
    // The first scan can come before anything else made Perli's folder.
    if let Some(folder) = file.parent() {
        let _ = fs::create_dir_all(folder);
    }
    let totals: HashMap<&PathBuf, u64> = known.iter().map(|(path, &(bytes, _))| (path, bytes)).collect();
    let Ok(text) = serde_json::to_string(&totals) else { return };
    // Written beside it and swapped in, so a crash or a reader never meets half a file. One
    // writer at a time, since scans of two views can save at once.
    static SAVING: Mutex<()> = Mutex::new(());
    let _one = SAVING.lock().unwrap_or_else(PoisonError::into_inner);
    let fresh = file.with_extension("new");
    if fs::write(&fresh, text).is_ok() {
        let _ = fs::rename(&fresh, &file);
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
    KNOWN.read().unwrap_or_else(PoisonError::into_inner).get(&key(path)).map(|&(bytes, _)| bytes)
}

pub fn forget() {
    let mut known = KNOWN.write().unwrap_or_else(PoisonError::into_inner);
    known.clear();
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
    let (mut reported, mut saved) = (Instant::now(), Instant::now());
    for found in folders {
        let Some(bytes) = total(&found, stop) else {
            // A stopped scan keeps the totals it finished.
            save();
            return;
        };
        {
            let mut known = KNOWN.write().unwrap_or_else(PoisonError::into_inner);
            // Checked under the lock: `forget` stops scans before it clears, so no total lands after.
            if stop.load(Ordering::SeqCst) {
                drop(known);
                save();
                return;
            }
            keep(&mut known, key(&found), bytes);
        }
        if reported.elapsed() >= REPORT_GAP {
            report();
            reported = Instant::now();
        }
        if saved.elapsed() >= SAVE_GAP {
            save();
            saved = Instant::now();
        }
    }
    report();
    save();
}

/// The kinds of file a cell names, biggest first: enough to tell what fills it.
const MOST_EXTS: usize = 4;
/// The biggest things inside a folder that come along with it, for the map's second ring.
const MOST_INNER: usize = 16;

/// One thing right inside a folder, with all the bytes under it, for Space.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Cell {
    pub name: String,
    pub bytes: u64,
    pub folder: bool,
    /// When a file under it last changed, in FILETIME ticks, or 0 with no files.
    pub newest: u64,
    /// The biggest things right inside a folder, with nothing deeper of their own.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub inner: Vec<Cell>,
    /// Bytes by extension, lowercase and without the dot, biggest first.
    pub exts: Vec<(String, u64)>,
    /// Bytes by the year files last changed, oldest first. Only the folder's own cells carry it.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub years: Vec<(i32, u64)>,
}

/// An extension as a key that costs no allocation: up to 8 ASCII letters, lowercase. Longer or
/// odd ones count with the files that have none.
type Ext = [u8; 8];

fn ext_of(entry: &Entry) -> Ext {
    let name = entry.name();
    let mut ext = [0; 8];
    let Some(dot) = name.iter().rposition(|&unit| unit == u16::from(b'.')) else { return ext };
    let tail = &name[dot + 1..];
    if tail.is_empty() || tail.len() > ext.len() || !tail.iter().all(|&unit| unit < 128) {
        return ext;
    }
    for (slot, &unit) in ext.iter_mut().zip(tail) {
        *slot = (unit as u8).to_ascii_lowercase();
    }
    ext
}

fn ext_text(ext: &Ext) -> String {
    String::from_utf8_lossy(&ext[..ext.iter().position(|&byte| byte == 0).unwrap_or(ext.len())]).into_owned()
}

/// The year of a FILETIME, by UTC, or 0 for none. Days to a civil date as in Howard Hinnant's
/// algorithm, so no date library is needed for one number.
fn year_of(ticks: u64) -> i32 {
    const TICKS_PER_DAY: u64 = 864_000_000_000;
    /// Days from 1601-01-01 to 1970-01-01.
    const TO_1970: i64 = 134_774;
    if ticks == 0 {
        return 0;
    }
    let days = (ticks / TICKS_PER_DAY) as i64 - TO_1970 + 719_468;
    let era = days.div_euclid(146_097);
    let of_era = days.rem_euclid(146_097);
    let year_of_era = (of_era - of_era / 1460 + of_era / 36_524 - of_era / 146_096) / 365;
    let of_year = of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month = (5 * of_year + 2) / 153;
    (year_of_era + era * 400 + i64::from(month >= 10)) as i32
}

/// What a walk under a folder adds up for Space.
#[derive(Default)]
struct Tally {
    bytes: u64,
    newest: u64,
    exts: HashMap<Ext, u64>,
    years: HashMap<i32, u64>,
}

impl Tally {
    fn file(&mut self, entry: &Entry) {
        let size = entry.size();
        self.bytes += size;
        self.newest = self.newest.max(entry.modified());
        *self.exts.entry(ext_of(entry)).or_default() += size;
        *self.years.entry(year_of(entry.modified())).or_default() += size;
    }

    fn add(&mut self, other: Tally) {
        self.bytes += other.bytes;
        self.newest = self.newest.max(other.newest);
        for (ext, bytes) in other.exts {
            *self.exts.entry(ext).or_default() += bytes;
        }
        for (year, bytes) in other.years {
            *self.years.entry(year).or_default() += bytes;
        }
    }

    /// Everything under `folder` added in, or false if `stop` came first. Links stay unfollowed.
    fn walk(&mut self, folder: &Path, stop: &AtomicBool) -> bool {
        let mut waiting = vec![folder.to_path_buf()];
        while let Some(next) = waiting.pop() {
            if stop.load(Ordering::SeqCst) {
                return false;
            }
            each_item(&next, |entry, is_folder| {
                if is_folder {
                    waiting.push(next.join(entry.file_name()));
                } else {
                    self.file(&entry);
                }
            });
        }
        true
    }

    /// The `most` biggest extensions.
    fn top_exts(&self, most: usize) -> Vec<(String, u64)> {
        let mut exts: Vec<(String, u64)> = self.exts.iter().filter(|(_, &bytes)| bytes > 0).map(|(ext, &bytes)| (ext_text(ext), bytes)).collect();
        exts.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        exts.truncate(most);
        exts
    }

    fn cell(self, name: String, folder: bool, inner: Vec<Cell>, years: bool) -> Cell {
        let exts = self.top_exts(MOST_EXTS);
        let mut by_year: Vec<(i32, u64)> = if years { self.years.into_iter().filter(|&(year, bytes)| year > 0 && bytes > 0).collect() } else { Vec::new() };
        by_year.sort_unstable();
        Cell { name, bytes: self.bytes, folder, newest: self.newest, inner, exts, years: by_year }
    }
}

fn file_cell(entry: &Entry, years: bool) -> Cell {
    let mut tally = Tally::default();
    tally.file(entry);
    tally.cell(entry.file_name().to_string_lossy().into_owned(), false, Vec::new(), years)
}

/// A folder weighed for Space: all of it, with its biggest parts one level down. None if stopped.
fn weigh_folder(path: &Path, name: String, stop: &AtomicBool) -> Option<Cell> {
    let mut whole = Tally::default();
    let mut files = Vec::new();
    let mut folders = Vec::new();
    each_item(path, |entry, is_folder| {
        if is_folder {
            folders.push(entry.file_name());
        } else {
            whole.file(&entry);
            files.push(entry);
        }
    });
    // Only the biggest files get a cell of their own, so a folder of 100,000 makes 16.
    files.sort_unstable_by_key(|file| std::cmp::Reverse(file.size()));
    files.truncate(MOST_INNER);
    let mut inner: Vec<Cell> = files.iter().map(|entry| file_cell(entry, false)).collect();
    for folder in folders {
        let mut part = Tally::default();
        if !part.walk(&path.join(&folder), stop) {
            return None;
        }
        // The part's biggest kind comes along, so even a small ring tells what fills it.
        inner.push(Cell {
            name: folder.to_string_lossy().into_owned(),
            bytes: part.bytes,
            folder: true,
            newest: part.newest,
            exts: part.top_exts(1),
            ..Cell::default()
        });
        whole.add(part);
    }
    inner.sort_by(|a, b| b.bytes.cmp(&a.bytes).then_with(|| a.name.cmp(&b.name)));
    inner.truncate(MOST_INNER);
    Some(whole.cell(name, true, inner, true))
}

/// Files by the hour they last changed, for the Time river: hours since 1970 by UTC, how many
/// files, and their bytes.
pub type Hours = Vec<(u32, u32, u64)>;

/// The hour of a FILETIME since 1970 by UTC, or nothing for one before 1970.
fn hour_of(ticks: u64) -> Option<u32> {
    const TICKS_PER_HOUR: u64 = 36_000_000_000;
    /// Hours from 1601-01-01 to 1970-01-01.
    const TO_1970: u64 = 134_774 * 24;
    (ticks / TICKS_PER_HOUR).checked_sub(TO_1970).and_then(|hour| u32::try_from(hour).ok())
}

/// The one Time river being counted.
static RIVER: LazyLock<Mutex<Arc<AtomicBool>>> = LazyLock::new(Mutex::default);

pub fn stop_river() {
    RIVER.lock().unwrap_or_else(PoisonError::into_inner).store(true, Ordering::SeqCst);
}

/// Counts every file under `folder` by the hour it last changed, on a thread of its own in place
/// of any count before it. `report` hears the hours counted since it last heard, and whether the
/// walk is done. Hidden and system files and folders stay out, so a repository's insides don't
/// drown out the work done in it. Links stay unfollowed.
pub fn river(folder: PathBuf, report: impl Fn(Hours, bool) + Send + 'static) {
    let stop = Arc::new(AtomicBool::new(false));
    mem::replace(&mut *RIVER.lock().unwrap_or_else(PoisonError::into_inner), stop.clone()).store(true, Ordering::SeqCst);
    thread::spawn(move || {
        let sight = crate::folder::Sight { hidden: false, system: false };
        let mut counted: HashMap<u32, (u32, u64)> = HashMap::new();
        let drained = |counted: &mut HashMap<u32, (u32, u64)>| {
            let mut hours: Hours = counted.drain().map(|(hour, (files, bytes))| (hour, files, bytes)).collect();
            hours.sort_unstable();
            hours
        };
        let mut waiting = vec![folder];
        let mut reported = Instant::now();
        while let Some(next) = waiting.pop() {
            if stop.load(Ordering::SeqCst) {
                return;
            }
            each_item(&next, |entry, is_folder| {
                if !sight.shows(&entry) {
                    return;
                }
                if is_folder {
                    waiting.push(next.join(entry.file_name()));
                } else if let Some(hour) = hour_of(entry.modified()) {
                    let slot = counted.entry(hour).or_default();
                    slot.0 += 1;
                    slot.1 += entry.size();
                }
            });
            if reported.elapsed() >= MAP_GAP && !counted.is_empty() {
                report(drained(&mut counted), false);
                reported = Instant::now();
            }
        }
        report(drained(&mut counted), true);
    });
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
// ponytail: always walks the disk, even with the search index on, so a whole drive can take a
// while. The index's `entries` table could answer sizes and years at once if that gets too slow.
fn weigh(folder: &Path, stop: &AtomicBool, report: impl Fn(Vec<Cell>, bool)) {
    let mut cells = Vec::new();
    each_item(folder, |entry, is_folder| {
        cells.push(if is_folder {
            Cell { name: entry.file_name().to_string_lossy().into_owned(), folder: true, ..Cell::default() }
        } else {
            file_cell(&entry, true)
        });
    });
    let folders: Vec<String> = cells.iter().filter(|cell| cell.folder).map(|cell| cell.name.clone()).collect();
    report(cells, folders.is_empty());

    let mut ready = Vec::new();
    let mut reported = Instant::now();
    for (at, name) in folders.iter().enumerate() {
        let Some(cell) = weigh_folder(&folder.join(name), name.clone(), stop) else {
            return;
        };
        ready.push(cell);
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
    fn past_the_most_totals_the_oldest_quarter_goes() {
        let mut known = HashMap::new();
        for n in 0..=MOST_KNOWN {
            keep(&mut known, PathBuf::from(n.to_string()), n as u64);
        }
        assert!(known.len() <= MOST_KNOWN * 3 / 4, "{}", known.len());
        assert!(!known.contains_key(Path::new("0")), "the oldest goes");
        assert_eq!(known.get(Path::new(&MOST_KNOWN.to_string())).map(|&(bytes, _)| bytes), Some(MOST_KNOWN as u64));
    }

    #[test]
    fn totals_loaded_from_last_time_go_a_quarter_at_a_time_too() {
        // Every saved total loads as equally old.
        let mut known: HashMap<PathBuf, (u64, u64)> = (0..MOST_KNOWN).map(|n| (PathBuf::from(n.to_string()), (1, 0))).collect();
        keep(&mut known, PathBuf::from("new"), 2);
        assert_eq!(known.len(), MOST_KNOWN * 3 / 4);
        assert!(known.contains_key(Path::new("new")));
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

        let plain = |cells: &[Cell]| {
            let mut list: Vec<(String, u64, bool)> = cells.iter().map(|cell| (cell.name.clone(), cell.bytes, cell.folder)).collect();
            list.sort();
            list
        };
        let cell = |name: &str, bytes, folder| (name.to_string(), bytes, folder);
        assert_eq!(plain(&heard[0].0), [cell("empty", 0, true), cell("loose.bin", 9, false), cell("top", 0, true)]);
        assert!(!heard[0].1, "the folders are still to come");
        let grown: Vec<Cell> = heard[1..].iter().flat_map(|(cells, _)| cells.clone()).collect();
        assert_eq!(plain(&grown), [cell("empty", 0, true), cell("top", 120, true)]);
        assert!(heard.last().unwrap().1);

        let top = grown.iter().find(|cell| cell.name == "top").unwrap();
        assert_eq!(plain(&top.inner), [cell("a.bin", 100, false), cell("inner", 20, true)], "one level down rides along");
        assert_eq!(top.exts, [("bin".to_string(), 120)]);
        let this_year = year_of(top.newest);
        assert!(this_year >= 2024, "{this_year}");
        assert_eq!(top.years, [(this_year, 120)]);
        assert!(top.inner.iter().all(|inner| inner.years.is_empty() && inner.inner.is_empty()));

        let stopped = Mutex::new(0);
        weigh(&tree.0, &AtomicBool::new(true), |_, _| *stopped.lock().unwrap() += 1);
        assert_eq!(stopped.into_inner().unwrap(), 1, "only what was known at once");
        fs::remove_dir_all(tree.0.join("top")).unwrap();
        fs::remove_dir_all(tree.0.join("empty")).unwrap();
        weigh(&tree.0, &AtomicBool::new(false), |cells, done| assert!(done && cells.len() == 1));
    }

    #[test]
    fn a_filetime_gives_its_year() {
        // 2000-01-01 and 1999-12-31 23:59:59 UTC, in FILETIME ticks.
        assert_eq!(year_of(125_911_584_000_000_000), 2000);
        assert_eq!(year_of(125_911_583_990_000_000), 1999);
        // 2024-02-29, a leap day.
        assert_eq!(year_of(133_535_520_000_000_000), 2024);
        assert_eq!(year_of(0), 0);
    }

    #[test]
    fn a_filetime_gives_its_hour_since_1970() {
        assert_eq!(hour_of(125_911_584_000_000_000), Some(262_968));
        assert_eq!(hour_of(125_911_583_990_000_000), Some(262_967));
        assert_eq!(hour_of(0), None);
    }

    #[test]
    fn the_river_counts_every_file_once() {
        let tree = Tree::new("river");
        let (told, heard) = mpsc::channel();
        river(tree.0.clone(), move |hours, done| told.send((hours, done)).unwrap());
        let mut bytes = 0;
        loop {
            let (hours, done) = heard.recv_timeout(Duration::from_secs(5)).unwrap();
            bytes += hours.iter().map(|&(_, _, size)| size).sum::<u64>();
            if done {
                break;
            }
        }
        assert_eq!(bytes, total(&tree.0, &AtomicBool::new(false)).unwrap());
    }

    #[test]
    fn a_biggest_folder_keeps_only_its_biggest_parts() {
        let root = std::env::temp_dir().join(format!("perli-sizes-many-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        for at in 0..MOST_INNER + 5 {
            fs::write(root.join(format!("{at}.TXT")), vec![0; at + 1]).unwrap();
        }
        fs::write(root.join("no-extension"), [0; 3]).unwrap();
        fs::write(root.join("long.extension9"), [0; 2]).unwrap();
        let cell = weigh_folder(&root, "many".into(), &AtomicBool::new(false)).unwrap();
        fs::remove_dir_all(&root).unwrap();

        assert_eq!(cell.inner.len(), MOST_INNER);
        assert_eq!(cell.inner[0].name, format!("{}.TXT", MOST_INNER + 4));
        assert_eq!(cell.exts[0].0, "txt", "lowercase");
        assert_eq!(cell.exts[1], (String::new(), 5), "no extension and an odd one count together");

        let tree = Tree::new("stopped-folder");
        assert!(weigh_folder(&tree.0, "x".into(), &AtomicBool::new(true)).is_none(), "a stop wins over the folders below");
    }

    #[test]
    fn a_stopped_scan_gives_nothing() {
        let tree = Tree::new("stop");
        assert_eq!(total(&tree.0, &AtomicBool::new(true)), None);
        assert_eq!(total(&tree.0, &AtomicBool::new(false)), Some(129));
    }

    #[test]
    fn a_stopped_scan_writes_the_totals_it_has() {
        let tree = Tree::new("saved");
        let file = saved_file().unwrap();
        let kept = key(&tree.0.join("kept"));
        keep(&mut KNOWN.write().unwrap(), kept.clone(), 5);
        scan(&tree.0, &AtomicBool::new(true), || ());
        let saved: HashMap<PathBuf, u64> = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(saved.get(&kept), Some(&5));
        let _ = fs::remove_file(&file);
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
