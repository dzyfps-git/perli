//! The Recycle Bin, read directly from its `$I` and `$R` files. Asking the shell for each item
//! is slow, and its restore shows native conflict dialogs that bypass undo.

use std::ffi::OsString;
use std::fs;
use std::os::windows::ffi::OsStringExt;
use std::path::{Path, PathBuf};

use windows::core::{Error, Result, HSTRING, PWSTR};
use windows::Win32::Foundation::{CloseHandle, LocalFree, HANDLE, HLOCAL};
use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
use windows::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
use windows::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use windows::Win32::System::WindowsProgramming::{DRIVE_FIXED, DRIVE_REMOVABLE};

use super::sys;
use super::{Done, Flow, Run};

/// One deleted item.
#[derive(Clone, Debug, PartialEq)]
pub struct BinItem {
    /// The `$R` file or folder holding the data.
    pub item: PathBuf,
    pub original: PathBuf,
    pub size: u64,
    /// FILETIME ticks.
    pub deleted: u64,
    pub is_dir: bool,
}

/// The `$I` file that describes a `$R` item.
fn info_path(item: &Path) -> PathBuf {
    let name = item.file_name().unwrap_or_default().to_string_lossy();
    item.with_file_name(format!("$I{}", name.get(2..).unwrap_or_default()))
}

/// Reads a `$I` file: format version (u64), size (u64), deletion time (u64), then the path.
/// Version 1 holds it in a fixed 520 bytes, and version 2 has a length in UTF-16 units first.
pub(super) fn parse_info(bytes: &[u8]) -> Option<(u64, u64, PathBuf)> {
    let number = |at: usize| Some(u64::from_le_bytes(bytes.get(at..at + 8)?.try_into().ok()?));
    let name = match number(0)? {
        1 => bytes.get(24..)?,
        2 => {
            let length = u32::from_le_bytes(bytes.get(24..28)?.try_into().ok()?) as usize;
            bytes.get(28..28 + length * 2)?
        }
        _ => return None,
    };
    let units: Vec<u16> = name
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .take_while(|&unit| unit != 0)
        .collect();
    Some((number(8)?, number(16)?, OsString::from_wide(&units).into()))
}

/// The items in one user's bin folder on one drive.
pub fn read_root(root: &Path) -> Vec<BinItem> {
    let entries = sys::read_dir(root).unwrap_or_default();
    entries
        .into_iter()
        .filter_map(|(name, _)| {
            let name = name.to_str()?;
            let id = name.strip_prefix("$I")?;
            let (size, deleted, original) = parse_info(&fs::read(root.join(name)).ok()?)?;
            let item = root.join(format!("$R{id}"));
            let stat = sys::stat(&item).ok()??;
            Some(BinItem {
                item,
                original,
                size,
                deleted,
                is_dir: stat.is_dir(),
            })
        })
        .collect()
}

fn user_sid() -> Result<String> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token)?;
        let mut size = 0;
        // Answers how much room it needs by failing.
        let _ = GetTokenInformation(token, TokenUser, None, 0, &mut size);
        let mut data = vec![0u64; (size as usize).div_ceil(8)];
        let read = GetTokenInformation(token, TokenUser, Some(data.as_mut_ptr().cast()), size, &mut size);
        CloseHandle(token)?;
        read?;

        let user = &*data.as_ptr().cast::<TOKEN_USER>();
        let mut text = PWSTR::null();
        ConvertSidToStringSidW(user.User.Sid, &mut text)?;
        let sid = text.to_string();
        LocalFree(Some(HLOCAL(text.0.cast())));
        sid.map_err(|_| Error::from_thread())
    }
}

/// Everything in this user's bin on every fixed and removable drive.
pub fn read() -> Result<Vec<BinItem>> {
    let sid = user_sid()?;
    let drives = unsafe { GetLogicalDrives() };
    let mut items = Vec::new();
    for letter in (0..26).filter(|bit| drives & (1 << bit) != 0) {
        let root = format!(r"{}:\", char::from(b'A' + letter));
        let kind = unsafe { GetDriveTypeW(&HSTRING::from(&root)) };
        if kind == DRIVE_FIXED || kind == DRIVE_REMOVABLE {
            items.extend(read_root(&Path::new(&root).join("$Recycle.Bin").join(&sid)));
        }
    }
    Ok(items)
}

impl Run<'_> {
    /// Puts items back where they came from, with the usual conflict answers.
    pub(super) fn restore(&mut self, items: Vec<(PathBuf, PathBuf)>) -> Flow {
        let mark = self.done.len();
        let moved = self.move_all(items.clone());
        for record in &mut self.done[mark..] {
            if let Done::Moved { to, .. } = record {
                *record = Done::Created { path: to.clone() };
            }
        }
        for (item, _) in &items {
            if matches!(sys::stat(item), Ok(None)) {
                let _ = sys::delete_file(&info_path(item));
            }
        }
        sys::refresh_bin_icon();
        moved
    }

    pub(super) fn purge(&mut self, items: Vec<BinItem>) -> Flow {
        for entry in items {
            self.delete_paths(&[entry.item.clone()])?;
            if matches!(sys::stat(&entry.item), Ok(None)) {
                let _ = sys::delete_file(&info_path(&entry.item));
            }
        }
        sys::refresh_bin_icon();
        Ok(())
    }
}
