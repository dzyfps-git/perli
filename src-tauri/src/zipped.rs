//! An archive opened as a folder, the way Explorer opens one: a ZIP, or any kind `packs` reads.
//! Its rows have paths such as `C:\dir\pack.zip\docs\a.txt`, which back, forward and up treat
//! like any other folder's. Nothing inside ever changes. What needs a real file gets one taken
//! out to a cache.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::fs;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::packs::{self, Item, Listed};
use crate::{inside, ops};

pub const READ_ONLY: &str = "This archive opens read-only. Extract it to change what's inside.";
pub const NEEDS_PASSWORD: &str = packs::NEEDS_PASSWORD;
const GONE: &str = "That isn't in the archive anymore";
const NO_FOLDER: &str = "This archive has no folder by that name";
const UNSAFE: &str = "This name in the archive isn't safe to use";
/// A solid archive is taken out whole once if it unpacks to this at most.
const MOST_WHOLE: u64 = 4 << 30;

const CACHE_FOLDER: &str = "perli-zip";
/// What was taken out stays this long, as the app it opened in may still be using it.
const CACHE_KEEP: Duration = Duration::from_secs(24 * 60 * 60);
/// How often a run that lasts days looks for what has outstayed `CACHE_KEEP`.
const SWEEP_EVERY: Duration = Duration::from_secs(60 * 60);

/// Passwords the user gave this session, by archive in lowercase. Never saved.
static PASSWORDS: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(Mutex::default);

fn is_zip(name: &OsStr) -> bool {
    Path::new(name).extension().is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
}

/// Whether a file of this name opens as a folder. A comic opens to be read instead.
fn is_archive(name: &OsStr) -> bool {
    let comic = Path::new(name).extension().is_some_and(|extension| extension.eq_ignore_ascii_case("cbr") || extension.eq_ignore_ascii_case("cb7"));
    is_zip(name) || packs::kind_of(name).is_some() && !comic
}

/// Whether `packs` reads this archive, rather than the ZIP code here.
fn is_pack(archive: &Path) -> bool {
    packs::kind_of(archive.as_os_str()).is_some()
}

/// The archive and the path inside it, with `/` between parts and `""` for its top. `None`
/// outside an archive. A path that goes into an archive inside it gets that one, taken out to
/// the cache. A row that is such an archive stays a row of the one it is in, so copying it
/// copies the file.
pub fn split(path: &Path) -> Option<(PathBuf, String)> {
    resolve(path, false).map(|opened| (opened.archive, opened.inner))
}

/// An archive path opened as a folder: like `split`, and an archive inside one opens too.
pub struct Opened {
    /// The archive to read, a file in the cache for one inside another.
    pub archive: PathBuf,
    pub inner: String,
    /// The shown path of each archive on the way, the outermost first, a real file.
    pub levels: Vec<PathBuf>,
    /// Why an archive on the way couldn't come out.
    pub failed: Option<String>,
}

pub fn opened(path: &Path) -> Option<Opened> {
    resolve(path, true)
}

/// Goes into each archive inside an archive that `path` goes into, and with `last` into one it
/// ends on too. A folder with an archive's name stays a folder.
fn resolve(path: &Path, last: bool) -> Option<Opened> {
    let (mut archive, inner) = first_split(path)?;
    let parts: Vec<&str> = inner.split('/').filter(|part| !part.is_empty()).collect();
    let (mut levels, mut start, mut failed) = (vec![archive.clone()], 0, None);
    for (index, name) in parts.iter().enumerate() {
        if !is_archive(OsStr::new(name)) || index + 1 == parts.len() && !last {
            continue;
        }
        match nested(&archive, &parts[start..index], name) {
            Ok(Some(cached)) => archive = cached,
            Ok(None) => continue,
            Err(error) => {
                failed = Some(error);
                break;
            }
        }
        levels.push(parts[..=index].iter().fold(levels[0].clone(), |path, part| path.join(part)));
        start = index + 1;
    }
    Some(Opened { archive, inner: parts[start..].join("/"), levels, failed })
}

/// The archive `name` in `parent` of `archive` as a file in the cache. `None` for a folder.
fn nested(archive: &Path, parent: &[&str], name: &str) -> Result<Option<PathBuf>, String> {
    let parent = parent.join("/");
    let inner = if parent.is_empty() { name.to_string() } else { format!("{parent}/{name}") };
    // One already taken out costs no read of the archive.
    let done = slot(archive, &inner, password(archive).as_deref()).0.join(name);
    if done.is_file() {
        return Ok(Some(done));
    }
    let (nodes, _) = list(archive, &parent, false)?;
    let wanted = name.to_lowercase();
    if !nodes.iter().any(|node| !node.folder && node.name.to_lowercase() == wanted) {
        return Ok(None);
    }
    real_in(archive, &inner).map(Some)
}

/// The archive a folder shown inside archives stands for, as in its menu: the innermost one it is
/// in, taken out of any it sits in. `None` outside an archive.
pub fn innermost(path: &Path) -> Option<Result<PathBuf, String>> {
    let shown = opened(path)?.levels.pop()?;
    Some(real(&shown))
}

/// The outermost archive a path is in, a real file.
pub fn outer(path: &Path) -> Option<PathBuf> {
    first_split(path).map(|(archive, _)| archive)
}

/// `split` with no archive inside an archive gone into. Only a name an archive has costs a look
/// at the disk.
fn first_split(path: &Path) -> Option<(PathBuf, String)> {
    let mut archive = PathBuf::new();
    let mut parts = path.components();
    while let Some(part) = parts.next() {
        archive.push(part);
        if matches!(part, Component::Normal(name) if is_archive(name)) && archive.is_file() {
            let inner: Vec<_> = parts.map(|part| part.as_os_str().to_string_lossy().into_owned()).collect();
            return Some((archive, inner.join("/")));
        }
    }
    None
}

/// Below an archive's top, as its rows are. The archive file itself is not.
pub fn is_inside(path: &Path) -> bool {
    split(path).is_some_and(|(_, inner)| !inner.is_empty())
}

fn key(archive: &Path) -> String {
    archive.to_string_lossy().to_lowercase()
}

pub fn password(archive: &Path) -> Option<String> {
    PASSWORDS.lock().unwrap_or_else(PoisonError::into_inner).get(&key(archive)).cloned()
}

/// Checks `password` on the archive's smallest locked file, then keeps it for the session.
pub fn unlock(archive: &Path, password: &str) -> Result<(), String> {
    if is_pack(archive) {
        packs::check_password(archive, password)?;
    } else {
        let zip = inside::open(archive)?;
        let smallest = (0..zip.len())
            .filter_map(|index| {
                let entry = zip.by_index_data(index).ok()?;
                let name = entry.name().ok()?.into_owned();
                (entry.encrypted() && !entry.is_dir()).then_some((entry.size(), name))
            })
            .min();
        if let Some((_, name)) = smallest {
            inside::check_password(archive, &name, password)?;
        }
    }
    PASSWORDS.lock().unwrap_or_else(PoisonError::into_inner).insert(key(archive), password.to_string());
    Ok(())
}

/// The lowercase parts of a path inside an archive.
fn parts_of(inner: &str) -> Vec<String> {
    inner.split(['/', '\\']).filter(|part| !part.is_empty()).map(str::to_lowercase).collect()
}

/// The parts of an entry's `name` below `inner`, or `None` if it is neither `inner` nor inside
/// it. Names match in any case, as Windows paths do.
fn below<'a>(name: &'a str, inner: &[String]) -> Option<Vec<&'a str>> {
    let mut parts = name.split(['/', '\\']).filter(|part| !part.is_empty());
    for wanted in inner {
        if parts.next()?.to_lowercase() != *wanted {
            return None;
        }
    }
    Some(parts.collect())
}

/// One row of an archive's folder. A folder adds up what is inside it.
#[derive(Debug, PartialEq)]
pub struct Node {
    /// Its folder under the one asked for, with `/` between parts. Empty right inside it.
    pub parent: String,
    pub name: String,
    pub size: u64,
    pub packed: u64,
    /// FILETIME ticks, the newest inside for a folder.
    pub modified: u64,
    pub folder: bool,
}

/// What an archive holds, read with the password given this session.
fn listed(archive: &Path) -> Result<Arc<Listed>, String> {
    if is_pack(archive) {
        return packs::list(archive, password(archive).as_deref());
    }
    let zip = inside::open(archive)?;
    let mut items = Vec::with_capacity(zip.len());
    for index in 0..zip.len() {
        let entry = zip.by_index_data(index).map_err(|error| error.to_string())?;
        let name = entry.name().map_err(|error| error.to_string())?;
        items.push(Item {
            name: name.trim_end_matches('/').to_string(),
            size: entry.size(),
            packed: entry.compressed_size(),
            ticks: entry.last_modified().map_or(0, ops::zip_ticks),
            folder: entry.is_dir(),
            locked: entry.encrypted(),
        });
    }
    Ok(Arc::new(Listed { items, solid: false, hidden: false }))
}

/// What is inside `inner`, all the way down with `deep` or else only right in it, and whether
/// anything in the archive is locked. Folders the archive names only in the paths of what is
/// deeper are rows too, and Mac archives' hidden `__MACOSX` copies are left out. An archive
/// whose very names are locked shows nothing until its password is given.
pub fn list(archive: &Path, inner: &str, deep: bool) -> Result<(Vec<Node>, bool), String> {
    let listed = listed(archive)?;
    if listed.hidden {
        return Ok((Vec::new(), true));
    }
    let inner = parts_of(inner);
    let (mut nodes, mut at) = (Vec::<Node>::new(), HashMap::<String, usize>::new());
    let mut found = inner.is_empty();
    for item in &listed.items {
        if item.name.starts_with("__MACOSX/") {
            continue;
        }
        let Some(rest) = below(&item.name, &inner) else { continue };
        found = true;
        let levels = if deep { rest.len() } else { rest.len().min(1) };
        for level in 1..=levels {
            let folder = level < rest.len() || item.folder;
            let place = *at.entry(rest[..level].join("/")).or_insert_with(|| {
                let (parent, name) = (rest[..level - 1].join("/"), rest[level - 1].to_string());
                nodes.push(Node { parent, name, size: 0, packed: 0, modified: 0, folder });
                nodes.len() - 1
            });
            let node = &mut nodes[place];
            if !item.folder {
                node.size += item.size;
                node.packed += item.packed;
            }
            node.modified = node.modified.max(item.ticks);
        }
    }
    if !found {
        return Err(NO_FOLDER.into());
    }
    Ok((nodes, listed.locked()))
}

/// A picture inside an archive, `edge` pixels on its longest side at most. Empty for anything
/// else, so the list shows its icon.
pub fn picture(archive: &Path, inner: &str, edge: u32) -> Vec<u8> {
    let Some(name) = inside::is_picture(inner).then(|| entry_name(archive, inner)).flatten() else {
        return Vec::new();
    };
    inside::picture(archive, &name, edge, password(archive).as_deref()).unwrap_or_default()
}

/// The archive's own name for the file at `inner`.
fn entry_name(archive: &Path, inner: &str) -> Option<String> {
    let inner = parts_of(inner);
    let fits = |item: &&Item| !item.folder && below(&item.name, &inner).is_some_and(|rest| rest.is_empty());
    listed(archive).ok()?.items.iter().find(fits).map(|item| item.name.clone())
}

/// The cache folder for `inner` of this version of the archive, and a fresh folder to write it
/// in before it moves there. What a password opened gets a folder of its own for that password.
fn slot(archive: &Path, inner: &str, password: Option<&str>) -> (PathBuf, PathBuf) {
    let root = cache_root();
    let version = fs::metadata(archive).ok().map(|metadata| (metadata.len(), metadata.modified().ok()));
    let mut hasher = DefaultHasher::new();
    // The mark of the web is part of the version, so a copy taken out unmarked is never reused.
    (key(archive), version, inner.to_lowercase(), ops::sys::read_zone(archive)).hash(&mut hasher);
    // Salted for this run alone, so a folder's name is no quick way to try passwords.
    password.map(|password| (password, *RUN_SALT)).hash(&mut hasher);
    let hash = hasher.finish();
    (root.join(format!("{hash:016x}")), root.join(format!("{hash:016x}-{}.part", crate::since_1970().as_nanos())))
}

/// Has `write` fill `part`, then moves it to `slot`. Fine too if another look made `done` first.
fn settle(part: &Path, slot: &Path, done: &Path, write: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
    fs::create_dir_all(part).map_err(|error| error.to_string())?;
    let written = write().and_then(|()| fs::rename(part, slot).map_err(|error| error.to_string()));
    if written.is_err() {
        let _ = fs::remove_dir_all(part);
    }
    match written {
        Err(_) if done.exists() => Ok(()),
        other => other,
    }
}

static RUN_SALT: LazyLock<u128> = LazyLock::new(|| crate::since_1970().as_nanos() ^ u128::from(std::process::id()));

/// One whole take-out of each archive at a time, so the thumbnails of a folder wait for one rather
/// than each start their own. Two archives come out side by side.
static WHOLE: LazyLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = LazyLock::new(Mutex::default);

fn whole_lock(archive: &Path) -> Arc<Mutex<()>> {
    WHOLE.lock().unwrap_or_else(PoisonError::into_inner).entry(key(archive)).or_default().clone()
}

/// Where all of a solid archive is taken out, once for each version of it. Reading a file of one
/// unpacks all before it, so the pictures of a folder read one by one would unpack it again for
/// each. A locked one comes out once its password is given. `None` for an archive that reads each
/// file as fast on its own, one still locked, and one too big.
pub fn whole(archive: &Path) -> Option<PathBuf> {
    if !is_pack(archive) {
        return None;
    }
    let password = password(archive);
    let listed = packs::list(archive, password.as_deref()).ok()?;
    let size: u64 = listed.items.iter().map(|item| item.size).sum();
    let locked = listed.locked();
    if !listed.solid || listed.hidden || locked && password.is_none() || size > MOST_WHOLE {
        return None;
    }
    let password = password.filter(|_| locked);
    let (slot, part) = slot(archive, "", password.as_deref());
    let one = whole_lock(archive);
    let _one = one.lock().unwrap_or_else(PoisonError::into_inner);
    if !slot.exists() {
        settle(&part, &slot, &slot, || take_out_pack(archive, "", &part, password.as_deref())).ok()?;
    }
    Some(slot)
}

/// A file or folder of an archive as a real one on disk, taken out to a cache once for each
/// version of the archive. Paths outside an archive come back as they are, and so does its top.
pub fn real(path: &Path) -> Result<PathBuf, String> {
    match split(path) {
        Some((archive, inner)) => real_in(&archive, &inner),
        None => Ok(path.to_path_buf()),
    }
}

/// `real` for `inner` of `archive`.
fn real_in(archive: &Path, inner: &str) -> Result<PathBuf, String> {
    let Some(name) = inner.rsplit('/').next().filter(|name| !name.is_empty()) else {
        return Ok(archive.to_path_buf());
    };
    let relative = ops::safe_relative(inner.split('/').collect());
    // A move may have taken it away from there.
    if let Some(found) = whole(archive).zip(relative).map(|(whole, relative)| whole.join(relative)).filter(|found| found.exists()) {
        return Ok(found);
    }
    let (slot, part) = slot(archive, inner, password(archive).as_deref());
    let target = slot.join(name);
    if target.exists() {
        return Ok(target);
    }
    // A move took what was here away.
    let _ = fs::remove_dir_all(&slot);
    settle(&part, &slot, &target, || take_out(archive, inner, &part.join(name)))?;
    Ok(target)
}

pub fn real_all(paths: &[PathBuf]) -> Result<Vec<PathBuf>, String> {
    paths.iter().map(|path| real(path)).collect()
}

/// Writes `inner`, a file or a folder with all it holds, to `target`.
fn take_out(archive: &Path, inner: &str, target: &Path) -> Result<(), String> {
    if is_pack(archive) {
        return take_out_pack(archive, inner, target, password(archive).as_deref());
    }
    let mut zip = inside::open(archive)?;
    let password = password(archive);
    let zone = ops::sys::read_zone(archive);
    let wanted = parts_of(inner);
    let mut found = false;
    for index in 0..zip.len() {
        let (name, is_dir, locked, ticks) = {
            let entry = zip.by_index_data(index).map_err(|error| error.to_string())?;
            let name = entry.name().map_err(|error| error.to_string())?.into_owned();
            (name, entry.is_dir(), entry.encrypted(), entry.last_modified().map_or(0, ops::zip_ticks))
        };
        let Some(rest) = below(&name, &wanted) else { continue };
        found = true;
        let Some(path) = landing(target, &rest) else { continue };
        if is_dir {
            fs::create_dir_all(&path).map_err(|error| error.to_string())?;
            continue;
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let key = password.as_deref().filter(|_| locked);
        if locked && key.is_none() {
            return Err(NEEDS_PASSWORD.into());
        }
        let mut entry = inside::data(&mut zip, index, key).map_err(inside::reason)?;
        let mut file = fs::File::create(&path).map_err(|error| error.to_string())?;
        std::io::copy(&mut entry, &mut file).map_err(|error| inside::read_failed(error, archive, &name, key))?;
        finish(file, &path, ticks, zone.as_deref());
    }
    if !found {
        return Err(GONE.into());
    }
    if target.exists() { Ok(()) } else { Err(UNSAFE.into()) }
}

/// `take_out` for the kinds `packs` reads, in one walk.
fn take_out_pack(archive: &Path, inner: &str, target: &Path, password: Option<&str>) -> Result<(), String> {
    let listed = packs::list(archive, password)?;
    if listed.hidden {
        return Err(NEEDS_PASSWORD.into());
    }
    let zone = ops::sys::read_zone(archive);
    let wanted = parts_of(inner);
    let mut found = false;
    for item in &listed.items {
        let Some(rest) = below(&item.name, &wanted) else { continue };
        found = true;
        if item.locked && !item.folder && password.is_none() {
            return Err(NEEDS_PASSWORD.into());
        }
        if let Some(path) = landing(target, &rest).filter(|_| item.folder) {
            fs::create_dir_all(path).map_err(|error| error.to_string())?;
        }
    }
    if !found {
        return Err(GONE.into());
    }
    let wants = |item: &Item| !item.folder && below(&item.name, &wanted).is_some();
    packs::walk(archive, password, wants, |item, body| {
        let Some(path) = below(&item.name, &wanted).and_then(|rest| landing(target, &rest)) else { return Ok(true) };
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut file = fs::File::create(&path).map_err(|error| error.to_string())?;
        body.pour(&mut file).map_err(|error| packs::read_error(error, item, password))?;
        finish(file, &path, item.ticks, zone.as_deref());
        Ok::<_, String>(true)
    })?;
    if target.exists() { Ok(()) } else { Err(UNSAFE.into()) }
}

/// Where an entry whose parts below the one taken out are `rest` lands in `target`. `None` for a
/// name that could reach outside it, which stays in the archive.
fn landing(target: &Path, rest: &[&str]) -> Option<PathBuf> {
    let relative = ops::safe_relative(rest.iter().collect())?;
    // An empty join would end the path in a backslash, which names no file.
    Some(if rest.is_empty() { target.to_path_buf() } else { target.join(relative) })
}

/// Gives a file just taken out its time in the archive and the archive's mark of the web.
fn finish(file: fs::File, path: &Path, ticks: u64, zone: Option<&[u8]>) {
    // Writing the mark changes the file's time, so the mark goes first.
    if let Some(zone) = zone {
        mark(path, zone);
    }
    if let Some(time) = time_of(ticks) {
        let _ = file.set_modified(time);
    }
}

/// Gives `path` the archive's mark of where it came from, so Windows warns about a downloaded
/// file taken out of a downloaded ZIP as it would about the ZIP. The cache sits outside any
/// test's folder, so this writes the stream itself rather than through `ops::sys`.
fn mark(path: &Path, zone: &[u8]) {
    let mut stream = path.as_os_str().to_owned();
    stream.push(":Zone.Identifier");
    let _ = fs::write(PathBuf::from(stream), zone);
}

/// FILETIME ticks as a time. None before 1970, which no ZIP can hold.
fn time_of(ticks: u64) -> Option<SystemTime> {
    const UNIX_START: u64 = 116_444_736_000_000_000;
    Some(UNIX_EPOCH + Duration::from_nanos(ticks.checked_sub(UNIX_START)?.checked_mul(100)?))
}

pub(crate) fn cache_root() -> PathBuf {
    static SWEPT: Mutex<Option<Instant>> = Mutex::new(None);
    let root = std::env::temp_dir().join(CACHE_FOLDER);
    let mut swept = SWEPT.lock().unwrap_or_else(PoisonError::into_inner);
    if swept.is_none_or(|at| at.elapsed() > SWEEP_EVERY) {
        *swept = Some(Instant::now());
        sweep(&root, CACHE_KEEP);
    }
    root
}

/// What everything taken out of archives takes up, in bytes.
pub fn cache_size() -> u64 {
    tree_size(&std::env::temp_dir().join(CACHE_FOLDER))
}

fn tree_size(path: &Path) -> u64 {
    let size = |entry: fs::DirEntry| match entry.file_type() {
        Ok(kind) if kind.is_dir() => tree_size(&entry.path()),
        _ => entry.metadata().map_or(0, |metadata| metadata.len()),
    };
    fs::read_dir(path).into_iter().flatten().flatten().map(size).sum()
}

/// Removes all that was taken out of archives. What an app still has open stays, and its bytes
/// come back.
pub fn clear_cache() -> u64 {
    sweep(&std::env::temp_dir().join(CACHE_FOLDER), Duration::ZERO);
    cache_size()
}

/// Removes what was taken out longer than `keep` ago.
fn sweep(root: &Path, keep: Duration) {
    for entry in fs::read_dir(root).into_iter().flatten().flatten() {
        let age = entry.metadata().and_then(|metadata| metadata.modified()).ok().and_then(|made| made.elapsed().ok());
        if age.is_none_or(|age| age > keep) {
            // One still open in another app goes on a later sweep.
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    use super::*;

    struct Fixture(PathBuf);

    impl Fixture {
        fn new(name: &str, entries: &[(&str, &str)]) -> Self {
            let folder = std::env::temp_dir().join(format!("perli-zipped-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&folder);
            fs::create_dir_all(&folder).unwrap();
            let mut zip = ZipWriter::new(fs::File::create(folder.join("pack.zip")).unwrap());
            for (name, text) in entries {
                if name.ends_with('/') {
                    zip.add_directory(*name, SimpleFileOptions::default()).unwrap();
                } else {
                    zip.start_file(*name, SimpleFileOptions::default()).unwrap();
                    zip.write_all(text.as_bytes()).unwrap();
                }
            }
            zip.finish().unwrap();
            Self(folder)
        }

        fn archive(&self) -> PathBuf {
            self.0.join("pack.zip")
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    const ENTRIES: [(&str, &str); 5] = [
        ("top.txt", "top"),
        ("docs/a.txt", "alpha"),
        ("docs/deeper/b.txt", "beta!"),
        ("empty/", ""),
        ("__MACOSX/docs/._a.txt", "mac"),
    ];

    #[test]
    fn split_finds_the_archive_and_the_path_inside_it() {
        let fixture = Fixture::new("split", &ENTRIES);
        let inside = fixture.archive().join("docs").join("deeper");

        assert_eq!(split(&inside), Some((fixture.archive(), "docs/deeper".into())));
        assert_eq!(split(&fixture.archive()), Some((fixture.archive(), String::new())));
        // A folder whose name ends in .zip is a plain folder.
        fs::create_dir_all(fixture.0.join("plain.zip")).unwrap();
        assert_eq!(split(&fixture.0.join("plain.zip").join("x")), None);
        assert_eq!(split(&fixture.0), None);
    }

    fn zip_of(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut zip = ZipWriter::new(std::io::Cursor::new(Vec::new()));
        for (name, bytes) in entries {
            zip.start_file(*name, SimpleFileOptions::default()).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }

    #[test]
    fn an_archive_inside_an_archive_opens_as_a_folder_and_stays_a_file_as_a_row() {
        let fixture = Fixture::new("nested", &[]);
        let outer = fixture.0.join("outer.zip");
        let inner = zip_of(&[("docs/a.txt", b"alpha")]);
        fs::write(&outer, zip_of(&[("in/b.zip", &inner), ("x.zip/y.txt", b"why")])).unwrap();
        let nested = outer.join("in").join("b.zip");

        let (cached, inside) = split(&nested.join("docs")).unwrap();
        assert_eq!(inside, "docs");
        assert!(cached.is_file() && cached != outer);
        assert_eq!(list(&cached, "", false).unwrap().0[0].name, "docs");
        // The row itself is the outer archive's, so copying it copies the file.
        assert_eq!(split(&nested), Some((outer.clone(), "in/b.zip".into())));
        assert!(is_inside(&nested) && is_inside(&nested.join("docs")));
        let top = opened(&nested).unwrap();
        assert_eq!((&top.archive, top.inner.as_str()), (&cached, ""));
        assert_eq!(top.levels, [outer.clone(), nested.clone()]);
        assert_eq!(fs::read_to_string(real(&nested.join("docs").join("a.txt")).unwrap()).unwrap(), "alpha");
        // A folder with an archive's name stays a folder.
        assert_eq!(split(&outer.join("x.zip").join("y.txt")), Some((outer.clone(), "x.zip/y.txt".into())));
        assert_eq!(opened(&outer.join("X.ZIP")).unwrap().levels.len(), 1);
        assert_eq!(innermost(&nested.join("docs")).unwrap().unwrap(), cached, "the folder's menu is the inner archive's");
        assert_eq!(innermost(&outer.join("x.zip")).unwrap().unwrap(), outer, "a folder named like an archive isn't one");

        let listing = crate::folder::Listing::read(&nested.to_string_lossy(), crate::folder::Order::default()).unwrap();
        assert_eq!(listing.names(&[0]), ["docs"]);
        assert_eq!(listing.zipped().unwrap().levels, [outer.clone(), nested.clone()]);
        let _ = fs::remove_dir_all(real(&nested.join("docs").join("a.txt")).unwrap().parent().unwrap());
        let _ = fs::remove_dir_all(cached.parent().unwrap());
    }

    #[test]
    fn list_shows_what_is_right_inside_with_folders_named_only_by_deeper_paths() {
        let fixture = Fixture::new("list", &ENTRIES);

        let (top, locked) = list(&fixture.archive(), "", false).unwrap();
        let mut names: Vec<_> = top.iter().map(|node| (node.name.as_str(), node.folder)).collect();
        names.sort();
        assert_eq!(names, [("docs", true), ("empty", true), ("top.txt", false)]);
        assert!(!locked);
        // A folder adds up all it holds.
        let docs = top.iter().find(|node| node.name == "docs").unwrap();
        assert_eq!(docs.size, 10);

        let (inside, _) = list(&fixture.archive(), "DOCS", false).unwrap();
        let mut names: Vec<_> = inside.iter().map(|node| node.name.as_str()).collect();
        names.sort();
        assert_eq!(names, ["a.txt", "deeper"]);

        let (deep, _) = list(&fixture.archive(), "docs", true).unwrap();
        let b = deep.iter().find(|node| node.name == "b.txt").unwrap();
        assert_eq!(b.parent, "deeper");

        assert_eq!(list(&fixture.archive(), "nowhere", false), Err(NO_FOLDER.into()));
    }

    #[test]
    fn a_zip_path_reads_as_a_folder_with_packed_sizes() {
        let fixture = Fixture::new("listing", &ENTRIES);
        let path = fixture.archive().join("docs");

        let listing = crate::folder::Listing::read(&path.to_string_lossy(), crate::folder::Order::default()).unwrap();

        let mut names = listing.names(&[0, 1]);
        names.sort();
        assert_eq!(names, ["a.txt", "deeper"]);
        assert_eq!(listing.zipped().unwrap().archive, fixture.archive());
        assert!(listing.packed(&[0, 1]).iter().all(|packed| packed.is_some_and(|bytes| bytes > 0)));
        assert!(listing.paths(&[0]).iter().all(|row| is_inside(row) && row.starts_with(&path)));
    }

    #[test]
    fn real_takes_files_and_folders_out_once_and_leaves_other_paths_alone() {
        let fixture = Fixture::new("real", &ENTRIES);

        let file = real(&fixture.archive().join("docs").join("a.txt")).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "alpha");
        assert_eq!(file.file_name().unwrap(), "a.txt");
        assert_eq!(real(&fixture.archive().join("docs").join("a.txt")).unwrap(), file);
        // It keeps the time the archive gave it.
        let modified = fs::metadata(&file).unwrap().modified().unwrap();
        assert!(modified.elapsed().unwrap() > Duration::from_secs(60));

        let folder = real(&fixture.archive().join("docs")).unwrap();
        assert_eq!(fs::read_to_string(folder.join("deeper").join("b.txt")).unwrap(), "beta!");
        assert_eq!(folder.file_name().unwrap(), "docs");

        assert_eq!(real(&fixture.archive()).unwrap(), fixture.archive());
        assert_eq!(real(&fixture.0).unwrap(), fixture.0);
        assert_eq!(real(&fixture.archive().join("gone.txt")), Err(GONE.into()));
        let _ = fs::remove_dir_all(file.parent().unwrap());
        let _ = fs::remove_dir_all(folder.parent().unwrap());
    }

    #[test]
    fn what_is_taken_out_keeps_the_mark_of_the_web() {
        let fixture = Fixture::new("zone", &ENTRIES);
        let zone = b"[ZoneTransfer]\r\nZoneId=3\r\n";
        mark(&fixture.archive(), zone);

        let file = real(&fixture.archive().join("top.txt")).unwrap();
        let folder = real(&fixture.archive().join("docs")).unwrap();

        assert_eq!(ops::sys::read_zone(&file).as_deref(), Some(zone.as_slice()));
        assert_eq!(ops::sys::read_zone(&folder.join("deeper").join("b.txt")).as_deref(), Some(zone.as_slice()));
        let _ = fs::remove_dir_all(file.parent().unwrap());
        let _ = fs::remove_dir_all(folder.parent().unwrap());
    }

    #[test]
    fn a_tar_opens_as_a_folder_and_comes_out_whole_once() {
        let fixture = Fixture::new("tar", &[]);
        let archive = fixture.0.join("pack.tar.gz");
        let mut squeezed = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        squeezed.write_all(&packs::tests::tar_bytes()).unwrap();
        fs::write(&archive, squeezed.finish().unwrap()).unwrap();
        let zone = b"[ZoneTransfer]\r\nZoneId=3\r\n";
        mark(&archive, zone);

        assert_eq!(split(&archive.join("docs")), Some((archive.clone(), "docs".into())));
        let (top, locked) = list(&archive, "", false).unwrap();
        let mut names: Vec<_> = top.iter().map(|node| (node.name.as_str(), node.folder)).collect();
        names.sort();
        assert_eq!(names, [("docs", true), ("top.txt", false)]);
        assert!(!locked);
        assert_eq!(top.iter().find(|node| node.name == "docs").unwrap().size, 10);

        // A TAR reads from its start, so it all comes out once and every file is served from there.
        let file = real(&archive.join("docs").join("deeper").join("b.txt")).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "beta!");
        let whole = whole(&archive).unwrap();
        assert!(file.starts_with(&whole));
        assert_eq!(real(&archive.join("top.txt")).unwrap(), whole.join("top.txt"));
        assert_eq!(ops::sys::read_zone(&file).as_deref(), Some(zone.as_slice()));
        let modified = fs::metadata(&file).unwrap().modified().unwrap();
        assert_eq!(modified.duration_since(UNIX_EPOCH).unwrap().as_secs(), 1_700_000_000);
        assert_eq!(real(&archive.join("gone.txt")), Err(GONE.into()));
        let _ = fs::remove_dir_all(whole);
    }

    #[test]
    fn a_locked_solid_7z_comes_out_whole_once_its_password_is_given() {
        let fixture = Fixture::new("locked-whole", &[]);
        let archive = fixture.0.join("pack.7z");
        packs::tests::seven(&archive, Some("sesame"), true, false);

        assert_eq!(whole(&archive), None);
        unlock(&archive, "sesame").unwrap();
        let whole = whole(&archive).unwrap();
        assert_eq!(fs::read_to_string(whole.join("docs").join("a.txt")).unwrap(), "alpha");
        assert_eq!(real(&archive.join("top.txt")).unwrap(), whole.join("top.txt"));
        PASSWORDS.lock().unwrap().remove(&key(&archive));
        let _ = fs::remove_dir_all(whole);
    }

    #[test]
    fn each_archive_has_its_own_lock() {
        let (a, b) = (Path::new(r"C:\a.7z"), Path::new(r"C:\b.7z"));
        assert!(Arc::ptr_eq(&whole_lock(a), &whole_lock(Path::new(r"C:\A.7Z"))));
        assert!(!Arc::ptr_eq(&whole_lock(a), &whole_lock(b)));
        // One coming out doesn't hold up another.
        let held = whole_lock(a);
        let _held = held.lock().unwrap();
        assert!(whole_lock(b).try_lock().is_ok());
    }

    #[test]
    fn the_cache_adds_up_and_clears() {
        let fixture = Fixture::new("cache", &[]);
        let root = fixture.0.join("cache");
        fs::create_dir_all(root.join("one").join("deeper")).unwrap();
        fs::write(root.join("one").join("a.bin"), [0; 300]).unwrap();
        fs::write(root.join("one").join("deeper").join("b.bin"), [0; 200]).unwrap();
        assert_eq!(tree_size(&root), 500);
        sweep(&root, CACHE_KEEP);
        assert_eq!(tree_size(&root), 500, "what is new stays");
        sweep(&root, Duration::ZERO);
        assert_eq!(tree_size(&root), 0);
    }

    #[test]
    fn a_7z_with_locked_names_shows_nothing_until_unlocked() {
        let fixture = Fixture::new("seven", &[]);
        let archive = fixture.0.join("pack.7z");
        packs::tests::seven(&archive, Some("open sesame"), false, true);

        assert_eq!(list(&archive, "", false), Ok((Vec::new(), true)));
        assert_eq!(real(&archive.join("top.txt")), Err(NEEDS_PASSWORD.into()));
        assert!(unlock(&archive, "wrong").is_err());
        unlock(&archive, "open sesame").unwrap();

        let (top, locked) = list(&archive, "", false).unwrap();
        assert_eq!(top.len(), 2);
        assert!(locked);
        let file = real(&archive.join("docs").join("a.txt")).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "alpha");
        let folder = real(&archive.join("docs")).unwrap();
        assert_eq!(fs::read_to_string(folder.join("deeper").join("b.txt")).unwrap(), "beta!");
        PASSWORDS.lock().unwrap().remove(&key(&archive));
        let _ = fs::remove_dir_all(file.parent().unwrap());
        let _ = fs::remove_dir_all(folder.parent().unwrap());
    }
}
