//! Runs file jobs on their own threads and reports to the UI through the `job` event.

use std::cell::Cell;
use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::clipboard;
use crate::ops::{self, Answer, Control, Done, Failed, Host, Job, Outcome, Progress, Question, Reply};
use crate::{parts, session};

/// Scanning goes one call deeper per folder level, and paths allow about 16,000 levels.
pub const STACK_BYTES: usize = 64 * 1024 * 1024;

const EVENT: &str = "job";
const REPORT_GAP: Duration = Duration::from_millis(100);
const UNDO_LIMIT: usize = 100;
const UNDO_FILE: &str = "undo.json";
/// Selecting more new items than this helps nobody, and sending them all is slow.
const SELECT_LIMIT: usize = 10_000;
/// How often a job waiting for its drive looks again, for a cancel or a "Start now".
const TURN_CHECK: Duration = Duration::from_millis(250);
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
        /// An undo, whose rows go back to where they were.
        back: bool,
        /// The folder the job fills, for what to do when it is done.
        target: Option<String>,
    },
    /// The job waits for another to finish on these drives. Empty once it starts.
    Waiting {
        drives: Vec<String>,
    },
    Progress(Progress),
    Asked {
        question: Question,
    },
    Finished {
        touched: Vec<String>,
        created: Vec<String>,
        kept: Vec<String>,
        failed: Vec<Retry>,
        cancelled: bool,
        /// The undo step this job added.
        step: Option<u64>,
        #[serde(flatten)]
        undoable: Undoable,
    },
}

/// What a copy or a move skipped, which the UI can try again.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Retry {
    source: String,
    folder: String,
    moving: bool,
}

impl From<&Failed> for Retry {
    fn from(failed: &Failed) -> Self {
        Self { source: text(&failed.source), folder: text(&failed.folder), moving: failed.moving }
    }
}

/// What Undo and Redo can do now.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Undoable {
    /// The step Undo would reverse next.
    latest_step: Option<u64>,
    redo: bool,
    /// What Undo and Redo would do, told the way a person would.
    undo_text: Option<String>,
    redo_text: Option<String>,
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
    /// The user would rather not wait for the drive.
    go_now: AtomicBool,
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
    /// When it happened, in milliseconds since 1970. Zero for steps saved before this was kept.
    #[serde(default)]
    at: u64,
    /// What a redo step will do again. Its records are what the undo did, which tell it backwards.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    text: Option<String>,
}

/// One step of the undo log, told the way a person would.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    id: u64,
    at: u64,
    text: String,
    /// Where to look for what it left: the item itself, or the folder it was in.
    path: String,
    /// It is the newest step, the only one Undo may take.
    newest: bool,
}

fn name_of(path: &Path) -> String {
    path.file_name().unwrap_or(path.as_os_str()).to_string_lossy().into_owned()
}

/// "Renamed A to B", "Moved 3 items to Photos": what a step did, and where to look for it.
fn describe(records: &[Done]) -> (String, PathBuf) {
    let counted = |verb: &str, name: &Path| match records.len() {
        1 => format!("{verb} {}", name_of(name)),
        many => format!("{verb} {many} items"),
    };
    let moves: Vec<(&PathBuf, &PathBuf)> = records
        .iter()
        .filter_map(|record| match record {
            Done::Moved { from, to } => Some((from, to)),
            _ => None,
        })
        .collect();
    match records {
        [] => (String::new(), PathBuf::new()),
        [Done::Created { path }, rest @ ..] if !rest.is_empty() && moves.len() == rest.len() => {
            let inside = moves.iter().all(|(_, to)| to.parent() == Some(path));
            let text = if inside {
                format!("Made {} with {} inside", name_of(path), rest.len())
            } else {
                format!("Changed {} items", records.len())
            };
            (text, path.clone())
        }
        [Done::Moved { from, to }, ..] if moves.len() == records.len() => {
            let renamed = moves.iter().all(|(from, to)| from.parent() == to.parent());
            let text = match (renamed, records.len()) {
                (true, 1) => format!("Renamed {} to {}", name_of(from), name_of(to)),
                (true, many) => format!("Renamed {many} items"),
                (false, _) => format!("{} to {}", counted("Moved", to), name_of(to.parent().unwrap_or(to))),
            };
            (text, to.clone())
        }
        [Done::Created { path }, ..] if records.iter().all(|record| matches!(record, Done::Created { .. })) => {
            (format!("{} to {}", counted("Added", path), name_of(path.parent().unwrap_or(path))), path.clone())
        }
        [Done::Recycled { original, .. }, ..] if records.iter().all(|record| matches!(record, Done::Recycled { .. })) => {
            (counted("Recycled", original), original.parent().unwrap_or(original).to_path_buf())
        }
        [first, ..] => {
            let path = match first {
                Done::Created { path } | Done::Moved { to: path, .. } | Done::Recycled { original: path, .. } => path,
            };
            (format!("Changed {} items", records.len()), path.clone())
        }
    }
}

/// What can be undone and redone, oldest first. Ids are never reused, so an old job can't pass
/// for the newest step. The log outlives the app, and what it holds may be out of date by then,
/// but undo never deletes for good and asks about anything it can't do.
#[derive(Default, Deserialize)]
struct UndoLog {
    next: u64,
    steps: Vec<Step>,
    redo: Vec<Step>,
    /// What the steps taken for the running undo did, for its redo step.
    #[serde(skip)]
    undone: Option<String>,
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
        let at = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |since| since.as_millis() as u64);
        let step = Step { id, records, at, text: None };
        match history {
            History::Undo => {
                self.redo.push(Step { text: self.undone.take(), ..step });
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
        let at = self.steps.len().checked_sub(1)?;
        Some(self.take_from(at))
    }

    /// Takes the newest steps down to and including `step`, as one batch in the order they
    /// happened. Nothing if `step` is no longer in the log.
    fn take_back_to(&mut self, step: u64) -> Option<Vec<Done>> {
        let at = self.steps.iter().position(|kept| kept.id == step)?;
        Some(self.take_from(at))
    }

    fn take_from(&mut self, at: usize) -> Vec<Done> {
        let taken: Vec<Step> = self.steps.drain(at..).collect();
        let newest = taken.last().map(|step| describe(&step.records).0).unwrap_or_default();
        self.undone = Some(match taken.len() {
            1 => newest,
            2 => format!("{newest}, and the step before it"),
            many => format!("{newest}, and {} steps before it", many - 1),
        });
        taken.into_iter().flat_map(|step| step.records).collect()
    }

    fn take_redo(&mut self) -> Option<Vec<Done>> {
        self.redo.pop().map(|step| step.records)
    }

    /// Every step that can still be undone, newest first.
    fn activity(&self) -> Vec<Activity> {
        let newest = self.latest();
        let told = self.steps.iter().rev().map(|step| {
            let (text, path) = describe(&step.records);
            Activity { id: step.id, at: step.at, text, path: text_of(&path), newest: Some(step.id) == newest }
        });
        told.collect()
    }

    fn undoable(&self) -> Undoable {
        let told = |step: &Step| step.text.clone().unwrap_or_else(|| describe(&step.records).0);
        Undoable {
            latest_step: self.latest(),
            redo: !self.redo.is_empty(),
            undo_text: self.steps.last().map(told).filter(|text| !text.is_empty()),
            redo_text: self.redo.last().map(told).filter(|text| !text.is_empty()),
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
    /// How many running copy-like jobs use each drive.
    busy: Mutex<HashMap<String, usize>>,
    freed: Condvar,
    /// The user's settings: read back every copy, and one copy-like job per drive at a time.
    verify: AtomicBool,
    one_per_drive: AtomicBool,
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

    pub fn activity(&self) -> Vec<Activity> {
        self.log().activity()
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

    pub fn set_options(&self, verify: bool, one_per_drive: bool) {
        self.verify.store(verify, Ordering::Relaxed);
        self.one_per_drive.store(one_per_drive, Ordering::Relaxed);
        self.freed.notify_all();
    }

    /// A job waiting for its drive starts anyway.
    pub fn start_now(&self, id: u64) {
        if let Some(entry) = self.entry(id) {
            entry.go_now.store(true, Ordering::Relaxed);
            self.freed.notify_all();
        }
    }

    /// Waits until no other job uses `drives`, when the user asked for one at a time. `waiting`
    /// hears which drives hold it up, once.
    fn take_turn(&self, entry: &Entry, drives: Vec<String>, waiting: impl Fn(Vec<String>)) -> Turn<'_> {
        let mut busy = lock(&self.busy);
        let mut told = false;
        loop {
            let blocked: Vec<String> = drives.iter().filter(|drive| busy.contains_key(*drive)).cloned().collect();
            let queued = self.one_per_drive.load(Ordering::Relaxed);
            if !queued || blocked.is_empty() || entry.go_now.load(Ordering::Relaxed) || entry.control.cancelled() {
                break;
            }
            if !told {
                waiting(blocked);
                told = true;
            }
            busy = self.freed.wait_timeout(busy, TURN_CHECK).unwrap_or_else(|error| error.into_inner()).0;
        }
        for drive in &drives {
            *busy.entry(drive.clone()).or_default() += 1;
        }
        drop(busy);
        if told {
            waiting(Vec::new());
        }
        Turn { jobs: self, drives }
    }
}

/// A job's hold on its drives, let go when it ends.
struct Turn<'a> {
    jobs: &'a Jobs,
    drives: Vec<String>,
}

impl Drop for Turn<'_> {
    fn drop(&mut self) {
        let mut busy = lock(&self.jobs.busy);
        for drive in &self.drives {
            if let Some(count) = busy.get_mut(drive) {
                *count -= 1;
                if *count == 0 {
                    busy.remove(drive);
                }
            }
        }
        self.jobs.freed.notify_all();
    }
}

/// The drives a job reads and writes in bulk, as `C:` or `\\server\share`. A move within one
/// drive only renames, and other jobs are quick, so they take no turn.
fn drives_of(job: &Job) -> Vec<String> {
    let drive = |path: &Path| match path.components().next() {
        Some(Component::Prefix(prefix)) => Some(prefix.as_os_str().to_string_lossy().to_uppercase()),
        _ => None,
    };
    let paths: Vec<&Path> = match job {
        Job::Copy { sources, folder } => sources.iter().map(PathBuf::as_path).chain([folder.as_path()]).collect(),
        Job::Move { sources, folder } if sources.iter().all(|source| drive(source) == drive(folder)) => Vec::new(),
        Job::Move { sources, folder } => sources.iter().map(PathBuf::as_path).chain([folder.as_path()]).collect(),
        Job::Zip { sources: paths, .. } | Job::Unzip { archives: paths, .. } => paths.iter().map(PathBuf::as_path).collect(),
        Job::Receive { folder, .. } => vec![folder.as_path()],
        _ => Vec::new(),
    };
    let mut drives: Vec<String> = paths.into_iter().filter_map(drive).collect();
    drives.sort();
    drives.dedup();
    drives
}

/// The folder a job fills, for "open it when done".
fn target_of(job: &Job) -> Option<String> {
    match job {
        Job::Copy { folder, .. } | Job::Move { folder, .. } | Job::Receive { folder, .. } => Some(text(folder)),
        Job::Zip { sources: paths, .. } | Job::Unzip { archives: paths, .. } => {
            paths.first().map(|path| text(&ops::sys::parent(path)))
        }
        _ => None,
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

/// Reverses the newest step. Does nothing if there is none, or if `step` is no longer it. With
/// `back`, reverses every step from the newest down to `step`, as one.
pub fn undo(app: &AppHandle, origin: Option<u32>, step: Option<u64>, back: bool) -> Result<(), String> {
    let jobs = app.state::<Jobs>();
    let mut log = jobs.log();
    let records = match (back, step) {
        (true, Some(step)) => log.take_back_to(step),
        _ => log.take(step),
    };
    drop(log);
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
            new_item: matches!(plan.job, Job::New { .. } | Job::Gather { .. } | Job::Template { .. } | Job::Zip { .. }),
            recycle: matches!(plan.job, Job::Recycle { .. }),
            back: matches!(plan.history, History::Undo),
            target: target_of(&plan.job),
        });

        let jobs = self.app.state::<Jobs>();
        let turn = jobs.take_turn(&self.entry, drives_of(&plan.job), |drives| self.send(Change::Waiting { drives }));
        let outcome = ops::run(plan.job, self, &self.entry.control);
        drop(turn);

        parts::forget(self.id);
        if let (Some(seen), false) = (plan.cut, outcome.cancelled) {
            let _ = clipboard::clear_if_unchanged(seen);
        }
        let created = created(&outcome.done);
        let Outcome {
            done,
            touched,
            kept,
            failed,
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
            failed: failed.iter().take(SELECT_LIMIT).map(Retry::from).collect(),
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

    fn verify_copies(&self) -> bool {
        self.app.state::<Jobs>().verify.load(Ordering::Relaxed)
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

fn text_of(path: &Path) -> String {
    text(path)
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
        Job::Gather { sources, .. } if sources.is_empty() => "Creating a folder".to_string(),
        Job::Gather { sources, .. } => listed("Moving into a new folder", sources),
        Job::New { .. } | Job::Template { .. } => "Creating a file".to_string(),
        Job::Shortcut { sources, .. } => listed("Linking to", sources),
        Job::Zip { sources, .. } => listed("Compressing", sources),
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
    fn each_step_is_told_the_way_a_person_would() {
        let path = |text: &str| PathBuf::from(text);
        let moved = |from: &str, to: &str| Done::Moved { from: path(from), to: path(to) };
        let told = |records: &[Done]| describe(records).0;
        assert_eq!(told(&[moved(r"C:\a\old.txt", r"C:\a\new.txt")]), "Renamed old.txt to new.txt");
        assert_eq!(told(&[moved(r"C:\a\1", r"C:\a\x"), moved(r"C:\a\2", r"C:\a\y")]), "Renamed 2 items");
        assert_eq!(told(&[moved(r"C:\a\one.txt", r"C:\Photos\one.txt")]), "Moved one.txt to Photos");
        let three = [moved(r"C:\a\1", r"C:\Photos\1"), moved(r"C:\a\2", r"C:\Photos\2"), moved(r"C:\a\3", r"C:\Photos\3")];
        assert_eq!(told(&three), "Moved 3 items to Photos");
        assert_eq!(told(&[Done::Created { path: path(r"C:\a\copy.txt") }]), "Added copy.txt to a");
        let bin = Done::Recycled { original: path(r"C:\a\gone.txt"), item: path(r"C:\$R\x") };
        assert_eq!(describe(&[bin]), ("Recycled gone.txt".to_string(), path(r"C:\a")));
        let gathered = [Done::Created { path: path(r"C:\a\Trip") }, moved(r"C:\a\1", r"C:\a\Trip\1"), moved(r"C:\a\2", r"C:\a\Trip\2")];
        assert_eq!(describe(&gathered), ("Made Trip with 2 inside".to_string(), path(r"C:\a\Trip")));
    }

    #[test]
    fn the_activity_is_newest_first_and_only_the_newest_can_be_undone() {
        let mut log = UndoLog::default();
        log.record(History::New, step(1));
        log.record(History::New, step(2));
        let told = log.activity();
        assert_eq!(told.iter().map(|one| (one.id, one.newest)).collect::<Vec<_>>(), [(1, true), (0, false)]);
        assert!(told[0].at > 0);
        assert!(UndoLog::parse(r#"{"next":1,"steps":[{"id":0,"records":[]}],"redo":[]}"#).activity()[0].at == 0);
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
    fn undo_can_go_back_several_steps_at_once() {
        let mut log = UndoLog::default();
        for number in 1..=4 {
            log.record(History::New, step(number));
        }

        // Records come in the order they happened, so the undo plays them backwards.
        let records = log.take_back_to(1).unwrap();
        assert_eq!(records, [step(2), step(3), step(4)].concat());
        assert_eq!(log.latest(), Some(0));
        assert_eq!(log.take_back_to(1), None, "that step is gone now");

        log.record(History::Undo, step(9));
        let redo = log.undoable().redo_text.unwrap();
        assert!(redo.starts_with("Added 4 to"), "{redo}");
        assert!(redo.ends_with("and 2 steps before it"), "{redo}");
    }

    #[test]
    fn undo_and_redo_say_what_they_will_do() {
        let mut log = UndoLog::default();
        let moved = vec![Done::Moved { from: PathBuf::from(r"C:\a\x.txt"), to: PathBuf::from(r"C:\a\y.txt") }];
        log.record(History::New, moved);
        assert_eq!(log.undoable().undo_text.as_deref(), Some("Renamed x.txt to y.txt"));

        log.take(None);
        let back = vec![Done::Moved { from: PathBuf::from(r"C:\a\y.txt"), to: PathBuf::from(r"C:\a\x.txt") }];
        log.record(History::Undo, back);
        assert_eq!(log.undoable().undo_text, None);
        assert_eq!(log.undoable().redo_text.as_deref(), Some("Renamed x.txt to y.txt"));
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
    fn only_bulk_jobs_take_a_turn_on_their_drives() {
        let paths = |list: &[&str]| list.iter().map(PathBuf::from).collect::<Vec<_>>();
        let copy = Job::Copy { sources: paths(&[r"c:\a\x.txt", r"D:\b"]), folder: PathBuf::from(r"D:\to") };
        assert_eq!(drives_of(&copy), ["C:", "D:"]);
        let rename = Job::Move { sources: paths(&[r"C:\a\x.txt"]), folder: PathBuf::from(r"C:\to") };
        assert!(drives_of(&rename).is_empty(), "a move on one drive only renames");
        let across = Job::Move { sources: paths(&[r"C:\a\x.txt"]), folder: PathBuf::from(r"\\nas\share\to") };
        assert_eq!(drives_of(&across), ["C:", r"\\NAS\SHARE"]);
        assert!(drives_of(&Job::Recycle { paths: paths(&[r"C:\a"]) }).is_empty());
        assert_eq!(target_of(&copy).as_deref(), Some(r"D:\to"));
    }

    #[test]
    fn a_second_job_on_a_drive_waits_until_the_first_lets_go() {
        let jobs = Arc::new(Jobs::default());
        jobs.set_options(false, true);
        let first = Entry::default();
        let turn = jobs.take_turn(&first, vec!["D:".into()], |_| panic!("nothing holds D: yet"));

        let (heard, hear) = mpsc::channel();
        let waiter = {
            let jobs = jobs.clone();
            thread::spawn(move || {
                let second = Entry::default();
                let _turn = jobs.take_turn(&second, vec!["D:".into()], |drives| heard.send(drives).unwrap());
            })
        };
        assert_eq!(hear.recv().unwrap(), ["D:"]);
        drop(turn);
        assert!(hear.recv().unwrap().is_empty(), "it says when it starts");
        waiter.join().unwrap();
        assert!(lock(&jobs.busy).is_empty());
    }

    #[test]
    fn events_reach_the_ui_flat_and_camel_cased() {
        let event = Event {
            id: 7,
            change: Change::Finished {
                touched: Vec::new(),
                created: Vec::new(),
                kept: Vec::new(),
                failed: Vec::new(),
                cancelled: false,
                step: None,
                undoable: Undoable {
                    latest_step: Some(3),
                    redo: true,
                    undo_text: Some("Renamed a to b".into()),
                    redo_text: None,
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
