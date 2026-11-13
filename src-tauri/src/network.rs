//! Network places: what a server shares, signing in to it, and mapped drives. Paths under a share
//! need nothing special, because every file call already takes UNC paths.

use std::ptr::null_mut;

use serde::Serialize;
use windows::core::{Error, Result, BOOL, HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    ERROR_ACCESS_DENIED, ERROR_CANCELLED, ERROR_INVALID_PASSWORD, ERROR_LOGON_FAILURE,
    ERROR_NOT_AUTHENTICATED, E_FAIL, HWND, NO_ERROR, WIN32_ERROR,
};
use windows::Win32::NetworkManagement::NetManagement::{NetApiBufferFree, MAX_PREFERRED_LENGTH};
use windows::Win32::NetworkManagement::WNet::{
    WNetAddConnection3W, WNetCancelConnection2W, WNetConnectionDialog, WNetDisconnectDialog,
    WNetGetConnectionW, CONNECT_INTERACTIVE, CONNECT_PROMPT, CONNECT_UPDATE_PROFILE, NETRESOURCEW,
    NET_CONNECT_FLAGS, RESOURCETYPE_ANY, RESOURCETYPE_DISK,
};
use windows::Win32::Storage::FileSystem::{
    GetDriveTypeW, GetLogicalDrives, NetShareEnum, SHARE_INFO_1, STYPE_DISKTREE, STYPE_MASK,
    STYPE_SPECIAL,
};
use windows::Win32::System::WindowsProgramming::DRIVE_REMOTE;

use crate::ops::Com;

/// What Windows' dialogs return when the user cancels them.
const CANCELLED: WIN32_ERROR = WIN32_ERROR(u32::MAX);

/// True for `\\server` with no share after it.
pub fn is_server(path: &str) -> bool {
    path.strip_prefix(r"\\").is_some_and(|rest| !rest.is_empty() && !rest.contains('\\'))
}

/// The folders `server` (`\\server`) shares, by name, and whether each is one Explorer keeps
/// out of sight: the admin shares, and any name ending in `$`.
pub fn shares(server: &str) -> Result<Vec<(String, bool)>> {
    let mut buffer = null_mut();
    let (mut read, mut total) = (0, 0);
    unsafe {
        WIN32_ERROR(NetShareEnum(
            &HSTRING::from(server),
            1,
            &raw mut buffer,
            MAX_PREFERRED_LENGTH,
            &raw mut read,
            &raw mut total,
            None,
        ))
        .ok()?;
        if buffer.is_null() {
            return Ok(Vec::new());
        }
        let rows = std::slice::from_raw_parts(buffer.cast::<SHARE_INFO_1>(), read as usize);
        let folders = rows.iter().filter(|row| row.shi1_type.0 & STYPE_MASK.0 == STYPE_DISKTREE.0);
        let found = folders
            .filter_map(|row| {
                let name = row.shi1_netname.to_string().ok()?;
                let out_of_sight = row.shi1_type.0 & STYPE_SPECIAL.0 != 0 || name.ends_with('$');
                Some((name, out_of_sight))
            })
            .collect();
        NetApiBufferFree(Some(buffer.cast()));
        Ok(found)
    }
}

/// The `\\server\share` that `path` is under. A bare server signs in through its `IPC$` share.
fn remote_of(path: &str) -> Option<String> {
    let mut parts = path.strip_prefix(r"\\")?.split('\\');
    let server = parts.next().filter(|server| !server.is_empty())?;
    let share = parts.next().filter(|share| !share.is_empty()).unwrap_or("IPC$");
    Some(format!(r"\\{server}\{share}"))
}

/// True for a share path or a mapped drive, where asking the disk can hang on an offline server.
pub fn is_remote(path: &str) -> bool {
    path.starts_with(r"\\") || mapped_drive(path).is_some()
}

/// The `Z:` of a path on a mapped drive.
fn mapped_drive(path: &str) -> Option<&str> {
    let device = path.get(..2).filter(|device| device.ends_with(':'))?;
    let kind = unsafe { GetDriveTypeW(&HSTRING::from(format!(r"{device}\"))) };
    (kind == DRIVE_REMOTE).then_some(device)
}

fn asks_for_sign_in(failure: &Error) -> bool {
    [ERROR_ACCESS_DENIED, ERROR_INVALID_PASSWORD, ERROR_LOGON_FAILURE, ERROR_NOT_AUTHENTICATED]
        .iter()
        .any(|code| code.to_hresult() == failure.code())
}

/// Shows Windows' sign-in dialog, which also offers to remember the password.
fn sign_in(remote: &str, owner: HWND) -> bool {
    let mut remote: Vec<u16> = remote.encode_utf16().chain([0]).collect();
    let resource = NETRESOURCEW {
        dwType: RESOURCETYPE_ANY,
        lpRemoteName: PWSTR(remote.as_mut_ptr()),
        ..Default::default()
    };
    let flags = CONNECT_INTERACTIVE | CONNECT_PROMPT;
    let result = unsafe {
        WNetAddConnection3W(Some(owner), &raw const resource, PCWSTR::null(), PCWSTR::null(), flags)
    };
    result == NO_ERROR
}

/// Brings back a mapped drive that Windows remembers but has not connected yet.
fn restore(device: &str, owner: HWND) -> bool {
    // The `windows` crate leaves this one out.
    windows_core::link!("mpr.dll" "system" fn WNetRestoreSingleConnectionW(
        parent: HWND,
        device: PCWSTR,
        use_ui: BOOL
    ) -> WIN32_ERROR);
    let device = HSTRING::from(device);
    unsafe { WNetRestoreSingleConnectionW(owner, PCWSTR(device.as_ptr()), true.into()) == NO_ERROR }
}

/// Tries to get past `failure`, which opening `path` ran into, and says whether to read again.
/// This can show a dialog, so call it off the main thread.
pub fn reconnect(path: &str, failure: &Error, owner: isize) -> bool {
    let owner = HWND(owner as _);
    match remote_of(path) {
        Some(remote) => asks_for_sign_in(failure) && sign_in(&remote, owner),
        None => mapped_drive(path).is_some_and(|device| restore(device, owner)),
    }
}

fn closed_dialog(result: WIN32_ERROR) -> Result<()> {
    if result == CANCELLED {
        Ok(())
    } else {
        result.ok()
    }
}

/// Windows' Map Network Drive dialog. Blocks until it closes, so call it off the main thread.
pub fn map_drive(owner: isize) -> Result<()> {
    // Its Browse button needs COM on this thread.
    let _com = Com::enter();
    closed_dialog(unsafe { WNetConnectionDialog(HWND(owner as _), RESOURCETYPE_DISK.0) })
}

/// Windows' Disconnect Network Drives dialog. Blocks until it closes, like `map_drive`.
pub fn disconnect_drive(owner: isize) -> Result<()> {
    let _com = Com::enter();
    closed_dialog(unsafe { WNetDisconnectDialog(Some(HWND(owner as _)), RESOURCETYPE_DISK.0) })
}

/// A network drive and the share it stands for.
#[derive(Debug, PartialEq, Serialize)]
pub struct Mapped {
    /// Such as `Z:`.
    letter: String,
    remote: String,
}

/// The letters a drive can be mapped to, and the drives mapped now.
#[derive(Debug, Serialize)]
pub struct Letters {
    free: Vec<String>,
    mapped: Vec<Mapped>,
}

/// Letters from Z down to D, as Windows offers them, that `mask` has (`taken`) or lacks.
/// A to C stay out: floppies and the system drive.
fn letters(mask: u32, taken: bool) -> Vec<String> {
    ('D'..='Z')
        .rev()
        .filter(|&letter| (mask >> (letter as u32 - 'A' as u32) & 1 == 1) == taken)
        .map(|letter| format!("{letter}:"))
        .collect()
}

/// True for `Z:`, the only form a drive is mapped or unmapped by.
fn is_letter(device: &str) -> bool {
    matches!(device.as_bytes(), [letter, b':'] if letter.is_ascii_alphabetic())
}

/// True for `\\server\share`, with or without folders after it.
pub fn is_share(remote: &str) -> bool {
    let Some(rest) = remote.strip_prefix(r"\\") else {
        return false;
    };
    let mut parts = rest.split('\\');
    let named = |part: Option<&str>| part.is_some_and(|name| !name.is_empty() && !name.contains(['/', '"', '<', '>', '|']));
    named(parts.next()) && named(parts.next())
}

fn remote_name(device: &str) -> Option<String> {
    let mut name = [0u16; 1024];
    let mut length = name.len() as u32;
    let found = unsafe {
        WNetGetConnectionW(&HSTRING::from(device), Some(PWSTR(name.as_mut_ptr())), &raw mut length)
    };
    let end = name.iter().position(|&unit| unit == 0)?;
    (found == NO_ERROR).then(|| String::from_utf16_lossy(&name[..end]))
}

/// Free letters and mapped drives, for Perli's own dialogs.
// ponytail: a remembered drive whose server is away has no letter in Windows' mask, so it is
// missing here. Windows' own dialog, one click away, lists those.
pub fn drive_letters() -> Letters {
    let mask = unsafe { GetLogicalDrives() };
    let mapped = letters(mask, true)
        .into_iter()
        .filter(|letter| mapped_drive(letter).is_some())
        .map(|letter| Mapped { remote: remote_name(&letter).unwrap_or_default(), letter })
        .collect();
    Letters { free: letters(mask, false), mapped }
}

/// Maps `letter` (`Z:`) to `remote` (`\\server\share`). With `remember` it comes back at sign-in.
/// Windows asks for a name and password itself when the server wants them. Blocks while it does.
pub fn map(letter: &str, remote: &str, remember: bool, owner: isize) -> Result<()> {
    if !is_letter(letter) {
        return Err(Error::new(E_FAIL, "Pick a drive letter"));
    }
    if !is_share(remote) {
        return Err(Error::new(E_FAIL, r"Type a share like \\server\share"));
    }
    let mut local: Vec<u16> = letter.to_uppercase().encode_utf16().chain([0]).collect();
    let mut share: Vec<u16> = remote.encode_utf16().chain([0]).collect();
    let resource = NETRESOURCEW {
        dwType: RESOURCETYPE_DISK,
        lpLocalName: PWSTR(local.as_mut_ptr()),
        lpRemoteName: PWSTR(share.as_mut_ptr()),
        ..Default::default()
    };
    let profile = if remember { CONNECT_UPDATE_PROFILE } else { NET_CONNECT_FLAGS(0) };
    let result = unsafe {
        WNetAddConnection3W(
            Some(HWND(owner as _)),
            &raw const resource,
            PCWSTR::null(),
            PCWSTR::null(),
            CONNECT_INTERACTIVE | profile,
        )
    };
    // Backing out of the sign-in is not a failure to report.
    if result == ERROR_CANCELLED {
        Ok(())
    } else {
        result.ok()
    }
}

/// Disconnects the mapped drive `letter`, and forgets it for the next sign-in. Open files on it
/// make this fail, so nothing is lost.
pub fn unmap(letter: &str) -> Result<()> {
    if !is_letter(letter) || mapped_drive(letter).is_none() {
        return Err(Error::new(E_FAIL, "That is not a network drive"));
    }
    unsafe { WNetCancelConnection2W(&HSTRING::from(letter), CONNECT_UPDATE_PROFILE, false) }.ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn letters_run_from_z_down_to_d() {
        let c_and_e = 0b10100;
        assert_eq!(letters(c_and_e, true), ["E:"]);
        let free = letters(c_and_e, false);
        assert_eq!((free.first().unwrap().as_str(), free.last().unwrap().as_str()), ("Z:", "D:"));
        assert_eq!(free.len(), 22);
    }

    #[test]
    fn only_a_server_with_a_share_maps() {
        assert!(is_share(r"\\server\share"));
        assert!(is_share(r"\\server\share\deep"));
        assert!(!is_share(r"\\server"));
        assert!(!is_share(r"\\server\"));
        assert!(!is_share(r"\\\share"));
        assert!(!is_share(r"C:\Users"));
        assert!(!is_share("//server/share"));
    }

    #[test]
    fn a_wrong_letter_or_share_is_refused_before_windows_is_asked() {
        assert!(map("ZZ", r"\\server\share", false, 0).is_err());
        assert!(map("1:", r"\\server\share", false, 0).is_err());
        assert!(map("Z:", r"\\server", false, 0).is_err());
        assert!(unmap(&std::env::var("SystemDrive").unwrap()).is_err());
        assert!(unmap("nope").is_err());
    }

    #[test]
    fn the_system_drive_is_neither_free_nor_mapped() {
        let system = std::env::var("SystemDrive").unwrap().to_uppercase();
        let found = drive_letters();
        assert!(!found.free.contains(&system));
        assert!(!found.mapped.iter().any(|drive| drive.letter == system));
    }

    #[test]
    fn only_a_bare_server_counts_as_one() {
        assert!(is_server(r"\\server"));
        assert!(!is_server(r"\\server\share"));
        assert!(!is_server(r"C:\Users"));
        assert!(!is_server(r"\\"));
    }

    #[test]
    fn a_path_signs_in_at_its_share() {
        assert_eq!(remote_of(r"\\server\share\deep\er").unwrap(), r"\\server\share");
        assert_eq!(remote_of(r"\\server\share").unwrap(), r"\\server\share");
        assert_eq!(remote_of(r"\\server").unwrap(), r"\\server\IPC$");
        assert_eq!(remote_of(r"C:\Users"), None);
        assert_eq!(remote_of(r"\\"), None);
    }

    #[test]
    fn a_share_typed_with_forward_slashes_signs_in_once_resolved() {
        let resolved = crate::folder::resolve("//server/share/deep").unwrap();
        assert_eq!(remote_of(&resolved).unwrap(), r"\\server\share");
    }

    #[test]
    fn a_local_drive_is_not_mapped() {
        assert_eq!(mapped_drive(&std::env::var("SystemDrive").unwrap()), None);
        assert_eq!(mapped_drive("shell:RecycleBinFolder"), None);
    }

    #[test]
    fn only_refused_access_asks_for_a_sign_in() {
        assert!(asks_for_sign_in(&ERROR_LOGON_FAILURE.to_hresult().into()));
        let missing = windows::Win32::Foundation::ERROR_BAD_NET_NAME.to_hresult();
        assert!(!asks_for_sign_in(&missing.into()));
    }

    #[test]
    fn this_pc_shares_its_system_drive_out_of_sight() {
        let shares = shares(r"\\localhost").unwrap();
        let system = std::env::var("SystemDrive").unwrap().replace(':', "$");
        let found = shares.iter().find(|(name, _)| name.eq_ignore_ascii_case(&system));
        assert!(found.unwrap().1, "{shares:?}");
        assert!(!shares.iter().any(|(name, _)| name == "IPC$"), "{shares:?}");
    }
}
