//! The opt-in helper that tells the index what changed on this PC's drives while no Perli ran,
//! from each NTFS drive's change journal, so a start needs no walk of the drives again. Only an
//! administrator may read the journal, and Perli runs without admin rights, so:
//!
//! - Set up once, with Windows asking for admin, Perli copies itself into a folder of its own in
//!   Program Files, where only an administrator can write, and registers a task that runs that
//!   copy with the highest rights for this user, always as `perli.exe --journal`.
//! - Each start, Perli runs that task, which Windows lets it do without asking again.
//! - The copy reads nothing a user could change: its state and what it finds go in its own folder,
//!   the finds readable only by the user it runs for. So nothing running as the user can make it
//!   run anything else, read anything else or write anywhere else.
//!
//! Its finds are the paths of what changed, which Perli then reads again one by one. A drive whose
//! journal started over, or that changed past `MOST_PATHS`, is walked again as before.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::os::windows::io::FromRawHandle;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use windows::core::{w, HSTRING, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, HLOCAL, LocalFree, ERROR_CANCELLED, GENERIC_READ, GENERIC_WRITE};
use windows::Win32::Security::Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1};
use windows::Win32::Security::{GetTokenInformation, TokenElevation, TokenElevationType, TokenElevationTypeDefault, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_ELEVATION, TOKEN_ELEVATION_TYPE, TOKEN_QUERY};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, GetDriveTypeW, GetFinalPathNameByHandleW, GetLogicalDrives, GetVolumeInformationW, OpenFileById, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_ID_DESCRIPTOR, FILE_ID_DESCRIPTOR_0, FILE_ID_TYPE, FILE_NAME_NORMALIZED, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE,
    FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows::Win32::System::Ioctl::{FSCTL_QUERY_USN_JOURNAL, FSCTL_READ_USN_JOURNAL, READ_USN_JOURNAL_DATA_V0, USN_JOURNAL_DATA_V0};
use windows::Win32::System::Threading::{GetCurrentProcess, GetExitCodeProcess, OpenProcessToken, WaitForSingleObject, CREATE_NO_WINDOW, INFINITE};
use windows::Win32::System::WindowsProgramming::DRIVE_FIXED;
use windows::Win32::System::IO::DeviceIoControl;
use windows::Win32::UI::Shell::{FOLDERID_ProgramFiles, IsUserAnAdmin, ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

/// What the task runs, and what sets it up and takes it away, each with Windows asking for admin.
pub const RUN: &str = "--journal";
pub const SET_UP: &str = "--journal-set-up";
pub const TAKE_AWAY: &str = "--journal-take-away";
/// What the uninstaller runs: takes the helper away, asking for admin, only if it is set up.
pub const OFF: &str = "--journal-off";
/// Goes up whenever what the helper does changes, so an older copy is set up again.
const VERSION: u32 = 2;
/// Journal reasons and the attribute that make a record a folder made or moved to its path.
const MADE: u32 = 0x0000_0100;
const MOVED_HERE: u32 = 0x0000_2000;
const FOLDER_ATTRIBUTE: u32 = 0x10;
const FOLDER: &str = "Perli Helper";
const EXE: &str = "perli.exe";
/// Past this many changed paths on a drive, it is walked again instead.
const MOST_PATHS: usize = 200_000;
/// How long Perli waits for the task to finish.
const TASK_WAIT: Duration = Duration::from_secs(90);
const BUFFER: usize = 1 << 20;

/// What the helper found on one drive.
#[derive(Debug, PartialEq)]
pub enum Found {
    /// Something there changed, made or went: its path.
    Changed(PathBuf),
    /// A folder made or moved to this path, which may have held another folder before.
    Fresh(PathBuf),
    /// Every change on this drive is in the list.
    Caught(PathBuf),
    /// Its changes aren't known: its journal started over, or too much changed.
    Lost(PathBuf),
}

#[derive(Clone, Copy, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// This user is an administrator, so the helper can be set up.
    pub possible: bool,
    pub on: bool,
    /// Set up by an older Perli, and to be set up again.
    pub old: bool,
}

/// The helper's folder in Program Files, where only an administrator can write. Windows says
/// where Program Files is, not anything the user sets.
fn folder() -> Option<PathBuf> {
    crate::places::known_folder(&FOLDERID_ProgramFiles).map(|files| Path::new(&files).join(FOLDER))
}

fn task_name(sid: &str) -> String {
    format!("\\Perli\\Journal {sid}")
}

fn finds_of(folder: &Path, sid: &str) -> PathBuf {
    folder.join(format!("{sid}.txt"))
}

fn state_of(folder: &Path, sid: &str) -> PathBuf {
    folder.join(format!("{sid}.state"))
}

/// `schtasks.exe` from System32, not whatever a changed PATH finds first.
fn schtasks() -> Command {
    let system = crate::places::known_folder(&windows::Win32::UI::Shell::FOLDERID_System).unwrap_or_else(|| "C:\\Windows\\System32".into());
    let mut command = Command::new(Path::new(&system).join("schtasks.exe"));
    command.creation_flags(CREATE_NO_WINDOW.0);
    command
}

fn token_info<T: Default>(class: windows::Win32::Security::TOKEN_INFORMATION_CLASS) -> Option<T> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).ok()?;
        let mut info = T::default();
        let mut size = 0;
        let read = GetTokenInformation(token, class, Some((&mut info as *mut T).cast()), std::mem::size_of::<T>() as u32, &mut size);
        let _ = CloseHandle(token);
        read.ok().map(|()| info)
    }
}

fn elevated() -> bool {
    token_info::<TOKEN_ELEVATION>(TokenElevation).is_some_and(|elevation| elevation.TokenIsElevated != 0)
}

pub fn status() -> Status {
    // An administrator with UAC on runs with a split token; with it off, as an administrator.
    let split = token_info::<TOKEN_ELEVATION_TYPE>(TokenElevationType).is_some_and(|kind| kind != TokenElevationTypeDefault);
    let possible = split || unsafe { IsUserAnAdmin() }.as_bool();
    let (Some(folder), Ok(sid)) = (folder(), crate::ops::user_sid()) else { return Status { possible, on: false, old: false } };
    let finds = fs::read_to_string(finds_of(&folder, &sid)).ok();
    let on = finds.is_some() && folder.join(EXE).exists();
    let old = on && finds.as_deref().and_then(|text| text.lines().next()) != Some(header().as_str());
    Status { possible, on, old }
}

fn header() -> String {
    format!("perli-journal {VERSION}")
}

/// Runs this Perli again with Windows asking for admin, to set the helper up or take it away.
pub fn change(on: bool) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let file = HSTRING::from(exe.as_os_str());
    let argument = HSTRING::from(if on { SET_UP } else { TAKE_AWAY });
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC,
        lpVerb: w!("runas"),
        lpFile: PCWSTR(file.as_ptr()),
        lpParameters: PCWSTR(argument.as_ptr()),
        nShow: SW_HIDE.0,
        ..Default::default()
    };
    if let Err(error) = unsafe { ShellExecuteExW(&mut info) } {
        return Err(if error.code() == ERROR_CANCELLED.to_hresult() { "Windows didn't get the go-ahead, so nothing changed".into() } else { error.message() });
    }
    let mut code = 1;
    unsafe {
        WaitForSingleObject(info.hProcess, INFINITE);
        let _ = GetExitCodeProcess(info.hProcess, &mut code);
        let _ = CloseHandle(info.hProcess);
    }
    match code {
        0 => Ok(()),
        _ => Err("The helper couldn't be set up".into()),
    }
}

/// Takes the helper away if it is set up, as Perli is uninstalled.
pub fn off() -> Result<(), String> {
    if status().on {
        change(false)?;
    }
    Ok(())
}

/// Runs the task and reads what it found, with the stamp of its report for the index to keep once
/// it has taken all of it in, or `None` when the helper isn't set up or didn't answer.
///
/// The helper moves on from each report as it writes it, so a Perli that stopped before its index
/// took one in would lose those changes. So the last report comes along too, unless `applied`, the
/// stamp the index kept, says it was taken in. Its drives caught up count only through the new one.
pub fn catch_up(applied: Option<&str>) -> Option<(Vec<Found>, String)> {
    let (folder, sid) = (folder()?, crate::ops::user_sid().ok()?);
    let finds = finds_of(&folder, &sid);
    let before = fs::metadata(&finds).and_then(|meta| meta.modified()).ok()?;
    let mut found = if applied == Some(stamp_of(before).as_str()) { Vec::new() } else { not_taken_in(&fs::read_to_string(&finds).unwrap_or_default()) };
    let started = schtasks().args(["/run", "/tn", &task_name(&sid)]).status().ok()?;
    if !started.success() {
        return None;
    }
    let deadline = Instant::now() + TASK_WAIT;
    let after = loop {
        let now = fs::metadata(&finds).and_then(|meta| meta.modified()).ok()?;
        if now > before {
            break now;
        }
        if Instant::now() > deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(250));
    };
    found.extend(read_finds(&fs::read_to_string(&finds).ok()?));
    Some((found, stamp_of(after)))
}

fn stamp_of(time: std::time::SystemTime) -> String {
    time.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos().to_string()
}

/// What a report the index never took in still tells: its changes, and its drives lost. That a
/// drive was caught up then says nothing of now.
fn not_taken_in(text: &str) -> Vec<Found> {
    read_finds(text).into_iter().filter(|found| !matches!(found, Found::Caught(_))).collect()
}

/// The finds as the helper writes them: a header, then a line for each.
fn read_finds(text: &str) -> Vec<Found> {
    text.lines()
        .skip(1)
        .filter_map(|line| match line.split_once('\t') {
            Some(("caught", root)) => Some(Found::Caught(root.into())),
            Some(("fresh", path)) => Some(Found::Fresh(path.into())),
            Some(("lost", root)) => Some(Found::Lost(root.into())),
            _ if !line.is_empty() => Some(Found::Changed(line.into())),
            _ => None,
        })
        .collect()
}

/// What the helper does, in the copy the task runs or the one Windows asked admin for. The exit
/// code says how it went.
pub fn helper(argument: &str) -> i32 {
    if !elevated() {
        return 2;
    }
    let (Some(folder), Ok(sid)) = (folder(), crate::ops::user_sid()) else { return 3 };
    let done = match argument {
        RUN => report(&folder, &sid, false),
        SET_UP => set_up(&folder, &sid),
        _ => take_away(&folder, &sid),
    };
    i32::from(done.is_err())
}

fn set_up(folder: &Path, sid: &str) -> Result<(), String> {
    let failed = |error: std::io::Error| error.to_string();
    fs::create_dir_all(folder).map_err(failed)?;
    fs::copy(std::env::current_exe().map_err(failed)?, folder.join(EXE)).map_err(failed)?;
    let exe = folder.join(EXE).to_string_lossy().replace('&', "&amp;");
    // No trigger: it runs when Perli asks, as this user, with the highest rights, and always so.
    let xml = format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Tells Perli what changed on this PC's drives while it was closed.</Description></RegistrationInfo>
  <Principals><Principal id="Author"><UserId>{sid}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>HighestAvailable</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author"><Exec><Command>"{exe}"</Command><Arguments>{RUN}</Arguments></Exec></Actions>
</Task>"#
    );
    let file = folder.join(format!("{sid}.xml"));
    let bytes: Vec<u8> = [0xFEFF].into_iter().chain(xml.encode_utf16()).flat_map(u16::to_le_bytes).collect();
    fs::write(&file, bytes).map_err(failed)?;
    let made = schtasks().args(["/create", "/tn", &task_name(sid), "/xml"]).arg(&file).arg("/f").status();
    let _ = fs::remove_file(&file);
    if !made.map_err(failed)?.success() {
        return Err("The task wasn't made".into());
    }
    // From now on: what changes from here is what the next start hears.
    report(folder, sid, true)
}

fn take_away(folder: &Path, sid: &str) -> Result<(), String> {
    let _ = schtasks().args(["/delete", "/tn", &task_name(sid), "/f"]).status();
    let _ = fs::remove_file(finds_of(folder, sid));
    let _ = fs::remove_file(state_of(folder, sid));
    // The copy stays while another user of this PC still has it set up.
    let others = fs::read_dir(folder).map(|entries| entries.flatten().any(|entry| entry.path().extension().is_some_and(|end| end == "txt"))).unwrap_or(false);
    if !others {
        let _ = fs::remove_file(folder.join(EXE));
        let _ = fs::remove_dir(folder);
    }
    Ok(())
}

/// Reads each fixed NTFS drive's journal from where the last report left off, and writes what
/// changed for this user only to read. A `fresh` report only notes where each journal is.
fn report(folder: &Path, sid: &str, fresh: bool) -> Result<(), String> {
    let state_file = state_of(folder, sid);
    let mut state: HashMap<String, (u64, i64)> = fs::read_to_string(&state_file)
        .unwrap_or_default()
        .lines()
        .filter_map(|line| {
            let mut parts = line.split(' ');
            Some((parts.next()?.to_string(), (parts.next()?.parse().ok()?, parts.next()?.parse().ok()?)))
        })
        .collect();
    let mut lines = vec![header()];
    for root in ntfs_drives() {
        let Some(volume) = Volume::open(&root) else { continue };
        let Some(journal) = volume.journal() else { continue };
        let known = state.get(&root).copied().filter(|&(id, usn)| !fresh && id == journal.UsnJournalID && usn >= journal.FirstUsn);
        let read = known.map(|(_, usn)| volume.changes(&root, usn, journal.NextUsn, journal.UsnJournalID));
        match read {
            Some(Some((paths, fresh, next))) => {
                lines.extend(paths.iter().map(|path| path.to_string_lossy().into_owned()));
                lines.extend(fresh.iter().map(|path| format!("fresh\t{}", path.to_string_lossy())));
                lines.push(format!("caught\t{root}"));
                state.insert(root, (journal.UsnJournalID, next));
            }
            _ if fresh => {
                state.insert(root, (journal.UsnJournalID, journal.NextUsn));
            }
            _ => {
                lines.push(format!("lost\t{root}"));
                state.insert(root, (journal.UsnJournalID, journal.NextUsn));
            }
        }
    }
    let saved: String = state.iter().map(|(root, (id, usn))| format!("{root} {id} {usn}\n")).collect();
    fs::write(&state_file, saved).map_err(|error| error.to_string())?;
    write_private(&finds_of(folder, sid), sid, &(lines.join("\n") + "\n"))
}

/// Writes `text` to `file` for SYSTEM, administrators and the user `sid` alone: other users of
/// this PC can't read what changed in places only an administrator can see.
fn write_private(file: &Path, sid: &str, text: &str) -> Result<(), String> {
    let staged = file.with_extension("new");
    let _ = fs::remove_file(&staged);
    let rules = HSTRING::from(format!("D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;{sid})"));
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(&rules, SDDL_REVISION_1, &mut descriptor, None) }.map_err(|error| error.message())?;
    let attributes = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: descriptor.0, bInheritHandle: false.into() };
    let opened = unsafe { CreateFileW(&HSTRING::from(staged.as_os_str()), GENERIC_WRITE.0, Default::default(), Some(&attributes), CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, None) };
    unsafe { LocalFree(Some(HLOCAL(descriptor.0))) };
    let handle = opened.map_err(|error| error.message())?;
    let mut out = unsafe { fs::File::from_raw_handle(handle.0) };
    std::io::Write::write_all(&mut out, text.as_bytes()).map_err(|error| error.to_string())?;
    drop(out);
    // Renamed, it keeps its own rules.
    fs::rename(&staged, file).map_err(|error| error.to_string())
}

/// Each fixed drive formatted NTFS, as `C:\`.
fn ntfs_drives() -> Vec<String> {
    let letters = unsafe { GetLogicalDrives() };
    (0..26u8)
        .filter(|at| letters & (1 << at) != 0)
        .map(|at| format!("{}:\\", char::from(b'A' + at)))
        .filter(|root| {
            let wide = HSTRING::from(root.as_str());
            let mut system = [0u16; 16];
            let read = unsafe { GetDriveTypeW(&wide) == DRIVE_FIXED && GetVolumeInformationW(&wide, None, None, None, None, Some(&mut system)).is_ok() };
            read && String::from_utf16_lossy(&system).trim_end_matches('\0') == "NTFS"
        })
        .collect()
}

/// A drive opened to read its journal, and its top folder, to open what the journal names by id.
struct Volume {
    device: HANDLE,
    top: HANDLE,
}

impl Volume {
    fn open(root: &str) -> Option<Self> {
        let share = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
        let device_path = HSTRING::from(format!("\\\\.\\{}", root.trim_end_matches('\\')));
        let device = unsafe { CreateFileW(&device_path, GENERIC_READ.0, share, None, OPEN_EXISTING, Default::default(), None) }.ok()?;
        let top = unsafe { CreateFileW(&HSTRING::from(root), FILE_READ_ATTRIBUTES.0, share, None, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, None) };
        match top {
            Ok(top) => Some(Self { device, top }),
            Err(_) => {
                let _ = unsafe { CloseHandle(device) };
                None
            }
        }
    }

    fn journal(&self) -> Option<USN_JOURNAL_DATA_V0> {
        let mut data = USN_JOURNAL_DATA_V0::default();
        let mut bytes = 0;
        unsafe {
            DeviceIoControl(self.device, FSCTL_QUERY_USN_JOURNAL, None, 0, Some((&mut data as *mut USN_JOURNAL_DATA_V0).cast()), std::mem::size_of::<USN_JOURNAL_DATA_V0>() as u32, Some(&mut bytes), None)
        }
        .ok()
        .map(|()| data)
    }

    /// The path of each thing changed from `from` up to `to`, those of folders made or moved
    /// there, and where the journal was read to. `None` past `MOST_PATHS`.
    fn changes(&self, root: &str, from: i64, to: i64, journal: u64) -> Option<(Vec<PathBuf>, Vec<PathBuf>, i64)> {
        let mut named: HashSet<(u64, String)> = HashSet::new();
        let mut fresh: HashSet<(u64, String)> = HashSet::new();
        let mut ask = READ_USN_JOURNAL_DATA_V0 { StartUsn: from, ReasonMask: u32::MAX, ReturnOnlyOnClose: 0, Timeout: 0, BytesToWaitFor: 0, UsnJournalID: journal };
        let mut buffer = vec![0u64; BUFFER / 8];
        while ask.StartUsn < to {
            let mut bytes = 0u32;
            let asked = (&ask as *const READ_USN_JOURNAL_DATA_V0).cast();
            let size = std::mem::size_of::<READ_USN_JOURNAL_DATA_V0>() as u32;
            unsafe { DeviceIoControl(self.device, FSCTL_READ_USN_JOURNAL, Some(asked), size, Some(buffer.as_mut_ptr().cast()), BUFFER as u32, Some(&mut bytes), None) }.ok()?;
            let read = unsafe { std::slice::from_raw_parts(buffer.as_ptr().cast::<u8>(), bytes as usize) };
            let (next, found) = records(read)?;
            for (parent, name, made) in found {
                if made {
                    fresh.insert((parent, name.clone()));
                }
                named.insert((parent, name));
            }
            if named.len() > MOST_PATHS {
                return None;
            }
            if next <= ask.StartUsn {
                break;
            }
            ask.StartUsn = next;
        }
        // Each folder named once, by its id.
        let mut folders: HashMap<u64, Option<PathBuf>> = HashMap::new();
        let mut path_of = |(parent, name): (u64, String)| Some(folders.entry(parent).or_insert_with(|| self.path_of(parent, root)).clone()?.join(name));
        let mut paths: Vec<PathBuf> = named.into_iter().filter_map(&mut path_of).collect();
        let mut fresh: Vec<PathBuf> = fresh.into_iter().filter_map(&mut path_of).collect();
        paths.sort();
        fresh.sort();
        Some((paths, fresh, ask.StartUsn))
    }

    /// Where the folder with this id is now, if it still is.
    fn path_of(&self, id: u64, root: &str) -> Option<PathBuf> {
        let wanted = FILE_ID_DESCRIPTOR { dwSize: std::mem::size_of::<FILE_ID_DESCRIPTOR>() as u32, Type: FILE_ID_TYPE(0), Anonymous: FILE_ID_DESCRIPTOR_0 { FileId: id as i64 } };
        let share = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
        let opened = unsafe { OpenFileById(self.top, &wanted, FILE_READ_ATTRIBUTES.0, share, None, FILE_FLAG_BACKUP_SEMANTICS) }.ok()?;
        let mut path = vec![0u16; 32_768];
        let length = unsafe { GetFinalPathNameByHandleW(opened, &mut path, FILE_NAME_NORMALIZED) } as usize;
        let _ = unsafe { CloseHandle(opened) };
        let text = String::from_utf16_lossy(path.get(..length)?);
        // `\\?\C:\…` as it comes.
        let text = text.strip_prefix("\\\\?\\").unwrap_or(&text);
        let drive = root.trim_end_matches('\\');
        text.get(..drive.len()).filter(|start| start.eq_ignore_ascii_case(drive))?;
        Some(PathBuf::from(text))
    }
}

impl Drop for Volume {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.device) };
        let _ = unsafe { CloseHandle(self.top) };
    }
}

/// A journal record: the id of the folder it is in, its name, and whether it is a folder made or
/// moved there.
type Record = (u64, String, bool);

/// What a read of the journal gave: the USN to read on from, then each record as the id of the
/// folder it is in, its name, and whether it is a folder made or moved there. `None` when it
/// isn't laid out as a journal read is.
fn records(read: &[u8]) -> Option<(i64, Vec<Record>)> {
    let next = i64::from_le_bytes(read.get(..8)?.try_into().ok()?);
    let (u16_at, u32_at, u64_at) = (
        |at: usize| -> Option<u16> { Some(u16::from_le_bytes(read.get(at..at + 2)?.try_into().ok()?)) },
        |at: usize| -> Option<u32> { Some(u32::from_le_bytes(read.get(at..at + 4)?.try_into().ok()?)) },
        |at: usize| -> Option<u64> { Some(u64::from_le_bytes(read.get(at..at + 8)?.try_into().ok()?)) },
    );
    let mut found = Vec::new();
    let mut at = 8;
    while at + 60 <= read.len() {
        let length = u32_at(at)? as usize;
        if length < 60 {
            return None;
        }
        // Only version 2 records, the ones NTFS writes, hold 64-bit ids.
        if u16_at(at + 4)? == 2 {
            let parent = u64_at(at + 16)?;
            let made = u32_at(at + 40)? & (MADE | MOVED_HERE) != 0 && u32_at(at + 52)? & FOLDER_ATTRIBUTE != 0;
            let (name_length, name_at) = (u16_at(at + 56)? as usize, u16_at(at + 58)? as usize);
            let name = read.get(at + name_at..at + name_at + name_length)?;
            let units: Vec<u16> = (0..name.len() / 2).map(|unit| u16::from_le_bytes([name[2 * unit], name[2 * unit + 1]])).collect();
            found.push((parent, String::from_utf16_lossy(&units), made));
        }
        at += length;
    }
    Some((next, found))
}

/// For the tests: a journal read of records, each a folder id, a name, and whether it is a folder
/// made there.
#[cfg(test)]
fn journal_read(next: i64, records: &[(u64, &str, bool)]) -> Vec<u8> {
    let mut read = next.to_le_bytes().to_vec();
    for &(parent, name, made) in records {
        let units: Vec<u8> = name.encode_utf16().flat_map(u16::to_le_bytes).collect();
        let length = (60 + units.len()).div_ceil(8) * 8;
        let mut record = vec![0u8; length];
        record[..4].copy_from_slice(&(length as u32).to_le_bytes());
        record[4..6].copy_from_slice(&2u16.to_le_bytes());
        record[16..24].copy_from_slice(&parent.to_le_bytes());
        if made {
            record[40..44].copy_from_slice(&MADE.to_le_bytes());
            record[52..56].copy_from_slice(&FOLDER_ATTRIBUTE.to_le_bytes());
        }
        record[56..58].copy_from_slice(&(units.len() as u16).to_le_bytes());
        record[58..60].copy_from_slice(&60u16.to_le_bytes());
        record[60..60 + units.len()].copy_from_slice(&units);
        read.extend(record);
    }
    read
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_journal_read_gives_each_folder_and_name() {
        let read = journal_read(4096, &[(7, "notes.txt", false), (9, "Fotos", true)]);
        assert_eq!(records(&read), Some((4096, vec![(7, "notes.txt".to_string(), false), (9, "Fotos".to_string(), true)])));
        assert_eq!(records(&4096i64.to_le_bytes()), Some((4096, Vec::new())), "a read at the end has no records");
        let mut broken = read.clone();
        broken[8..12].copy_from_slice(&3u32.to_le_bytes());
        assert_eq!(records(&broken), None, "a record shorter than its header isn't read on");
    }

    #[test]
    fn a_report_never_taken_in_keeps_its_changes_and_losses_but_not_its_catch_up() {
        let text = "perli-journal 1\nC:\\a.txt\ncaught\tC:\\\nlost\tD:\\\n";
        assert_eq!(not_taken_in(text), vec![Found::Changed(r"C:\a.txt".into()), Found::Lost(r"D:\".into())]);
    }

    #[test]
    fn finds_read_back_as_written() {
        let text = format!("{}\nC:\\Users\\a\\b.txt\nfresh\tC:\\Users\\a\ncaught\tC:\\\nlost\tD:\\\n", header());
        assert_eq!(
            read_finds(&text),
            [Found::Changed("C:\\Users\\a\\b.txt".into()), Found::Fresh("C:\\Users\\a".into()), Found::Caught("C:\\".into()), Found::Lost("D:\\".into())]
        );
    }

    #[test]
    fn only_admin_runs_the_helper() {
        // Tests run without admin rights, so the helper does nothing and says so.
        if !elevated() {
            assert_eq!(helper(RUN), 2);
        }
    }
}
