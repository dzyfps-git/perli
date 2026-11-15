//! Ejects a USB stick or disk through Plug and Play itself, so Windows shows no box of its own
//! when something is still using the drive. Perli tells the user instead, with a Try again.

use std::mem::size_of;
use std::path::Path;
use std::thread;
use std::time::Duration;

use serde::Serialize;
use windows::core::{Owned, HSTRING, PCWSTR};
use windows::Win32::Devices::DeviceAndDriverInstallation::{
    CM_Get_Parent, CM_Request_Device_EjectW, SetupDiEnumDeviceInterfaces, SetupDiGetClassDevsW,
    SetupDiGetDeviceInterfaceDetailW, CR_SUCCESS, DIGCF_DEVICEINTERFACE, DIGCF_PRESENT, PNP_VETO_TYPE,
    PNP_VetoOutstandingOpen, PNP_VetoTypeUnknown, PNP_VetoWindowsApp, PNP_VetoWindowsService,
    SP_DEVICE_INTERFACE_DATA, SP_DEVICE_INTERFACE_DETAIL_DATA_W, SP_DEVINFO_DATA,
};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, GetDriveTypeW, FILE_FLAGS_AND_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows::Win32::System::Ioctl::{
    GUID_DEVINTERFACE_DISK, IOCTL_STORAGE_GET_DEVICE_NUMBER, IOCTL_STORAGE_GET_HOTPLUG_INFO, STORAGE_DEVICE_NUMBER,
    STORAGE_HOTPLUG_INFO,
};
use windows::Win32::System::WindowsProgramming::DRIVE_CDROM;
use windows::Win32::System::IO::DeviceIoControl;

/// How an eject went. Busy says why in words the user can act on.
#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Ejected {
    Done,
    Busy { reason: String },
}

/// Perli's own watch lists folders for a moment each second, so one try can meet it.
const TRIES: u32 = 3;
const TRY_GAP: Duration = Duration::from_millis(400);

/// Ejects the drive at `root`. None hands it to the shell's own eject instead: a disc, whose tray
/// answers without any box, a card in a reader built into the PC, and any drive whose disk
/// can't be found.
// ponytail: a card in a built-in reader still gets Windows' box when busy. Its own eject would
// lock, dismount and eject the media (KB165721), and needs a reader to try it on.
pub fn eject(root: &Path) -> Option<Result<Ejected, String>> {
    if unsafe { GetDriveTypeW(&HSTRING::from(root.as_os_str())) } == DRIVE_CDROM {
        return None;
    }
    let letter = root.to_string_lossy().trim_end_matches('\\').to_string();
    let number = device_number(&format!(r"\\.\{letter}"))?;
    let (disk, path) = disk_node(&number)?;
    // Taking the device out whole fits a USB stick or disk. A built-in reader would vanish.
    if !device_hotplug(&path) {
        return None;
    }
    Some(eject_node(disk))
}

fn eject_node(disk: u32) -> Result<Ejected, String> {
    // The disk sits on the device that comes out: the USB stick or the disk's USB box.
    let mut parent = 0;
    if unsafe { CM_Get_Parent(&mut parent, disk, 0) } != CR_SUCCESS {
        return Err("Windows can't eject this drive".to_string());
    }
    let mut last = Ejected::Done;
    for attempt in 0..TRIES {
        if attempt > 0 {
            thread::sleep(TRY_GAP);
        }
        let mut veto = PNP_VetoTypeUnknown;
        // Asking for the veto's name is what keeps Windows from showing its own box.
        let mut name = [0u16; 260];
        let asked = unsafe { CM_Request_Device_EjectW(parent, Some(&mut veto), Some(&mut name), 0) };
        if asked == CR_SUCCESS && veto == PNP_VetoTypeUnknown {
            return Ok(Ejected::Done);
        }
        let end = name.iter().position(|unit| *unit == 0).unwrap_or(name.len());
        last = Ejected::Busy { reason: reason(veto, &String::from_utf16_lossy(&name[..end])) };
    }
    Ok(last)
}

/// True when the whole device can come out, as a USB stick or disk can, rather than only its
/// media, as with a card in a reader built into the PC.
fn device_hotplug(disk: &str) -> bool {
    ask::<STORAGE_HOTPLUG_INFO>(disk, IOCTL_STORAGE_GET_HOTPLUG_INFO).is_some_and(|info| info.DeviceHotplug)
}

/// The disk type and number of a drive or a disk, which tie a drive letter to its disk.
fn device_number(path: &str) -> Option<STORAGE_DEVICE_NUMBER> {
    ask(path, IOCTL_STORAGE_GET_DEVICE_NUMBER)
}

/// Asks a drive or disk one question that needs no rights, and so opens it for no access.
fn ask<T: Default>(path: &str, code: u32) -> Option<T> {
    let share = FILE_SHARE_READ | FILE_SHARE_WRITE;
    let opened = unsafe { CreateFileW(&HSTRING::from(path), 0, share, None, OPEN_EXISTING, FILE_FLAGS_AND_ATTRIBUTES(0), None) };
    let opened = unsafe { Owned::new(opened.ok()?) };
    let mut answer = T::default();
    let size = size_of::<T>() as u32;
    unsafe { DeviceIoControl(*opened, code, None, 0, Some((&raw mut answer).cast()), size, Some(&mut 0), None) }.ok()?;
    Some(answer)
}

/// Puts what Windows says stopped the eject into plain words.
fn reason(veto: PNP_VETO_TYPE, name: &str) -> String {
    let program = Path::new(name).file_stem().map(|stem| stem.to_string_lossy().to_string()).filter(|stem| !stem.is_empty());
    if veto == PNP_VetoOutstandingOpen {
        return "A file on it is still open".to_string();
    }
    match program {
        Some(program) if veto == PNP_VetoWindowsApp || veto == PNP_VetoWindowsService => format!("{program} is still using it"),
        _ => "Windows is still using it".to_string(),
    }
}

/// The Plug and Play node of the disk with this number, and the path that opens the disk.
fn disk_node(wanted: &STORAGE_DEVICE_NUMBER) -> Option<(u32, String)> {
    let flags = DIGCF_PRESENT | DIGCF_DEVICEINTERFACE;
    let disks = unsafe { Owned::new(SetupDiGetClassDevsW(Some(&GUID_DEVINTERFACE_DISK), PCWSTR::null(), None, flags).ok()?) };
    for index in 0.. {
        let mut interface = SP_DEVICE_INTERFACE_DATA { cbSize: size_of::<SP_DEVICE_INTERFACE_DATA>() as u32, ..Default::default() };
        unsafe { SetupDiEnumDeviceInterfaces(*disks, None, &GUID_DEVINTERFACE_DISK, index, &mut interface) }.ok()?;
        let mut needed = 0;
        let _ = unsafe { SetupDiGetDeviceInterfaceDetailW(*disks, &interface, None, 0, Some(&mut needed), None) };
        // u64 keeps the buffer aligned for the struct laid over it.
        let mut buffer = vec![0u64; (needed as usize).div_ceil(8).max(1)];
        let detail = buffer.as_mut_ptr().cast::<SP_DEVICE_INTERFACE_DETAIL_DATA_W>();
        unsafe { (*detail).cbSize = size_of::<SP_DEVICE_INTERFACE_DETAIL_DATA_W>() as u32 };
        let mut info = SP_DEVINFO_DATA { cbSize: size_of::<SP_DEVINFO_DATA>() as u32, ..Default::default() };
        if unsafe { SetupDiGetDeviceInterfaceDetailW(*disks, &interface, Some(detail), needed, None, Some(&mut info)) }.is_err() {
            continue;
        }
        let path = unsafe { PCWSTR((&raw const (*detail).DevicePath).cast()).to_string() }.ok()?;
        let found = device_number(&path);
        if found.is_some_and(|found| found.DeviceType == wanted.DeviceType && found.DeviceNumber == wanted.DeviceNumber) {
            return Some((info.DevInst, path));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_veto_reads_as_plain_words() {
        assert_eq!(reason(PNP_VetoOutstandingOpen, r"STORAGE\Volume\{1234}"), "A file on it is still open");
        assert_eq!(reason(PNP_VetoWindowsApp, r"\Device\HarddiskVolume3\Program Files\Tool\tool.exe"), "tool is still using it");
        assert_eq!(reason(PNP_VetoWindowsService, "Spooler"), "Spooler is still using it");
        assert_eq!(reason(PNP_VetoWindowsApp, ""), "Windows is still using it");
        assert_eq!(reason(PNP_VetoTypeUnknown, "whatever"), "Windows is still using it");
    }

    #[test]
    fn the_system_disk_is_found_and_never_taken_out_whole() {
        // Only looks: nothing here asks Windows to eject anything.
        let number = device_number(r"\\.\C:").expect("C: has a disk number");
        let (_, disk) = disk_node(&number).expect("C:'s disk is among the disks");
        assert!(!device_hotplug(&disk));
    }
}
