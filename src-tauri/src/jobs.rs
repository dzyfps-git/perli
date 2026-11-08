//! Runs file jobs on their own threads and reports to the UI through the `job` event.

use std::cell::Cell;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::clipboard;
use crate::ops::{self, Answer, Control, Done, Host, Job, Outcome, Progress, Question, Reply};
use crate::{parts, session};

/// Scanning goes one call deeper per folder level, and paths allow about 16,000 levels.
pub const STACK_BYTES: usize = 64 * 1024 * 1024;

const EVENT: &str = "job";
const REPORT_GAP: Duration = Duration::from_millis(100);
const UNDO_LIMIT: usize = 100;
const UNDO_FILE: &str = "undo.json";
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
    pub history: History,
}

/// Where a job's changes go in the undo log.
#[derive(Clone, Copy)]
pub enum History {
    New,
    Undo,
    Redo,
}

impl From<Job> for Plan {
    fn from(job: Job) -> Self {
        Self {
            job,
            origin: None,
            cut: None,
            history: History::New,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "kind")]
enum Change {
    Started {
        title: String,
        origin: Option<u32>,
        /// The job makes a new item, whose name the UI opens for editing.
        new_item: bool,
        recycle: bool,
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
        /// The undo step this job added.
        step: Option<u64>,
        #[serde(flatten)]
        undoable: Undoable,
    },
}

/// What Undo and Redo can do now.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Undoable {
    /// The step Undo would reverse next.
    latest_step: Option<u64>,
    redo: bool,
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

/// One job's changes, undone together.
#[derive(Deserialize, Serialize)]
struct Step {
    id: u64,
    records: Vec<Done>,
}

/// What can be undone and redone, oldest first. Ids are never reused, so an old job can't pass
/// for the newest step. The log outlives the app, and what it holds may be out of date by then,
/// but undo never deletes for good and asks about anything it can't do.
#[derive(Default, Deserialize)]
struct UndoLog {
    next: u64,
    steps: Vec<Step>,
    redo: Vec<Step>,
}

impl UndoLog {
    fn load() -> Self {
        let file = session::data_file(UNDO_FILE);
        let text = file.and_then(|file| fs::read_to_string(file).ok());
        text.map_or_else(Self::default, |text| Self::parse(&text))
    }

    /// Damaged text starts fresh, because a lost undo log harms nothing.
    fn parse(text: &str) -> Self {
        serde_json::from_str(text).unwrap_or_default()
    }

    /// A step that can't be written, which a path that isn't valid Unicode causes, stays in
    /// memory only.
    fn text(&self) -> String {
        let saved = |steps: &[Step]| -> Vec<serde_json::Value> {
            let values = steps.iter().map(serde_json::to_value);
            values.filter_map(std::result::Result::ok).collect()
        };
        let log = serde_json::json!({
            "next": self.next,
            "steps": saved(&self.steps),
            "redo": saved(&self.redo),
        });
        log.to_string()
    }

    // ponytail: rewrites the whole log per job and two windows overwrite each other. Fine for
    // 100 steps of normal size, append-only per step if huge steps make this slow.
    fn save(&self) {
        if let Some(file) = session::data_file(UNDO_FILE) {
            if let Err(error) = session::write(&file, &self.text()) {
                eprintln!("saving the undo log failed: {error}");
            }
        }
    }

    /// Stores what a job did, if anything, and gives the id of a new undo step. A cancelled job
    /// still stores what landed before the cancel, and an undo stores how to redo itself.
    fn record(&mut self, history: History, records: Vec<Done>) -> Option<u64> {
        if records.is_empty() {
            return None;
        }
        let id = self.next;
        self.next += 1;
        let step = Step { id, records };
        match history {
            History::Undo => {
                self.redo.push(step);
                return None;
            }
            History::New => {
                self.redo.clear();
                self.steps.push(step);
            }
            History::Redo => self.steps.push(step),
        }
        if self.steps.len() > UNDO_LIMIT {
            self.steps.remove(0);
        }
        Some(id)
    }

    fn latest(&self) -> Option<u64> {
        self.steps.last().map(|step| step.id)
    }

    /// Takes the newest step. With `wanted`, only if that is the newest.
    fn take(&mut self, wanted: Option<u64>) -> Option<Vec<Done>> {
        if wanted.is_some() && wanted != self.latest() {
            return None;
        }
        self.steps.pop().map(|step| step.records)
    }

    fn take_redo(&mut self) -> Option<Vec<Done>> {
        self.redo.pop().map(|step| step.records)
    }

    fn undoable(&self) -> Undoable {
        Undoable {
            latest_step: self.latest(),
            redo: !self.redo.is_empty(),
        }
    }
}

/// Every running job, and what can be undone.
#[derive(Default)]
pub struct Jobs {
    next: AtomicU64,
    running: Mutex<HashMap<u64, Arc<Entry>>>,
    /// Set while an update installs, which ends Perli, so no job may start. Read and written
    /// only under the `running` lock.
    closed: AtomicBool,
    undo: Mutex<UndoLog>,
    /// Reads the saved log off the main thread, so a big one can't slow the start.
    loading: Mutex<Option<JoinHandle<UndoLog>>>,
}

impl Jobs {
    pub fn loading_history() -> Self {
        Self {
            loading: Mutex::new(Some(thread::spawn(UndoLog::load))),
            ..Self::default()
        }
    }

    fn log(&self) -> MutexGuard<'_, UndoLog> {
        let mut log = lock(&self.undo);
        if let Some(loading) = lock(&self.loading).take() {
            *log = loading.join().unwrap_or_default();
        }
        log
    }

    pub fn undoable(&self) -> Undoable {
        self.log().undoable()
    }

    pub fn running(&self) -> bool {
        !lock(&self.running).is_empty()
    }

    /// Stops new jobs from starting, if none is running. Says whether it did.
    pub fn close(&self) -> bool {
        let running = lock(&self.running);
        let idle = running.is_empty();
        if idle {
            self.closed.store(true, Ordering::SeqCst);
        }
        idle
    }

    pub fn reopen(&self) {
        let _running = lock(&self.running);
        self.closed.store(false, Ordering::SeqCst);
    }

    fn admit(&self, id: u64, entry: Arc<Entry>) -> Result<(), String> {
        let mut running = lock(&self.running);
        if self.closed.load(Ordering::SeqCst) {
            return Err("Perli is installing an update, so nothing new can start.".into());
        }
        running.insert(id, entry);
        Ok(())
    }

    pub fn cancel_all(&self) {
        for entry in lock(&self.running).values() {
            entry.control.cancel();
            entry.reply(CANCEL);
        }
    }

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
}

/// Starts a job on its own thread and returns right away. One job per thread lets jobs run
/// side by side, and each thread hosts its own shell work.
pub fn start(app: &AppHandle, plan: Plan) -> Result<(), String> {
    let jobs = app.state::<Jobs>();
    let id = jobs.next.fetch_add(1, Ordering::Relaxed);
    let entry = Arc::<Entry>::default();
    jobs.admit(id, entry.clone())?;

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

fn replay(
    app: &AppHandle,
    records: Option<Vec<Done>>,
    origin: Option<u32>,
    history: History,
) -> Result<(), String> {
    match records {
        Some(records) => start(
            app,
            Plan {
                origin,
                history,
                ..Job::Undo { records }.into()
            },
        ),
        None => Ok(()),
    }
}

/// Reverses the newest step. Does nothing if there is none, or if `step` is no longer it.
pub fn undo(app: &AppHandle, origin: Option<u32>, step: Option<u64>) -> Result<(), String> {
    let records = app.state::<Jobs>().log().take(step);
    replay(app, records, origin, History::Undo)
}

/// An undo's own records are the way back, so a redo is an undo of those.
pub fn redo(app: &AppHandle, origin: Option<u32>) -> Result<(), String> {
    let records = app.state::<Jobs>().log().take_redo();
    replay(app, records, origin, History::Redo)
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
        self.send(Change::Started {
            title: match plan.history {
                History::Redo => "Redoing".to_string(),
                _ => title(&plan.job),
            },
            origin: plan.origin,
            new_item: matches!(plan.job, Job::New { .. } | Job::Template { .. } | Job::Zip { .. }),
            recycle: matches!(plan.job, Job::Recycle { .. }),
        });

        let outcome = ops::run(plan.job, self, &self.entry.control);

        let jobs = self.app.state::<Jobs>();
        parts::forget(self.id);
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
        let mut log = jobs.log();
        let step = log.record(plan.history, done);
        log.save();
        let undoable = log.undoable();
        drop(log);
        // Only now is the job over, so closing waits for its undo step to be saved.
        lock(&jobs.running).remove(&self.id);
        self.send(Change::Finished {
            touched: touched.iter().map(|path| text(path)).collect(),
            created,
            kept: kept.iter().map(|path| text(path)).collect(),
            cancelled,
            step,
            undoable,
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

    fn temp_folder(&self, folder: &Path) {
        parts::note(self.id, folder);
    }

    fn staged(&self, staged: &Path, source: &Path) {
        parts::note_staged(self.id, staged, source);
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
        Job::RenameAll { renames } => format!("Renaming {} items", renames.len()),
        Job::New { directory: true, .. } => "Creating a folder".to_string(),
        Job::New { .. } | Job::Template { .. } => "Creating a file".to_string(),
        Job::Shortcut { sources, .. } => listed("Linking to", sources),
        Job::Zip { sources } => listed("Compressing", sources),
        Job::Unzip { archives, .. } => listed("Extracting", archives),
        Job::Receive { .. } => "Copying dragged files".to_string(),
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
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;

    use super::*;

    fn step(number: usize) -> Vec<Done> {
        vec![Done::Created {
            path: PathBuf::from(number.to_string()),
        }]
    }

    #[test]
    fn closing_waits_for_jobs_and_keeps_new_ones_out() {
        let jobs = Jobs::default();
        jobs.admit(1, Arc::default()).unwrap();
        assert!(!jobs.close(), "a running job keeps it open");
        lock(&jobs.running).clear();

        assert!(jobs.close());
        assert!(jobs.admit(2, Arc::default()).is_err());
        assert!(!jobs.running());
        jobs.reopen();
        assert!(jobs.admit(3, Arc::default()).is_ok());
    }

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
        let mut log = UndoLog::default();
        for number in 0..=UNDO_LIMIT {
            assert_eq!(log.record(History::New, step(number)), Some(number as u64));
        }

        assert_eq!(log.record(History::New, Vec::new()), None);
        assert_eq!(log.latest(), Some(UNDO_LIMIT as u64));
        assert_eq!(log.steps.len(), UNDO_LIMIT);
        assert_eq!(log.steps[0].records, step(1));
    }

    #[test]
    fn an_old_job_cannot_undo_a_newer_one() {
        let mut log = UndoLog::default();
        let first = log.record(History::New, step(1));
        assert_eq!(log.take(first), Some(step(1)));

        // The log is as long as it was when the first job ended, but this is another step.
        let second = log.record(History::New, step(2));
        assert_ne!(first, second);
        assert_eq!(log.take(first), None);
        assert_eq!(log.take(second), Some(step(2)));
        assert_eq!(log.latest(), None);
    }

    #[test]
    fn ctrl_z_takes_whatever_is_newest() {
        let mut log = UndoLog::default();
        log.record(History::New, step(1));
        log.record(History::New, step(2));

        assert_eq!(log.take(None), Some(step(2)));
        assert_eq!(log.take(None), Some(step(1)));
        assert_eq!(log.take(None), None);
    }

    #[test]
    fn redo_walks_back_through_what_undo_did() {
        let mut log = UndoLog::default();
        log.record(History::New, step(1));

        let records = log.take(None).unwrap();
        // What the undo job did, which is how to redo it.
        assert_eq!(log.record(History::Undo, step(2)), None);
        assert_eq!(records, step(1));
        assert_eq!(log.latest(), None);
        assert!(log.undoable().redo);

        let records = log.take_redo().unwrap();
        assert_eq!(records, step(2));
        assert!(log.record(History::Redo, step(3)).is_some());
        assert!(!log.undoable().redo);
        assert_eq!(log.take(None), Some(step(3)));
    }

    #[test]
    fn a_new_change_ends_redo_but_a_job_that_changed_nothing_does_not() {
        let mut log = UndoLog::default();
        log.record(History::New, step(1));
        log.take(None);
        log.record(History::Undo, step(2));

        log.record(History::New, Vec::new());
        assert!(log.undoable().redo);

        log.record(History::New, step(3));
        assert!(!log.undoable().redo);
    }

    #[test]
    fn redo_leaves_later_redo_steps_alone() {
        let mut log = UndoLog::default();
        log.record(History::New, step(1));
        log.record(History::New, step(2));
        for number in [3, 4] {
            log.take(None);
            log.record(History::Undo, step(number));
        }

        log.take_redo();
        log.record(History::Redo, step(5));

        assert!(log.undoable().redo);
    }

    #[test]
    fn the_log_survives_a_restart_and_keeps_ids_unique() {
        let mut log = UndoLog::default();
        let kept = log.record(History::New, step(1));
        log.record(History::New, step(2));
        log.take(None);
        log.record(History::Undo, step(3));

        let mut restarted = UndoLog::parse(&log.text());

        assert_eq!(restarted.latest(), kept);
        assert!(restarted.undoable().redo);
        assert!(restarted.record(History::New, step(4)) > kept);
        assert_eq!(restarted.take(None), Some(step(4)));
        assert_eq!(restarted.take(kept), Some(step(1)));
    }

    #[test]
    fn damaged_log_starts_fresh() {
        for text in ["", "{", r#"{"next":"x"}"#, r#"{"next":1,"steps":[{"id":0}],"redo":[]}"#] {
            assert_eq!(UndoLog::parse(text).latest(), None);
        }
    }

    #[test]
    fn a_step_that_cannot_be_written_stays_out_of_the_file() {
        let mut log = UndoLog::default();
        let good = log.record(History::New, step(1));
        log.record(
            History::New,
            vec![Done::Created {
                path: OsString::from_wide(&[0xD800]).into(),
            }],
        );

        let restarted = UndoLog::parse(&log.text());

        assert_eq!(restarted.steps.len(), 1);
        assert_eq!(restarted.latest(), good);
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
                step: None,
                undoable: Undoable {
                    latest_step: Some(3),
                    redo: true,
                },
            },
        };
        let json = serde_json::to_value(event).unwrap();

        assert_eq!(json["id"], 7);
        assert_eq!(json["kind"], "finished");
        assert_eq!(json["latestStep"], 3);
        assert_eq!(json["redo"], true);
        assert_eq!(json["step"], serde_json::Value::Null);

        let event = Event {
            id: 8,
            change: Change::Progress(Progress {
                total_bytes: 9,
                ..Progress::default()
            }),
        };
        let json = serde_json::to_value(event).unwrap();

        assert_eq!(json["kind"], "progress");
        assert_eq!(json["totalBytes"], 9);
    }
}
