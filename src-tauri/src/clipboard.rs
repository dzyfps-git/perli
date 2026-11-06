//! Files on the Windows clipboard, in Explorer's own formats so the two can trade.

use std::ffi::OsString;
use std::mem::size_of;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::PathBuf;
use std::ptr;
use std::thread;
use std::time::Duration;

use windows::core::{Error, Result};
use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL, HWND};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, GetClipboardSequenceNumber,
    IsClipboardFormatAvailable, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
};
use windows::Win32::System::Memory::{
    GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE,
};
use windows::Win32::System::Ole::{DROPEFFECT_COPY, DROPEFFECT_LINK, DROPEFFECT_MOVE};
use windows::Win32::UI::Shell::{CFSTR_PREFERREDDROPEFFECT, DROPFILES};

/// Windows' standard clipboard format number for a list of files.
const CF_HDROP: u32 = 15;

const OPEN_TRIES: u32 = 5;
const OPEN_WAIT: Duration = Duration::from_millis(20);

/// Where `DROPFILES` says whether its names are UTF-16.
const WIDE_FLAG_OFFSET: usize = 16;

pub struct Files {
    pub paths: Vec<PathBuf>,
    pub cut: bool,
}

/// The open clipboard, closed again when dropped.
struct Open;

impl Open {
    /// Other programs hold the clipboard for a moment at a time, so it is worth a few tries.
    fn new(owner: HWND) -> Result<Self> {
        let owner = (!owner.is_invalid()).then_some(owner);
        for _ in 1..OPEN_TRIES {
            if unsafe { OpenClipboard(owner) }.is_ok() {
                return Ok(Self);
            }
            thread::sleep(OPEN_WAIT);
        }
        unsafe { OpenClipboard(owner) }?;
        Ok(Self)
    }
}

impl Drop for Open {
    fn drop(&mut self) {
        let _ = unsafe { CloseClipboard() };
    }
}

fn effect_format() -> u32 {
    unsafe { RegisterClipboardFormatW(CFSTR_PREFERREDDROPEFFECT) }
}

fn encode(paths: &[PathBuf]) -> Vec<u8> {
    let mut bytes = vec![0; size_of::<DROPFILES>()];
    bytes[..4].copy_from_slice(&(size_of::<DROPFILES>() as u32).to_le_bytes());
    bytes[WIDE_FLAG_OFFSET] = 1;
    for path in paths {
        let name = path.as_os_str().encode_wide().chain([0]);
        bytes.extend(name.flat_map(u16::to_le_bytes));
    }
    bytes.extend([0, 0]);
    bytes
}

// ponytail: UTF-16 lists only, which every program since Windows 2000 writes.
fn decode(bytes: &[u8]) -> Option<Vec<PathBuf>> {
    let word = |at: usize| Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?));
    if word(WIDE_FLAG_OFFSET)? == 0 {
        return None;
    }
    let units: Vec<u16> = bytes
        .get(word(0)? as usize..)?
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    let names = units.split(|&unit| unit == 0).take_while(|name| !name.is_empty());
    Some(names.map(|name| OsString::from_wide(name).into()).collect())
}

unsafe fn put(format: u32, bytes: &[u8]) -> Result<()> {
    let memory = GlobalAlloc(GMEM_MOVEABLE, bytes.len())?;
    let target = GlobalLock(memory);
    if target.is_null() {
        let error = Error::from_thread();
        let _ = GlobalFree(Some(memory));
        return Err(error);
    }
    ptr::copy_nonoverlapping(bytes.as_ptr(), target.cast(), bytes.len());
    // Reports an error once the lock count reaches zero, which is the normal outcome.
    let _ = GlobalUnlock(memory);
    // The clipboard owns the memory once this works.
    if let Err(error) = SetClipboardData(format, Some(HANDLE(memory.0))) {
        let _ = GlobalFree(Some(memory));
        return Err(error);
    }
    Ok(())
}

unsafe fn take(format: u32) -> Option<Vec<u8>> {
    let memory = HGLOBAL(GetClipboardData(format).ok()?.0);
    let source = GlobalLock(memory) as *const u8;
    if source.is_null() {
        return None;
    }
    let bytes = std::slice::from_raw_parts(source, GlobalSize(memory)).to_vec();
    let _ = GlobalUnlock(memory);
    Some(bytes)
}

/// `owner` is a window of this program. With none, `EmptyClipboard` leaves the clipboard
/// without an owner, and Windows documents that `SetClipboardData` then fails.
pub fn write(paths: &[PathBuf], cut: bool, owner: isize) -> Result<()> {
    let effect = if cut {
        DROPEFFECT_MOVE.0
    } else {
        DROPEFFECT_COPY.0 | DROPEFFECT_LINK.0
    };
    let _open = Open::new(HWND(owner as _))?;
    unsafe {
        EmptyClipboard()?;
        put(CF_HDROP, &encode(paths))?;
        put(effect_format(), &effect.to_le_bytes())
    }
}

/// The files on the clipboard, if it holds any.
pub fn read() -> Result<Option<Files>> {
    if !has_files() {
        return Ok(None);
    }
    let _open = Open::new(HWND::default())?;
    let Some(paths) = (unsafe { take(CF_HDROP) }).as_deref().and_then(decode) else {
        return Ok(None);
    };
    let effect = unsafe { take(effect_format()) }.unwrap_or_default();
    let cut = effect.first().is_some_and(|&low| u32::from(low) & DROPEFFECT_MOVE.0 != 0);
    Ok(Some(Files { paths, cut }))
}

pub fn has_files() -> bool {
    unsafe { IsClipboardFormatAvailable(CF_HDROP) }.is_ok()
}

/// Changes every time any program writes the clipboard.
pub fn sequence() -> u32 {
    unsafe { GetClipboardSequenceNumber() }
}

/// A cut is used up once it is pasted, unless something else was copied since `seen`.
pub fn clear_if_unchanged(seen: u32) -> Result<()> {
    if sequence() != seen {
        return Ok(());
    }
    let _open = Open::new(HWND::default())?;
    unsafe { EmptyClipboard() }
}

#[cfg(test)]
mod tests {
    use std::process::Command;

    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::GENERIC_ALL;
    use windows::Win32::System::StationsAndDesktops::{
        CreateDesktopW, CreateWindowStationW, SetProcessWindowStation, SetThreadDesktop,
        DESKTOP_CONTROL_FLAGS,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, HWND_MESSAGE, WINDOW_EX_STYLE, WINDOW_STYLE,
    };

    use super::*;

    #[test]
    fn file_list_survives_encoding() {
        let paths = vec![PathBuf::from(r"C:\a b\ünï.txt"), PathBuf::from(r"D:\c.")];
        assert_eq!(decode(&encode(&paths)), Some(paths));
    }

    #[test]
    fn file_list_needs_wide_names_and_a_whole_header() {
        let mut bytes = encode(&[PathBuf::from(r"C:\a")]);
        assert_eq!(decode(&bytes[..8]), None);
        bytes[WIDE_FLAG_OFFSET] = 0;
        assert_eq!(decode(&bytes), None);
    }

    /// A window station has a clipboard of its own, so the user's is never touched. Joining one
    /// changes the whole process, so the real test gets a process to itself.
    #[test]
    fn files_survive_a_real_clipboard() {
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["clipboard::tests::private_round_trip", "--exact", "--ignored", "--nocapture"])
            .args(["--test-threads=1"])
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"), "{output:?}");
    }

    #[test]
    #[ignore = "files_survive_a_real_clipboard runs this in its own process"]
    fn private_round_trip() {
        let window = unsafe {
            let station = CreateWindowStationW(PCWSTR::null(), 0, GENERIC_ALL.0, None).unwrap();
            SetProcessWindowStation(station).unwrap();
            let desktop = CreateDesktopW(
                w!("perli-test"),
                PCWSTR::null(),
                None,
                DESKTOP_CONTROL_FLAGS(0),
                GENERIC_ALL.0,
                None,
            )
            .unwrap();
            SetThreadDesktop(desktop).unwrap();
            CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("STATIC"),
                PCWSTR::null(),
                WINDOW_STYLE(0),
                0,
                0,
                0,
                0,
                Some(HWND_MESSAGE),
                None,
                None,
                None,
            )
            .unwrap()
        };
        let paths = vec![PathBuf::from(r"C:\a.txt"), PathBuf::from(r"C:\b.txt")];

        write(&paths, true, window.0 as isize).unwrap();
        let files = read().unwrap().unwrap();
        assert_eq!(files.paths, paths);
        assert!(files.cut);

        clear_if_unchanged(sequence()).unwrap();
        assert!(!has_files());
    }
}
