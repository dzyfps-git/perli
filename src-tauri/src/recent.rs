//! The files and folders Windows lists as recently opened, newest first.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use windows::core::{Interface, HSTRING};
use windows::Win32::Storage::FileSystem::{FILE_ATTRIBUTE_DIRECTORY, WIN32_FIND_DATAW};
use windows::Win32::System::Com::{CoCreateInstance, IPersistFile, CLSCTX_INPROC_SERVER, STGM_READ};
use windows::Win32::UI::Shell::{FOLDERID_Recent, IShellLinkW, ShellLink};

use crate::ops::Com;
use crate::{network, places};

/// Longest path a shortcut stores in plain form.
const MAX_PATH: usize = 260;

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recent {
    name: String,
    path: String,
    is_dir: bool,
    /// When it was last opened, in milliseconds since 1970.
    opened: u64,
}

/// Blocks, because each target is checked on disk, so call it off the main thread.
pub fn read(limit: usize) -> Vec<Recent> {
    places::known_folder(&FOLDERID_Recent).map_or_else(Vec::new, |folder| read_from(Path::new(&folder), limit))
}

/// Takes `target` off Windows' list of recent items, as Explorer's "Remove from Quick access"
/// does: every shortcut in the Recent folder that points to it goes. The file itself stays.
pub fn forget(target: &str) -> std::io::Result<usize> {
    let folder = places::known_folder(&FOLDERID_Recent).ok_or_else(|| std::io::Error::other("Windows has no Recent folder"))?;
    forget_in(Path::new(&folder), target)
}

fn forget_in(folder: &Path, target: &str) -> std::io::Result<usize> {
    let _com = Com::enter();
    let mut gone = 0;
    for (_, shortcut) in shortcuts_in(folder) {
        if target_of(&shortcut).is_some_and(|(path, _)| path.eq_ignore_ascii_case(target)) {
            fs::remove_file(&shortcut)?;
            gone += 1;
        }
    }
    Ok(gone)
}

/// The shortcuts in `folder`, newest first.
fn shortcuts_in(folder: &Path) -> Vec<(SystemTime, PathBuf)> {
    let mut shortcuts: Vec<(SystemTime, PathBuf)> = fs::read_dir(folder)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.path().extension().is_some_and(|extension| extension.eq_ignore_ascii_case("lnk")))
        .filter_map(|entry| Some((entry.metadata().ok()?.modified().ok()?, entry.path())))
        .collect();
    shortcuts.sort_by_key(|shortcut| std::cmp::Reverse(shortcut.0));
    shortcuts
}

fn read_from(folder: &Path, limit: usize) -> Vec<Recent> {
    let _com = Com::enter();
    let mut found: Vec<Recent> = Vec::new();
    for (when, shortcut) in shortcuts_in(folder) {
        if found.len() == limit {
            break;
        }
        let Some((target, stored_dir)) = target_of(&shortcut) else { continue };
        if found.iter().any(|known| known.path.eq_ignore_ascii_case(&target)) {
            continue;
        }
        // ponytail: a remote target is never asked about, because an offline server can hang
        // for seconds, so a gone one stays listed and opening it reports the failure.
        let is_dir = if network::is_remote(&target) {
            stored_dir
        } else {
            match fs::metadata(&target) {
                Ok(data) => data.is_dir(),
                Err(_) => continue,
            }
        };
        let name = Path::new(&target)
            .file_name()
            .map_or_else(|| target.clone(), |name| name.to_string_lossy().into_owned());
        let opened = when.duration_since(UNIX_EPOCH).map_or(0, |since| since.as_millis() as u64);
        found.push(Recent { name, path: target, is_dir, opened });
    }
    found
}

/// Where a shortcut points, and whether it was a folder when the shortcut was made, without
/// asking Windows to search for a moved target.
fn target_of(shortcut: &Path) -> Option<(String, bool)> {
    let mut path = [0u16; MAX_PATH];
    let mut data = WIN32_FIND_DATAW::default();
    unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
        link.cast::<IPersistFile>().ok()?.Load(&HSTRING::from(shortcut.as_os_str()), STGM_READ).ok()?;
        link.GetPath(&mut path, &raw mut data, 0).ok()?;
    }
    let end = path.iter().position(|&unit| unit == 0)?;
    let is_dir = data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 != 0;
    (end > 0).then(|| (String::from_utf16_lossy(&path[..end]), is_dir))
}

#[cfg(test)]
mod tests {
    use std::fs::File;
    use std::time::Duration;

    use super::*;
    use crate::ops::write_shortcut;

    #[test]
    fn newest_first_without_gone_targets_or_repeats() {
        let root = std::env::temp_dir().join(format!("perli-recent-{}", std::process::id()));
        let (links, files) = (root.join("links"), root.join("files"));
        fs::create_dir_all(&links).unwrap();
        fs::create_dir_all(files.join("folder")).unwrap();
        fs::write(files.join("old.txt"), "").unwrap();
        fs::write(files.join("new.txt"), "").unwrap();
        let _com = Com::enter();
        let now = SystemTime::now();
        let link = |name: &str, target: &str, age: u64| {
            let shortcut = links.join(name);
            write_shortcut(&files.join(target), &shortcut).unwrap();
            File::options()
                .write(true)
                .open(&shortcut)
                .unwrap()
                .set_modified(now - Duration::from_secs(age))
                .unwrap();
        };
        link("old.lnk", "old.txt", 300);
        link("gone.lnk", "gone.txt", 10);
        link("new.lnk", "new.txt", 100);
        link("again.lnk", "new.txt", 200);
        link("folder.lnk", "folder", 50);
        fs::write(links.join("not a shortcut.txt"), "").unwrap();

        let found = read_from(&links, 10);
        let names: Vec<_> = found.iter().map(|recent| (recent.name.as_str(), recent.is_dir)).collect();
        assert_eq!(names, [("folder", true), ("new.txt", false), ("old.txt", false)]);
        assert_eq!(read_from(&links, 1).len(), 1);
        assert_eq!(target_of(&links.join("folder.lnk")).map(|(_, dir)| dir), Some(true), "the shortcut knows");
        assert!(found[0].opened > found[1].opened, "newest first, with when");

        assert_eq!(forget_in(&links, &files.join("new.txt").to_string_lossy()).unwrap(), 2, "both shortcuts to it");
        let left: Vec<_> = read_from(&links, 10).into_iter().map(|recent| recent.name).collect();
        assert_eq!(left, ["folder", "old.txt"]);
        assert!(files.join("new.txt").exists(), "the file itself stays");
        assert!(network::is_remote(r"\\server\share\a.txt"));
        assert!(!network::is_remote(&files.to_string_lossy()));
        assert_eq!(network::place_of(r"\\server\share\a.txt"), r"\\server");
        assert_eq!(network::place_of(r"Z:\a.txt"), "Z:");
        assert!(network::must_answer(&files.to_string_lossy()).is_ok(), "this PC always answers");
        fs::remove_dir_all(&root).unwrap();
    }
}
