//! The file engine: copy, move, delete, recycle, restore and undo. It knows nothing about the
//! UI. A job talks to the outside through `Host`, and `Control` pauses or cancels it.

mod bin;
mod names;
mod shell;
pub mod sys;
mod transfer;
mod tree;

#[cfg(test)]
mod tests;

use std::collections::{BTreeSet, HashMap, HashSet};
use std::mem;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};

use serde::{Deserialize, Serialize};
use windows::core::{Error, Result};

pub use bin::{read as read_bin, BinItem};
pub use names::check_rename;
pub use shell::shell_item;
pub use transfer::{is_temp_name, put_back, remove_leftovers};
pub use tree::measure;

/// One unit of work, run to the end by `run`.
pub enum Job {
    Copy { sources: Vec<PathBuf>, folder: PathBuf },
    Move { sources: Vec<PathBuf>, folder: PathBuf },
    Rename { path: PathBuf, name: String },
    New { folder: PathBuf, directory: bool },
    Template { folder: PathBuf, template: Template },
    Recycle { paths: Vec<PathBuf> },
    Delete { paths: Vec<PathBuf> },
    Restore { items: Vec<BinItem> },
    Purge { items: Vec<BinItem> },
    Empty,
    Undo { records: Vec<Done> },
}

/// A new file of a type Windows knows, such as a blank spreadsheet.
#[derive(Clone, Debug, PartialEq)]
pub struct Template {
    /// The name before any number, such as "New Text Document".
    pub stem: String,
    /// Starts with a dot.
    pub extension: String,
    pub content: Content,
}

/// What a new file starts with.
#[derive(Clone, Debug, PartialEq)]
pub enum Content {
    Empty,
    Bytes(Vec<u8>),
    /// A blank document of that type, to copy.
    Copy(PathBuf),
}

/// One change a job made, in a form that can be undone.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub enum Done {
    Created { path: PathBuf },
    Moved { from: PathBuf, to: PathBuf },
    Recycled { original: PathBuf, item: PathBuf },
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub bytes: u64,
    pub total_bytes: u64,
    pub items: u64,
    pub total_items: u64,
    pub current: String,
}

/// What the job can do next. The UI shows one button for each it is offered.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Answer {
    Replace,
    KeepBoth,
    Merge,
    Skip,
    Retry,
    Elevate,
    Permanent,
    Cancel,
}

#[derive(Clone, Copy, Debug, Deserialize)]
pub struct Reply {
    pub answer: Answer,
    /// Use the same answer for every later case of this kind.
    pub all: bool,
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct Facts {
    pub size: u64,
    /// FILETIME ticks.
    pub modified: u64,
    pub folder: bool,
}

impl From<sys::Stat> for Facts {
    fn from(stat: sys::Stat) -> Self {
        Self {
            size: stat.size,
            modified: stat.modified,
            folder: stat.is_dir(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Question {
    Conflict {
        name: String,
        source: Facts,
        target: Facts,
        choices: Vec<Answer>,
    },
    Problem {
        path: String,
        message: String,
        choices: Vec<Answer>,
    },
    NoBin {
        path: String,
        choices: Vec<Answer>,
    },
}

/// The world outside a job.
pub trait Host {
    fn progress(&self, progress: &Progress);
    fn ask(&self, question: Question) -> Reply;

    /// The window a UAC prompt belongs to.
    fn owner(&self) -> isize {
        0
    }

    /// The job is about to write partial files in `folder`. Called once for each folder.
    fn temp_folder(&self, _folder: &Path) {}

    /// The job is about to move `source` to `staged`, which then holds the only copy of it.
    fn staged(&self, _staged: &Path, _source: &Path) {}
}

/// Pauses or cancels a running job from another thread.
#[derive(Default)]
pub struct Control {
    paused: Mutex<bool>,
    resumed: Condvar,
    cancelled: AtomicBool,
}

impl Control {
    pub fn pause(&self) {
        *self.paused.lock().unwrap_or_else(|error| error.into_inner()) = true;
    }

    pub fn resume(&self) {
        *self.paused.lock().unwrap_or_else(|error| error.into_inner()) = false;
        self.resumed.notify_all();
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
        self.resume();
    }

    pub fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }

    /// Waits out any pause. False once cancelled.
    pub fn proceed(&self) -> bool {
        let mut paused = self.paused.lock().unwrap_or_else(|error| error.into_inner());
        while *paused {
            paused = self
                .resumed
                .wait(paused)
                .unwrap_or_else(|error| error.into_inner());
        }
        !self.cancelled()
    }
}

/// The job was cancelled, so everything up the call stack stops.
struct Stopped;

type Flow<T = ()> = std::result::Result<T, Stopped>;

/// The kinds of question an "apply to all" answer covers.
#[derive(Eq, Hash, PartialEq)]
enum Key {
    Files,
    Folders,
    Mixed,
    NoBin,
    Refused,
    Problem(i32),
}

/// Work put off to the end of the job, to run with admin rights.
enum Elevated {
    Copy { source: PathBuf, target: PathBuf },
    Move { source: PathBuf, target: PathBuf },
    New { target: PathBuf, directory: bool },
    Delete { path: PathBuf },
    Recycle { path: PathBuf },
}

/// What a job left behind.
pub struct Outcome {
    pub done: Vec<Done>,
    /// Folders whose contents changed.
    pub touched: BTreeSet<PathBuf>,
    /// Sources a move left alone because they changed while it ran.
    pub kept: Vec<PathBuf>,
    pub cancelled: bool,
}

struct Run<'a> {
    host: &'a dyn Host,
    control: &'a Arc<Control>,
    progress: Progress,
    memo: HashMap<Key, Answer>,
    done: Vec<Done>,
    touched: BTreeSet<PathBuf>,
    kept: Vec<PathBuf>,
    /// Folders a merge moved everything out of, children first.
    emptied: Vec<PathBuf>,
    elevated: Vec<Elevated>,
    /// An undo only ever moves things back, so it never deletes for good.
    undoing: bool,
    temp_folders: HashSet<PathBuf>,
}

impl<'a> Run<'a> {
    fn new(host: &'a dyn Host, control: &'a Arc<Control>) -> Self {
        Self {
            host,
            control,
            progress: Progress::default(),
            memo: HashMap::new(),
            done: Vec::new(),
            touched: BTreeSet::new(),
            kept: Vec::new(),
            emptied: Vec::new(),
            elevated: Vec::new(),
            undoing: false,
            temp_folders: HashSet::new(),
        }
    }

    fn job(&mut self, job: Job) -> Flow {
        match job {
            Job::Copy { sources, folder } => self.copy(sources, &folder),
            Job::Move { sources, folder } => self.move_sources(sources, &folder),
            Job::Rename { path, name } => self.rename(&path, &name),
            Job::New { folder, directory } => self.new_item(&folder, directory),
            Job::Template { folder, template } => self.new_from(&folder, &template),
            Job::Recycle { paths } => {
                self.add_total(paths.len() as u64, 0);
                self.recycle(paths)
            }
            Job::Delete { paths } => self.delete_paths(&paths),
            Job::Restore { items } => {
                self.restore(items.into_iter().map(|item| (item.item, item.original)).collect())
            }
            Job::Purge { items } => self.purge(items),
            Job::Empty => {
                self.attempt(Path::new("Recycle Bin"), None, |_| sys::empty_bin())?;
                Ok(())
            }
            Job::Undo { records } => self.undo(records),
        }
    }

    fn rename(&mut self, path: &Path, name: &str) -> Flow {
        self.add_total(1, 0);
        let target = path.with_file_name(name);
        // The shell's rename takes the same route as a move within one folder.
        let elevated = Elevated::Move {
            source: path.to_path_buf(),
            target: target.clone(),
        };
        if self.attempt(path, Some(elevated), |_| sys::rename(path, &target))?.is_some() {
            self.done.push(Done::Moved {
                from: path.to_path_buf(),
                to: target,
            });
        }
        self.step(1, 0);
        Ok(())
    }

    fn new_item(&mut self, folder: &Path, directory: bool) -> Flow {
        self.add_total(1, 0);
        let target = names::new_item(folder, directory);
        let elevated = Elevated::New {
            target: target.clone(),
            directory,
        };
        let made = self.attempt(folder, Some(elevated), |_| {
            if directory {
                sys::create_dir(&target)
            } else {
                sys::create_file(&target)
            }
        })?;
        if made.is_some() {
            self.done.push(Done::Created { path: target });
        }
        self.step(1, 0);
        Ok(())
    }

    // ponytail: no admin route for templates, as the shell's new item can't carry their content.
    fn new_from(&mut self, folder: &Path, template: &Template) -> Flow {
        self.add_total(1, 0);
        let target = names::free(folder, &template.stem, &template.extension);
        let made = self.attempt(folder, None, |_| match &template.content {
            Content::Empty => sys::create_file(&target),
            Content::Bytes(bytes) => sys::write_new(&target, bytes),
            Content::Copy(file) => sys::copy_file(file, &target, false, |_| true),
        })?;
        if made.is_some() {
            self.done.push(Done::Created { path: target });
        }
        self.step(1, 0);
        Ok(())
    }

    /// Applies records backwards, each kind in one batch where they sit together.
    fn undo(&mut self, records: Vec<Done>) -> Flow {
        self.undoing = true;
        let backwards: Vec<Done> = records.into_iter().rev().collect();
        let same_kind = |a: &Done, b: &Done| mem::discriminant(a) == mem::discriminant(b);
        for group in backwards.chunk_by(same_kind) {
            match &group[0] {
                Done::Created { .. } => {
                    let paths: Vec<PathBuf> = group
                        .iter()
                        .filter_map(|record| match record {
                            Done::Created { path } => Some(path.clone()),
                            _ => None,
                        })
                        .collect();
                    self.add_total(paths.len() as u64, 0);
                    self.recycle(paths)?;
                }
                Done::Moved { .. } => {
                    self.move_all(group.iter().filter_map(|record| match record {
                        Done::Moved { from, to } => Some((to.clone(), from.clone())),
                        _ => None,
                    }).collect())?;
                }
                Done::Recycled { .. } => {
                    self.restore(group.iter().filter_map(|record| match record {
                        Done::Recycled { original, item } => Some((item.clone(), original.clone())),
                        _ => None,
                    }).collect())?;
                }
            }
        }
        Ok(())
    }

    /// A pause point. Fails once cancelled.
    fn check(&self) -> Flow {
        if self.control.proceed() {
            Ok(())
        } else {
            Err(Stopped)
        }
    }

    fn stop(&self) -> Stopped {
        self.control.cancel();
        Stopped
    }

    fn add_total(&mut self, items: u64, bytes: u64) {
        self.progress.total_items += items;
        self.progress.total_bytes += bytes;
    }

    fn step(&mut self, items: u64, bytes: u64) {
        self.progress.items += items;
        self.progress.bytes += bytes;
        self.host.progress(&self.progress);
    }

    /// Reports a copy in flight. False cancels the copy.
    fn copied(&mut self, bytes: u64) -> bool {
        self.progress.bytes = bytes;
        self.host.progress(&self.progress);
        self.control.proceed()
    }

    fn ask(&mut self, key: Key, question: Question) -> Flow<Answer> {
        if let Some(answer) = self.memo.get(&key) {
            return Ok(*answer);
        }
        let reply = self.host.ask(question);
        if reply.answer == Answer::Cancel {
            return Err(self.stop());
        }
        if reply.all && reply.answer != Answer::Retry {
            self.memo.insert(key, reply.answer);
        }
        Ok(reply.answer)
    }

    fn problem(&mut self, path: &Path, error: &Error, can_elevate: bool) -> Flow<Answer> {
        let mut choices = vec![Answer::Retry, Answer::Skip, Answer::Cancel];
        if can_elevate && sys::is_access_denied(error) {
            choices.insert(1, Answer::Elevate);
        }
        let users = if sys::is_in_use(error) {
            sys::users_of(&[path.to_path_buf()])
        } else {
            Vec::new()
        };
        let question = Question::Problem {
            path: path.to_string_lossy().into_owned(),
            message: with_users(&error.message(), &users),
            choices,
        };
        self.ask(Key::Problem(error.code().0), question)
    }

    /// Tells the user about something that can't be retried, and moves on past it.
    fn refuse(&mut self, path: &Path, message: &str) -> Flow {
        let question = Question::Problem {
            path: path.to_string_lossy().into_owned(),
            message: message.to_string(),
            choices: vec![Answer::Skip, Answer::Cancel],
        };
        self.ask(Key::Refused, question)?;
        self.step(1, 0);
        Ok(())
    }

    /// Runs `action` until it works or the user gives up, giving `None` for a skip. With
    /// `elevated`, the user may hand the work over to run with admin rights.
    fn attempt<T>(
        &mut self,
        path: &Path,
        elevated: Option<Elevated>,
        mut action: impl FnMut(&mut Self) -> Result<T>,
    ) -> Flow<Option<T>> {
        let can_elevate = elevated.is_some();
        let mut elevated = elevated;
        self.progress.current = path.to_string_lossy().into_owned();
        loop {
            self.check()?;
            let error = match action(self) {
                Ok(value) => return Ok(Some(value)),
                Err(error) => error,
            };
            // A cancelled copy fails with an error of its own.
            self.check()?;
            match self.problem(path, &error, can_elevate)? {
                Answer::Retry => {}
                Answer::Elevate => {
                    self.elevated.extend(elevated.take());
                    return Ok(None);
                }
                _ => return Ok(None),
            }
        }
    }

    fn finish(mut self, cancelled: bool) -> Outcome {
        for record in &self.done {
            match record {
                Done::Created { path } => self.touched.insert(sys::parent(path)),
                Done::Moved { from, to } => {
                    self.touched.insert(sys::parent(from));
                    self.touched.insert(sys::parent(to))
                }
                Done::Recycled { original, .. } => self.touched.insert(sys::parent(original)),
            };
        }
        Outcome {
            done: self.done,
            touched: self.touched,
            kept: self.kept,
            cancelled,
        }
    }
}

/// Adds the apps holding a file to what Windows said about it.
fn with_users(message: &str, users: &[String]) -> String {
    if users.is_empty() {
        return message.to_string();
    }
    format!("{} Open in {}.", message.trim_end(), users.join(", "))
}

/// Runs a job to its end on this thread, which also hosts any shell work it needs.
pub fn run(job: Job, host: &dyn Host, control: &Arc<Control>) -> Outcome {
    let _com = shell::Com::enter();
    let mut run = Run::new(host, control);
    let worked = run.job(job).and_then(|()| run.finish_elevated());
    run.finish(worked.is_err() || control.cancelled())
}
