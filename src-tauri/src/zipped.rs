//! A ZIP opened as a folder, the way Explorer opens one. Its rows have paths such as
//! `C:\dir\pack.zip\docs\a.txt`, which back, forward and up treat like any other folder's.
//! Nothing inside ever changes. What needs a real file gets one taken out to a cache.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::fs;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::{Component, Path, PathBuf};
use std::sync::{LazyLock, Mutex, Once, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::{inside, ops};

pub const READ_ONLY: &str = "This ZIP opens read-only. Extract it to change what's inside.";
pub const NEEDS_PASSWORD: &str = "This file is locked. Enter the ZIP's password first.";
const GONE: &str = "That isn't in the ZIP anymore";
const NO_FOLDER: &str = "This ZIP has no folder by that name";

const CACHE_FOLDER: &str = "perli-zip";
/// What was taken out stays this long, as the app it opened in may still be using it.
const CACHE_KEEP: Duration = Duration::from_secs(24 * 60 * 60);

/// Passwords the user gave this session, by archive in lowercase. Never saved.
static PASSWORDS: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(Mutex::default);

fn is_zip(name: &OsStr) -> bool {
    Path::new(name).extension().is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
}

/// The archive and the path inside it, with `/` between parts and `""` for its top. `None`
/// outside a ZIP. Only a name that ends in `.zip` costs a look at the disk.
pub fn split(path: &Path) -> Option<(PathBuf, String)> {
    let mut archive = PathBuf::new();
    let mut parts = path.components();
    while let Some(part) = parts.next() {
        archive.push(part);
        if matches!(part, Component::Normal(name) if is_zip(name)) && archive.is_file() {
            let inner: Vec<_> = parts.map(|part| part.as_os_str().to_string_lossy().into_owned()).collect();
            return Some((archive, inner.join("/")));
        }
    }
    None
}

/// Below a ZIP's top, as its rows are. The ZIP file itself is not.
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

/// One row of a ZIP's folder. A folder adds up what is inside it.
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

/// What is inside `inner`, all the way down with `deep` or else only right in it, and whether
/// anything in the archive is locked. Folders the archive names only in the paths of what is
/// deeper are rows too, and Mac archives' hidden `__MACOSX` copies are left out.
pub fn list(archive: &Path, inner: &str, deep: bool) -> Result<(Vec<Node>, bool), String> {
    let zip = inside::open(archive)?;
    let inner = parts_of(inner);
    let (mut nodes, mut at) = (Vec::<Node>::new(), HashMap::<String, usize>::new());
    let (mut locked, mut found) = (false, inner.is_empty());
    for index in 0..zip.len() {
        let entry = zip.by_index_data(index).map_err(|error| error.to_string())?;
        locked |= entry.encrypted();
        let name = entry.name().map_err(|error| error.to_string())?;
        if name.starts_with("__MACOSX/") {
            continue;
        }
        let Some(rest) = below(&name, &inner) else { continue };
        found = true;
        let ticks = entry.last_modified().map_or(0, ops::zip_ticks);
        let levels = if deep { rest.len() } else { rest.len().min(1) };
        for level in 1..=levels {
            let folder = level < rest.len() || entry.is_dir();
            let place = *at.entry(rest[..level].join("/")).or_insert_with(|| {
                let (parent, name) = (rest[..level - 1].join("/"), rest[level - 1].to_string());
                nodes.push(Node { parent, name, size: 0, packed: 0, modified: 0, folder });
                nodes.len() - 1
            });
            let node = &mut nodes[place];
            if !entry.is_dir() {
                node.size += entry.size();
                node.packed += entry.compressed_size();
            }
            node.modified = node.modified.max(ticks);
        }
    }
    if !found {
        return Err(NO_FOLDER.into());
    }
    Ok((nodes, locked))
}

/// A picture inside a ZIP, `edge` pixels on its longest side at most. Empty for anything else,
/// so the list shows its icon.
pub fn picture(archive: &Path, inner: &str, edge: u32) -> Vec<u8> {
    let Some(name) = inside::is_picture(inner).then(|| entry_name(archive, inner)).flatten() else {
        return Vec::new();
    };
    inside::picture(archive, &name, edge, password(archive).as_deref()).unwrap_or_default()
}

/// The archive's own name for the file at `inner`.
fn entry_name(archive: &Path, inner: &str) -> Option<String> {
    let zip = inside::open(archive).ok()?;
    let inner = parts_of(inner);
    let fits = |name: &std::borrow::Cow<'_, str>| !name.ends_with('/') && below(name, &inner).is_some_and(|rest| rest.is_empty());
    let found = zip.file_names().flatten().find(fits).map(|name| name.into_owned());
    found
}

/// A file or folder of a ZIP as a real one on disk, taken out to a cache once for each version
/// of the archive. Paths outside a ZIP come back as they are, and so does a ZIP's top.
pub fn real(path: &Path) -> Result<PathBuf, String> {
    let Some((archive, inner)) = split(path) else {
        return Ok(path.to_path_buf());
    };
    let Some(name) = inner.rsplit('/').next().filter(|name| !name.is_empty()) else {
        return Ok(archive);
    };
    let root = cache_root();
    let version = fs::metadata(&archive).ok().map(|metadata| (metadata.len(), metadata.modified().ok()));
    let mut hasher = DefaultHasher::new();
    (key(&archive), version, inner.to_lowercase()).hash(&mut hasher);
    let slot = root.join(format!("{:016x}", hasher.finish()));
    let target = slot.join(name);
    if target.exists() {
        return Ok(target);
    }
    // A move took what was here away.
    let _ = fs::remove_dir_all(&slot);
    let part = root.join(format!("{:016x}-{}.part", hasher.finish(), crate::since_1970().as_nanos()));
    fs::create_dir_all(&part).map_err(|error| error.to_string())?;
    let written = take_out(&archive, &inner, &part.join(name)).and_then(|()| fs::rename(&part, &slot).map_err(|error| error.to_string()));
    match written {
        Ok(()) => Ok(target),
        // Another look took it out first.
        Err(_) if target.exists() => {
            let _ = fs::remove_dir_all(&part);
            Ok(target)
        }
        Err(error) => {
            let _ = fs::remove_dir_all(&part);
            Err(error)
        }
    }
}

pub fn real_all(paths: &[PathBuf]) -> Result<Vec<PathBuf>, String> {
    paths.iter().map(|path| real(path)).collect()
}

/// Writes `inner`, a file or a folder with all it holds, to `target`.
fn take_out(archive: &Path, inner: &str, target: &Path) -> Result<(), String> {
    let mut zip = inside::open(archive)?;
    let password = password(archive);
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
        // A name that could reach outside the target stays in the archive.
        let Some(relative) = ops::safe_relative(rest.iter().collect()) else { continue };
        // An empty join would end the path in a backslash, which names no file.
        let path = if rest.is_empty() { target.to_path_buf() } else { target.join(relative) };
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
        let mut entry = match key {
            Some(key) => zip.by_index_decrypt(index, key.as_bytes()),
            None => zip.by_index(index),
        }
        .map_err(inside::reason)?;
        let mut file = fs::File::create(&path).map_err(|error| error.to_string())?;
        std::io::copy(&mut entry, &mut file).map_err(|error| inside::read_failed(error, archive, &name, key))?;
        if let Some(time) = time_of(ticks) {
            let _ = file.set_modified(time);
        }
    }
    if !found {
        return Err(GONE.into());
    }
    if target.exists() {
        Ok(())
    } else {
        Err("This name in the archive isn't safe to use".into())
    }
}

/// FILETIME ticks as a time. None before 1970, which no ZIP can hold.
fn time_of(ticks: u64) -> Option<SystemTime> {
    const UNIX_START: u64 = 116_444_736_000_000_000;
    Some(UNIX_EPOCH + Duration::from_nanos(ticks.checked_sub(UNIX_START)?.checked_mul(100)?))
}

fn cache_root() -> PathBuf {
    static SWEPT: Once = Once::new();
    let root = std::env::temp_dir().join(CACHE_FOLDER);
    // ponytail: swept once a run; sweep on a timer if runs that last days fill the disk.
    SWEPT.call_once(|| sweep(&root, CACHE_KEEP));
    root
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
}
