//! The folders and drives the sidebar offers.

use std::mem::size_of;
use std::path::Path;
use std::process::Command;
use std::ptr;

use serde::Serialize;
use windows::core::{Interface, Owned, Result, GUID, HSTRING, PCWSTR, PWSTR};
use windows::Win32::Devices::PortableDevices::{IPortableDeviceManager, PortableDeviceManager};
use windows::Win32::Storage::FileSystem::{
    BusTypeFileBackedVirtual, BusTypeUsb, CreateFileW, STORAGE_BUS_TYPE, GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDrives, FILE_FLAGS_AND_ATTRIBUTES,
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
/// Where Windows keeps the user's WSL distros.
const LXSS: &str = r"Software\Microsoft\Windows\CurrentVersion\Lxss";
/// What every distro's files are shared as.
pub const WSL_ROOT: &str = r"\\wsl.localhost";

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
    /// An ISO or VHD mounted as a drive, which ejecting unmounts.
    mounted: bool,
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

/// A Linux distro of WSL, whose files show as a network share.
#[derive(Debug, PartialEq, Serialize)]
pub struct Distro {
    name: String,
    path: String,
    /// The one `wsl` starts with no name given.
    default: bool,
    /// Running now. Opening its files starts it, which takes a moment.
    running: bool,
}

#[derive(Serialize)]
pub struct Places {
    folders: Vec<Folder>,
    drives: Vec<Drive>,
    clouds: Vec<Cloud>,
    devices: Vec<Device>,
    linux: Vec<Distro>,
    libraries: Vec<Library>,
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
        Ok(Places { folders, drives, clouds, devices, linux: read_distros(LXSS), libraries: libraries() })
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

pub(crate) fn drive_paths() -> impl Iterator<Item = String> {
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
            let mounted = matches!(kind, DRIVE_FIXED | DRIVE_CDROM) && is_mounted_image(&path);
            let removable = mounted || kind == DRIVE_REMOVABLE || kind == DRIVE_CDROM || (kind == DRIVE_FIXED && is_usb(&path));
            let network = kind == DRIVE_REMOTE;
            // A server can be slow to answer, and BitLocker is about this PC's own disks.
            let protection = if network { None } else { bitlocker(&path) };
            Drive { name, path, network, removable, mounted, encrypted: protection.is_some(), locked: protection == Some(LOCKED) }
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
pub(crate) fn is_usb(drive: &str) -> bool {
    bus_of(drive) == Some(BusTypeUsb)
}

/// A disk Windows made from a file, as when an ISO or a VHD is mounted.
fn is_mounted_image(drive: &str) -> bool {
    bus_of(drive) == Some(BusTypeFileBackedVirtual)
}

fn bus_of(drive: &str) -> Option<STORAGE_BUS_TYPE> {
    let volume = HSTRING::from(format!(r"\\.\{}", drive.trim_end_matches('\\')));
    let share = FILE_SHARE_READ | FILE_SHARE_WRITE;
    // Asking for no access is enough for this question, and needs no rights.
    let opened = unsafe { CreateFileW(&volume, 0, share, None, OPEN_EXISTING, FILE_FLAGS_AND_ATTRIBUTES(0), None) };
    let opened = opened.map(|handle| unsafe { Owned::new(handle) }).ok()?;
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
    asked.is_ok().then_some(device.BusType)
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

/// The user's WSL distros. Only a PC with WSL has any, and only then is `wsl.exe` asked which
/// are running.
fn read_distros(key: &str) -> Vec<Distro> {
    let default = registry::read_text(HKEY_CURRENT_USER, key, Some("DefaultDistribution")).unwrap_or_default();
    let mut distros: Vec<Distro> = registry::subkeys(HKEY_CURRENT_USER, key)
        .into_iter()
        .filter_map(|id| {
            let name = registry::read_text(HKEY_CURRENT_USER, &format!(r"{key}\{id}"), Some("DistributionName"))?;
            Some(Distro { path: format!(r"{WSL_ROOT}\{name}"), default: id.eq_ignore_ascii_case(&default), running: false, name })
        })
        .collect();
    if !distros.is_empty() {
        let running = running_distros();
        for distro in &mut distros {
            distro.running = running.iter().any(|name| name.eq_ignore_ascii_case(&distro.name));
        }
    }
    distros.sort_by_key(|distro| (!distro.default, distro.name.to_lowercase()));
    distros
}

fn running_distros() -> Vec<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    Command::new("wsl.exe")
        .args(["--list", "--running", "--quiet"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|output| names_from_wsl(&output.stdout))
        .unwrap_or_default()
}

/// `wsl.exe` writes its lists in UTF-16, one name a line.
fn names_from_wsl(bytes: &[u8]) -> Vec<String> {
    let units: Vec<u16> = bytes.as_chunks::<2>().0.iter().map(|pair| u16::from_le_bytes(*pair)).collect();
    String::from_utf16_lossy(&units)
        .lines()
        .map(|line| line.trim_matches(['\u{feff}', '\0', ' ', '\r']).to_string())
        .filter(|name| !name.is_empty())
        .collect()
}

/// A folder of a WSL distro as the distro and the Linux path, such as `Ubuntu` and `/home/ana`.
pub fn linux_spot(folder: &str) -> Option<(String, String)> {
    let lower = folder.to_ascii_lowercase();
    let rest = [r"\\wsl.localhost\", r"\\wsl$\"].iter().find_map(|root| lower.starts_with(root).then(|| &folder[root.len()..]))?;
    let (distro, inner) = rest.split_once('\\').unwrap_or((rest, ""));
    let inner = inner.replace('\\', "/");
    (!distro.is_empty()).then(|| (distro.to_string(), format!("/{}", inner.trim_end_matches('/'))))
}

/// A file Windows mounts as a drive.
pub fn is_disk_image(path: &Path) -> bool {
    path.extension().is_some_and(|extension| ["iso", "img", "vhd", "vhdx"].iter().any(|kind| extension.eq_ignore_ascii_case(kind)))
}

/// What every Windows library opens as in Perli, followed by its name.
pub const LIBRARY_ROOT: &str = r"shell:Libraries\";

/// A Windows library: one name over several folders, such as Documents.
#[derive(Debug, PartialEq, Serialize)]
pub struct Library {
    name: String,
    path: String,
    /// Its folders, the one new files go to first.
    locations: Vec<String>,
}

/// Where Windows keeps the user's libraries.
fn libraries_folder() -> Option<std::path::PathBuf> {
    Some(std::path::PathBuf::from(std::env::var_os("APPDATA")?).join(r"Microsoft\Windows\Libraries"))
}

/// The user's libraries that have a folder, in name order.
pub fn libraries() -> Vec<Library> {
    let Some(folder) = libraries_folder() else { return Vec::new() };
    let mut found: Vec<Library> = std::fs::read_dir(folder)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if !path.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("library-ms")) {
                return None;
            }
            let name = path.file_stem()?.to_string_lossy().into_owned();
            let locations = library_locations(&std::fs::read_to_string(&path).ok()?);
            (!locations.is_empty()).then(|| Library { path: format!("{LIBRARY_ROOT}{name}"), name, locations })
        })
        .collect();
    found.sort_by_key(|library| library.name.to_lowercase());
    found
}

/// The folders of the library `path` names, such as `shell:Libraries\Documents`.
pub fn library_at(path: &str) -> Option<Vec<String>> {
    let name = path.get(..LIBRARY_ROOT.len()).filter(|start| start.eq_ignore_ascii_case(LIBRARY_ROOT)).map(|_| &path[LIBRARY_ROOT.len()..])?;
    let file = libraries_folder()?.join(format!("{name}.library-ms"));
    Some(library_locations(&std::fs::read_to_string(file).ok()?))
}

/// The folders a `.library-ms` file lists, the default save location first. A folder named by a
/// known folder's id is looked up; one that no longer exists is left out.
fn library_locations(xml: &str) -> Vec<String> {
    let mut reader = quick_xml::Reader::from_str(xml);
    let (mut locations, mut is_default) = (Vec::<(bool, String)>::new(), false);
    let mut text = String::new();
    loop {
        match reader.read_event() {
            Ok(quick_xml::events::Event::Start(start)) => match start.local_name().as_ref() {
                "searchConnectorDescription" => is_default = false,
                "url" => text.clear(),
                "isDefaultSaveLocation" => text.clear(),
                _ => {}
            },
            Ok(quick_xml::events::Event::Text(part)) => text.push_str(&part.xml10_content()),
            Ok(quick_xml::events::Event::End(end)) => match end.local_name().as_ref() {
                "isDefaultSaveLocation" => is_default = text.trim() == "true",
                "url" => {
                    let url = text.trim();
                    let folder = match url.strip_prefix("knownfolder:") {
                        Some(id) => GUID::try_from(id.trim_matches(['{', '}'])).ok().and_then(|id| known_folder(&id)),
                        None => Some(url.to_string()),
                    };
                    locations.extend(folder.filter(|folder| Path::new(folder).is_dir()).map(|folder| (false, folder)));
                }
                "searchConnectorDescription" => {
                    if let Some(last) = locations.last_mut().filter(|_| is_default) {
                        last.0 = true;
                    }
                }
                _ => {}
            },
            Ok(quick_xml::events::Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    locations.sort_by_key(|(default, _)| !default);
    locations.into_iter().map(|(_, folder)| folder).collect()
}

/// The folders pinned to File Explorer's Quick access, for Perli's own pins.
pub fn quick_access_pins() -> Result<Vec<String>> {
    use windows::Win32::UI::Shell::{BHID_EnumItems, IEnumShellItems, IShellItem, IShellItem2, SHCreateItemFromParsingName, SIGDN_FILESYSPATH};
    use windows::Win32::UI::Shell::PropertiesSystem::PSGetPropertyKeyFromName;
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE).ok()?;
        let found = (|| -> Result<Vec<String>> {
            let home: IShellItem = SHCreateItemFromParsingName(&HSTRING::from(QUICK_ACCESS), None)?;
            let items: IEnumShellItems = home.BindToHandler(None, &BHID_EnumItems)?;
            let mut pinned_key = Default::default();
            PSGetPropertyKeyFromName(&HSTRING::from("System.Home.IsPinned"), &raw mut pinned_key)?;
            let mut pins = Vec::new();
            loop {
                let mut item = [None];
                if items.Next(&mut item, None).is_err() {
                    break;
                }
                let Some(item) = item[0].take() else { break };
                let pinned = item.cast::<IShellItem2>().and_then(|item| item.GetBool(&pinned_key)).is_ok_and(|pinned| pinned.as_bool());
                let Ok(path) = item.GetDisplayName(SIGDN_FILESYSPATH) else { continue };
                let text = path.to_string().unwrap_or_default();
                CoTaskMemFree(Some(path.0.cast()));
                if pinned && Path::new(&text).is_dir() {
                    pins.push(text);
                }
            }
            Ok(pins)
        })();
        CoUninitialize();
        found
    }
}

/// File Explorer's Quick access, which lists pinned and frequent folders.
const QUICK_ACCESS: &str = "shell:::{679f85cb-0220-4080-b29b-5540cc05aab6}";

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
    fn a_library_lists_its_folders_the_save_location_first() {
        let temp = std::env::temp_dir();
        let missing = temp.join("perli no such library folder 51c");
        let xml = format!(
            r#"<?xml version="1.0"?><libraryDescription xmlns="http://schemas.microsoft.com/windows/2009/library"><searchConnectorDescriptionList>
            <searchConnectorDescription><simpleLocation><url>{missing}</url></simpleLocation></searchConnectorDescription>
            <searchConnectorDescription><simpleLocation><url>knownfolder:{{FDD39AD0-238F-46AF-ADB4-6C85480369C7}}</url></simpleLocation></searchConnectorDescription>
            <searchConnectorDescription><isDefaultSaveLocation>true</isDefaultSaveLocation><simpleLocation><url>{temp}</url></simpleLocation></searchConnectorDescription>
            </searchConnectorDescriptionList></libraryDescription>"#,
            missing = missing.display(),
            temp = temp.display(),
        );
        let found = library_locations(&xml);
        assert_eq!(found.first().map(String::as_str), Some(temp.to_string_lossy().as_ref()), "the save location comes first");
        assert_eq!(found.len(), 2, "the known folder is looked up, and the missing folder is left out");
        assert_eq!(found[1], known_folder(&FOLDERID_Documents).unwrap());
        assert_eq!(library_at(r"C:\Users"), None);
    }

    #[test]
    #[ignore]
    fn prints_this_pcs_libraries_and_quick_access_pins() {
        println!("{:#?}", libraries());
        println!("{:#?}", quick_access_pins());
    }

    #[test]
    fn wsl_folders_turn_into_a_distro_and_a_linux_path() {
        assert_eq!(linux_spot(r"\\wsl.localhost\Ubuntu\home\ana"), Some(("Ubuntu".into(), "/home/ana".into())));
        assert_eq!(linux_spot(r"\\WSL$\Debian"), Some(("Debian".into(), "/".into())));
        assert_eq!(linux_spot(r"\\wsl.localhost\Ubuntu\"), Some(("Ubuntu".into(), "/".into())));
        assert_eq!(linux_spot(r"\\server\share"), None);
        assert_eq!(linux_spot(r"C:\Users"), None);
        let listed: Vec<u8> = "\u{feff}Ubuntu\r\nDebian\r\n".encode_utf16().flat_map(u16::to_le_bytes).collect();
        assert_eq!(names_from_wsl(&listed), ["Ubuntu", "Debian"]);
    }

    #[test]
    fn distros_come_from_their_registry_keys_default_first() {
        let key = r"Software\Perli\TestLxss";
        registry::delete_tree(HKEY_CURRENT_USER, key);
        registry::write_text(HKEY_CURRENT_USER, &format!(r"{key}\{{b}}"), "DistributionName", "Ubuntu").unwrap();
        registry::write_text(HKEY_CURRENT_USER, &format!(r"{key}\{{a}}"), "DistributionName", "Alpine").unwrap();
        registry::write_text(HKEY_CURRENT_USER, key, "DefaultDistribution", "{b}").unwrap();
        let names: Vec<_> = read_distros(key).into_iter().map(|distro| (distro.name, distro.default)).collect();
        registry::delete_tree(HKEY_CURRENT_USER, key);
        assert_eq!(names, [("Ubuntu".to_string(), true), ("Alpine".to_string(), false)]);
    }

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
