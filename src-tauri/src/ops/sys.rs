//! Thin wrappers over the Windows file calls. Every call that changes the disk lives here
//! and passes the test guard first, so a test cannot touch anything outside its temp folder.

use std::ffi::{c_void, OsString};
use std::fs::File;
use std::io::Write;
use std::mem::size_of;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};

use windows::core::{Error, Owned, Result, HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    ERROR_ACCESS_DENIED, ERROR_ALREADY_EXISTS, ERROR_FILE_NOT_FOUND, ERROR_LOCK_VIOLATION,
    ERROR_MORE_DATA, ERROR_NOT_SAME_DEVICE, ERROR_NO_MORE_FILES, ERROR_PATH_NOT_FOUND,
    ERROR_SHARING_VIOLATION, ERROR_SUCCESS, E_UNEXPECTED, FILETIME, GENERIC_WRITE, HANDLE,
    STILL_ACTIVE,
};
use windows::Win32::Storage::FileSystem::{
    CopyFile2, CreateDirectoryW, CreateFileW, DeleteFileW, FindClose, FindExInfoBasic,
    FindExSearchNameMatch, FindFirstFileExW, FindNextFileW, FlushFileBuffers,
    GetFileInformationByHandle, GetFileInformationByHandleEx, GetFinalPathNameByHandleW,
    MoveFileExW, RemoveDirectoryW, SetFileAttributesW, SetFileInformationByHandle, SetFileTime,
    BY_HANDLE_FILE_INFORMATION, COPYFILE2_CALLBACK_CHUNK_FINISHED,
    COPYFILE2_CALLBACK_STREAM_FINISHED, COPYFILE2_EXTENDED_PARAMETERS, COPYFILE2_MESSAGE,
    COPYFILE2_MESSAGE_ACTION, COPYFILE2_PROGRESS_CANCEL, COPYFILE2_PROGRESS_CONTINUE,
    COPY_FILE_FAIL_IF_EXISTS, CREATE_NEW, FILE_ATTRIBUTE_ARCHIVE, FILE_ATTRIBUTE_DIRECTORY,
    FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_READONLY,
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_SYSTEM, FILE_BASIC_INFO,
    FILE_FLAGS_AND_ATTRIBUTES, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_NAME_NORMALIZED, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ,
    FILE_SHARE_WRITE, FILE_WRITE_ATTRIBUTES, FIND_FIRST_EX_LARGE_FETCH, FileBasicInfo,
    GETFINALPATHNAMEBYHANDLE_FLAGS,
    MAXIMUM_REPARSE_DATA_BUFFER_SIZE, MOVE_FILE_FLAGS, OPEN_EXISTING,
    VOLUME_NAME_NT, WIN32_FIND_DATAW,
};
use windows::Win32::System::Ioctl::{FSCTL_GET_REPARSE_POINT, FSCTL_SET_REPARSE_POINT};
use windows::Win32::System::RestartManager::{
    RmEndSession, RmGetList, RmRegisterResources, RmStartSession, CCH_RM_SESSION_KEY,
    RM_PROCESS_INFO,
};
use windows::Win32::System::Threading::{
    GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::System::IO::DeviceIoControl;
use windows::Win32::UI::Shell::{
    SHEmptyRecycleBinW, SHERB_NOCONFIRMATION, SHERB_NOPROGRESSUI, SHERB_NOSOUND,
};

/// The reparse tag bit that says the object stands in for another name: a junction, mount
/// point or symlink. Cloud placeholders lack it, so they count as normal files and folders.
const NAME_SURROGATE: u32 = 0x2000_0000;

/// How many files under a folder Restart Manager gets asked about.
const USERS_FILE_LIMIT: usize = 1000;

/// Attributes a new folder takes from the folder it copies.
const FOLDER_ATTRIBUTES: u32 = FILE_ATTRIBUTE_HIDDEN.0 | FILE_ATTRIBUTE_SYSTEM.0 | FILE_ATTRIBUTE_READONLY.0;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Stat {
    attributes: u32,
    tag: u32,
    pub size: u64,
    /// FILETIME ticks.
    pub modified: u64,
    /// FILETIME ticks.
    pub created: u64,
}

impl Stat {
    fn from_find_data(data: &WIN32_FIND_DATAW) -> Self {
        let ticks = |time: FILETIME| (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime);
        let reparse = data.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0;
        Self {
            attributes: data.dwFileAttributes,
            tag: if reparse { data.dwReserved0 } else { 0 },
            size: (u64::from(data.nFileSizeHigh) << 32) | u64::from(data.nFileSizeLow),
            modified: ticks(data.ftLastWriteTime),
            created: ticks(data.ftCreationTime),
        }
    }

    /// True for a folder and for a link to one.
    pub fn is_dir(self) -> bool {
        self.attributes & FILE_ATTRIBUTE_DIRECTORY.0 != 0
    }

    pub fn is_link(self) -> bool {
        self.tag & NAME_SURROGATE != 0
    }

    /// A real folder to walk into, never a link to one.
    pub fn is_folder(self) -> bool {
        self.is_dir() && !self.is_link()
    }

    pub fn is_file(self) -> bool {
        !self.is_dir() && !self.is_link()
    }
}

/// The `\\?\` form, which turns off Windows path parsing. That gives long paths and keeps
/// names with a trailing dot or space intact, so `path` must already be absolute and clean.
pub fn extended(path: &Path) -> HSTRING {
    let wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    let units = |text: &str| text.encode_utf16().collect::<Vec<u16>>();
    if wide.starts_with(&units(r"\\?\")) {
        HSTRING::from_wide(&wide)
    } else if wide.starts_with(&units(r"\\")) {
        HSTRING::from_wide(&[units(r"\\?\UNC\").as_slice(), &wide[2..]].concat())
    } else {
        HSTRING::from_wide(&[units(r"\\?\").as_slice(), &wide].concat())
    }
}

/// Visits everything that matches `pattern`, including `.` and `..`.
pub fn each_entry(pattern: &HSTRING, mut visit: impl FnMut(&WIN32_FIND_DATAW)) -> Result<()> {
    let mut data = WIN32_FIND_DATAW::default();
    let found = unsafe {
        FindFirstFileExW(
            pattern,
            FindExInfoBasic,
            (&raw mut data).cast(),
            FindExSearchNameMatch,
            None,
            FIND_FIRST_EX_LARGE_FETCH,
        )
    };
    let handle = match found {
        Ok(handle) => handle,
        // An empty drive root has no "." entry, so nothing matches.
        Err(error) if error.code() == ERROR_FILE_NOT_FOUND.to_hresult() => return Ok(()),
        Err(error) => return Err(error),
    };

    let finished = loop {
        visit(&data);
        if let Err(error) = unsafe { FindNextFileW(handle, &mut data) } {
            break if error.code() == ERROR_NO_MORE_FILES.to_hresult() {
                Ok(())
            } else {
                Err(error)
            };
        }
    };
    unsafe { FindClose(handle) }?;
    finished
}

/// Facts about the object at `path` itself, never what a link points to. `None` if nothing
/// is there. A drive root is an error.
pub fn stat(path: &Path) -> Result<Option<Stat>> {
    let mut found = None;
    match each_entry(&extended(path), |data| {
        found = Some(Stat::from_find_data(data));
    }) {
        Err(error) if error.code() == ERROR_PATH_NOT_FOUND.to_hresult() => Ok(None),
        finished => finished.map(|()| found),
    }
}

pub fn read_dir(folder: &Path) -> Result<Vec<(OsString, Stat)>> {
    let mut entries = Vec::new();
    each_entry(&extended(&folder.join("*")), |data| {
        let length = data.cFileName.iter().position(|&unit| unit == 0).unwrap_or(0);
        let name = &data.cFileName[..length];
        if name != [b'.' as u16] && name != [b'.' as u16, b'.' as u16] {
            entries.push((OsString::from_wide(name), Stat::from_find_data(data)));
        }
    })?;
    Ok(entries)
}

fn open(path: &Path, access: u32, flags: FILE_FLAGS_AND_ATTRIBUTES) -> Result<Owned<HANDLE>> {
    unsafe {
        let file = CreateFileW(
            &extended(path),
            access,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            None,
            OPEN_EXISTING,
            flags,
            None,
        )?;
        Ok(Owned::new(file))
    }
}

/// Opens the object itself, never a link's target.
fn open_object(path: &Path, access: u32) -> Result<Owned<HANDLE>> {
    open(path, access, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
}

fn identity(path: &Path) -> Result<(u32, u64)> {
    let file = open_object(path, FILE_READ_ATTRIBUTES.0)?;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    unsafe { GetFileInformationByHandle(*file, &mut info) }?;
    let index = (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow);
    Ok((info.dwVolumeSerialNumber, index))
}

/// True when two paths reach the same object, such as through a junction.
pub fn same_file(a: &Path, b: &Path) -> Result<bool> {
    Ok(identity(a)? == identity(b)?)
}

/// The real location of a folder with every link followed, for comparing only.
pub fn final_path(path: &Path) -> Result<String> {
    let file = open(path, FILE_READ_ATTRIBUTES.0, FILE_FLAG_BACKUP_SEMANTICS)?;
    let mut text = vec![0; 32768];
    let length = unsafe {
        GetFinalPathNameByHandleW(
            *file,
            &mut text,
            GETFINALPATHNAMEBYHANDLE_FLAGS(FILE_NAME_NORMALIZED.0 | VOLUME_NAME_NT.0),
        )
    };
    if length == 0 {
        return Err(Error::from_thread());
    }
    Ok(String::from_utf16_lossy(&text[..length as usize]).to_lowercase())
}

/// True when `path` is `folder` or anything under it. Both come from `final_path`.
pub fn is_inside(path: &str, folder: &str) -> bool {
    path == folder
        || path
            .strip_prefix(folder)
            .is_some_and(|rest| rest.starts_with('\\'))
}

pub fn is_cross_drive(error: &Error) -> bool {
    error.code() == ERROR_NOT_SAME_DEVICE.to_hresult()
}

pub fn is_access_denied(error: &Error) -> bool {
    error.code() == ERROR_ACCESS_DENIED.to_hresult()
}

/// Another program holds the file.
pub fn is_in_use(error: &Error) -> bool {
    let code = error.code();
    code == ERROR_SHARING_VIOLATION.to_hresult() || code == ERROR_LOCK_VIOLATION.to_hresult()
}

/// Up to `room` more files at or under `path`, for asking who holds them.
fn files_under(path: &Path, room: usize, files: &mut Vec<PathBuf>) {
    match stat(path) {
        Ok(Some(found)) if found.is_folder() => {
            for (name, _) in read_dir(path).unwrap_or_default() {
                if files.len() < room {
                    files_under(&path.join(name), room, files);
                }
            }
        }
        Ok(Some(found)) if !found.is_dir() && files.len() < room => files.push(path.to_path_buf()),
        _ => {}
    }
}

/// The apps holding files at or under `paths`, through Windows Restart Manager. It can only ask
/// about files, so a folder held open by something's current directory shows nothing.
pub fn users_of(paths: &[PathBuf]) -> Vec<String> {
    let mut files = Vec::new();
    for path in paths {
        files_under(path, USERS_FILE_LIMIT, &mut files);
    }
    let names: Vec<HSTRING> = files.iter().map(|file| HSTRING::from(file.as_os_str())).collect();
    let raw: Vec<PCWSTR> = names.iter().map(|name| PCWSTR(name.as_ptr())).collect();
    let mut session = 0;
    let mut key = [0u16; CCH_RM_SESSION_KEY as usize + 1];
    unsafe {
        if RmStartSession(&raw mut session, None, PWSTR(key.as_mut_ptr())) != ERROR_SUCCESS {
            return Vec::new();
        }
        let users = session_users(session, &raw);
        let _ = RmEndSession(session);
        users
    }
}

unsafe fn session_users(session: u32, files: &[PCWSTR]) -> Vec<String> {
    let (mut needed, mut count, mut reasons) = (0, 0, 0);
    unsafe {
        if RmRegisterResources(session, Some(files), None, None) != ERROR_SUCCESS
            || RmGetList(session, &raw mut needed, &raw mut count, None, &raw mut reasons) != ERROR_MORE_DATA
        {
            return Vec::new();
        }
        let mut found = vec![RM_PROCESS_INFO::default(); needed as usize];
        count = needed;
        if RmGetList(session, &raw mut needed, &raw mut count, Some(found.as_mut_ptr()), &raw mut reasons)
            != ERROR_SUCCESS
        {
            return Vec::new();
        }
        found.truncate(count as usize);
        let name = |info: &RM_PROCESS_INFO| {
            let length = info.strAppName.iter().position(|&unit| unit == 0)?;
            Some(String::from_utf16_lossy(&info.strAppName[..length]))
        };
        let mut users: Vec<String> = found.iter().filter_map(name).collect();
        users.sort();
        users.dedup();
        users
    }
}

struct CopyState<'a> {
    report: &'a mut dyn FnMut(u64) -> bool,
    flush: bool,
    failure: Option<Error>,
}

/// Runs on the thread that called `CopyFile2`.
unsafe extern "system" fn copy_progress(
    message: *const COPYFILE2_MESSAGE,
    state: *const c_void,
) -> COPYFILE2_MESSAGE_ACTION {
    let (message, state) = (&*message, &mut *(state as *mut CopyState));
    match message.Type {
        COPYFILE2_CALLBACK_CHUNK_FINISHED
            if !(state.report)(message.Info.ChunkFinished.uliTotalBytesTransferred) =>
        {
            COPYFILE2_PROGRESS_CANCEL
        }
        COPYFILE2_CALLBACK_STREAM_FINISHED if state.flush => {
            match FlushFileBuffers(message.Info.StreamFinished.hDestinationFile) {
                Ok(()) => COPYFILE2_PROGRESS_CONTINUE,
                Err(error) => {
                    state.failure = Some(error);
                    COPYFILE2_PROGRESS_CANCEL
                }
            }
        }
        _ => COPYFILE2_PROGRESS_CONTINUE,
    }
}

/// Copies a file to a new name. `report` gets the bytes so far and returns false to cancel,
/// which removes the partial copy. With `flush` the bytes are on the disk at return.
pub fn copy_file(
    from: &Path,
    to: &Path,
    flush: bool,
    mut report: impl FnMut(u64) -> bool,
) -> Result<()> {
    guard(to);
    let mut state = CopyState {
        report: &mut report,
        flush,
        failure: None,
    };
    let parameters = COPYFILE2_EXTENDED_PARAMETERS {
        dwSize: size_of::<COPYFILE2_EXTENDED_PARAMETERS>() as u32,
        dwCopyFlags: COPY_FILE_FAIL_IF_EXISTS,
        pProgressRoutine: Some(copy_progress),
        pvCallbackContext: (&raw mut state).cast(),
        ..Default::default()
    };
    let copied = unsafe { CopyFile2(&extended(from), &extended(to), Some(&parameters)) };
    match state.failure {
        Some(error) => Err(error),
        None => copied,
    }
}

/// Renames without replacing anything. Windows refuses if `to` is on another drive.
pub fn rename(from: &Path, to: &Path) -> Result<()> {
    guard(from);
    guard(to);
    unsafe { MoveFileExW(&extended(from), &extended(to), MOVE_FILE_FLAGS(0)) }
}

/// The first step of every move, so tests can make it look like another drive.
pub fn move_path(from: &Path, to: &Path) -> Result<()> {
    #[cfg(test)]
    if test_guard::crossing_drives() {
        return Err(ERROR_NOT_SAME_DEVICE.to_hresult().into());
    }
    rename(from, to)
}

pub fn create_dir(path: &Path) -> Result<()> {
    guard(path);
    unsafe { CreateDirectoryW(&extended(path), None) }
}

/// Creates a folder that copies the look of `model`.
pub fn create_dir_like(path: &Path, model: Stat) -> Result<()> {
    create_dir(path)?;
    let attributes = model.attributes & FOLDER_ATTRIBUTES;
    if attributes != 0 {
        let attributes = FILE_FLAGS_AND_ATTRIBUTES(attributes | FILE_ATTRIBUTE_ARCHIVE.0);
        unsafe { SetFileAttributesW(&extended(path), attributes) }?;
    }
    Ok(())
}

/// Creates a folder and any missing parents. A folder already there is fine.
pub fn create_dirs(path: &Path) -> Result<()> {
    // Windows may answer access denied, not already exists, for a drive root.
    if final_path(path).is_ok() {
        return Ok(());
    }
    match create_dir(path) {
        Err(error) if error.code() == ERROR_ALREADY_EXISTS.to_hresult() => Ok(()),
        Err(error) if error.code() == ERROR_PATH_NOT_FOUND.to_hresult() => {
            create_dirs(path.parent().ok_or(error)?)?;
            create_dir(path)
        }
        created => created,
    }
}

/// Writes a file that must not exist yet.
pub fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
    fill_new(path, |file| file.write_all(bytes))
}

/// Makes a file that must not exist yet. If `fill` fails the file goes again, because nothing
/// records it and it would block a retry under the same name.
pub(super) fn fill_new(path: &Path, fill: impl FnOnce(&mut File) -> std::io::Result<()>) -> Result<()> {
    guard(path);
    let target = PathBuf::from(extended(path).to_os_string());
    let mut file = File::options().write(true).create_new(true).open(target)?;
    let filled = fill(&mut file);
    drop(file);
    if filled.is_err() {
        let _ = delete_file(path);
    }
    Ok(filled?)
}

pub fn create_file(path: &Path) -> Result<()> {
    guard(path);
    unsafe {
        CreateFileW(
            &extended(path),
            GENERIC_WRITE.0,
            FILE_SHARE_READ,
            None,
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL,
            None,
        )
        .map(|file| drop(Owned::new(file)))
    }
}

/// Clears the read-only mark on the object itself, then runs `action` again.
fn retry_writable(path: &Path, error: Error, action: impl Fn() -> Result<()>) -> Result<()> {
    if !is_access_denied(&error) {
        return Err(error);
    }
    let file = open_object(path, FILE_READ_ATTRIBUTES.0 | FILE_WRITE_ATTRIBUTES.0).map_err(|_| error.clone())?;
    let size = size_of::<FILE_BASIC_INFO>() as u32;
    let mut info = FILE_BASIC_INFO::default();
    unsafe { GetFileInformationByHandleEx(*file, FileBasicInfo, (&raw mut info).cast(), size) }?;
    if info.FileAttributes & FILE_ATTRIBUTE_READONLY.0 == 0 {
        return Err(error);
    }
    let attributes = info.FileAttributes & !FILE_ATTRIBUTE_READONLY.0;
    let attributes = if attributes == 0 { FILE_ATTRIBUTE_NORMAL.0 } else { attributes };
    // Times left at zero stay as they are.
    let info = FILE_BASIC_INFO {
        FileAttributes: attributes,
        ..Default::default()
    };
    unsafe { SetFileInformationByHandle(*file, FileBasicInfo, (&raw const info).cast(), size) }?;
    drop(file);
    action()
}

/// False once process `id` has ended. A process this user may not look at is still running.
pub fn is_running(id: u32) -> bool {
    match unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, id) } {
        Ok(process) => {
            let process = unsafe { Owned::new(process) };
            let mut code = 0;
            let asked = unsafe { GetExitCodeProcess(*process, &mut code) };
            asked.is_ok() && code == STILL_ACTIVE.0 as u32
        }
        Err(error) => is_access_denied(&error),
    }
}

/// Deletes a file or a link to a file. A link's target is never touched.
pub fn delete_file(path: &Path) -> Result<()> {
    guard(path);
    let name = extended(path);
    let delete = || unsafe { DeleteFileW(&name) };
    delete().or_else(|error| retry_writable(path, error, delete))
}

/// Removes an empty folder or a link to a folder. A link's target is never touched, and
/// Windows refuses a folder that is not empty.
pub fn remove_dir(path: &Path) -> Result<()> {
    guard(path);
    let name = extended(path);
    let remove = || unsafe { RemoveDirectoryW(&name) };
    remove().or_else(|error| retry_writable(path, error, remove))
}

pub fn set_times(path: &Path, created: u64, modified: u64) -> Result<()> {
    guard(path);
    let time = |ticks: u64| FILETIME {
        dwLowDateTime: ticks as u32,
        dwHighDateTime: (ticks >> 32) as u32,
    };
    let file = open_object(path, FILE_WRITE_ATTRIBUTES.0)?;
    unsafe { SetFileTime(*file, Some(&time(created)), None, Some(&time(modified))) }
}

pub fn read_link(path: &Path) -> Result<Vec<u8>> {
    let file = open_object(path, FILE_READ_ATTRIBUTES.0)?;
    let mut data = vec![0u8; MAXIMUM_REPARSE_DATA_BUFFER_SIZE as usize];
    let mut written = 0;
    unsafe {
        DeviceIoControl(
            *file,
            FSCTL_GET_REPARSE_POINT,
            None,
            0,
            Some(data.as_mut_ptr().cast()),
            data.len() as u32,
            Some(&mut written),
            None,
        )
    }?;
    data.truncate(written as usize);
    Ok(data)
}

/// Makes a link from `read_link` data. A symlink needs a privilege most users lack.
pub fn write_link(path: &Path, data: &[u8], directory: bool) -> Result<()> {
    if directory {
        create_dir(path)?;
    } else {
        create_file(path)?;
    }
    let linked = open_object(path, GENERIC_WRITE.0).and_then(|file| unsafe {
        DeviceIoControl(
            *file,
            FSCTL_SET_REPARSE_POINT,
            Some(data.as_ptr().cast()),
            data.len() as u32,
            None,
            0,
            None,
            None,
        )
    });
    if linked.is_err() {
        let _ = if directory { remove_dir(path) } else { delete_file(path) };
    }
    linked
}

/// Asks Windows to redraw the Recycle Bin icon after files left the bin without its help.
pub fn refresh_bin_icon() {
    windows_core::link!("shell32.dll" "system" fn SHUpdateRecycleBinIcon() -> windows_core::HRESULT);
    let _ = unsafe { SHUpdateRecycleBinIcon() };
}

/// Permanently deletes everything in every Recycle Bin.
pub fn empty_bin() -> Result<()> {
    if cfg!(test) {
        panic!("tests never empty the real Recycle Bin");
    }
    match unsafe {
        SHEmptyRecycleBinW(
            None,
            None,
            SHERB_NOCONFIRMATION | SHERB_NOPROGRESSUI | SHERB_NOSOUND,
        )
    } {
        // What Windows answers when the bin is already empty.
        Err(error) if error.code() == E_UNEXPECTED => Ok(()),
        emptied => emptied,
    }
}

#[cfg(not(test))]
#[inline(always)]
pub fn guard(_path: &Path) {}

#[cfg(test)]
pub use test_guard::guard;

/// Every test names its temp folder here. Anything that writes outside it panics, and so does
/// any write on a thread that named none.
#[cfg(test)]
pub mod test_guard {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::path::Component;

    thread_local! {
        static ROOT: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
        static ALLOWED: RefCell<Vec<PathBuf>> = const { RefCell::new(Vec::new()) };
        static CROSSING: Cell<bool> = const { Cell::new(false) };
    }

    pub fn guard(path: &Path) {
        let climbs = path.components().any(|part| part == Component::ParentDir);
        let inside = ROOT.with_borrow(|root| {
            root.as_ref().is_some_and(|root| path.starts_with(root))
        });
        let allowed = ALLOWED.with_borrow(|allowed| allowed.iter().any(|exact| exact == path));
        assert!(
            (inside && !climbs) || allowed,
            "a test reached {path:?}, outside its temp folder"
        );
    }

    pub fn enter(root: &Path) {
        ROOT.set(Some(root.to_path_buf()));
    }

    /// Lets a test touch one exact path, for the bin copies of items it recycled itself.
    pub fn allow(path: &Path) {
        ALLOWED.with_borrow_mut(|allowed| allowed.push(path.to_path_buf()));
    }

    pub fn pretend_other_drive(crossing: bool) {
        CROSSING.set(crossing);
    }

    pub fn crossing_drives() -> bool {
        CROSSING.get()
    }
}

/// The folder a path sits in, never empty.
pub fn parent(path: &Path) -> PathBuf {
    path.parent().unwrap_or(path).to_path_buf()
}
