//! One-way sync: pairs of folders, either of which may be in the cloud, kept alike from one side.
//! "Update" copies what is new or changed and takes nothing away; "Mirror" also takes away what
//! the source no longer has. A run is an ordinary job, so it shows its progress, lands in the
//! activity log and has Undo, and what it replaces or takes away goes to a bin first.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use windows::core::{w, HSTRING, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::Threading::{CreateMutexW, ReleaseMutex, WaitForSingleObject};
use windows::Win32::UI::Shell::PathMatchSpecW;

use crate::ops::{sys, Job};
use crate::{remote, session};

const PAIRS_FILE: &str = "sync-pairs.json";
/// How long a window waits for another to finish saving the pairs before it saves anyway.
const HOLD_MS: u32 = 5000;
/// Times this close count as one, as FAT drives and some services keep them in 2 s steps.
const SAME_TIME: u64 = 2 * 10_000_000;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pair {
    /// Empty for a pair not saved yet.
    #[serde(default)]
    pub id: String,
    pub from: PathBuf,
    pub to: PathBuf,
    /// Also takes away from `to` what `from` no longer has.
    #[serde(default)]
    pub mirror: bool,
    /// Names left alone on both sides, as `*.tmp; node_modules`.
    #[serde(default)]
    pub skip: String,
    /// Runs by itself this often while Perli is open, in minutes. 0 is never.
    #[serde(default)]
    pub every: u32,
    /// When it last ran, in ms since 1970. 0 is never, so the first run shows what it will do.
    #[serde(default)]
    pub ran: u64,
}

/// What a run would do.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    /// Each file or folder that goes over, with the folder it lands in.
    pub copies: Vec<(PathBuf, PathBuf)>,
    /// What goes to a bin: replaced by a newer copy, or in a mirror gone from the source.
    pub removes: Vec<PathBuf>,
    /// The size of the files that go over. A new folder counts as nothing, not yet read.
    pub bytes: u64,
}

struct Child {
    name: String,
    size: u64,
    modified: u64,
    folder: bool,
}

/// What a folder holds, in the cloud or here. Links are left out, so a walk never goes round.
fn children(folder: &Path) -> Result<Vec<Child>, String> {
    if let Some(rows) = remote::rows(folder, true) {
        return Ok(rows?.into_iter().map(|(item, _)| Child { name: item.name, size: item.size, modified: item.modified, folder: item.folder }).collect());
    }
    let read = sys::read_dir(folder).map_err(|error| format!("{}: {}", folder.display(), error.message()))?;
    Ok(read
        .into_iter()
        .filter(|(_, stat)| !stat.is_link())
        .map(|(name, stat)| Child { name: name.to_string_lossy().into_owned(), size: stat.size, modified: stat.modified, folder: stat.is_dir() })
        .collect())
}

fn patterns(skip: &str) -> Vec<HSTRING> {
    skip.split([';', ',', '\n']).map(str::trim).filter(|one| !one.is_empty()).map(HSTRING::from).collect()
}

fn skipped(patterns: &[HSTRING], name: &str) -> bool {
    let name = HSTRING::from(name);
    patterns.iter().any(|one| unsafe { PathMatchSpecW(PCWSTR(name.as_ptr()), one) }.as_bool())
}

fn holds(outer: &Path, inner: &Path) -> bool {
    let low = |path: &Path| format!("{}\\", path.to_string_lossy().trim_end_matches('\\').to_lowercase());
    low(inner).starts_with(&low(outer))
}

/// What a run of `pair` would do now.
pub fn preview(pair: &Pair) -> Result<Preview, String> {
    if holds(&pair.from, &pair.to) || holds(&pair.to, &pair.from) {
        return Err("Neither folder of a sync can hold the other".into());
    }
    let mut preview = Preview::default();
    walk(&pair.from, &pair.to, pair.mirror, &patterns(&pair.skip), &mut preview)?;
    Ok(preview)
}

fn walk(from: &Path, to: &Path, mirror: bool, skip: &[HSTRING], preview: &mut Preview) -> Result<(), String> {
    let ours = children(from)?;
    // A target on this PC not made yet holds nothing; the first run makes it.
    let theirs = if !remote::is_remote(to) && !to.exists() { Vec::new() } else { children(to)? };
    let there = |name: &str| theirs.iter().find(|child| child.name.eq_ignore_ascii_case(name));
    for child in ours.iter().filter(|child| !skipped(skip, &child.name)) {
        let source = from.join(&child.name);
        match there(&child.name) {
            Some(old) if old.folder && child.folder => walk(&source, &to.join(&old.name), mirror, skip, preview)?,
            // A copy made earlier is as new as its source or newer, as an upload takes the time it went up.
            Some(old) if !old.folder && !child.folder && old.size == child.size && old.modified + SAME_TIME >= child.modified => {}
            found => {
                if let Some(old) = found {
                    preview.removes.push(to.join(&old.name));
                }
                preview.copies.push((source, to.to_path_buf()));
                preview.bytes += child.size;
            }
        }
    }
    if mirror {
        for old in theirs.iter().filter(|old| !skipped(skip, &old.name)) {
            if !ours.iter().any(|child| child.name.eq_ignore_ascii_case(&old.name)) {
                preview.removes.push(to.join(&old.name));
            }
        }
    }
    Ok(())
}

/// The job that does what `preview` says: what goes away first, then a copy into each folder.
pub fn job(preview: Preview) -> Option<Job> {
    let mut jobs = Vec::new();
    if !preview.removes.is_empty() {
        jobs.push(Job::Recycle { paths: preview.removes });
    }
    let mut groups: Vec<(PathBuf, Vec<PathBuf>)> = Vec::new();
    for (source, folder) in preview.copies {
        match groups.iter_mut().find(|(known, _)| *known == folder) {
            Some((_, sources)) => sources.push(source),
            None => groups.push((folder, vec![source])),
        }
    }
    jobs.extend(groups.into_iter().map(|(folder, sources)| Job::Copy { sources, folder }));
    match jobs.len() {
        0 => None,
        1 => jobs.pop(),
        _ => Some(Job::Several { jobs }),
    }
}

/// The saved pairs, in the order they were made.
pub fn pairs() -> Vec<Pair> {
    session::data_file(PAIRS_FILE).map_or_else(Vec::new, |file| read_from(&file))
}

fn read_from(file: &Path) -> Vec<Pair> {
    fs::read(file).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
}

/// A mutex every Perli window shares, held while one reads, changes and saves the pairs. Each
/// window is a process of its own, so without it two saving at once would keep only the last.
struct Held(HANDLE);

impl Held {
    fn take() -> Self {
        let mutex = unsafe { CreateMutexW(None, false, w!("Local\\PerliSyncPairs")) }.unwrap_or_default();
        if !mutex.is_invalid() {
            // A window that died holding it leaves it abandoned, which is taken as free.
            unsafe { WaitForSingleObject(mutex, HOLD_MS) };
        }
        Self(mutex)
    }
}

impl Drop for Held {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            let _ = unsafe { ReleaseMutex(self.0) };
            let _ = unsafe { CloseHandle(self.0) };
        }
    }
}

/// Reads the pairs in `file`, lets `change` change them and saves them if it did, all while
/// holding the windows' mutex.
fn change_in<T>(file: &Path, change: impl FnOnce(&mut Vec<Pair>) -> Result<T, String>) -> Result<T, String> {
    let _held = Held::take();
    let mut all = read_from(file);
    let before = serde_json::to_string_pretty(&all).map_err(|error| error.to_string())?;
    let answer = change(&mut all)?;
    let text = serde_json::to_string_pretty(&all).map_err(|error| error.to_string())?;
    if text != before {
        if let Some(folder) = file.parent() {
            fs::create_dir_all(folder).map_err(|error| error.to_string())?;
        }
        let staged = file.with_extension("json.new");
        fs::write(&staged, text).and_then(|()| fs::rename(&staged, file)).map_err(|error| error.to_string())?;
    }
    Ok(answer)
}

fn change<T>(change: impl FnOnce(&mut Vec<Pair>) -> Result<T, String>) -> Result<T, String> {
    let file = session::data_file(PAIRS_FILE).ok_or("There is no folder for Perli's own files")?;
    change_in(&file, change)
}

/// `pair` saved into `all`, as new or over the one it changes. Gives it as saved.
fn put(all: &mut Vec<Pair>, mut pair: Pair) -> Pair {
    match all.iter_mut().find(|known| !pair.id.is_empty() && known.id == pair.id) {
        Some(known) => {
            pair.ran = known.ran;
            *known = pair.clone();
        }
        None => {
            pair.id = remote::http::random_text(10);
            pair.ran = 0;
            all.push(pair.clone());
        }
    }
    pair
}

/// Saves a new pair or a changed one. Gives it as saved.
pub fn save_pair(pair: Pair) -> Result<Pair, String> {
    if holds(&pair.from, &pair.to) || holds(&pair.to, &pair.from) {
        return Err("Neither folder of a sync can hold the other".into());
    }
    change(|all| Ok(put(all, pair)))
}

pub fn remove_pair(id: &str) -> Result<(), String> {
    change(|all| {
        all.retain(|pair| pair.id != id);
        Ok(())
    })
}

/// The pair, noted as run now. A `scheduled` run is only taken when it is due, so of the windows
/// open, only the first to ask runs it.
pub fn take_run(id: &str, scheduled: bool) -> Result<Option<Pair>, String> {
    change(|all| {
        let pair = all.iter_mut().find(|pair| pair.id == id).ok_or("That sync is gone")?;
        let now = crate::since_1970().as_millis() as u64;
        if scheduled && (pair.every == 0 || now < pair.ran + u64::from(pair.every) * 60_000) {
            return Ok(None);
        }
        pair.ran = now;
        Ok(Some(pair.clone()))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_saving_pairs_at_once_each_keep_theirs() {
        let file = std::env::temp_dir().join(format!("perli-sync-pairs-{}.json", std::process::id()));
        let _ = fs::remove_file(&file);
        let pair = |at: usize| Pair { id: String::new(), from: format!("C:\\from{at}").into(), to: "D:\\to".into(), mirror: false, skip: String::new(), every: 0, ran: 0 };
        let savers: Vec<_> = (0..8)
            .map(|at| {
                let file = file.clone();
                std::thread::spawn(move || {
                    for round in 0..5 {
                        change_in(&file, |all| Ok(put(all, pair(at * 10 + round)))).unwrap();
                    }
                })
            })
            .collect();
        for saver in savers {
            saver.join().unwrap();
        }
        assert_eq!(read_from(&file).len(), 40, "no save is lost to another made at the same time");
        let _ = fs::remove_file(&file);
    }

    #[test]
    fn a_target_not_made_yet_gets_everything() {
        let root = std::env::temp_dir().join(format!("perli-sync-new-{}", std::process::id()));
        let from = root.join("from");
        fs::create_dir_all(from.join("sub")).unwrap();
        fs::write(from.join("a.txt"), "a").unwrap();
        let pair = Pair { id: String::new(), from: from.clone(), to: root.join("to"), mirror: true, skip: String::new(), every: 0, ran: 0 };
        let look = preview(&pair).unwrap();
        assert_eq!(look.copies.len(), 2);
        assert!(look.removes.is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_run_copies_what_changed_and_a_mirror_takes_away_what_went() {
        let root = std::env::temp_dir().join(format!("perli-sync-{}", std::process::id()));
        let (from, to) = (root.join("from"), root.join("to"));
        for folder in [from.join("sub"), to.join("sub"), to.join("gone")] {
            fs::create_dir_all(folder).unwrap();
        }
        fs::write(from.join("same.txt"), "same").unwrap();
        fs::write(from.join("new.txt"), "new").unwrap();
        fs::write(from.join("sub").join("changed.txt"), "longer now").unwrap();
        fs::write(from.join("skip.tmp"), "left alone").unwrap();
        fs::write(to.join("sub").join("changed.txt"), "short").unwrap();
        fs::write(to.join("old.txt"), "old").unwrap();
        fs::write(to.join("kept.tmp"), "skipped, so kept").unwrap();
        // A copy made earlier: same size, written after the source.
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(to.join("same.txt"), "same").unwrap();

        let mut pair = Pair { id: String::new(), from: from.clone(), to: to.clone(), mirror: false, skip: "*.tmp".into(), every: 0, ran: 0 };
        let names = |paths: Vec<PathBuf>| {
            let mut names: Vec<String> = paths.iter().map(|path| path.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/")).collect();
            names.sort();
            names
        };
        let update = preview(&pair).unwrap();
        assert_eq!(names(update.copies.iter().map(|(source, _)| source.clone()).collect()), ["from/new.txt", "from/sub/changed.txt"]);
        assert_eq!(names(update.removes), ["to/sub/changed.txt"]);

        pair.mirror = true;
        let mirror = preview(&pair).unwrap();
        assert_eq!(names(mirror.removes.clone()), ["to/gone", "to/old.txt", "to/sub/changed.txt"]);
        let Some(Job::Several { jobs }) = job(mirror) else { panic!("removes, then a copy per folder") };
        assert!(matches!(&jobs[..], [Job::Recycle { .. }, Job::Copy { .. }, Job::Copy { .. }]));

        pair.to = from.join("sub");
        assert!(preview(&pair).is_err());
        let _ = fs::remove_dir_all(root);
    }
}
