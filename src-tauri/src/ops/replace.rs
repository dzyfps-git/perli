//! Writing over a file that is already there. The new content goes to a file beside it, which
//! Windows swaps in whole, so the real name never holds half a file. The old content moves to
//! Perli's own folder, where Undo finds it.

use std::collections::HashSet;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use windows::core::Result;
use windows::Win32::Storage::FileSystem::{
    MoveFileExW, ReplaceFileW, MOVEFILE_COPY_ALLOWED, MOVEFILE_WRITE_THROUGH, REPLACEFILE_IGNORE_MERGE_ERRORS,
};

use super::sys;
use super::transfer::{file_name, staged_path};
use super::{names, Answer, Done, Failed, Flow, Key, Question, Run};

/// What Undo keeps outlives the steps that name it by this long at least, so a write another
/// window is in the middle of never loses its old content to a sweep.
const KEPT_GRACE: Duration = Duration::from_secs(24 * 60 * 60);

static KEPT_NUMBER: AtomicU64 = AtomicU64::new(0);

/// When a file last changed, in FILETIME ticks, and its length: what a reader saw.
pub type Seen = (u64, u64);

pub fn seen(path: &Path) -> Option<Seen> {
    sys::stat(path).ok().flatten().map(|stat| (stat.modified, stat.size))
}

/// Swaps `fresh`, a whole file beside `path`, in for it. Windows keeps the old file's
/// attributes, creation time, permissions and other streams, such as the mark of where it came
/// from. The old content lands at `backup`. If Windows stops halfway, the old file goes back.
fn swap(path: &Path, fresh: &Path, backup: &Path) -> Result<()> {
    sys::guard(path);
    sys::guard(fresh);
    sys::guard(backup);
    let swapped = unsafe {
        ReplaceFileW(&sys::extended(path), &sys::extended(fresh), &sys::extended(backup), REPLACEFILE_IGNORE_MERGE_ERRORS, None, None)
    };
    // One failure leaves the old file under the backup's name and nothing at `path`.
    if swapped.is_err() && matches!(sys::stat(path), Ok(None)) && matches!(sys::stat(backup), Ok(Some(_))) {
        let _ = sys::rename(backup, path);
    }
    swapped
}

/// Moves `backup` into `folder` for Undo, under a name of its own that ends with the file's.
fn keep(backup: &Path, folder: &Path, name: &OsStr) -> Result<PathBuf> {
    sys::create_dirs(folder)?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
    let number = KEPT_NUMBER.fetch_add(1, Ordering::Relaxed);
    let kept = folder.join(format!("{now}-{}-{number}-{}", std::process::id(), name.to_string_lossy()));
    sys::guard(&kept);
    unsafe { MoveFileExW(&sys::extended(backup), &sys::extended(&kept), MOVEFILE_COPY_ALLOWED | MOVEFILE_WRITE_THROUGH) }?;
    Ok(kept)
}

/// A free name beside `path` for its old content, such as "notes (old).txt".
fn old_beside(path: &Path) -> PathBuf {
    let stem = path.file_stem().unwrap_or_default().to_string_lossy();
    let extension = path.extension().map(|extension| format!(".{}", extension.to_string_lossy())).unwrap_or_default();
    names::free(&sys::parent(path), &format!("{stem} (old)"), &extension)
}

/// Removes what Undo kept in `folder` for steps that are gone from the log, once it is old
/// enough that no running write can still be about to record it.
pub fn sweep(folder: &Path, wanted: &HashSet<PathBuf>) {
    let Ok(entries) = fs::read_dir(folder) else { return };
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
    // The name starts with when `keep` took it in: a move keeps the file's own times.
    let old = |entry: &fs::DirEntry| {
        let name = entry.file_name();
        let kept_at = name.to_str().and_then(|name| name.split('-').next()?.parse::<u128>().ok());
        kept_at.is_some_and(|at| now.saturating_sub(at) > KEPT_GRACE.as_millis())
    };
    for entry in entries.flatten() {
        if !wanted.contains(&entry.path()) && old(&entry) {
            let _ = fs::remove_file(entry.path());
        }
    }
}

impl Run<'_> {
    /// Writes `path` anew: `write` fills a file beside it, which then takes its place. The old
    /// content is kept for Undo when the host has a place for it. False if the user skipped.
    pub(super) fn replace(&mut self, path: &Path, mut write: impl FnMut(&Path) -> Result<()>) -> Flow<bool> {
        let temp = self.temp_beside(path);
        // Holds the only copy of the old content for a moment, so no leftover sweep takes it.
        let backup = staged_path(&sys::parent(path));
        let swapped = self.attempt(path, None, |_| {
            // A retry starts from nothing.
            let _ = sys::delete_file(&temp);
            write(&temp)?;
            swap(path, &temp, &backup)
        })?;
        if swapped.is_none() {
            let _ = sys::delete_file(&temp);
            self.failed.push(Failed { source: path.to_path_buf(), folder: sys::parent(path), moving: false });
            return Ok(false);
        }
        self.touched.insert(sys::parent(path));
        let Some(folder) = self.host.kept_folder() else {
            // ponytail: with nowhere to keep it, the old content goes, as in any editor, and the
            // step can't be undone.
            let _ = sys::delete_file(&backup);
            return Ok(true);
        };
        match keep(&backup, &folder, file_name(path)) {
            Ok(kept) => self.done.push(Done::Replaced { path: path.to_path_buf(), kept }),
            // The only copy of the old content never goes: it stays beside the file, where Undo
            // still finds it, and the user hears why.
            Err(error) => {
                let beside = old_beside(path);
                let kept = if sys::rename(&backup, &beside).is_ok() { beside } else { backup };
                self.done.push(Done::Replaced { path: path.to_path_buf(), kept: kept.clone() });
                let message = format!("{} The old version stays here instead of in Perli's folder.", error.message().trim_end());
                self.tell(&kept, &message)?;
            }
        }
        Ok(true)
    }

    /// Writes text the user edited over the file it came from. If the file changed since they
    /// read it, they choose whether theirs still goes over it.
    pub(super) fn save(&mut self, path: &Path, bytes: &[u8], read: Option<Seen>) -> Flow {
        self.add_total(1, 0);
        if read.is_some() && seen(path) != read {
            let question = Question::Problem {
                path: path.to_string_lossy().into_owned(),
                message: "It changed since you opened it. Save yours over it?".into(),
                choices: vec![Answer::Replace, Answer::Cancel],
            };
            if self.ask(Key::Changed, question)? != Answer::Replace {
                return Err(self.stop());
            }
        }
        self.replace(path, |temp| sys::write_new(temp, bytes))?;
        self.step(1, 0);
        Ok(())
    }

    /// Undo of a write: the kept content goes back, and what it replaces is kept in turn, for Redo.
    pub(super) fn put_back_kept(&mut self, path: &Path, kept: &Path) -> Flow {
        self.add_total(1, 0);
        if self.replace(path, |temp| sys::copy_file(kept, temp, false, |_| true))? {
            let _ = sys::delete_file(kept);
        }
        self.step(1, 0);
        Ok(())
    }
}
