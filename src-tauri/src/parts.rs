//! Finds the partial files of a job that never finished, because Perli crashed or was killed.
//! A running job lists the folders it writes to and a job that ends removes its list, so any
//! list left at start belongs to a job that died.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::ops::{self, sys};
use crate::session;

const FOLDER: &str = "parts";

fn list(job: u64) -> Option<PathBuf> {
    let name = format!("{}-{job}.txt", std::process::id());
    Some(session::data_file(FOLDER)?.join(name))
}

/// Must land before the job writes in `folder`, or a crash could leave a file nobody knows of.
pub fn note(job: u64, folder: &Path) {
    let Some(list) = list(job) else { return };
    let written = list.parent().map_or(Ok(()), fs::create_dir_all).and_then(|()| {
        let mut file = OpenOptions::new().create(true).append(true).open(&list)?;
        file.write_all(format!("{}\n", folder.display()).as_bytes())
    });
    if let Err(error) = written {
        eprintln!("noting a temp folder failed: {error}");
    }
}

pub fn forget(job: u64) {
    if let Some(list) = list(job) {
        let _ = fs::remove_file(list);
    }
}

/// The process that wrote the list `name`.
fn process_of(name: &str) -> Option<u32> {
    name.split_once('-')?.0.parse().ok()
}

/// Cleans every folder on `list`. False if a drive is away, so that the list can wait for it.
fn clean(list: &Path, process: u32) -> bool {
    let Ok(text) = fs::read_to_string(list) else {
        return false;
    };
    let mut folders: Vec<&str> = text.lines().collect();
    folders.sort_unstable();
    folders.dedup();
    let mut finished = true;
    for folder in folders.into_iter().map(Path::new) {
        let drive_is_here = || folder.ancestors().last().is_some_and(Path::exists);
        finished &= ops::remove_leftovers(folder, process).is_ok() || drive_is_here();
    }
    finished
}

/// Runs at start, off the main thread.
pub fn sweep() {
    let lists = session::data_file(FOLDER).and_then(|folder| fs::read_dir(folder).ok());
    for entry in lists.into_iter().flatten().flatten() {
        let name = entry.file_name();
        let Some(process) = name.to_str().and_then(process_of) else {
            continue;
        };
        if !sys::is_running(process) && clean(&entry.path(), process) {
            let _ = fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_list_names_its_process() {
        assert_eq!(process_of("1234-7.txt"), Some(1234));
        assert_eq!(process_of("note.txt"), None);
        assert_eq!(process_of("x-7.txt"), None);
    }

    #[test]
    fn a_list_waits_for_a_drive_that_is_away_but_not_for_a_deleted_folder() {
        let folder = std::env::temp_dir().join(format!("perli-parts-{}", std::process::id()));
        fs::create_dir_all(&folder).unwrap();
        let list = folder.join("list.txt");
        let gone = folder.join("gone");

        fs::write(&list, format!("{}\n", gone.display())).unwrap();
        assert!(clean(&list, 1));

        let free = (b'P'..=b'Z')
            .map(|letter| format!("{}:\\", char::from(letter)))
            .find(|drive| !Path::new(drive).exists())
            .unwrap();
        fs::write(&list, format!("{free}folder\n")).unwrap();
        assert!(!clean(&list, 1));

        fs::remove_dir_all(&folder).unwrap();
    }
}
