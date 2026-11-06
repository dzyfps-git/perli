//! Finds what a job left when it never finished, because Perli crashed or was killed. A running
//! job lists the folders it writes to and any move it staged, and a job that ends removes its
//! list, so a list left at start belongs to a job that died. Partial files go. Staged files are
//! originals, so they go back.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::ops::{self, sys};
use crate::session;

const FOLDER: &str = "parts";
/// Splits a staged file from its source on a list line. No Windows path can hold it.
const STAGED: char = '|';

fn list(job: u64) -> Option<PathBuf> {
    let name = format!("{}-{job}.txt", std::process::id());
    Some(session::data_file(FOLDER)?.join(name))
}

fn append(job: u64, line: &str) {
    let Some(list) = list(job) else { return };
    let written = list.parent().map_or(Ok(()), fs::create_dir_all).and_then(|()| {
        let mut file = OpenOptions::new().create(true).append(true).open(&list)?;
        file.write_all(format!("{line}\n").as_bytes())
    });
    if let Err(error) = written {
        eprintln!("noting {line} failed: {error}");
    }
}

/// Must land before the job writes in `folder`, or a crash could leave a file nobody knows of.
pub fn note(job: u64, folder: &Path) {
    append(job, &folder.display().to_string());
}

/// Must land before the move. If it can't, the staged file still stays, just under its temp name.
pub fn note_staged(job: u64, staged: &Path, source: &Path) {
    append(job, &format!("{}{STAGED}{}", staged.display(), source.display()));
}

fn staged_waiting(text: &str) -> bool {
    let mut staged = text.lines().filter_map(|line| line.split_once(STAGED));
    staged.any(|(staged, _)| Path::new(staged).exists())
}

/// A staged file still waiting keeps the list, so the next start can put it back.
pub fn forget(job: u64) {
    let Some(list) = list(job) else { return };
    if !staged_waiting(&fs::read_to_string(&list).unwrap_or_default()) {
        let _ = fs::remove_file(list);
    }
}

/// The process that wrote the list `name`.
fn process_of(name: &str) -> Option<u32> {
    name.split_once('-')?.0.parse().ok()
}

fn drive_is_here(path: &Path) -> bool {
    path.ancestors().last().is_some_and(Path::exists)
}

/// Gone means the job got past this file. False if it needs another try at a later start.
fn restore(staged: &Path, source: &Path) -> bool {
    match sys::stat(staged) {
        Ok(Some(_)) => ops::put_back(staged, source).is_ok(),
        Ok(None) => drive_is_here(staged),
        Err(_) => false,
    }
}

/// Handles every line of `list`. False if a drive is away or a staged file could not go back,
/// so that the list can wait.
fn clean(list: &Path, process: u32) -> bool {
    let Ok(text) = fs::read_to_string(list) else {
        return false;
    };
    let mut lines: Vec<&str> = text.lines().collect();
    lines.sort_unstable();
    lines.dedup();
    let mut finished = true;
    for line in lines {
        finished &= match line.split_once(STAGED) {
            Some((staged, source)) => restore(Path::new(staged), Path::new(source)),
            None => {
                let folder = Path::new(line);
                ops::remove_leftovers(folder, process).is_ok() || drive_is_here(folder)
            }
        };
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
    fn a_staged_file_goes_back_and_a_taken_name_costs_nothing() {
        let folder = std::env::temp_dir().join(format!("perli-staged-{}", std::process::id()));
        let (from, to) = (folder.join("from"), folder.join("to"));
        fs::create_dir_all(&to).unwrap();
        sys::test_guard::enter(&folder);
        let list = folder.join("list.txt");
        let staged = to.join("~perli-1-2.moved");
        let source = from.join("a.txt");
        let line = format!("{}{STAGED}{}\n", staged.display(), source.display());
        fs::write(&list, &line).unwrap();

        // Its folder went away too, and a gone staged file is simply done.
        fs::write(&staged, "original").unwrap();
        assert!(staged_waiting(&line));
        assert!(clean(&list, 1));
        assert_eq!(fs::read_to_string(&source).unwrap(), "original");
        assert!(!staged_waiting(&line));
        assert!(clean(&list, 1));

        fs::write(&source, "newer").unwrap();
        fs::write(&staged, "original").unwrap();
        assert!(clean(&list, 1));
        assert_eq!(fs::read_to_string(&source).unwrap(), "newer");
        assert!(!staged.exists());
        let names = fs::read_dir(&from).unwrap().count();
        assert_eq!(names, 2);

        fs::remove_dir_all(&folder).unwrap();
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
