//! Runs file jobs on their own threads and reports to the UI through the `job` event.

use std::cell::Cell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::clipboard;
use crate::ops::{self, Answer, Control, Done, Host, Job, Outcome, Progress, Question, Reply};

/// Scanning goes one call deeper per folder level, and paths allow about 16,000 levels.
pub const STACK_BYTES: usize = 64 * 1024 * 1024;

const EVENT: &str = "job";
const REPORT_GAP: Duration = Duration::from_millis(100);
const UNDO_LIMIT: usize = 100;
/// Selecting more new items than this helps nobody, and sending them all is slow.
const SELECT_LIMIT: usize = 10_000;
const CANCEL: Reply = Reply {
    answer: Answer::Cancel,
    all: false,
};

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

/// A job for `Jobs::start`.
pub struct Plan {
    pub job: Job,
    /// The view that asked, which selects what the job makes.
    pub origin: Option<u32>,
    /// The clipboard's sequence number, when this pastes a cut.
    pub cut: Option<u32>,
}

impl From<Job> for Plan {
    fn from(job: Job) -> Self {
        Self {
            job,
            origin: None,
            cut: None,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "kind")]
enum Change {
    Started {
        title: String,
        origin: Option<u32>,
    },
    Progress(Progress),
    Asked {
        question: Question,
    },
    Finished {
        touched: Vec<String>,
        created: Vec<String>,
        kept: Vec<String>,
        cancelled: bool,
        undo_steps: usize,
    },
}

#[derive(Clone, Serialize)]
struct Event {
    id: u64,
    #[serde(flatten)]
    change: Change,
}

#[derive(Default)]
struct Entry {
    control: Arc<Control>,
    /// Takes the answer to the question on screen.
    waiting: Mutex<Option<Sender<Reply>>>,
}

impl Entry {
    fn reply(&self, reply: Reply) {
        if let Some(sender) = lock(&self.waiting).take() {
            let _ = sender.send(reply);
        }
    }
}

/// Every running job, and what can be undone.
#[derive(Default)]
pub struct Jobs {
    next: AtomicU64,
    running: Mutex<HashMap<u64, Arc<Entry>>>,
    undo: Mutex<Vec<Vec<Done>>>,
}

impl Jobs {
    fn entry(&self, id: u64) -> Option<Arc<Entry>> {
        lock(&self.running).get(&id).cloned()
    }

    pub fn pause(&self, id: u64) {
        if let Some(entry) = self.entry(id) {
            entry.control.pause();
        }
    }

    pub fn resume(&self, id: u64) {
        if let Some(entry) = self.entry(id) {
            entry.control.resume();
        }
    }

    pub fn cancel(&self, id: u64) {
        if let Some(entry) = self.entry(id) {
            entry.control.cancel();
            entry.reply(CANCEL);
        }
    }

    pub fn answer(&self, id: u64, reply: Reply) {
        if let Some(entry) = self.entry(id) {
            entry.reply(reply);
        }
    }

    /// Stores what a job did, returning how many steps can be undone. A cancelled job still
    /// stores what landed before the cancel.
    fn remember(&self, records: Vec<Done>) -> usize {
        let mut undo = lock(&self.undo);
        if !records.is_empty() {
            undo.push(records);
        }
        if undo.len() > UNDO_LIMIT {
            undo.remove(0);
        }
        undo.len()
    }
}

/// Starts a job on its own thread and returns right away. One job per thread lets jobs run
/// side by side, and each thread hosts its own shell work.
pub fn start(app: &AppHandle, plan: Plan) -> Result<(), String> {
    let jobs = app.state::<Jobs>();
    let id = jobs.next.fetch_add(1, Ordering::Relaxed);
    let entry = Arc::<Entry>::default();
    lock(&jobs.running).insert(id, entry.clone());

    let bridge = Bridge {
        app: app.clone(),
        id,
        entry,
        reported: Cell::new(None),
    };
    thread::Builder::new()
        .name(format!("job {id}"))
        .stack_size(STACK_BYTES)
        .spawn(move || bridge.work(plan))
        .map(drop)
        .map_err(|error| {
            lock(&jobs.running).remove(&id);
            error.to_string()
        })
}

/// Reverses the newest step. Does nothing if there is none.
pub fn undo(app: &AppHandle) -> Result<(), String> {
    match lock(&app.state::<Jobs>().undo).pop() {
        Some(records) => start(app, Job::Undo { records }.into()),
        None => Ok(()),
    }
}

/// Connects a running job to the UI.
struct Bridge {
    app: AppHandle,
    id: u64,
    entry: Arc<Entry>,
    reported: Cell<Option<Instant>>,
}

impl Bridge {
    fn send(&self, change: Change) {
        let event = Event { id: self.id, change };
        if let Err(error) = self.app.emit(EVENT, event) {
            eprintln!("job event failed: {error}");
        }
    }

    fn work(&self, plan: Plan) {
        let undoable = !matches!(plan.job, Job::Undo { .. });
        self.send(Change::Started {
            title: title(&plan.job),
            origin: plan.origin,
        });

        let outcome = ops::run(plan.job, self, &self.entry.control);

        let jobs = self.app.state::<Jobs>();
        lock(&jobs.running).remove(&self.id);
        if let (Some(seen), false) = (plan.cut, outcome.cancelled) {
            let _ = clipboard::clear_if_unchanged(seen);
        }
        let created = created(&outcome.done);
        let Outcome {
            done,
            touched,
            kept,
            cancelled,
        } = outcome;
        let undo_steps = jobs.remember(if undoable { done } else { Vec::new() });
        self.send(Change::Finished {
            touched: touched.iter().map(|path| text(path)).collect(),
            created,
            kept: kept.iter().map(|path| text(path)).collect(),
            cancelled,
            undo_steps,
        });
    }
}

impl Host for Bridge {
    fn progress(&self, progress: &Progress) {
        let now = Instant::now();
        if self.reported.get().is_some_and(|last| now - last < REPORT_GAP) {
            return;
        }
        self.reported.set(Some(now));
        self.send(Change::Progress(progress.clone()));
    }

    fn ask(&self, question: Question) -> Reply {
        let (sender, receiver) = mpsc::channel();
        *lock(&self.entry.waiting) = Some(sender);
        // A cancel from before the line above found nobody waiting, so nobody would answer.
        if self.entry.control.cancelled() {
            return CANCEL;
        }
        self.send(Change::Asked { question });
        receiver.recv().unwrap_or(CANCEL)
    }

    fn owner(&self) -> isize {
        owner(&self.app)
    }
}

/// The main window, which UAC prompts and the clipboard need.
pub fn owner(app: &AppHandle) -> isize {
    let window = app.get_webview_window("main");
    let handle = window.and_then(|window| window.hwnd().ok());
    handle.map_or(0, |handle| handle.0 as isize)
}

fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn created(done: &[Done]) -> Vec<String> {
    let made = done.iter().filter_map(|record| match record {
        Done::Created { path } | Done::Moved { to: path, .. } => Some(text(path)),
        Done::Recycled { .. } => None,
    });
    made.take(SELECT_LIMIT).collect()
}

fn title(job: &Job) -> String {
    let named = |verb: &str, paths: &[&Path]| match paths {
        [one] => format!("{verb} {}", one.file_name().unwrap_or_default().to_string_lossy()),
        many => format!("{verb} {} items", many.len()),
    };
    let listed = |verb: &str, paths: &[PathBuf]| {
        named(verb, &paths.iter().map(PathBuf::as_path).collect::<Vec<_>>())
    };
    let deleted = |verb: &str, items: &[ops::BinItem]| {
        named(verb, &items.iter().map(|item| item.original.as_path()).collect::<Vec<_>>())
    };
    match job {
        Job::Copy { sources, .. } => listed("Copying", sources),
        Job::Move { sources, .. } => listed("Moving", sources),
        Job::Rename { name, .. } => format!("Renaming to {name}"),
        Job::New { directory: true, .. } => "Creating a folder".to_string(),
        Job::New { .. } => "Creating a file".to_string(),
        Job::Recycle { paths } => listed("Recycling", paths),
        Job::Delete { paths } => listed("Deleting", paths),
        Job::Restore { items } => deleted("Restoring", items),
        Job::Purge { items } => deleted("Deleting", items),
        Job::Empty => "Emptying the Recycle Bin".to_string(),
        Job::Undo { .. } => "Undoing".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_name_one_item_and_count_several() {
        let one = Job::Copy {
            sources: vec![PathBuf::from(r"C:\a\b.txt")],
            folder: PathBuf::new(),
        };
        let two = Job::Recycle {
            paths: vec![PathBuf::from(r"C:\a"), PathBuf::from(r"C:\b")],
        };

        assert_eq!(title(&one), "Copying b.txt");
        assert_eq!(title(&two), "Recycling 2 items");
    }

    #[test]
    fn undo_log_keeps_the_newest_steps() {
        let jobs = Jobs::default();
        let step = |number: usize| {
            vec![Done::Created {
                path: PathBuf::from(number.to_string()),
            }]
        };

        for number in 0..=UNDO_LIMIT {
            assert_eq!(jobs.remember(step(number)), (number + 1).min(UNDO_LIMIT));
        }

        assert_eq!(jobs.remember(Vec::new()), UNDO_LIMIT);
        assert_eq!(lock(&jobs.undo)[0], step(1));
    }

    #[test]
    fn events_reach_the_ui_flat_and_camel_cased() {
        let event = Event {
            id: 7,
            change: Change::Finished {
                touched: Vec::new(),
                created: Vec::new(),
                kept: Vec::new(),
                cancelled: false,
                undo_steps: 3,
            },
        };
        let json = serde_json::to_value(event).unwrap();

        assert_eq!(json["id"], 7);
        assert_eq!(json["kind"], "finished");
        assert_eq!(json["undoSteps"], 3);
    }
}
