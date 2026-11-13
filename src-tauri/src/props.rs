//! What Perli's own Properties sheet shows about files and folders, and the two attributes it
//! changes. Security, sharing and the rest stay with Windows' own window.

use std::fs;
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use windows::core::{Error, Result, HSTRING, PWSTR};
use windows::Win32::Foundation::E_FAIL;
use windows::Win32::Storage::FileSystem::{
    GetFileAttributesW, SetFileAttributesW, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_HIDDEN,
    FILE_ATTRIBUTE_READONLY, FILE_FLAGS_AND_ATTRIBUTES, INVALID_FILE_ATTRIBUTES,
};
use windows::Win32::UI::Shell::{AssocQueryStringW, ASSOCF_NONE, ASSOCSTR_FRIENDLYAPPNAME};

const READ_ONLY: u32 = FILE_ATTRIBUTE_READONLY.0;
const HIDDEN: u32 = FILE_ATTRIBUTE_HIDDEN.0;
const DIRECTORY: u32 = FILE_ATTRIBUTE_DIRECTORY.0;

/// How many of the items have something.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Share {
    All,
    None,
    Some,
}

fn share(have: usize, of: usize) -> Share {
    match have {
        0 => Share::None,
        all if all == of => Share::All,
        _ => Share::Some,
    }
}

/// Times are milliseconds since 1970, as the UI's dates count. The single-item facts are of the
/// first item, and the UI shows them only when it is alone.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Facts {
    paths: Vec<String>,
    folders: usize,
    files: usize,
    /// A drive itself, which has no attributes to change.
    is_root: bool,
    size: u64,
    modified: Option<f64>,
    created: Option<f64>,
    accessed: Option<f64>,
    /// Among the files, since on a folder the flag means something else to Windows.
    read_only: Share,
    hidden: Share,
    /// Windows' name for the type, such as "PNG File".
    kind: Option<String>,
    /// The app a double click opens it with.
    default_app: Option<String>,
    /// Kept by a sync app with nothing on this PC, so reading it would download it.
    online_only: bool,
}

fn millis(time: std::io::Result<SystemTime>) -> Option<f64> {
    Some(time.ok()?.duration_since(UNIX_EPOCH).ok()?.as_secs_f64() * 1000.0)
}

fn extension_of(path: &Path) -> Option<String> {
    path.extension()?.to_str().map(str::to_lowercase)
}

/// The app Windows opens `.extension` with, by the name it shows.
fn default_app(extension: &str) -> Option<String> {
    let dotted = HSTRING::from(format!(".{extension}"));
    let mut name = [0u16; 260];
    let mut length = name.len() as u32;
    let found = unsafe {
        AssocQueryStringW(
            ASSOCF_NONE,
            ASSOCSTR_FRIENDLYAPPNAME,
            &dotted,
            None,
            Some(PWSTR(name.as_mut_ptr())),
            &raw mut length,
        )
    };
    let end = name.iter().position(|&unit| unit == 0)?;
    (found.is_ok() && end > 0).then(|| String::from_utf16_lossy(&name[..end]))
}

/// Reads the disk, so call it off the main thread.
pub fn facts(paths: Vec<PathBuf>) -> Result<Facts> {
    let first = paths.first().ok_or_else(|| Error::new(E_FAIL, "Nothing is selected"))?;
    let about = fs::metadata(first).map_err(|_| Error::new(E_FAIL, "That item is gone"))?;
    let attributes: Vec<u32> = paths
        .iter()
        .filter_map(|path| fs::symlink_metadata(path).ok())
        .map(|found| found.file_attributes())
        .collect();
    let files: Vec<u32> = attributes.iter().copied().filter(|found| found & DIRECTORY == 0).collect();
    let with = |list: &[u32], flag: u32| share(list.iter().filter(|found| *found & flag != 0).count(), list.len());
    let extension = (!about.is_dir()).then(|| extension_of(first)).flatten();
    let kind = extension
        .as_ref()
        .and_then(|extension| crate::shell::type_names(vec![extension.clone()]).ok()?.remove(extension));
    Ok(Facts {
        folders: attributes.len() - files.len(),
        files: files.len(),
        is_root: first.parent().is_none(),
        size: if about.is_dir() { 0 } else { about.len() },
        modified: millis(about.modified()),
        created: millis(about.created()),
        accessed: millis(about.accessed()),
        read_only: with(&files, READ_ONLY),
        hidden: with(&attributes, HIDDEN),
        kind,
        default_app: extension.as_deref().and_then(default_app),
        online_only: crate::thumbs::is_online_only(first),
        paths: paths.iter().map(|path| path.display().to_string()).collect(),
    })
}

/// `attributes` with the two flags as asked. A folder keeps its read-only flag, which Windows
/// uses there to mark a folder with its own look, not one that can't be written to.
fn changed(attributes: u32, read_only: Option<bool>, hidden: Option<bool>) -> u32 {
    let set = |all: u32, flag: u32, on: Option<bool>| match on {
        Some(true) => all | flag,
        Some(false) => all & !flag,
        None => all,
    };
    let read_only = read_only.filter(|_| attributes & DIRECTORY == 0);
    set(set(attributes, READ_ONLY, read_only), HIDDEN, hidden)
}

/// Turns read-only or hidden on or off for each of `paths`, and for nothing inside them.
pub fn set_attributes(paths: &[PathBuf], read_only: Option<bool>, hidden: Option<bool>) -> Result<()> {
    for path in paths {
        if path.parent().is_none() {
            return Err(Error::new(E_FAIL, "A drive has no attributes to change"));
        }
        let name = HSTRING::from(path.as_os_str());
        let now = unsafe { GetFileAttributesW(&name) };
        if now == INVALID_FILE_ATTRIBUTES {
            return Err(Error::from_thread());
        }
        let wanted = changed(now, read_only, hidden);
        if wanted != now {
            unsafe { SetFileAttributesW(&name, FILE_FLAGS_AND_ATTRIBUTES(wanted)) }?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let folder = std::env::temp_dir().join(format!("perli-props-{name}-{}", std::process::id()));
        fs::create_dir_all(&folder).unwrap();
        folder
    }

    #[test]
    fn a_share_is_all_none_or_some() {
        assert_eq!(share(0, 3), Share::None);
        assert_eq!(share(3, 3), Share::All);
        assert_eq!(share(1, 3), Share::Some);
        assert_eq!(share(0, 0), Share::None);
    }

    #[test]
    fn only_the_asked_flags_change_and_a_folder_keeps_read_only() {
        let archive = 0x20;
        assert_eq!(changed(archive, Some(true), None), archive | READ_ONLY);
        assert_eq!(changed(archive | READ_ONLY | HIDDEN, Some(false), None), archive | HIDDEN);
        assert_eq!(changed(archive, None, Some(true)), archive | HIDDEN);
        assert_eq!(changed(archive, None, None), archive);
        assert_eq!(changed(DIRECTORY, Some(true), Some(true)), DIRECTORY | HIDDEN);
    }

    #[test]
    fn a_file_turns_read_only_and_hidden_and_back() {
        let folder = temp("flags");
        let file = folder.join("note.txt");
        fs::write(&file, "four").unwrap();
        let paths = vec![file.clone(), folder.clone()];

        let before = facts(paths.clone()).unwrap();
        assert_eq!((before.files, before.folders, before.size), (1, 1, 4));
        assert_eq!((before.read_only, before.hidden), (Share::None, Share::None));
        assert!(before.modified.is_some() && !before.is_root);

        set_attributes(&paths, Some(true), Some(true)).unwrap();
        let after = facts(paths.clone()).unwrap();
        assert_eq!((after.read_only, after.hidden), (Share::All, Share::All));
        assert!(fs::metadata(&file).unwrap().permissions().readonly());
        assert_eq!(fs::metadata(&folder).unwrap().file_attributes() & READ_ONLY, 0);

        set_attributes(&paths, Some(false), Some(false)).unwrap();
        assert_eq!(facts(paths).unwrap().hidden, Share::None);
        fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn a_drive_is_a_root_and_keeps_its_attributes() {
        let drive = PathBuf::from(format!(r"{}\", std::env::var("SystemDrive").unwrap()));
        assert!(facts(vec![drive.clone()]).unwrap().is_root);
        assert!(set_attributes(&[drive], None, Some(true)).is_err());
    }

    #[test]
    fn text_has_a_type_name_and_a_missing_item_fails() {
        let folder = temp("kind");
        let file = folder.join("note.txt");
        fs::write(&file, "").unwrap();
        assert!(facts(vec![file]).unwrap().kind.is_some());
        assert!(facts(vec![folder.join("gone.txt")]).is_err());
        fs::remove_dir_all(folder).unwrap();
    }
}
