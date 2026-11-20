//! An opt-in list of every file on this PC's drives, so a search over a folder, a drive or every
//! drive answers from it at once instead of walking. It is off until the user turns it on, and
//! turning it off deletes it.
//!
//! Every Perli window is its own process. One of them keeps the list, which a named mutex picks,
//! and all of them read it. The keeper walks each drive at background priority and then follows
//! a change watch on the drive's root. A USB disk is walked again now and then instead of being
//! watched, because a watch holds a handle on it and Windows then can't eject it.
//
// A keeper that starts walks every drive again once, a while after it starts, to catch what
// changed while no Perli ran. With the journal helper set up (see journal.rs), the NTFS change
// journal tells that at once instead, and only drives it couldn't read are walked again.
use std::collections::{BTreeSet, HashMap, VecDeque};
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use windows::core::HSTRING;
use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE, WAIT_ABANDONED, WAIT_OBJECT_0};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, GetDriveTypeW, GetLogicalDrives, ReadDirectoryChangesW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OVERLAPPED, FILE_LIST_DIRECTORY,
    FILE_NOTIFY_CHANGE_ATTRIBUTES, FILE_NOTIFY_CHANGE_CREATION, FILE_NOTIFY_CHANGE_DIR_NAME, FILE_NOTIFY_CHANGE_FILE_NAME,
    FILE_NOTIFY_CHANGE_LAST_WRITE, FILE_NOTIFY_CHANGE_SIZE, FILE_NOTIFY_INFORMATION, FILE_SHARE_DELETE, FILE_SHARE_READ,
    FILE_SHARE_WRITE, OPEN_EXISTING, WIN32_FIND_DATAW,
};
use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
use windows::Win32::System::Threading::{
    CreateEventW, CreateMutexW, GetCurrentThread, ReleaseMutex, ResetEvent, SetEvent, SetThreadPriority, WaitForMultipleObjects,
    WaitForSingleObject, INFINITE, THREAD_MODE_BACKGROUND_BEGIN,
};
use windows::Win32::System::WindowsProgramming::{DRIVE_FIXED, DRIVE_REMOTE};
use windows::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};

use crate::folder::Sight;
use crate::ops::sys;

const DATABASE: &str = "index.db";
const KEEPER: &str = "Local\\PerliIndexKeeper";
/// Rows written in one go while walking.
const BATCH: usize = 4000;
/// Changes wait this long for more of the same before they are written.
const SETTLE: Duration = Duration::from_millis(400);
/// How often a window that doesn't keep the list tries to, in case the keeper closed.
const TRY_KEEP: Duration = Duration::from_secs(15);
/// The keeper says it is alive this often, and a list whose keeper went quiet for longer than
/// `STALE` is not trusted.
const BEAT: Duration = Duration::from_secs(5);
const STALE: Duration = Duration::from_secs(20);
/// A keeper that starts waits this long before walking drives it already knows again.
const LOOK_AGAIN_AFTER: Duration = Duration::from_secs(120);
/// A USB disk is walked again this often.
const USB_AGAIN: Duration = Duration::from_secs(30 * 60);
/// Drives come and go: the keeper checks for new ones this often.
const DRIVES_AGAIN: Duration = Duration::from_secs(20);
const ATTRIBUTE_DIRECTORY: u32 = 0x10;
const ATTRIBUTE_HIDDEN: u32 = 0x2;
const ATTRIBUTE_SYSTEM: u32 = 0x4;
const ATTRIBUTE_REPARSE: u32 = 0x400;

const SCHEMA: &str = "
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = -8000;
CREATE TABLE IF NOT EXISTS folders(
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL,
    low TEXT NOT NULL UNIQUE,
    depth INTEGER NOT NULL,
    hid INTEGER NOT NULL,
    sys INTEGER NOT NULL,
    seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS entries(
    folder INTEGER NOT NULL,
    low TEXT NOT NULL,
    name TEXT NOT NULL,
    attributes INTEGER NOT NULL,
    size INTEGER NOT NULL,
    modified INTEGER NOT NULL,
    created INTEGER NOT NULL,
    seen INTEGER NOT NULL,
    PRIMARY KEY(folder, low)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS drives(root TEXT PRIMARY KEY, walked INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
";

/// What the user chose, which every window hands over as it changes.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    pub on: bool,
    pub paused: bool,
    /// Wait while the PC runs on its battery.
    pub battery: bool,
    /// Network drives with a letter are listed too.
    pub network: bool,
    /// Folders left out, with all they hold.
    pub skip: Vec<String>,
}

static OPTIONS: Mutex<Option<Options>> = Mutex::new(None);
static KEEPING: AtomicBool = AtomicBool::new(false);

fn options() -> Options {
    OPTIONS.lock().unwrap_or_else(PoisonError::into_inner).clone().unwrap_or_default()
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |since| since.as_millis() as i64)
}

/// A mark for the rows one walk or change writes, always later than the last one, so a walk can
/// drop what it didn't see even when two come in the same millisecond.
fn next_seen() -> i64 {
    static LAST: AtomicI64 = AtomicI64::new(0);
    let now = now_ms();
    let mut last = LAST.load(Ordering::SeqCst);
    loop {
        let next = now.max(last + 1);
        match LAST.compare_exchange(last, next, Ordering::SeqCst, Ordering::SeqCst) {
            Ok(_) => return next,
            Err(newer) => last = newer,
        }
    }
}

fn path_of() -> Option<PathBuf> {
    crate::session::data_file(DATABASE)
}

/// Lowercase, the way search compares names.
fn low(text: &str) -> String {
    text.to_lowercase()
}

/// A folder's lowercase path with one backslash at its end, which is where the paths of
/// everything inside it start.
fn inside_of(folder_low: &str) -> String {
    if folder_low.ends_with('\\') {
        folder_low.to_string()
    } else {
        format!("{folder_low}\\")
    }
}

/// The first path past everything that starts with `prefix`, which ends with a backslash.
fn past(prefix: &str) -> String {
    format!("{}]", &prefix[..prefix.len() - 1])
}

fn depth_of(path: &Path) -> i64 {
    path.components().count() as i64
}

fn root_of(path: &Path) -> PathBuf {
    path.ancestors().last().unwrap_or(path).to_path_buf()
}

/// A row as `FindFirstFile` would have given it, so the list's rows are made the way a walk's are.
pub fn find_data(name: &str, attributes: u32, size: u64, modified: u64, created: u64) -> WIN32_FIND_DATAW {
    let time = |value: u64| FILETIME { dwLowDateTime: value as u32, dwHighDateTime: (value >> 32) as u32 };
    let mut data = WIN32_FIND_DATAW {
        dwFileAttributes: attributes,
        ftCreationTime: time(created),
        ftLastWriteTime: time(modified),
        nFileSizeHigh: (size >> 32) as u32,
        nFileSizeLow: size as u32,
        ..Default::default()
    };
    for (at, unit) in name.encode_utf16().take(data.cFileName.len() - 1).enumerate() {
        data.cFileName[at] = unit;
    }
    data
}

fn stamp(time: FILETIME) -> u64 {
    (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime)
}

fn name_of(data: &WIN32_FIND_DATAW) -> String {
    let length = data.cFileName.iter().position(|&unit| unit == 0).unwrap_or(data.cFileName.len());
    String::from_utf16_lossy(&data.cFileName[..length])
}

/// The deepest hidden, and the deepest protected, folder from the top of the drive down to and
/// with a folder `depth` deep whose parent's are `parent` and whose own attributes are `attributes`.
fn chain(parent: (i64, i64), attributes: u32, depth: i64) -> (i64, i64) {
    let hidden = attributes & ATTRIBUTE_HIDDEN != 0;
    let protected = attributes & (ATTRIBUTE_HIDDEN | ATTRIBUTE_SYSTEM) == ATTRIBUTE_HIDDEN | ATTRIBUTE_SYSTEM;
    (if hidden { depth } else { parent.0 }, if protected { depth } else { parent.1 })
}

/// A folder's id, depth and chain.
type Known = (i64, i64, (i64, i64));

struct Db(Connection);

impl Db {
    fn open(path: &Path) -> rusqlite::Result<Self> {
        if let Some(folder) = path.parent() {
            let _ = std::fs::create_dir_all(folder);
        }
        let connection = Connection::open(path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.execute_batch(SCHEMA)?;
        Ok(Self(connection))
    }

    fn meta(&self, key: &str) -> Option<String> {
        self.0.query_row("SELECT value FROM meta WHERE key = ?", [key], |row| row.get(0)).optional().ok().flatten()
    }

    fn set_meta(&self, key: &str, value: &str) {
        let _ = self.0.execute("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value]);
    }

    /// The id, depth and chain of a folder in the list.
    fn folder(&self, folder_low: &str) -> Option<(i64, i64, (i64, i64))> {
        self.0
            .query_row("SELECT id, depth, hid, sys FROM folders WHERE low = ?", [folder_low], |row| Ok((row.get(0)?, row.get(1)?, (row.get(2)?, row.get(3)?))))
            .optional()
            .ok()
            .flatten()
    }

    fn put_folder(&self, path: &Path, chain: (i64, i64), seen: i64) -> rusqlite::Result<i64> {
        let text = path.to_string_lossy();
        self.0.query_row(
            "INSERT INTO folders(path, low, depth, hid, sys, seen) VALUES(?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(low) DO UPDATE SET path = excluded.path, hid = excluded.hid, sys = excluded.sys, seen = excluded.seen
             RETURNING id",
            params![text, low(&text), depth_of(path), chain.0, chain.1, seen],
            |row| row.get(0),
        )
    }

    fn put_entry(&self, folder: i64, data: &WIN32_FIND_DATAW, seen: i64) -> rusqlite::Result<()> {
        let name = name_of(data);
        let size = (u64::from(data.nFileSizeHigh) << 32) | u64::from(data.nFileSizeLow);
        self.0
            .prepare_cached(
                "INSERT INTO entries(folder, low, name, attributes, size, modified, created, seen) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(folder, low) DO UPDATE SET name = excluded.name, attributes = excluded.attributes, size = excluded.size,
                 modified = excluded.modified, created = excluded.created, seen = excluded.seen",
            )?
            .execute(params![
                folder,
                low(&name),
                name,
                data.dwFileAttributes,
                size as i64,
                stamp(data.ftLastWriteTime) as i64,
                stamp(data.ftCreationTime) as i64,
                seen
            ])?;
        Ok(())
    }

    /// Takes out a folder, everything it holds, and its own row in its parent.
    fn forget(&self, path: &Path) -> rusqlite::Result<()> {
        let path_low = low(&path.to_string_lossy());
        let prefix = inside_of(&path_low);
        let end = past(&prefix);
        let gone = "SELECT id FROM folders WHERE low = ?1 OR (low >= ?2 AND low < ?3)";
        self.0.execute(&format!("DELETE FROM entries WHERE folder IN ({gone})"), params![path_low, prefix, end])?;
        self.0.execute("DELETE FROM folders WHERE low = ?1 OR (low >= ?2 AND low < ?3)", params![path_low, prefix, end])?;
        if let (Some(parent), Some(name)) = (path.parent(), path.file_name()) {
            if let Some((id, ..)) = self.folder(&low(&parent.to_string_lossy())) {
                self.0.execute("DELETE FROM entries WHERE folder = ? AND low = ?", params![id, low(&name.to_string_lossy())])?;
            }
        }
        Ok(())
    }

    /// Drops what a walk of `top` and all it holds didn't see again.
    fn drop_unseen(&self, top: &Path, seen: i64) -> rusqlite::Result<()> {
        let top_low = low(&top.to_string_lossy());
        let prefix = inside_of(&top_low);
        let end = past(&prefix);
        let under = "SELECT id FROM folders WHERE low = ?1 OR (low >= ?2 AND low < ?3)";
        self.0.execute(&format!("DELETE FROM entries WHERE seen < ?4 AND folder IN ({under})"), params![top_low, prefix, end, seen])?;
        self.0.execute("DELETE FROM folders WHERE seen < ?4 AND (low = ?1 OR (low >= ?2 AND low < ?3))", params![top_low, prefix, end, seen])?;
        Ok(())
    }

    fn clear(&self) -> rusqlite::Result<()> {
        self.0.execute_batch("DELETE FROM entries; DELETE FROM folders; DELETE FROM drives;")
    }
}

/// How a walk is told to stop, and hears what it has done.
trait Steer {
    fn stop(&mut self) -> bool;
    fn walked(&mut self, _entries: usize) {}
}

impl<F: FnMut() -> bool> Steer for F {
    fn stop(&mut self) -> bool {
        self()
    }
}

/// Lists `top` and everything under it, then drops what is no longer there. Folders in `skip`
/// (lowercase) are left out, and links are listed but not followed. False when it was stopped.
fn walk(db: &Db, top: &Path, skip: &[String], steer: &mut dyn Steer) -> rusqlite::Result<bool> {
    let seen = next_seen();
    let top_low = low(&top.to_string_lossy());
    if skip.iter().any(|skipped| top_low == *skipped || top_low.starts_with(&inside_of(skipped))) {
        return Ok(true);
    }
    // A folder's chain comes from its parent's, or from its own attributes at the top of a drive.
    let parent_chain = match top.parent() {
        Some(parent) => db.folder(&low(&parent.to_string_lossy())).map_or((0, 0), |(.., chain)| chain),
        None => (0, 0),
    };
    let own = if top.parent().is_some() {
        let mut attributes = 0;
        let _ = sys::each_entry(&sys::extended(top), |data| attributes = data.dwFileAttributes);
        chain(parent_chain, attributes, depth_of(top))
    } else {
        (0, 0)
    };
    let mut queue = VecDeque::from([(top.to_path_buf(), own)]);
    let mut pending = 0;
    let mut batch = db.0.unchecked_transaction()?;
    while let Some((folder, folder_chain)) = queue.pop_front() {
        if steer.stop() {
            batch.commit()?;
            return Ok(false);
        }
        let id = db.put_folder(&folder, folder_chain, seen)?;
        let depth = depth_of(&folder);
        let _ = sys::each_entry(&sys::extended(&folder.join("*")), |data| {
            let name = name_of(data);
            if name == "." || name == ".." {
                return;
            }
            let _ = db.put_entry(id, data, seen);
            pending += 1;
            let attributes = data.dwFileAttributes;
            if attributes & ATTRIBUTE_DIRECTORY != 0 && attributes & ATTRIBUTE_REPARSE == 0 {
                let inner = folder.join(&name);
                let inner_low = low(&inner.to_string_lossy());
                if !skip.contains(&inner_low) {
                    queue.push_back((inner, chain(folder_chain, attributes, depth + 1)));
                }
            }
        });
        if pending >= BATCH {
            batch.commit()?;
            steer.walked(pending);
            pending = 0;
            batch = db.0.unchecked_transaction()?;
        }
    }
    batch.commit()?;
    steer.walked(pending);
    db.drop_unseen(top, seen)?;
    Ok(true)
}

/// Brings the list up to date for one path a change watch named: its row, and if it is a folder
/// that is new or now hidden in another way, everything in it.
fn apply(db: &Db, path: &Path, skip: &[String]) -> rusqlite::Result<()> {
    let path_low = low(&path.to_string_lossy());
    if skip.iter().any(|skipped| path_low == *skipped || path_low.starts_with(&inside_of(skipped))) {
        return Ok(());
    }
    let Some(parent) = path.parent() else { return Ok(()) };
    let mut found = None;
    let _ = sys::each_entry(&sys::extended(path), |data| found = Some(*data));
    let Some(data) = found else {
        return db.forget(path);
    };
    let Some((parent_id, parent_depth, parent_chain)) = known_folder(db, parent)? else {
        return Ok(());
    };
    db.put_entry(parent_id, &data, next_seen())?;
    let attributes = data.dwFileAttributes;
    if attributes & ATTRIBUTE_DIRECTORY == 0 || attributes & ATTRIBUTE_REPARSE != 0 {
        return Ok(());
    }
    let wanted = chain(parent_chain, attributes, parent_depth + 1);
    match db.folder(&path_low) {
        Some((.., known)) if known == wanted => Ok(()),
        _ => walk(db, path, skip, &mut || false).map(drop),
    }
}

/// A folder's row, made from its parent's when a change came before the walk reached it.
fn known_folder(db: &Db, folder: &Path) -> rusqlite::Result<Option<Known>> {
    let folder_low = low(&folder.to_string_lossy());
    if let Some(known) = db.folder(&folder_low) {
        return Ok(Some(known));
    }
    let Some(parent) = folder.parent() else { return Ok(None) };
    let Some((_, parent_depth, parent_chain)) = known_folder(db, parent)? else { return Ok(None) };
    let mut attributes = 0;
    let _ = sys::each_entry(&sys::extended(folder), |data| attributes = data.dwFileAttributes);
    let own = chain(parent_chain, attributes, parent_depth + 1);
    let id = db.put_folder(folder, own, next_seen())?;
    Ok(Some((id, parent_depth + 1, own)))
}

/// A part of a search the list answers: the folders from `start` up to `end`, but `not`.
#[derive(Clone, Debug, PartialEq)]
pub struct Part {
    start: String,
    end: String,
    not: String,
    /// How deep the folder the search walks from is, which hidden folders above it don't count past.
    depth: i64,
}

impl Part {
    /// Everything inside `folder`, but not its own entries.
    fn inside(folder: &Path) -> Self {
        let folder_low = low(&folder.to_string_lossy());
        let start = inside_of(&folder_low);
        Self { end: past(&start), start, not: folder_low, depth: depth_of(folder) }
    }

    /// A whole drive, from its top.
    fn drive(root: &Path) -> Self {
        let start = inside_of(&low(&root.to_string_lossy()));
        Self { end: past(&start), not: String::new(), start, depth: depth_of(root) }
    }
}

/// The drive roots the list answers for now, from what its keeper last said. None when this
/// window has the list off, or its keeper went quiet.
fn live() -> Vec<String> {
    if !options().on || options().paused {
        return Vec::new();
    }
    let Some(db) = path_of().filter(|path| path.exists()).and_then(|path| Db::open(&path).ok()) else {
        return Vec::new();
    };
    let beat: i64 = db.meta("beat").and_then(|beat| beat.parse().ok()).unwrap_or(0);
    if now_ms() - beat > STALE.as_millis() as i64 {
        return Vec::new();
    }
    db.meta("live").map(|live| live.split('|').filter(|root| !root.is_empty()).map(str::to_string).collect()).unwrap_or_default()
}

/// Takes out of `below` what the list can answer for, and says what to ask it instead. `folder`
/// is where the search walks from, whose own entries it has read already.
pub fn parts_for(folder: &Path, below: &mut VecDeque<PathBuf>) -> Vec<Part> {
    let live = live();
    let answers = |path: &Path| live.contains(&low(&root_of(path).to_string_lossy()));
    if live.is_empty() {
        return Vec::new();
    }
    let mut parts = Vec::new();
    let folder_low = inside_of(&low(&folder.to_string_lossy()));
    if answers(folder) {
        parts.push(Part::inside(folder));
        below.retain(|path| !low(&path.to_string_lossy()).starts_with(&folder_low));
    }
    below.retain(|path| {
        let whole_drive = path.parent().is_none();
        if whole_drive && answers(path) {
            parts.push(Part::drive(path));
            return false;
        }
        true
    });
    parts
}

/// One page of the rows whose lowercase names hold `text`, in the parts given, nearest folders
/// first and each folder's rows together.
pub fn page(parts: &[Part], text: &str, deepest: usize, sight: Sight, skip: usize, take: usize) -> Vec<(PathBuf, WIN32_FIND_DATAW)> {
    let Some(db) = path_of().and_then(|path| Db::open(&path).ok()) else {
        return Vec::new();
    };
    page_in(&db, parts, text, deepest, sight, skip, take).unwrap_or_default()
}

fn page_in(db: &Db, parts: &[Part], text: &str, deepest: usize, sight: Sight, skip: usize, take: usize) -> rusqlite::Result<Vec<(PathBuf, WIN32_FIND_DATAW)>> {
    if parts.is_empty() {
        return Ok(Vec::new());
    }
    let mut values: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(low(text)), Box::new(deepest.min(i64::MAX as usize) as i64)];
    let mut conditions = Vec::new();
    for part in parts {
        let at = values.len();
        let (hidden, system, depth) = (u8::from(sight.hidden), u8::from(sight.system), at + 4);
        conditions.push(format!(
            "(f.low >= ?{} AND f.low < ?{} AND f.low != ?{} AND ({hidden} OR f.hid <= ?{depth}) AND ({system} OR f.sys <= ?{depth}))",
            at + 1,
            at + 2,
            at + 3
        ));
        values.extend([Box::new(part.start.clone()) as Box<dyn rusqlite::ToSql>, Box::new(part.end.clone()), Box::new(part.not.clone()), Box::new(part.depth)]);
    }
    let sql = format!(
        "SELECT f.path, e.name, e.attributes, e.size, e.modified, e.created FROM entries e JOIN folders f ON f.id = e.folder
         WHERE instr(e.low, ?1) > 0 AND f.depth <= ?2 AND ({}) ORDER BY f.depth, e.folder LIMIT {take} OFFSET {skip}",
        conditions.join(" OR ")
    );
    let mut statement = db.0.prepare(&sql)?;
    let rows = statement.query_map(rusqlite::params_from_iter(values.iter().map(|value| value.as_ref())), |row| {
        let folder: String = row.get(0)?;
        let name: String = row.get(1)?;
        let data = find_data(&name, row.get(2)?, row.get::<_, i64>(3)? as u64, row.get::<_, i64>(4)? as u64, row.get::<_, i64>(5)? as u64);
        Ok((PathBuf::from(folder), data))
    })?;
    rows.collect()
}

/// How the list is doing, as Settings shows it.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// off, waiting (for the window that keeps it), walking, ready, paused or battery.
    pub state: String,
    pub files: u64,
    pub folders: u64,
    pub bytes: u64,
    /// When the last walk of a drive ended, in ms since 1970.
    pub walked: Option<i64>,
    /// What a walk has listed so far.
    pub listed: u64,
    pub drives: Vec<String>,
}

pub fn status() -> Status {
    let options = options();
    if !options.on {
        return Status { state: "off".into(), ..Default::default() };
    }
    let Some(path) = path_of().filter(|path| path.exists()) else {
        return Status { state: "waiting".into(), ..Default::default() };
    };
    let bytes = ["", "-wal"].iter().filter_map(|end| std::fs::metadata(format!("{}{end}", path.display())).ok()).map(|data| data.len()).sum();
    let Ok(db) = Db::open(&path) else {
        return Status { state: "waiting".into(), bytes, ..Default::default() };
    };
    let count = |sql: &str| db.0.query_row(sql, [], |row| row.get::<_, i64>(0)).unwrap_or(0) as u64;
    let beat: i64 = db.meta("beat").and_then(|beat| beat.parse().ok()).unwrap_or(0);
    let state = if now_ms() - beat > STALE.as_millis() as i64 { "waiting".into() } else { db.meta("state").unwrap_or_else(|| "waiting".into()) };
    Status {
        state,
        files: count("SELECT count(*) FROM entries"),
        folders: count("SELECT count(*) FROM folders"),
        bytes,
        walked: db.0.query_row("SELECT max(walked) FROM drives", [], |row| row.get(0)).ok().flatten(),
        listed: db.meta("listed").and_then(|listed| listed.parse().ok()).unwrap_or(0),
        drives: db.meta("live").map(|live| live.split('|').filter(|root| !root.is_empty()).map(str::to_uppercase).collect()).unwrap_or_default(),
    }
}

/// Asks the keeper, whichever window it is in, to list everything afresh.
pub fn rebuild() -> Result<(), String> {
    let path = path_of().ok_or("Windows gave no place to keep the index")?;
    let db = Db::open(&path).map_err(|error| error.to_string())?;
    db.set_meta("ask", &now_ms().to_string());
    Ok(())
}

/// Takes what the user chose. The first time the list is on, this window starts trying to keep it.
pub fn set_options(next: Options) {
    let on = next.on;
    *OPTIONS.lock().unwrap_or_else(PoisonError::into_inner) = Some(next);
    if on && !KEEPING.swap(true, Ordering::SeqCst) {
        thread::spawn(|| {
            keep();
            KEEPING.store(false, Ordering::SeqCst);
            // Turned on again while the last keeper was leaving.
            if options().on {
                set_options(options());
            }
        });
    }
}

/// The drives to list: those inside the PC and on USB, and network ones when asked.
fn drives(network: bool) -> Vec<(PathBuf, bool)> {
    let letters = unsafe { GetLogicalDrives() };
    (0..26u8)
        .filter(|bit| letters & (1 << bit) != 0)
        .filter_map(|bit| {
            let root = format!("{}:\\", char::from(b'A' + bit));
            let kind = unsafe { GetDriveTypeW(&HSTRING::from(root.as_str())) };
            let usb = kind == DRIVE_FIXED && crate::places::is_usb(&root);
            (kind == DRIVE_FIXED || (network && kind == DRIVE_REMOTE)).then(|| (PathBuf::from(root), usb || kind == DRIVE_REMOTE))
        })
        .collect()
}

fn on_battery() -> bool {
    let mut power = SYSTEM_POWER_STATUS::default();
    unsafe { GetSystemPowerStatus(&mut power) }.is_ok() && power.ACLineStatus == 0
}

pub(crate) enum Heard {
    Changed(PathBuf),
    /// Too much changed at once for the watch to say what: walk the drive again.
    Lost(PathBuf),
    /// The journal told every change on this drive while no Perli ran: no walk again needed.
    Caught(PathBuf),
}

/// A change watch on the top of a drive, held by its own thread. Each read waits on the drive and
/// on `quit` at once, so a watch told to stop ends then, between reads or in one.
pub(crate) struct Watch {
    quit: isize,
    thread: Option<thread::JoinHandle<()>>,
}

impl Watch {
    pub(crate) fn start(root: PathBuf, heard: Sender<Heard>) -> Option<Self> {
        let share = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
        let flags = FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OVERLAPPED;
        let opened = unsafe { CreateFileW(&HSTRING::from(root.as_os_str()), FILE_LIST_DIRECTORY.0, share, None, OPEN_EXISTING, flags, None) }.ok()?;
        let (Ok(done), Ok(quit)) = (unsafe { CreateEventW(None, true, false, None) }, unsafe { CreateEventW(None, true, false, None) }) else {
            let _ = unsafe { CloseHandle(opened) };
            return None;
        };
        let raw = [opened.0 as isize, done.0 as isize, quit.0 as isize];
        // The drive tells only of changes once a read is asked for, so the watch is handed back
        // only then, and a change made right after it starts is heard too.
        let (listening, ready) = mpsc::channel::<()>();
        let thread = thread::spawn(move || {
            let mut listening = Some(listening);
            let [opened, done, quit] = raw.map(|raw| HANDLE(raw as *mut _));
            let mut buffer = vec![0u32; 16 * 1024];
            let filter = FILE_NOTIFY_CHANGE_FILE_NAME
                | FILE_NOTIFY_CHANGE_DIR_NAME
                | FILE_NOTIFY_CHANGE_ATTRIBUTES
                | FILE_NOTIFY_CHANGE_SIZE
                | FILE_NOTIFY_CHANGE_LAST_WRITE
                | FILE_NOTIFY_CHANGE_CREATION;
            loop {
                let mut bytes = 0u32;
                let mut overlapped = OVERLAPPED { hEvent: done, ..Default::default() };
                let _ = unsafe { ResetEvent(done) };
                let asked = unsafe {
                    ReadDirectoryChangesW(opened, buffer.as_mut_ptr().cast(), (buffer.len() * 4) as u32, true, filter, None, Some(&mut overlapped), None)
                };
                if asked.is_err() {
                    break;
                }
                if let Some(listening) = listening.take() {
                    let _ = listening.send(());
                }
                if unsafe { WaitForMultipleObjects(&[done, quit], false, INFINITE) } != WAIT_OBJECT_0 {
                    // Told to stop: the read is called off, and waited for, as it writes into `buffer`.
                    let _ = unsafe { CancelIoEx(opened, Some(&overlapped)) };
                    let _ = unsafe { GetOverlappedResult(opened, &overlapped, &mut bytes, true) };
                    break;
                }
                if unsafe { GetOverlappedResult(opened, &overlapped, &mut bytes, false) }.is_err() {
                    break;
                }
                if bytes == 0 {
                    let _ = heard.send(Heard::Lost(root.clone()));
                    continue;
                }
                let mut at = 0usize;
                loop {
                    let record = unsafe { &*(buffer.as_ptr().cast::<u8>().add(at).cast::<FILE_NOTIFY_INFORMATION>()) };
                    let units = unsafe { std::slice::from_raw_parts(record.FileName.as_ptr(), record.FileNameLength as usize / 2) };
                    let _ = heard.send(Heard::Changed(root.join(String::from_utf16_lossy(units))));
                    if record.NextEntryOffset == 0 {
                        break;
                    }
                    at += record.NextEntryOffset as usize;
                }
            }
            let _ = unsafe { CloseHandle(opened) };
            let _ = unsafe { CloseHandle(done) };
        });
        // A read that can't be asked for ends the thread, which says so at once.
        let _ = ready.recv_timeout(Duration::from_secs(2));
        Some(Self { quit: raw[2], thread: Some(thread) })
    }
}

impl Drop for Watch {
    fn drop(&mut self) {
        let quit = HANDLE(self.quit as *mut _);
        let _ = unsafe { SetEvent(quit) };
        // Quick, as the wait wakes at once: then the drive's handle is closed, and `quit` can go.
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        let _ = unsafe { CloseHandle(quit) };
    }
}

/// Holds the keeper's mutex for as long as this window keeps the list.
struct Keeper(HANDLE);

impl Keeper {
    fn take() -> Option<Self> {
        let name: Vec<u16> = std::ffi::OsStr::new(KEEPER).encode_wide().chain([0]).collect();
        let handle = unsafe { CreateMutexW(None, false, windows::core::PCWSTR(name.as_ptr())) }.ok()?;
        let waited = unsafe { WaitForSingleObject(handle, 0) };
        if waited == WAIT_OBJECT_0 || waited == WAIT_ABANDONED {
            Some(Self(handle))
        } else {
            let _ = unsafe { CloseHandle(handle) };
            None
        }
    }
}

impl Drop for Keeper {
    fn drop(&mut self) {
        let _ = unsafe { ReleaseMutex(self.0) };
        let _ = unsafe { CloseHandle(self.0) };
    }
}

/// Waits to keep the list, then keeps it until the user turns it off.
fn keep() {
    let keeper = loop {
        if !options().on {
            return;
        }
        if let Some(keeper) = Keeper::take() {
            break keeper;
        }
        thread::sleep(TRY_KEEP);
    };
    let _ = unsafe { SetThreadPriority(GetCurrentThread(), THREAD_MODE_BACKGROUND_BEGIN) };
    let Some(path) = path_of() else { return };
    let Ok(db) = Db::open(&path) else { return };
    Keeping::new(db).run();
    drop(keeper);
    if !options().on {
        for end in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{end}", path.display()));
        }
    }
}

struct Keeping {
    db: Db,
    heard: Receiver<Heard>,
    sender: Sender<Heard>,
    watches: HashMap<PathBuf, Watch>,
    /// Drives to walk, each with when, the USB ones again and again.
    due: Vec<(PathBuf, Instant, bool)>,
    changed: BTreeSet<PathBuf>,
    last_change: Instant,
    skip: Vec<String>,
    asked: Option<String>,
    beat: Instant,
    drives_seen: Instant,
    listed: u64,
    said: String,
    /// Paused since the last look for drives, so what was walked before is walked again soon.
    rested: bool,
    /// The journal helper was asked what changed while no Perli ran.
    caught_up: bool,
}

impl Keeping {
    fn new(db: Db) -> Self {
        let (sender, heard) = mpsc::channel();
        let asked = db.meta("ask");
        Self {
            db,
            heard,
            sender,
            watches: HashMap::new(),
            due: Vec::new(),
            changed: BTreeSet::new(),
            last_change: Instant::now(),
            skip: Vec::new(),
            asked,
            beat: Instant::now() - BEAT,
            drives_seen: Instant::now() - DRIVES_AGAIN,
            listed: 0,
            said: String::new(),
            rested: false,
            caught_up: false,
        }
    }

    fn say(&mut self, state: &str) {
        if self.said != state {
            self.db.set_meta("state", state);
            self.said = state.to_string();
        }
    }

    /// The drives it answers for: walked through once, and watched or walked again on a timer.
    fn say_live(&self) {
        let walked: Vec<String> = self
            .db
            .0
            .prepare("SELECT root FROM drives")
            .and_then(|mut rows| rows.query_map([], |row| row.get(0))?.collect())
            .unwrap_or_default();
        let present: Vec<String> = self.due.iter().map(|(root, ..)| low(&root.to_string_lossy())).collect();
        let live: Vec<String> = walked.into_iter().filter(|root| present.contains(root)).collect();
        self.db.set_meta("live", &live.join("|"));
    }

    fn look_for_drives(&mut self, network: bool) {
        let found = drives(network);
        let known: Vec<String> = self.db.0.prepare("SELECT root FROM drives").and_then(|mut rows| rows.query_map([], |row| row.get(0))?.collect()).unwrap_or_default();
        for (root, again) in &found {
            if self.due.iter().any(|(due, ..)| due == root) {
                continue;
            }
            let walked_before = known.contains(&low(&root.to_string_lossy()));
            let when = if walked_before && !self.rested { Instant::now() + LOOK_AGAIN_AFTER } else { Instant::now() };
            self.due.push((root.clone(), when, *again));
            if !again {
                if let Some(watch) = Watch::start(root.clone(), self.sender.clone()) {
                    self.watches.insert(root.clone(), watch);
                }
            }
        }
        self.due.retain(|(root, ..)| found.iter().any(|(present, _)| present == root));
        self.watches.retain(|root, _| found.iter().any(|(present, _)| present == root));
        self.drives_seen = Instant::now();
        self.rested = false;
        self.say_live();
    }

    /// Stops watching and forgets what was due, as a pause does; a resume walks everything again.
    fn rest(&mut self) {
        self.watches.clear();
        self.due.clear();
        self.changed.clear();
        while self.heard.try_recv().is_ok() {}
        self.rested = true;
    }

    fn run(mut self) {
        loop {
            let options = options();
            if !options.on {
                return;
            }
            if self.beat.elapsed() >= BEAT {
                self.db.set_meta("beat", &now_ms().to_string());
                self.beat = Instant::now();
            }
            if options.paused {
                if !self.due.is_empty() || !self.watches.is_empty() {
                    self.rest();
                    self.db.set_meta("live", "");
                }
                self.say("paused");
                thread::sleep(Duration::from_secs(1));
                continue;
            }
            let mut skip: Vec<String> = options.skip.iter().map(|folder| low(folder.trim_end_matches('\\'))).collect();
            if let Some(own) = path_of().and_then(|path| path.parent().map(Path::to_path_buf)) {
                skip.push(low(&own.to_string_lossy()));
            }
            if skip != self.skip {
                // Newly left out goes at once; brought back comes with a walk of its drive.
                for folder in skip.iter().filter(|folder| !self.skip.contains(folder)) {
                    let _ = self.db.forget(Path::new(folder));
                }
                for folder in self.skip.iter().filter(|folder| !skip.contains(folder)) {
                    let root = root_of(Path::new(folder));
                    for due in self.due.iter_mut().filter(|(due, ..)| low(&due.to_string_lossy()) == low(&root.to_string_lossy())) {
                        due.1 = Instant::now();
                    }
                }
                self.skip = skip;
            }
            let asked = self.db.meta("ask");
            if asked != self.asked {
                self.asked = asked;
                let _ = self.db.clear();
                self.say_live();
                for due in &mut self.due {
                    due.1 = Instant::now();
                }
            }
            if self.drives_seen.elapsed() >= DRIVES_AGAIN || self.due.is_empty() {
                self.look_for_drives(options.network);
            }
            if !self.caught_up {
                // Once the drives are known, as what it hears names them.
                self.caught_up = true;
                let sender = self.sender.clone();
                thread::spawn(move || {
                    for found in crate::journal::catch_up().unwrap_or_default() {
                        let _ = sender.send(match found {
                            crate::journal::Found::Changed(path) => Heard::Changed(path),
                            crate::journal::Found::Caught(root) => Heard::Caught(root),
                            crate::journal::Found::Lost(root) => Heard::Lost(root),
                        });
                    }
                });
            }
            match self.heard.recv_timeout(Duration::from_millis(250)) {
                Ok(heard) => self.hear(heard),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
            while let Ok(heard) = self.heard.try_recv() {
                self.hear(heard);
            }
            if !self.changed.is_empty() && self.last_change.elapsed() >= SETTLE {
                let changed = std::mem::take(&mut self.changed);
                let batch = self.db.0.unchecked_transaction();
                for path in &changed {
                    let _ = apply(&self.db, path, &self.skip);
                }
                if let Ok(batch) = batch {
                    let _ = batch.commit();
                }
            }
            if options.battery && on_battery() {
                self.say("battery");
                continue;
            }
            let Some(at) = self.due.iter().position(|(_, when, _)| *when <= Instant::now()) else {
                self.say("ready");
                continue;
            };
            let (root, _, again) = self.due[at].clone();
            self.due[at].1 = if again { Instant::now() + USB_AGAIN } else { Instant::now() + Duration::from_secs(u64::MAX / 4) };
            self.say("walking");
            if self.walk_drive(&root) {
                let _ = self.db.0.execute(
                    "INSERT INTO drives(root, walked) VALUES(?, ?) ON CONFLICT(root) DO UPDATE SET walked = excluded.walked",
                    params![low(&root.to_string_lossy()), now_ms()],
                );
                self.say_live();
            } else if let Some(due) = self.due.iter_mut().find(|(due, ..)| *due == root) {
                // Stopped partway: it goes on from the start when it can.
                due.1 = Instant::now();
            }
        }
    }

    fn hear(&mut self, heard: Heard) {
        match heard {
            Heard::Changed(path) => {
                self.changed.insert(path);
                self.last_change = Instant::now();
            }
            Heard::Lost(root) => {
                for due in self.due.iter_mut().filter(|(due, ..)| *due == root) {
                    due.1 = Instant::now();
                }
            }
            Heard::Caught(root) => {
                // The walk to catch up, still to come, isn't needed. One never made is.
                let root = low(&root.to_string_lossy());
                let walked: Vec<String> = self.db.0.prepare("SELECT root FROM drives").and_then(|mut rows| rows.query_map([], |row| row.get(0))?.collect()).unwrap_or_default();
                for due in self.due.iter_mut().filter(|(due, _, again)| !again && low(&due.to_string_lossy()) == root && walked.contains(&root)) {
                    due.1 = Instant::now() + Duration::from_secs(u64::MAX / 4);
                }
            }
        }
    }

    /// Walks a drive, stopping when the user turns the list off, pauses it, changes what is left
    /// out, or unplugs the power. Its own folder is never listed, since writing the list changes it.
    fn walk_drive(&mut self, root: &Path) -> bool {
        let skip = self.skip.clone();
        let start = options();
        struct Steering<'a> {
            start: &'a Options,
            db: &'a Db,
            listed: &'a mut u64,
            beat: Instant,
        }
        impl Steer for Steering<'_> {
            fn stop(&mut self) -> bool {
                let now = options();
                if self.beat.elapsed() >= BEAT {
                    self.db.set_meta("beat", &now_ms().to_string());
                    self.beat = Instant::now();
                }
                !now.on || now.paused || now.skip != self.start.skip || (now.battery && on_battery())
            }
            fn walked(&mut self, entries: usize) {
                *self.listed += entries as u64;
                self.db.set_meta("listed", &self.listed.to_string());
            }
        }
        self.listed = 0;
        let mut steering = Steering { start: &start, db: &self.db, listed: &mut self.listed, beat: Instant::now() };
        walk(&self.db, root, &skip, &mut steering).unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    struct Tree(PathBuf);

    impl Tree {
        fn new(name: &str) -> Self {
            let root = std::env::temp_dir().join(format!("perli-index-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&root);
            fs::create_dir_all(&root).unwrap();
            Self(root)
        }

        fn file(&self, relative: &str) -> PathBuf {
            let path = self.0.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, "x").unwrap();
            path
        }

        fn db(&self) -> Db {
            Db::open(&self.0.with_extension("db")).unwrap()
        }
    }

    impl Drop for Tree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
            for end in ["db", "db-wal", "db-shm"] {
                let _ = fs::remove_file(self.0.with_extension(end));
            }
        }
    }

    #[test]
    fn a_watch_hears_a_change_and_stops_at_once_between_changes() {
        let tree = Tree::new("watch");
        let (sender, heard) = mpsc::channel();
        let watch = Watch::start(tree.0.clone(), sender).unwrap();
        let made = tree.file("new.txt");
        let first = heard.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(matches!(first, Heard::Changed(path) if path == made));
        let asked = Instant::now();
        drop(watch);
        assert!(asked.elapsed() < Duration::from_secs(2), "a watch told to stop ends with no change on its drive");
    }

    const ALL: Sight = Sight { hidden: true, system: true };
    const PLAIN: Sight = Sight { hidden: false, system: false };

    fn names(rows: &[(PathBuf, WIN32_FIND_DATAW)]) -> Vec<String> {
        rows.iter().map(|(_, data)| name_of(data)).collect()
    }

    fn hide(path: &Path) {
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
        unsafe {
            windows::Win32::Storage::FileSystem::SetFileAttributesW(
                windows::core::PCWSTR(wide.as_ptr()),
                windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_HIDDEN,
            )
        }
        .unwrap();
    }

    #[test]
    fn a_walk_lists_everything_and_a_page_finds_names_nearest_first() {
        let tree = Tree::new("walk");
        tree.file(r"deep\inner\Report final.txt");
        tree.file(r"report.txt");
        tree.file(r"deep\report.md");
        tree.file(r"deep\plain.txt");
        let db = tree.db();
        assert!(walk(&db, &tree.0, &[], &mut || false).unwrap());

        let inside = [Part::inside(&tree.0)];
        // The folder's own entries are read by the search itself.
        assert_eq!(names(&page_in(&db, &inside, "REPORT", usize::MAX, ALL, 0, 100).unwrap()), ["report.md", "Report final.txt"]);
        assert_eq!(names(&page_in(&db, &inside, "report", usize::MAX, ALL, 1, 100).unwrap()), ["Report final.txt"], "a page starts where asked");
        assert_eq!(names(&page_in(&db, &inside, "report", usize::MAX, ALL, 0, 1).unwrap()), ["report.md"], "and takes no more than asked");
        let deepest = depth_of(&tree.0.join("deep")) as usize;
        assert_eq!(names(&page_in(&db, &inside, "report", deepest, ALL, 0, 100).unwrap()), ["report.md"], "no deeper than asked");
        let (folder, data) = &page_in(&db, &inside, "final", usize::MAX, ALL, 0, 1).unwrap()[0];
        assert_eq!(folder, &tree.0.join(r"deep\inner"));
        assert_eq!((data.nFileSizeLow, data.dwFileAttributes & ATTRIBUTE_DIRECTORY), (1, 0));
    }

    #[test]
    fn hidden_folders_count_only_below_where_the_search_starts() {
        let tree = Tree::new("hidden");
        tree.file(r"secret\inner\note.txt");
        hide(&tree.0.join("secret"));
        let db = tree.db();
        walk(&db, &tree.0, &[], &mut || false).unwrap();

        assert!(page_in(&db, &[Part::inside(&tree.0)], "note", usize::MAX, PLAIN, 0, 9).unwrap().is_empty(), "inside a hidden folder");
        assert_eq!(names(&page_in(&db, &[Part::inside(&tree.0)], "note", usize::MAX, ALL, 0, 9).unwrap()), ["note.txt"], "unless hidden ones show");
        let from_inside = [Part::inside(&tree.0.join("secret"))];
        assert_eq!(names(&page_in(&db, &from_inside, "note", usize::MAX, PLAIN, 0, 9).unwrap()), ["note.txt"], "a search inside it finds what it holds");
    }

    #[test]
    fn changes_bring_the_list_up_to_date_and_a_new_walk_drops_what_went() {
        let tree = Tree::new("changes");
        tree.file(r"a\one.txt");
        let db = tree.db();
        walk(&db, &tree.0, &[], &mut || false).unwrap();
        let inside = [Part::inside(&tree.0)];
        let found = |text: &str| names(&page_in(&db, &inside, text, usize::MAX, ALL, 0, 99).unwrap());

        let added = tree.file(r"a\b\two.txt");
        apply(&db, &added, &[]).unwrap();
        assert_eq!(found("two"), ["two.txt"], "a file in a folder made after the walk");
        fs::rename(tree.0.join("a"), tree.0.join("moved")).unwrap();
        apply(&db, &tree.0.join("a"), &[]).unwrap();
        apply(&db, &tree.0.join("moved"), &[]).unwrap();
        let (folder, _) = &page_in(&db, &inside, "two", usize::MAX, ALL, 0, 1).unwrap()[0];
        assert_eq!(folder, &tree.0.join(r"moved\b"), "a renamed folder takes all it holds along");
        assert_eq!(found("one"), ["one.txt"]);

        fs::remove_file(tree.0.join(r"moved\one.txt")).unwrap();
        tree.file(r"moved/three.txt");
        walk(&db, &tree.0, &[], &mut || false).unwrap();
        assert!(found("one").is_empty(), "a walk drops what it no longer sees");
        assert_eq!(found("e.t"), ["three.txt"]);
    }

    #[test]
    fn left_out_folders_and_stopped_walks() {
        let tree = Tree::new("skip");
        tree.file(r"keep\a.txt");
        tree.file(r"out\b.txt");
        let db = tree.db();
        let skip = [low(&tree.0.join("out").to_string_lossy())];
        walk(&db, &tree.0, &skip, &mut || false).unwrap();
        let inside = [Part::inside(&tree.0)];
        assert_eq!(names(&page_in(&db, &inside, ".txt", usize::MAX, ALL, 0, 9).unwrap()), ["a.txt"]);
        apply(&db, &tree.file(r"out\c.txt"), &skip).unwrap();
        assert_eq!(names(&page_in(&db, &inside, ".txt", usize::MAX, ALL, 0, 9).unwrap()), ["a.txt"], "a change there is left out too");

        let other = Tree::new("stopped");
        other.file(r"x\y.txt");
        let db = other.db();
        assert!(!walk(&db, &other.0, &[], &mut || true).unwrap(), "a walk told to stop says so");
    }

    #[test]
    fn parts_take_over_from_the_walk_only_where_the_list_answers() {
        let mut below = VecDeque::from([PathBuf::from(r"C:\Users\a\Docs"), PathBuf::from(r"D:\")]);
        assert!(parts_for(Path::new(r"C:\Users\a"), &mut below).is_empty(), "with the list off");
        assert_eq!(below.len(), 2);
        let part = Part::inside(Path::new(r"C:\Users\A"));
        assert_eq!((part.start.as_str(), part.end.as_str(), part.not.as_str()), (r"c:\users\a\", r"c:\users\a]", r"c:\users\a"));
        let drive = Part::drive(Path::new(r"D:\"));
        assert_eq!((drive.start.as_str(), drive.end.as_str(), drive.not.as_str()), (r"d:\", "d:]", ""));
    }

    #[test]
    fn a_found_row_reads_back_as_windows_gave_it() {
        let data = find_data("name.txt", 0x20, (5 << 32) | 7, 0x0102_0304_0506_0708, 9);
        assert_eq!(name_of(&data), "name.txt");
        assert_eq!((data.nFileSizeHigh, data.nFileSizeLow, stamp(data.ftLastWriteTime), stamp(data.ftCreationTime)), (5, 7, 0x0102_0304_0506_0708, 9));
        assert_eq!(chain((0, 0), ATTRIBUTE_HIDDEN, 4), (4, 0));
        assert_eq!(chain((2, 0), ATTRIBUTE_HIDDEN | ATTRIBUTE_SYSTEM, 5), (5, 5));
        assert_eq!(chain((2, 3), 0, 6), (2, 3));
    }
}
