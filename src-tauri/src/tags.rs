//! Tags, kept in a database of Perli's own and keyed by NTFS file ID, so that a file keeps them when
//! it moves or gets a new name, and no file of the user's ever changes. With no database there are
//! no tags, and they cost nothing.

use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::mem;
use std::os::windows::ffi::OsStringExt;
use std::path::{Path, PathBuf};
use std::slice;
use std::sync::{Mutex, PoisonError};

use rusqlite::{params, Connection, ErrorCode};
use serde::Serialize;
use windows::core::{Owned, HSTRING};
use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_INVALID_PARAMETER, ERROR_NO_MORE_FILES, HANDLE};
use windows::Win32::Storage::FileSystem::{
    ExtendedFileIdType, FileIdExtdDirectoryInfo, FileIdExtdDirectoryRestartInfo, FileIdInfo, GetDriveTypeW,
    GetFileInformationByHandleEx, GetFinalPathNameByHandleW, GetLogicalDrives, GetVolumeInformationByHandleW,
    OpenFileById, FILE_FLAG_BACKUP_SEMANTICS, FILE_ID_128, FILE_ID_DESCRIPTOR, FILE_ID_DESCRIPTOR_0,
    FILE_ID_EXTD_DIR_INFO, FILE_ID_INFO, FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE,
    FILE_SHARE_READ, FILE_SHARE_WRITE, GETFINALPATHNAMEBYHANDLE_FLAGS,
};
use windows::Win32::System::SystemServices::FILE_SUPPORTS_OPEN_BY_FILE_ID;

use crate::folder::Entry;
use crate::ops::sys;
use crate::session;

const DATABASE: &str = "tags.db";
const SCHEMA: &str = "
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS tags(
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        color INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tagged(
        volume INTEGER NOT NULL,
        file BLOB NOT NULL,
        tag INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        PRIMARY KEY(volume, file, tag)
    ) WITHOUT ROWID;
";
const NO_NTFS: &str = "Tags need an NTFS drive";
const NAME_TAKEN: &str = "A tag with this name already exists";
const NO_NAME: &str = "A tag needs a name";
/// Holds a few hundred names, and the folder's next call picks up the rest.
const LISTING_BYTES: usize = 64 * 1024;

type FileId = [u8; 16];

/// Tells a file apart for as long as it lives on its volume.
#[derive(Clone, Copy)]
struct Key {
    volume: u64,
    file: FileId,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct Tag {
    pub id: u32,
    pub name: String,
    /// Which of the UI's tag colors.
    pub color: u8,
}

/// The tags of each entry that has any, by its position in the entries given.
pub type Tagged = HashMap<u32, Box<[u32]>>;

fn key_of(handle: HANDLE) -> windows::core::Result<Key> {
    let mut info = FILE_ID_INFO::default();
    let size = mem::size_of_val(&info) as u32;
    unsafe { GetFileInformationByHandleEx(handle, FileIdInfo, (&raw mut info).cast(), size) }?;
    Ok(Key { volume: info.VolumeSerialNumber, file: info.FileId.Identifier })
}

/// Drives that can't open a file by its ID may give it another one at any time.
fn file_key(path: &Path) -> Result<Key, String> {
    let file = sys::open_object(path, FILE_READ_ATTRIBUTES.0).map_err(|error| error.message())?;
    let mut flags = 0;
    unsafe { GetVolumeInformationByHandleW(*file, None, None, None, Some(&raw mut flags), None) }
        .map_err(|error| error.message())?;
    if flags & FILE_SUPPORTS_OPEN_BY_FILE_ID == 0 {
        return Err(NO_NTFS.to_string());
    }
    key_of(*file).map_err(|error| error.message())
}

fn file_keys(paths: &[PathBuf]) -> Result<Vec<Key>, String> {
    paths.iter().map(|path| file_key(path)).collect()
}

/// Calls `visit` with each name in the open folder and its ID. One call covers hundreds of files,
/// where opening each to ask would make a tagged folder slow.
fn each_id(folder: HANDLE, mut visit: impl FnMut(&[u16], FileId)) -> windows::core::Result<()> {
    let mut buffer = vec![0u64; LISTING_BYTES / mem::size_of::<u64>()];
    let mut class = FileIdExtdDirectoryRestartInfo;
    loop {
        let read = unsafe {
            GetFileInformationByHandleEx(folder, class, buffer.as_mut_ptr().cast(), LISTING_BYTES as u32)
        };
        match read {
            Err(error) if error.code() == ERROR_NO_MORE_FILES.to_hresult() => return Ok(()),
            other => other?,
        }
        class = FileIdExtdDirectoryInfo;
        let mut at = buffer.as_ptr().cast::<u8>();
        loop {
            let info = at.cast::<FILE_ID_EXTD_DIR_INFO>();
            // Windows wrote these fields, and the name runs on past the end of the struct.
            let (name, id, next) = unsafe {
                let start = (&raw const (*info).FileName).cast::<u16>();
                let units = (*info).FileNameLength as usize / mem::size_of::<u16>();
                (slice::from_raw_parts(start, units), (*info).FileId.Identifier, (*info).NextEntryOffset)
            };
            visit(name, id);
            if next == 0 {
                break;
            }
            at = unsafe { at.add(next as usize) };
        }
    }
}

/// Matches the IDs in `folder` with the tags `on_volume` knows of.
fn read_folder(
    folder: &Path,
    entries: &[Entry],
    on_volume: impl FnOnce(u64) -> HashMap<FileId, Vec<u32>>,
) -> windows::core::Result<Tagged> {
    let access = FILE_LIST_DIRECTORY.0 | FILE_READ_ATTRIBUTES.0;
    let handle = sys::open_folder(folder, access)?;
    let files = on_volume(key_of(*handle)?.volume);
    if files.is_empty() {
        return Ok(Tagged::new());
    }
    let places: HashMap<&[u16], u32> = entries.iter().map(Entry::name).zip(0..).collect();
    let mut tagged = Tagged::new();
    each_id(*handle, |name, id| {
        if let (Some(&entry), Some(tags)) = (places.get(name), files.get(&id)) {
            tagged.insert(entry, tags.as_slice().into());
        }
    })?;
    Ok(tagged)
}

/// What `GetDriveTypeW` calls a drive on another computer.
const DRIVE_REMOTE: u32 = 4;
/// How Windows starts the paths it gives for a handle.
const VERBATIM: &str = r"\\?\";

/// The open top of each drive of this computer, by the serial number of its volume.
// ponytail: network drives are left out, since one that is gone can take many seconds to say so.
// Tags are for NTFS, which a share rarely passes on.
fn volumes() -> HashMap<u64, Owned<HANDLE>> {
    let letters = unsafe { GetLogicalDrives() };
    let roots = (0..26u8).filter(|bit| letters & (1 << bit) != 0).map(|bit| format!("{}:\\", char::from(b'A' + bit)));
    roots
        .filter(|root| unsafe { GetDriveTypeW(&HSTRING::from(root.as_str())) } != DRIVE_REMOTE)
        .filter_map(|root| {
            let top = sys::open_folder(Path::new(&root), FILE_READ_ATTRIBUTES.0).ok()?;
            Some((key_of(*top).ok()?.volume, top))
        })
        .collect()
}

fn open_by_id(volume: HANDLE, file: FileId) -> windows::core::Result<Owned<HANDLE>> {
    let id = FILE_ID_DESCRIPTOR {
        dwSize: mem::size_of::<FILE_ID_DESCRIPTOR>() as u32,
        Type: ExtendedFileIdType,
        Anonymous: FILE_ID_DESCRIPTOR_0 { ExtendedFileId: FILE_ID_128 { Identifier: file } },
    };
    let share = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
    let opened = unsafe { OpenFileById(volume, &id, FILE_READ_ATTRIBUTES.0, share, None, FILE_FLAG_BACKUP_SEMANTICS) };
    opened.map(|handle| unsafe { Owned::new(handle) })
}

/// True only when Windows says no file on `volume` has this ID. A file that is there but can't
/// be opened, such as one another app holds or one the user may not read, is not gone.
fn gone(volume: HANDLE, file: FileId) -> bool {
    open_by_id(volume, file).is_err_and(|error| NO_SUCH_ID.contains(&error.code()))
}

/// What `OpenFileById` says for an ID no file has.
const NO_SUCH_ID: [windows::core::HRESULT; 2] = [ERROR_INVALID_PARAMETER.to_hresult(), ERROR_FILE_NOT_FOUND.to_hresult()];

/// Where the file with this ID is now, if it still exists.
fn path_of(volume: HANDLE, file: FileId) -> Option<PathBuf> {
    let opened = open_by_id(volume, file).ok()?;
    let mut path = vec![0u16; 1024];
    loop {
        let units = unsafe { GetFinalPathNameByHandleW(*opened, &mut path, GETFINALPATHNAMEBYHANDLE_FLAGS(0)) } as usize;
        match units {
            0 => return None,
            units if units > path.len() => path.resize(units, 0),
            units => {
                let full = OsString::from_wide(&path[..units]).into_string().ok()?;
                return Some(PathBuf::from(full.strip_prefix(VERBATIM).unwrap_or(&full)));
            }
        }
    }
}

struct Store(Connection);

impl Store {
    fn open(path: &Path) -> rusqlite::Result<Self> {
        let database = Connection::open(path)?;
        database.execute_batch(SCHEMA)?;
        Ok(Self(database))
    }

    fn all(&self) -> rusqlite::Result<Vec<Tag>> {
        let mut rows = self.0.prepare_cached("SELECT id, name, color FROM tags ORDER BY name")?;
        let tag = |row: &rusqlite::Row| Ok(Tag { id: row.get(0)?, name: row.get(1)?, color: row.get(2)? });
        let tags = rows.query_map([], tag)?.collect();
        tags
    }

    fn create(&self, name: &str, color: u8) -> rusqlite::Result<Tag> {
        self.0.execute("INSERT INTO tags(name, color) VALUES(?, ?)", params![name, color])?;
        Ok(Tag { id: self.0.last_insert_rowid() as u32, name: name.to_string(), color })
    }

    fn edit(&self, id: u32, name: &str, color: u8) -> rusqlite::Result<()> {
        self.0.execute("UPDATE tags SET name = ?, color = ? WHERE id = ?", params![name, color, id])?;
        Ok(())
    }

    fn delete(&self, id: u32) -> rusqlite::Result<()> {
        self.0.execute("DELETE FROM tags WHERE id = ?", [id])?;
        Ok(())
    }

    fn set(&self, keys: &[Key], tag: u32, on: bool) -> rusqlite::Result<()> {
        let change = if on {
            "INSERT OR IGNORE INTO tagged(volume, file, tag) VALUES(?, ?, ?)"
        } else {
            "DELETE FROM tagged WHERE volume = ? AND file = ? AND tag = ?"
        };
        let all_at_once = self.0.unchecked_transaction()?;
        let mut statement = all_at_once.prepare(change)?;
        for key in keys {
            statement.execute(params![key.volume as i64, key.file, tag])?;
        }
        drop(statement);
        all_at_once.commit()
    }

    /// The tags all of `keys` have.
    fn common(&self, keys: &[Key]) -> rusqlite::Result<Vec<u32>> {
        let mut rows = self.0.prepare_cached("SELECT tag FROM tagged WHERE volume = ? AND file = ?")?;
        let mut shared: Option<Vec<u32>> = None;
        for key in keys {
            let tags = rows
                .query_map(params![key.volume as i64, key.file], |row| row.get(0))?
                .collect::<rusqlite::Result<Vec<u32>>>()?;
            shared = Some(match shared {
                Some(mut kept) => {
                    kept.retain(|tag| tags.contains(tag));
                    kept
                }
                None => tags,
            });
        }
        Ok(shared.unwrap_or_default())
    }

    /// Every file that has `tag`, with all of its tags.
    fn with_tag(&self, tag: u32) -> rusqlite::Result<HashMap<(u64, FileId), Vec<u32>>> {
        let mut rows = self.0.prepare_cached(
            "SELECT volume, file, tag FROM tagged
             WHERE (volume, file) IN (SELECT volume, file FROM tagged WHERE tag = ?)",
        )?;
        let mut files = HashMap::<(u64, FileId), Vec<u32>>::new();
        let row = rows.query_map([tag], |row| Ok((row.get::<_, i64>(0)?, row.get(1)?, row.get(2)?)))?;
        for found in row {
            let (volume, file, tag) = found?;
            files.entry((volume as u64, file)).or_default().push(tag);
        }
        Ok(files)
    }

    fn any_tagged(&self) -> rusqlite::Result<bool> {
        self.0.query_row("SELECT EXISTS(SELECT 1 FROM tagged)", [], |row| row.get(0))
    }

    /// Every tagged file, once.
    fn files(&self) -> rusqlite::Result<Vec<(u64, FileId)>> {
        let mut rows = self.0.prepare_cached("SELECT DISTINCT volume, file FROM tagged")?;
        let files = rows.query_map([], |row| Ok((row.get::<_, i64>(0)? as u64, row.get(1)?)))?.collect();
        files
    }

    fn forget(&self, files: &[(u64, FileId)]) -> rusqlite::Result<()> {
        let all_at_once = self.0.unchecked_transaction()?;
        let mut statement = all_at_once.prepare("DELETE FROM tagged WHERE volume = ? AND file = ?")?;
        for (volume, file) in files {
            statement.execute(params![*volume as i64, file])?;
        }
        drop(statement);
        all_at_once.commit()
    }

    /// Every read of a folder loads the volume's rows, so `sweep` keeps them to files that exist.
    fn on_volume(&self, volume: u64) -> rusqlite::Result<HashMap<FileId, Vec<u32>>> {
        let mut rows = self.0.prepare_cached("SELECT file, tag FROM tagged WHERE volume = ?")?;
        let mut files = HashMap::<FileId, Vec<u32>>::new();
        let row = rows.query_map([volume as i64], |row| Ok((row.get(0)?, row.get(1)?)))?;
        for found in row {
            let (file, tag) = found?;
            files.entry(file).or_default().push(tag);
        }
        Ok(files)
    }
}

static STORE: Mutex<Option<Store>> = Mutex::new(None);

/// Runs `read` if tags were ever made, without making a database for it.
fn existing<T>(read: impl FnOnce(&Store) -> T) -> Option<T> {
    let mut store = STORE.lock().unwrap_or_else(PoisonError::into_inner);
    if store.is_none() {
        let path = session::data_file(DATABASE).filter(|path| path.exists())?;
        *store = Store::open(&path).ok();
    }
    store.as_ref().map(read)
}

fn made() -> Result<Store, String> {
    let path = session::data_file(DATABASE).ok_or("Windows gave no place to keep tags")?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    Store::open(&path).map_err(described)
}

fn opened<T>(change: impl FnOnce(&Store) -> rusqlite::Result<T>) -> Result<T, String> {
    let mut store = STORE.lock().unwrap_or_else(PoisonError::into_inner);
    let store = match &mut *store {
        Some(store) => store,
        empty => empty.insert(made()?),
    };
    change(store).map_err(described)
}

fn described(error: rusqlite::Error) -> String {
    match error.sqlite_error_code() {
        Some(ErrorCode::ConstraintViolation) => NAME_TAKEN.to_string(),
        _ => error.to_string(),
    }
}

fn named(name: &str) -> Result<&str, String> {
    Some(name.trim()).filter(|name| !name.is_empty()).ok_or_else(|| NO_NAME.to_string())
}

pub fn all() -> Result<Vec<Tag>, String> {
    existing(Store::all).transpose().map_err(described).map(Option::unwrap_or_default)
}

pub fn create(name: &str, color: u8) -> Result<Tag, String> {
    let name = named(name)?;
    opened(|store| store.create(name, color))
}

pub fn edit(id: u32, name: &str, color: u8) -> Result<(), String> {
    let name = named(name)?;
    opened(|store| store.edit(id, name, color))
}

pub fn delete(id: u32) -> Result<(), String> {
    opened(|store| store.delete(id))
}

/// Nothing changes unless every file can take it.
pub fn set(paths: &[PathBuf], tag: u32, on: bool) -> Result<(), String> {
    let keys = file_keys(paths)?;
    opened(|store| store.set(&keys, tag, on))
}

/// The tags all of `paths` have.
pub fn common(paths: &[PathBuf]) -> Result<Vec<u32>, String> {
    let keys = file_keys(paths)?;
    existing(|store| store.common(&keys)).transpose().map_err(described).map(Option::unwrap_or_default)
}

/// The tag with this name, in any case.
pub fn named_id(name: &str) -> Option<u32> {
    let tags = all().unwrap_or_default();
    tags.iter().find(|tag| tag.name.to_lowercase() == name.to_lowercase()).map(|tag| tag.id)
}

/// Where each file with `tag` is now, with all of its tags, by path. A file that is gone, or on a
/// drive that is not here, is left out and keeps its tags.
pub fn files_with(tag: u32) -> Vec<(PathBuf, Box<[u32]>)> {
    let files = existing(|store| store.with_tag(tag)).and_then(Result::ok).unwrap_or_default();
    if files.is_empty() {
        return Vec::new();
    }
    let volumes = volumes();
    let mut found: Vec<(PathBuf, Box<[u32]>)> = files
        .into_iter()
        .filter_map(|((volume, file), tags)| Some((path_of(**volumes.get(&volume)?, file)?, tags.into())))
        .collect();
    found.sort();
    found
}

/// The tagged files among `files` that are gone for good. Only drives that are here are asked,
/// so an unplugged drive keeps its tags until it comes back.
fn gone_of(files: Vec<(u64, FileId)>, volumes: &HashMap<u64, Owned<HANDLE>>) -> Vec<(u64, FileId)> {
    files.into_iter().filter(|(volume, file)| volumes.get(volume).is_some_and(|top| gone(**top, *file))).collect()
}

/// Drops the tags of files that no longer exist, so they don't weigh on every folder read. The
/// store is only locked to read the list and to drop, never while Windows is asked.
pub fn sweep() {
    let Some(Ok(files)) = existing(Store::files) else { return };
    let gone = gone_of(files, &volumes());
    if !gone.is_empty() {
        if let Some(Err(error)) = existing(|store| store.forget(&gone)) {
            eprintln!("dropping the tags of deleted files failed: {error}");
        }
    }
}

/// Each tag's place in name order, for sorting.
pub fn places() -> HashMap<u32, u64> {
    let tags = all().unwrap_or_default();
    tags.iter().map(|tag| tag.id).zip(0..).collect()
}

/// What `entries` of `folder` carry. A folder that can't say shows no tags, which is no reason to
/// stop, and until something is tagged this asks Windows for nothing.
pub fn in_folder(folder: &Path, entries: &[Entry]) -> Tagged {
    if !existing(Store::any_tagged).is_some_and(|any| any.unwrap_or(false)) {
        return Tagged::new();
    }
    let files = |volume| existing(|store| store.on_volume(volume)).and_then(Result::ok).unwrap_or_default();
    read_folder(folder, entries, files).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use std::os::windows::fs::OpenOptionsExt;
    use std::process::Command;

    use super::*;

    struct Folder(PathBuf);

    impl Folder {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!("perli-tags-{name}-{}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn file(&self, name: &str) -> PathBuf {
            let path = self.0.join(name);
            fs::write(&path, "").unwrap();
            path
        }

        fn entries(&self) -> Vec<Entry> {
            let mut entries = Vec::new();
            sys::each_entry(&sys::extended(&self.0.join("*")), |data| {
                entries.extend(Entry::from_find_data(data));
            })
            .unwrap();
            entries
        }

        /// Each tagged entry's name and tags, A to Z.
        fn read(&self, store: &Store) -> Vec<(String, Vec<u32>)> {
            let entries = self.entries();
            let tagged = read_folder(&self.0, &entries, |volume| store.on_volume(volume).unwrap()).unwrap();
            let mut read: Vec<_> = tagged
                .into_iter()
                .map(|(entry, tags)| (String::from_utf16_lossy(entries[entry as usize].name()), tags.to_vec()))
                .collect();
            read.sort();
            read
        }
    }

    impl Drop for Folder {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn store() -> Store {
        Store::open(Path::new(":memory:")).unwrap()
    }

    fn key(path: &Path) -> Key {
        file_key(path).unwrap()
    }

    #[test]
    fn tags_can_be_made_changed_and_listed_a_to_z() {
        let store = store();
        let work = store.create("work", 1).unwrap();
        store.create("Art", 2).unwrap();

        store.edit(work.id, "Zebra", 3).unwrap();

        let tags = store.all().unwrap();
        assert_eq!(tags[0].name, "Art");
        assert_eq!(tags[1], Tag { id: work.id, name: "Zebra".to_string(), color: 3 });
    }

    #[test]
    fn two_tags_can_not_share_a_name_in_any_case() {
        let store = store();
        store.create("Work", 1).unwrap();

        assert_eq!(described(store.create("work", 2).unwrap_err()), NAME_TAKEN);
    }

    #[test]
    fn a_name_must_hold_more_than_spaces() {
        assert_eq!(named(" a "), Ok("a"));
        assert!(named("   ").is_err());
    }

    #[test]
    fn a_folder_shows_each_files_tags() {
        let (store, folder) = (store(), Folder::new("shows"));
        let (a, b) = (store.create("a", 0).unwrap().id, store.create("b", 0).unwrap().id);
        let first = folder.file("first.txt");
        folder.file("plain.txt");
        store.set(&[key(&first)], a, true).unwrap();
        store.set(&[key(&first)], b, true).unwrap();

        assert_eq!(folder.read(&store), [("first.txt".to_string(), vec![a, b])]);
    }

    #[test]
    fn a_tag_stays_with_a_file_that_gets_a_new_name() {
        let (store, folder) = (store(), Folder::new("renamed"));
        let tag = store.create("keep", 0).unwrap().id;
        let file = folder.file("old.txt");
        store.set(&[key(&file)], tag, true).unwrap();

        fs::rename(&file, folder.0.join("new.txt")).unwrap();

        assert_eq!(folder.read(&store), [("new.txt".to_string(), vec![tag])]);
    }

    #[test]
    fn a_tag_stays_with_a_file_moved_on_the_same_drive() {
        let (store, from, to) = (store(), Folder::new("from"), Folder::new("to"));
        let tag = store.create("keep", 0).unwrap().id;
        let file = from.file("a.txt");
        store.set(&[key(&file)], tag, true).unwrap();

        fs::rename(&file, to.0.join("a.txt")).unwrap();

        assert_eq!(to.read(&store), [("a.txt".to_string(), vec![tag])]);
    }

    #[test]
    fn a_folder_can_be_tagged_and_a_link_is_tagged_as_itself() {
        let (store, folder) = (store(), Folder::new("links"));
        let tag = store.create("keep", 0).unwrap().id;
        let target = folder.0.join("target");
        fs::create_dir(&target).unwrap();
        let link = folder.0.join("link");
        let made = Command::new("cmd")
            .args(["/C", "mklink", "/J", link.to_str().unwrap(), target.to_str().unwrap()])
            .output()
            .unwrap();
        assert!(made.status.success(), "{made:?}");

        store.set(&[key(&link)], tag, true).unwrap();

        assert_eq!(folder.read(&store), [("link".to_string(), vec![tag])]);
    }

    #[test]
    fn deleting_a_tag_takes_it_off_every_file_and_taking_one_off_works() {
        let (store, folder) = (store(), Folder::new("gone"));
        let (a, b) = (store.create("a", 0).unwrap().id, store.create("b", 0).unwrap().id);
        let file = folder.file("file.txt");
        store.set(&[key(&file)], a, true).unwrap();
        store.set(&[key(&file)], b, true).unwrap();

        store.delete(a).unwrap();
        assert_eq!(folder.read(&store), [("file.txt".to_string(), vec![b])]);

        store.set(&[key(&file)], b, false).unwrap();
        assert!(folder.read(&store).is_empty());
        assert!(!store.any_tagged().unwrap());
    }

    #[test]
    fn the_tags_in_common_are_those_every_file_has() {
        let (store, folder) = (store(), Folder::new("common"));
        let (a, b) = (store.create("a", 0).unwrap().id, store.create("b", 0).unwrap().id);
        let (one, two) = (key(&folder.file("1")), key(&folder.file("2")));
        store.set(&[one, two], a, true).unwrap();
        store.set(&[one], b, true).unwrap();

        assert_eq!(store.common(&[one, two]).unwrap(), [a]);
        assert_eq!(store.common(&[one]).unwrap().len(), 2);
        assert!(store.common(&[]).unwrap().is_empty());
    }

    #[test]
    fn a_big_folder_is_read_past_one_call() {
        let (store, folder) = (store(), Folder::new("big"));
        let tag = store.create("keep", 0).unwrap().id;
        let names: Vec<String> = (0..2_000).map(|number| format!("{number:0>120}")).collect();
        let keys: Vec<Key> = names.iter().map(|name| key(&folder.file(name))).collect();
        store.set(&keys, tag, true).unwrap();

        assert_eq!(folder.read(&store).len(), names.len());
    }

    #[test]
    fn a_tagged_file_is_found_by_its_id_wherever_it_went() {
        let (store, folder) = (store(), Folder::new("found"));
        let (a, b) = (store.create("a", 0).unwrap().id, store.create("b", 0).unwrap().id);
        let file = folder.file("old.txt");
        let other = folder.file("other.txt");
        store.set(&[key(&file)], a, true).unwrap();
        store.set(&[key(&file), key(&other)], b, true).unwrap();
        let moved = folder.0.join("new.txt");
        fs::rename(&file, &moved).unwrap();

        let files = store.with_tag(a).unwrap();
        assert_eq!(files.len(), 1);
        let ((volume, id), tags) = files.into_iter().next().unwrap();
        assert_eq!(tags, [a, b]);
        let volumes = volumes();
        let path = path_of(**volumes.get(&volume).unwrap(), id).unwrap();
        assert_eq!(path.file_name().unwrap(), "new.txt");
        assert_eq!(key(&path).file, key(&moved).file);

        fs::remove_file(&moved).unwrap();
        assert_eq!(path_of(**volumes.get(&volume).unwrap(), id), None);
    }

    #[test]
    fn only_files_that_are_gone_lose_their_tags() {
        let (store, folder) = (store(), Folder::new("sweep"));
        let tag = store.create("a", 0).unwrap().id;
        let (kept, deleted, held) = (folder.file("kept.txt"), folder.file("deleted.txt"), folder.file("held.txt"));
        store.set(&[key(&kept), key(&deleted), key(&held)], tag, true).unwrap();
        let away = (key(&kept).volume ^ 1, key(&kept).file);
        store.set(&[Key { volume: away.0, file: away.1 }], tag, true).unwrap();
        fs::remove_file(&deleted).unwrap();
        // A file another app holds with no sharing at all is still there.
        let _locked = fs::OpenOptions::new().read(true).share_mode(0).open(&held).unwrap();

        let gone = gone_of(store.files().unwrap(), &volumes());
        store.forget(&gone).unwrap();

        assert_eq!(gone.len(), 1, "only the deleted file, never the held one or a drive that isn't here");
        assert_eq!(folder.read(&store), [("held.txt".to_string(), vec![tag]), ("kept.txt".to_string(), vec![tag])]);
        assert!(store.files().unwrap().contains(&away), "a drive not plugged in keeps its tags");
    }

    #[test]
    fn a_file_that_is_gone_has_no_key() {
        let folder = Folder::new("missing");
        assert!(file_key(&folder.0.join("nope")).is_err());
    }
}
