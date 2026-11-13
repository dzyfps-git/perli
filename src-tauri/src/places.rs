//! The folders and drives the sidebar offers.

use std::mem::size_of;
use std::path::Path;
use std::process::Command;
use std::ptr;

use serde::Serialize;
use windows::core::{Owned, Result, GUID, HSTRING, PCWSTR, PWSTR};
use windows::Win32::Devices::PortableDevices::{IPortableDeviceManager, PortableDeviceManager};
use windows::Win32::Storage::FileSystem::{
    BusTypeUsb, CreateFileW, GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDrives, FILE_FLAGS_AND_ATTRIBUTES,
    FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
    COINIT_DISABLE_OLE1DDE,
};
use windows::Win32::System::Ioctl::{
    PropertyStandardQuery, StorageDeviceProperty, IOCTL_STORAGE_QUERY_PROPERTY, STORAGE_DEVICE_DESCRIPTOR,
    STORAGE_PROPERTY_QUERY,
};
use windows::Win32::System::Registry::HKEY_CURRENT_USER;
use windows::Win32::System::WindowsProgramming::{DRIVE_CDROM, DRIVE_FIXED, DRIVE_REMOTE, DRIVE_REMOVABLE};
use windows::Win32::System::IO::DeviceIoControl;
use windows::Win32::UI::Shell::{
    FOLDERID_Desktop, FOLDERID_Documents, FOLDERID_Downloads, FOLDERID_Music, FOLDERID_Pictures,
    FOLDERID_Profile, FOLDERID_Videos, SHGetFileInfoW, SHGetKnownFolderPath, KF_FLAG_DEFAULT,
    SHFILEINFOW, SHGFI_DISPLAYNAME,
};

use crate::registry;

/// Where sync apps list their folders for Explorer's side pane.
const NAMESPACE: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\Desktop\NameSpace";
const CLASSES: &str = r"Software\Classes";

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
    network: bool,
    /// It can be ejected: a card, a disc, or a disk on a USB cable.
    removable: bool,
    /// BitLocker keeps it encrypted.
    encrypted: bool,
    /// Encrypted and not unlocked yet.
    locked: bool,
}

/// A phone, camera or player that shows its files without a drive letter.
#[derive(Serialize)]
pub struct Device {
    name: String,
    /// What Windows calls it, which is also where Explorer finds it.
    id: String,
}

/// A folder a sync app keeps, such as OneDrive.
#[derive(Debug, PartialEq, Serialize)]
pub struct Cloud {
    name: String,
    path: String,
}

#[derive(Serialize)]
pub struct Places {
    folders: Vec<Folder>,
    drives: Vec<Drive>,
    clouds: Vec<Cloud>,
    devices: Vec<Device>,
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
        // A computer with no phone plugged in, or no service for them, just has none to show.
        let devices = read_devices().unwrap_or_default();
        CoUninitialize();
        let clouds = read_clouds(NAMESPACE, CLASSES);
        Ok(Places { folders, drives, clouds, devices })
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
            let kind = unsafe { GetDriveTypeW(&HSTRING::from(&path)) };
            let removable = kind == DRIVE_REMOVABLE || kind == DRIVE_CDROM || (kind == DRIVE_FIXED && is_usb(&path));
            let network = kind == DRIVE_REMOTE;
            // A server can be slow to answer, and BitLocker is about this PC's own disks.
            let protection = if network { None } else { bitlocker(&path) };
            Drive { name, path, network, removable, encrypted: protection.is_some(), locked: protection == Some(LOCKED) }
        })
        .collect()
}

/// What `System.Volume.BitLockerProtection` says of a drive that is locked.
const LOCKED: i32 = 6;

/// BitLocker's state for an encrypted drive: on, encrypting, decrypting, paused or locked. Off
/// (2) and none (0) are not encrypted.
fn bitlocker(drive: &str) -> Option<i32> {
    crate::preview::whole_number(std::path::Path::new(drive), "System.Volume.BitLockerProtection").filter(|state| ![0, 2].contains(state))
}

/// True for a disk on a USB cable, which Windows calls fixed like the ones inside.
fn is_usb(drive: &str) -> bool {
    let volume = HSTRING::from(format!(r"\\.\{}", drive.trim_end_matches('\\')));
    let share = FILE_SHARE_READ | FILE_SHARE_WRITE;
    // Asking for no access is enough for this question, and needs no rights.
    let opened = unsafe { CreateFileW(&volume, 0, share, None, OPEN_EXISTING, FILE_FLAGS_AND_ATTRIBUTES(0), None) };
    let Ok(opened) = opened.map(|handle| unsafe { Owned::new(handle) }) else {
        return false;
    };
    let query = STORAGE_PROPERTY_QUERY {
        PropertyId: StorageDeviceProperty,
        QueryType: PropertyStandardQuery,
        ..Default::default()
    };
    let mut device = STORAGE_DEVICE_DESCRIPTOR::default();
    let asked = unsafe {
        DeviceIoControl(
            *opened,
            IOCTL_STORAGE_QUERY_PROPERTY,
            Some((&raw const query).cast()),
            size_of::<STORAGE_PROPERTY_QUERY>() as u32,
            Some((&raw mut device).cast()),
            size_of::<STORAGE_DEVICE_DESCRIPTOR>() as u32,
            Some(&mut 0),
            None,
        )
    };
    asked.is_ok() && device.BusType == BusTypeUsb
}

/// Windows' own folder of drives and devices, which is where a phone's files are found.
const THIS_PC: &str = "::{20D04FE0-3AEA-1069-A2D8-08002B30309D}";
/// How Windows names a drive it also lists as a device. Those have a letter, and are drives here.
const DRIVE_AS_DEVICE: &str = "wpdbusenum";

/// Phones and the like. COM must be set up on this thread.
unsafe fn read_devices() -> Result<Vec<Device>> {
    let manager: IPortableDeviceManager = CoCreateInstance(&PortableDeviceManager, None, CLSCTX_INPROC_SERVER)?;
    let mut count = 0;
    manager.GetDevices(ptr::null_mut(), &mut count)?;
    let mut ids = vec![PWSTR::null(); count as usize];
    manager.GetDevices(ids.as_mut_ptr(), &mut count)?;
    ids.truncate(count as usize);

    let mut devices = Vec::new();
    for id in ids {
        if id.is_null() {
            continue;
        }
        let text = id.to_string().unwrap_or_default();
        let mut length = 0;
        let _ = manager.GetDeviceFriendlyName(PCWSTR(id.0), PWSTR::null(), &mut length);
        let mut name = vec![0u16; length as usize];
        let named = length > 0 && manager.GetDeviceFriendlyName(PCWSTR(id.0), PWSTR(name.as_mut_ptr()), &mut length).is_ok();
        CoTaskMemFree(Some(id.0.cast()));
        if named && !text.to_lowercase().contains(DRIVE_AS_DEVICE) {
            let end = name.iter().position(|&unit| unit == 0).unwrap_or(name.len());
            devices.push(Device { name: String::from_utf16_lossy(&name[..end]), id: text });
        }
    }
    Ok(devices)
}

/// Shows a device's files in Explorer, which is the one app that can browse them. Only a device
/// that is plugged in now opens, so nothing else can be started through here.
pub fn open_device(id: &str) -> std::result::Result<(), String> {
    let known = read()
        .map_err(|error| error.message())?
        .devices
        .iter()
        .any(|device| device.id == id);
    if !known {
        return Err("This device is no longer connected".to_string());
    }
    Command::new("explorer.exe")
        .arg(format!(r"{THIS_PC}\{id}"))
        .spawn()
        .map(drop)
        .map_err(|error| error.to_string())
}

/// Starts Windows' own BitLocker prompt for a locked drive, as Explorer does on a double click.
pub fn unlock_drive(drive: &str) -> std::result::Result<(), String> {
    let letter = drive.trim_end_matches('\\');
    if !(letter.len() == 2 && letter.ends_with(':') && letter.starts_with(|c: char| c.is_ascii_alphabetic())) {
        return Err("Only a drive letter can be unlocked".to_string());
    }
    let windows = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
    Command::new(format!(r"{windows}\System32\BdeUnlock.exe"))
        .arg(letter)
        .spawn()
        .map(drop)
        .map_err(|error| error.to_string())
}

/// A class names its folder outright, or as a known folder's id, which is how OneDrive does it.
fn cloud_path(class: &str) -> Option<String> {
    let bag = format!(r"{class}\Instance\InitPropertyBag");
    let path = registry::read_text(HKEY_CURRENT_USER, &bag, Some("TargetFolderPath"));
    path.or_else(|| {
        let id = registry::read_text(HKEY_CURRENT_USER, &bag, Some("TargetKnownFolder"))?;
        known_folder(&GUID::try_from(id.trim_matches(['{', '}'])).ok()?)
    })
}

/// The folders Explorer's side pane shows from sync apps. Asking the keys under the user's own
/// classes costs no extra dependency, unlike the sync root manager, and matches that pane.
fn read_clouds(namespace: &str, classes: &str) -> Vec<Cloud> {
    let ids = registry::subkeys(HKEY_CURRENT_USER, namespace);
    ids.iter()
        .filter_map(|id| {
            let class = format!(r"{classes}\CLSID\{id}");
            let name = registry::read_text(HKEY_CURRENT_USER, &class, Some(""))?;
            let path = cloud_path(&class).filter(|path| Path::new(path).is_dir())?;
            Some(Cloud { name, path })
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
        assert!(!drive.network);
        assert!(!drive.removable, "the system drive can't be ejected");
        assert!(open_device("no such device").is_err());
    }

    #[test]
    fn cloud_folders_come_by_path_or_known_folder_and_must_exist() {
        let top = format!(r"Software\Classes\perli-test-clouds-{}", std::process::id());
        let (namespace, classes) = (format!(r"{top}\namespace"), format!(r"{top}\classes"));
        let add = |id: &str, name: Option<&str>, value: &str, target: &str| {
            let (space, class) = (format!(r"{namespace}\{id}"), format!(r"{classes}\CLSID\{id}"));
            registry::write_text(HKEY_CURRENT_USER, &space, "", "listed").unwrap();
            if let Some(name) = name {
                registry::write_text(HKEY_CURRENT_USER, &class, "", name).unwrap();
            }
            let bag = format!(r"{class}\Instance\InitPropertyBag");
            registry::write_text(HKEY_CURRENT_USER, &bag, value, target).unwrap();
        };
        let temp = std::env::temp_dir();
        let temp = temp.to_str().unwrap();
        let known = format!("{{{FOLDERID_Documents:?}}}");
        add("{1}", Some("By path"), "TargetFolderPath", temp);
        add("{2}", Some("By id"), "TargetKnownFolder", &known);
        add("{3}", Some("Gone"), "TargetFolderPath", r"C:\perli-no-such-folder");
        add("{4}", None, "TargetFolderPath", temp);

        let clouds = read_clouds(&namespace, &classes);
        registry::delete_tree(HKEY_CURRENT_USER, &top);

        let documents = known_folder(&FOLDERID_Documents).unwrap();
        assert_eq!(
            clouds,
            [
                Cloud { name: "By path".into(), path: temp.into() },
                Cloud { name: "By id".into(), path: documents },
            ]
        );
    }
}
