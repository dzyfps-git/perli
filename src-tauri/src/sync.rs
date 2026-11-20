//! One-way sync: pairs of folders, either of which may be in the cloud, kept alike from one side.
//! "Update" copies what is new or changed and takes nothing away; "Mirror" also takes away what
//! the source no longer has. A run is an ordinary job, so it shows its progress, lands in the
//! activity log and has Undo, and what it replaces or takes away goes to a bin first.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use windows::core::{w, HSTRING, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_ABANDONED, WAIT_OBJECT_0};
use windows::Win32::System::Threading::{CreateMutexW, ReleaseMutex, WaitForSingleObject};
use windows::Win32::UI::Shell::PathMatchSpecW;

use crate::ops::{sys, Job};
use crate::{remote, session};

const PAIRS_FILE: &str = "sync-pairs.json";
/// Times this close count as one, as FAT drives and some services keep them in 2 s steps.
const SAME_TIME: u64 = 2 * 10_000_000;
/// How long a window waits for another to finish with the pairs.
const HOLD_MS: u32 = 5000;

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
    /// New folders made on the other side before the copies, outermost first: those holding
    /// something left out, which go over piece by piece.
    pub folders: Vec<PathBuf>,
    /// The other side keeps no bin, as S3, so what goes is deleted for good, once the run asks.
    pub for_good: bool,
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
    let mut preview = Preview { for_good: matches!(remote::at(&pair.to), Some(Ok(at)) if !at.service.has_bin()), ..Preview::default() };
    walk(&pair.from, &pair.to, pair.mirror, &patterns(&pair.skip), &mut preview, false)?;
    Ok(preview)
}

/// What a run does from `from` into `to`. A `fresh` target is a folder the run makes, holding nothing yet.
fn walk(from: &Path, to: &Path, mirror: bool, skip: &[HSTRING], preview: &mut Preview, fresh: bool) -> Result<(), String> {
    let ours = children(from)?;
    // A target on this PC not made yet holds nothing; the first run makes it.
    let theirs = if fresh || !remote::is_remote(to) && !to.exists() { Vec::new() } else { children(to)? };
    let there = |name: &str| theirs.iter().find(|child| child.name.eq_ignore_ascii_case(name));
    for child in ours.iter().filter(|child| !skipped(skip, &child.name)) {
        let source = from.join(&child.name);
        match there(&child.name) {
            Some(old) if old.folder && child.folder => walk(&source, &to.join(&old.name), mirror, skip, preview, false)?,
            // A copy made earlier is as new as its source or newer, as an upload takes the time it went up.
            Some(old) if !old.folder && !child.folder && old.size == child.size && old.modified + SAME_TIME >= child.modified => {}
            found => {
                if let Some(old) = found {
                    preview.removes.push(to.join(&old.name));
                }
                if child.folder && leaves_out(&source, skip)? {
                    // A copy of the whole folder would take what is left out along, so the folder
                    // is made there and the rest goes in piece by piece.
                    let made = to.join(&child.name);
                    preview.folders.push(made.clone());
                    walk(&source, &made, false, skip, preview, true)?;
                } else {
                    preview.copies.push((source, to.to_path_buf()));
                    preview.bytes += child.size;
                }
            }
        }
    }
    if mirror {
        for old in theirs.iter().filter(|old| !skipped(skip, &old.name)) {
            if !ours.iter().any(|child| child.name.eq_ignore_ascii_case(&old.name)) {
                take_away(&to.join(&old.name), old.folder, skip, preview)?;
            }
        }
    }
    Ok(())
}

/// Whether anything under `folder` has a name left out, which a copy or removal of it whole would touch.
fn leaves_out(folder: &Path, skip: &[HSTRING]) -> Result<bool, String> {
    if skip.is_empty() {
        return Ok(false);
    }
    for child in children(folder)? {
        if skipped(skip, &child.name) || child.folder && leaves_out(&folder.join(&child.name), skip)? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// What a mirror takes away of `path`, gone from the source: all of it, or of a folder holding
/// something left alone, the rest, so that stays and so does the folder.
fn take_away(path: &Path, folder: bool, skip: &[HSTRING], preview: &mut Preview) -> Result<(), String> {
    if !folder || !leaves_out(path, skip)? {
        preview.removes.push(path.to_path_buf());
        return Ok(());
    }
    for child in children(path)?.into_iter().filter(|child| !skipped(skip, &child.name)) {
        take_away(&path.join(&child.name), child.folder, skip, preview)?;
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
    session::data_file(PAIRS_FILE)
        .and_then(|file| fs::read(file).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// A mutex every Perli window shares, held while one reads, changes and saves the pairs. Each
/// window is a process of its own, so without it two could both take one run, or two saving at
/// once keep only the last.
struct Held(HANDLE);

impl Held {
    /// Fails when another window holds it too long, and then nothing is read or changed.
    fn take() -> Result<Self, String> {
        let mutex = unsafe { CreateMutexW(None, false, w!("Local\\PerliSyncPairs")) }.map_err(|error| error.message())?;
        // A window that died holding it leaves it abandoned, which is taken as free.
        match unsafe { WaitForSingleObject(mutex, HOLD_MS) } {
            WAIT_OBJECT_0 | WAIT_ABANDONED => Ok(Self(mutex)),
            _ => {
                let _ = unsafe { CloseHandle(mutex) };
                Err("Another Perli window is busy with the syncs. Try again in a moment.".into())
            }
        }
    }
}

impl Drop for Held {
    fn drop(&mut self) {
        let _ = unsafe { ReleaseMutex(self.0) };
        let _ = unsafe { CloseHandle(self.0) };
    }
}

fn save(pairs: &[Pair]) -> Result<(), String> {
    let file = session::data_file(PAIRS_FILE).ok_or("There is no folder for Perli's own files")?;
    if let Some(folder) = file.parent() {
        fs::create_dir_all(folder).map_err(|error| error.to_string())?;
    }
    let staged = file.with_extension("json.new");
    let text = serde_json::to_string_pretty(pairs).map_err(|error| error.to_string())?;
    fs::write(&staged, text).and_then(|()| fs::rename(&staged, &file)).map_err(|error| error.to_string())
}

/// Saves a new pair or a changed one. Gives it as saved.
pub fn save_pair(mut pair: Pair) -> Result<Pair, String> {
    if holds(&pair.from, &pair.to) || holds(&pair.to, &pair.from) {
        return Err("Neither folder of a sync can hold the other".into());
    }
    let _held = Held::take()?;
    let mut all = pairs();
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
    save(&all)?;
    Ok(pair)
}

pub fn remove_pair(id: &str) -> Result<(), String> {
    let _held = Held::take()?;
    let mut all = pairs();
    all.retain(|pair| pair.id != id);
    save(&all)
}

/// The pair, noted as run now. A `scheduled` run is only taken when it is due, so of the windows
/// open, only the first to ask runs it: the look and the note are one step under the windows' mutex.
pub fn take_run(id: &str, scheduled: bool) -> Result<Option<Pair>, String> {
    let _held = Held::take()?;
    let mut all = pairs();
    let pair = all.iter_mut().find(|pair| pair.id == id).ok_or("That sync is gone")?;
    let now = crate::since_1970().as_millis() as u64;
    if scheduled && (pair.every == 0 || now < pair.ran + u64::from(pair.every) * 60_000) {
        return Ok(None);
    }
    pair.ran = now;
    let taken = pair.clone();
    save(&all)?;
    Ok(Some(taken))
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn what_is_left_out_stays_left_out_inside_new_and_gone_folders() {
        let root = std::env::temp_dir().join(format!("perli-sync-skip-{}", std::process::id()));
        let (from, to) = (root.join("from"), root.join("to"));
        for folder in [from.join("new").join("deep"), from.join("plain"), to.join("gone").join("deep")] {
            fs::create_dir_all(folder).unwrap();
        }
        for (path, text) in [
            (from.join("new").join("keep.txt"), "k"),
            (from.join("new").join("cache.tmp"), "c"),
            (from.join("new").join("deep").join("also.txt"), "a"),
            (from.join("plain").join("p.txt"), "p"),
            (to.join("gone").join("x.txt"), "x"),
            (to.join("gone").join("deep").join("y.tmp"), "y"),
            (to.join("gone").join("deep").join("z.txt"), "z"),
        ] {
            fs::write(path, text).unwrap();
        }
        let pair = Pair { id: String::new(), from: from.clone(), to: to.clone(), mirror: true, skip: "*.tmp".into(), every: 0, ran: 0 };
        let look = preview(&pair).unwrap();
        let rel = |path: &Path| path.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/");
        let mut copies: Vec<String> = look.copies.iter().map(|(source, folder)| format!("{} -> {}", rel(source), rel(folder))).collect();
        copies.sort();
        assert_eq!(copies, ["from/new/deep -> to/new", "from/new/keep.txt -> to/new", "from/plain -> to"]);
        assert_eq!(look.folders.iter().map(|path| rel(path)).collect::<Vec<_>>(), ["to/new"]);
        let mut removes: Vec<String> = look.removes.iter().map(|path| rel(path)).collect();
        removes.sort();
        assert_eq!(removes, ["to/gone/deep/z.txt", "to/gone/x.txt"], "what is left out stays, and the folders holding it");
        assert!(!look.for_good);
        let _ = fs::remove_dir_all(root);
    }
}
