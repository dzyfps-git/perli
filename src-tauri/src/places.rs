//! The folders and drives the sidebar offers.

use std::mem::size_of;

use serde::Serialize;
use windows::core::{Result, GUID, HSTRING};
use windows::Win32::Storage::FileSystem::{
    GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDrives, FILE_FLAGS_AND_ATTRIBUTES,
};
use windows::Win32::System::Com::{
    CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
};
use windows::Win32::System::WindowsProgramming::{DRIVE_REMOTE, DRIVE_REMOVABLE};
use windows::Win32::UI::Shell::{
    FOLDERID_Desktop, FOLDERID_Documents, FOLDERID_Downloads, FOLDERID_Music, FOLDERID_Pictures,
    FOLDERID_Profile, FOLDERID_Videos, SHGetFileInfoW, SHGetKnownFolderPath, KF_FLAG_DEFAULT,
    SHFILEINFOW, SHGFI_DISPLAYNAME,
};

const FOLDERS: [(&str, GUID); 7] = [
    ("home", FOLDERID_Profile),
    ("desktop", FOLDERID_Desktop),
    ("documents", FOLDERID_Documents),
    ("downloads", FOLDERID_Downloads),
    ("pictures", FOLDERID_Pictures),
    ("music", FOLDERID_Music),
    ("videos", FOLDERID_Videos),
];

#[derive(Serialize)]
pub struct Folder {
    kind: &'static str,
    path: String,
}

#[derive(Serialize)]
pub struct Drive {
    name: String,
    path: String,
}

#[derive(Serialize)]
pub struct Places {
    folders: Vec<Folder>,
    drives: Vec<Drive>,
}

#[derive(Serialize)]
pub struct DriveSpace {
    free: u64,
    total: u64,
}

/// Can hang for as long as a network drive takes to answer, so call it off the main thread.
pub fn drive_space(path: &str) -> Result<DriveSpace> {
    let (mut free, mut total) = (0, 0);
    unsafe {
        GetDiskFreeSpaceExW(
            &HSTRING::from(path),
            Some(&raw mut free),
            Some(&raw mut total),
            None,
        )?;
    }
    Ok(DriveSpace { free, total })
}

/// Blocks, because asking about a drive can wake it, so call it off the main thread.
pub fn read() -> Result<Places> {
    let folders = FOLDERS
        .iter()
        .filter_map(|(kind, id)| known_folder(id).map(|path| Folder { kind, path }))
        .collect();

    unsafe {
        // Windows requires COM on this thread for `SHGetFileInfoW`.
        CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE).ok()?;
        let drives = read_drives();
        CoUninitialize();
        Ok(Places { folders, drives })
    }
}

/// Follows redirection, so a Documents folder moved to OneDrive or D: is found.
pub fn known_folder(id: &GUID) -> Option<String> {
    unsafe {
        let path = SHGetKnownFolderPath(id, KF_FLAG_DEFAULT, None).ok()?;
        let text = path.to_string().ok();
        CoTaskMemFree(Some(path.as_ptr().cast()));
        text
    }
}

fn drive_paths() -> impl Iterator<Item = String> {
    let letters = unsafe { GetLogicalDrives() };
    (0..26)
        .filter(move |bit| letters & (1 << bit) != 0)
        .map(|bit| format!(r"{}:\", char::from(b'A' + bit)))
}

fn read_drives() -> Vec<Drive> {
    drive_paths()
        .map(|path| {
            let name = display_name(&path).unwrap_or_else(|| path.clone());
            Drive { name, path }
        })
        .collect()
}

/// Drives a file can be sent to, with the name Explorer shows and the path.
pub fn removable_drives() -> Vec<(String, String)> {
    drive_paths()
        .filter(|path| {
            let kind = unsafe { GetDriveTypeW(&HSTRING::from(path)) };
            kind == DRIVE_REMOVABLE || kind == DRIVE_REMOTE
        })
        .map(|path| (display_name(&path).unwrap_or_else(|| path.clone()), path))
        .collect()
}

/// The name Explorer shows, such as "Local Disk (C:)".
pub fn display_name(path: &str) -> Option<String> {
    let mut info = SHFILEINFOW::default();
    let found = unsafe {
        SHGetFileInfoW(
            &HSTRING::from(path),
            FILE_FLAGS_AND_ATTRIBUTES(0),
            Some(&raw mut info),
            size_of::<SHFILEINFOW>() as u32,
            SHGFI_DISPLAYNAME,
        )
    };
    let name = info.szDisplayName;
    let length = name.iter().position(|&unit| unit == 0)?;
    (found != 0 && length > 0).then(|| String::from_utf16_lossy(&name[..length]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_home_folder_and_the_system_drive() {
        let places = read().unwrap();

        let home = places.folders.iter().find(|folder| folder.kind == "home");
        assert_eq!(
            home.unwrap().path.to_lowercase(),
            std::env::var("USERPROFILE").unwrap().to_lowercase()
        );

        let system = std::env::var("SystemDrive").unwrap();
        let drive = places
            .drives
            .iter()
            .find(|drive| drive.path == format!(r"{system}\"))
            .unwrap();
        assert!(drive.name.contains(&system), "{}", drive.name);

        let space = drive_space(&drive.path).unwrap();
        assert!(space.total > 0 && space.free <= space.total);
    }
}
