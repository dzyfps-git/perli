//! Small steps on the Windows registry.

use windows::core::{Result, HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::System::Registry::{
    RegCloseKey, RegDeleteKeyValueW, RegDeleteKeyW, RegDeleteTreeW, RegEnumKeyExW, RegGetValueW,
    RegOpenKeyExW, RegQueryInfoKeyW, RegSetKeyValueW, HKEY, KEY_READ, REG_ROUTINE_FLAGS, REG_SZ,
    RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ,
};

/// Longest key name the registry allows, with room for the null.
const LONGEST_KEY: usize = 256;

fn open(root: HKEY, key: &str) -> Option<HKEY> {
    let mut opened = HKEY::default();
    let found = unsafe { RegOpenKeyExW(root, &HSTRING::from(key), None, KEY_READ, &raw mut opened) };
    (found == ERROR_SUCCESS).then_some(opened)
}

pub fn exists(root: HKEY, key: &str) -> bool {
    let opened = open(root, key);
    if let Some(opened) = opened {
        let _ = unsafe { RegCloseKey(opened) };
    }
    opened.is_some()
}

/// The raw bytes of a value. Text values come with Windows' environment names filled in.
pub fn read_value(root: HKEY, key: &str, name: Option<&str>, kinds: REG_ROUTINE_FLAGS) -> Option<Vec<u8>> {
    let key = HSTRING::from(key);
    let name = name.map(HSTRING::from);
    let name = name.as_ref().map_or(PCWSTR::null(), |name| PCWSTR(name.as_ptr()));
    let mut size = 0;
    unsafe {
        let found = RegGetValueW(root, &key, name, kinds, None, None, Some(&raw mut size));
        if found != ERROR_SUCCESS {
            return None;
        }
        let mut bytes = vec![0; size as usize];
        let read = RegGetValueW(
            root,
            &key,
            name,
            kinds,
            None,
            Some(bytes.as_mut_ptr().cast()),
            Some(&raw mut size),
        );
        (read == ERROR_SUCCESS).then(|| {
            bytes.truncate(size as usize);
            bytes
        })
    }
}

pub fn read_text(root: HKEY, key: &str, name: Option<&str>) -> Option<String> {
    let bytes = read_value(root, key, name, RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ)?;
    let units: Vec<u16> = bytes.chunks_exact(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect();
    let end = units.iter().position(|&unit| unit == 0).unwrap_or(units.len());
    Some(String::from_utf16_lossy(&units[..end]))
}

/// The names of the keys directly under `key`.
pub fn subkeys(root: HKEY, key: &str) -> Vec<String> {
    let Some(opened) = open(root, key) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    let mut name = [0u16; LONGEST_KEY];
    for index in 0.. {
        let mut length = LONGEST_KEY as u32;
        let result = unsafe {
            RegEnumKeyExW(
                opened,
                index,
                Some(PWSTR(name.as_mut_ptr())),
                &raw mut length,
                None,
                None,
                None,
                None,
            )
        };
        if result != ERROR_SUCCESS {
            break;
        }
        found.push(String::from_utf16_lossy(&name[..length as usize]));
    }
    // With no key name, Windows hands back `root` itself, and other threads are using that.
    if opened != root {
        let _ = unsafe { RegCloseKey(opened) };
    }
    found
}

/// Makes the key if it is missing. An empty `name` is the key's default value.
pub fn write_text(root: HKEY, key: &str, name: &str, text: &str) -> Result<()> {
    let data = HSTRING::from(text);
    let bytes = (data.len() as u32 + 1) * 2;
    unsafe {
        RegSetKeyValueW(
            root,
            &HSTRING::from(key),
            &HSTRING::from(name),
            REG_SZ.0,
            Some(data.as_ptr().cast()),
            bytes,
        )
    }
    .ok()
}

pub fn delete_value(root: HKEY, key: &str, name: &str) {
    let _ = unsafe { RegDeleteKeyValueW(root, &HSTRING::from(key), &HSTRING::from(name)) };
}

pub fn delete_tree(root: HKEY, key: &str) {
    let _ = unsafe { RegDeleteTreeW(root, &HSTRING::from(key)) };
}

/// Deletes a key only if it holds no keys and no values. Windows' own delete would also take
/// a key that still has values.
pub fn delete_if_empty(root: HKEY, key: &str) {
    let Some(opened) = open(root, key) else {
        return;
    };
    let (mut keys, mut values) = (0, 0);
    let asked = unsafe {
        RegQueryInfoKeyW(
            opened,
            None,
            None,
            None,
            Some(&raw mut keys),
            None,
            None,
            Some(&raw mut values),
            None,
            None,
            None,
            None,
        )
    };
    let _ = unsafe { RegCloseKey(opened) };
    if asked == ERROR_SUCCESS && keys == 0 && values == 0 {
        let _ = unsafe { RegDeleteKeyW(root, &HSTRING::from(key)) };
    }
}
