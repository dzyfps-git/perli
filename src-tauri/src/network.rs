//! Network places: what a server shares, signing in to it, and mapped drives. Paths under a share
//! need nothing special, because every file call already takes UNC paths.

use std::ptr::null_mut;

use windows::core::{Error, Result, BOOL, HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    ERROR_ACCESS_DENIED, ERROR_INVALID_PASSWORD, ERROR_LOGON_FAILURE, ERROR_NOT_AUTHENTICATED, HWND,
    NO_ERROR, WIN32_ERROR,
};
use windows::Win32::NetworkManagement::NetManagement::{NetApiBufferFree, MAX_PREFERRED_LENGTH};
use windows::Win32::NetworkManagement::WNet::{
    WNetAddConnection3W, WNetConnectionDialog, WNetDisconnectDialog, CONNECT_INTERACTIVE,
    CONNECT_PROMPT, NETRESOURCEW, RESOURCETYPE_ANY, RESOURCETYPE_DISK,
};
use windows::Win32::Storage::FileSystem::{
    GetDriveTypeW, NetShareEnum, SHARE_INFO_1, STYPE_DISKTREE, STYPE_MASK, STYPE_SPECIAL,
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

#[cfg(test)]
mod tests {
    use super::*;

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
