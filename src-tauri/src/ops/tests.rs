//! Runs the engine against real files in a temp folder. `sys::test_guard` fails any test that
//! writes outside it.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::fs;
use std::os::windows::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering as AtomicOrdering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use windows::Win32::Storage::FileSystem::GetLogicalDrives;

use super::bin::{parse_info, read_root};
use super::names::check as check_name;
use super::sys::test_guard;
use super::*;

static NEXT_FOLDER: AtomicU32 = AtomicU32::new(0);

/// Parallel tests must not pick the same drive letter.
static DRIVE_LETTERS: Mutex<()> = Mutex::new(());

/// The folder a test may touch, removed at the end.
pub(super) struct Sandbox(PathBuf);

impl Sandbox {
    pub(super) fn new() -> Self {
        let number = NEXT_FOLDER.fetch_add(1, AtomicOrdering::Relaxed);
        let root = std::env::temp_dir().join(format!("perli-ops-{}-{number}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        test_guard::enter(&root);
        Self(root)
    }

    pub(super) fn path(&self, relative: &str) -> PathBuf {
        self.0.join(relative)
    }

    pub(super) fn file(&self, relative: &str, text: &str) -> PathBuf {
        let path = self.path(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, text).unwrap();
        path
    }

    fn folder(&self, relative: &str) -> PathBuf {
        let path = self.path(relative);
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn junction(&self, relative: &str, target: &Path) -> PathBuf {
        let path = self.path(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let made = Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&path)
            .arg(target)
            .output()
            .unwrap();
        assert!(made.status.success(), "{made:?}");
        path
    }

    fn names(&self, relative: &str) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(self.path(relative))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Answers questions from a list, then skips. `during` runs on every progress report.
#[derive(Default)]
pub(super) struct Script {
    replies: RefCell<VecDeque<Reply>>,
    questions: RefCell<Vec<Question>>,
    during: Option<Box<dyn Fn(&Progress)>>,
}

impl Script {
    fn answering(answers: &[Answer]) -> Self {
        let replies = answers.iter().map(|&answer| Reply { answer, all: false });
        Self {
            replies: RefCell::new(replies.collect()),
            ..Self::default()
        }
    }

    fn always(answer: Answer) -> Self {
        Self {
            replies: RefCell::new(VecDeque::from([Reply { answer, all: true }])),
            ..Self::default()
        }
    }

    fn asked(&self) -> usize {
        self.questions.borrow().len()
    }
}

impl Host for Script {
    fn progress(&self, progress: &Progress) {
        if let Some(during) = &self.during {
            during(progress);
        }
    }

    fn ask(&self, question: Question) -> Reply {
        self.questions.borrow_mut().push(question);
        self.replies.borrow_mut().pop_front().unwrap_or(Reply {
            answer: Answer::Skip,
            all: false,
        })
    }
}

fn run_with(job: Job, host: &Script) -> Outcome {
    run(job, host, &Arc::new(Control::default()))
}

fn go(job: Job) -> Outcome {
    run_with(job, &Script::default())
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap()
}

fn copy(source: &Path, folder: &Path) -> Job {
    Job::Copy {
        sources: vec![source.to_path_buf()],
        folder: folder.to_path_buf(),
    }
}

fn moving(source: &Path, folder: &Path) -> Job {
    Job::Move {
        sources: vec![source.to_path_buf()],
        folder: folder.to_path_buf(),
    }
}

/// Writes down which folders a job said it would use.
#[derive(Default)]
struct Noting {
    folders: RefCell<Vec<PathBuf>>,
}

impl Host for Noting {
    fn progress(&self, _progress: &Progress) {}

    fn ask(&self, _question: Question) -> Reply {
        panic!("nothing here should ask");
    }

    fn temp_folder(&self, folder: &Path) {
        self.folders.borrow_mut().push(folder.to_path_buf());
    }
}

/// Removes what a test put in the real Recycle Bin, one item at a time, then the test's own
/// permission to touch it.
fn purge(outcome: &Outcome) {
    for record in &outcome.done {
        if let Done::Recycled { item, .. } = record {
            purge_item(item);
        }
    }
}

fn purge_item(item: &Path) {
    let name = item.file_name().unwrap().to_string_lossy();
    let info = item.with_file_name(format!("$I{}", &name[2..]));
    test_guard::allow(item);
    test_guard::allow(&info);
    if item.is_dir() {
        // Only this item's own tree, by exact path.
        for entry in fs::read_dir(item).unwrap() {
            test_guard::allow(&entry.unwrap().path());
        }
    }
    go(Job::Purge {
        items: vec![BinItem {
            item: item.to_path_buf(),
            original: PathBuf::new(),
            size: 0,
            deleted: 0,
            is_dir: item.is_dir(),
        }],
    });
}

fn allow_bin_copy(outcome: &Outcome) {
    for record in &outcome.done {
        if let Done::Recycled { item, .. } = record {
            let name = item.file_name().unwrap().to_string_lossy();
            test_guard::allow(item);
            test_guard::allow(&item.with_file_name(format!("$I{}", &name[2..])));
        }
    }
}

fn undo(outcome: Outcome) -> Outcome {
    allow_bin_copy(&outcome);
    go(Job::Undo {
        records: outcome.done,
    })
}

/// A drive letter with no Recycle Bin, pointing at a folder.
struct SubstDrive(String);

impl SubstDrive {
    fn new(folder: &Path) -> Self {
        let _picking = DRIVE_LETTERS.lock().unwrap_or_else(|error| error.into_inner());
        let used = unsafe { GetLogicalDrives() };
        let letter = (b'P'..=b'Z')
            .rev()
            .find(|letter| used & (1 << (letter - b'A')) == 0)
            .unwrap();
        let drive = format!("{}:", char::from(letter));
        let made = Command::new("subst").arg(&drive).arg(folder).status().unwrap();
        assert!(made.success());
        Self(drive)
    }
}

impl Drop for SubstDrive {
    fn drop(&mut self) {
        let _ = Command::new("subst").arg(&self.0).arg("/D").status();
    }
}

/// A file nobody else can open until this drops.
fn lock(path: &Path) -> fs::File {
    fs::OpenOptions::new().read(true).share_mode(0).open(path).unwrap()
}

fn long_folder(sandbox: &Sandbox) -> PathBuf {
    let mut path = sandbox.0.clone();
    while path.as_os_str().len() < 300 {
        path.push("a-rather-long-folder-name");
    }
    sys::create_dirs(&path).unwrap();
    path
}

fn write_extended(path: &Path, text: &str) {
    fs::write(sys::extended(path).to_os_string(), text).unwrap();
}

fn read_extended(path: &Path) -> String {
    fs::read_to_string(sys::extended(path).to_os_string()).unwrap()
}

fn exists(path: &Path) -> bool {
    matches!(sys::stat(path), Ok(Some(_)))
}

// The guard.

#[test]
#[should_panic(expected = "outside its temp folder")]
fn guard_stops_a_write_outside_the_sandbox() {
    let _sandbox = Sandbox::new();
    let _ = sys::delete_file(Path::new(r"C:\Windows\perli-never.txt"));
}

#[test]
#[should_panic(expected = "outside its temp folder")]
fn guard_stops_a_write_on_a_thread_with_no_sandbox() {
    let _ = sys::create_dir(&std::env::temp_dir().join("perli-never"));
}

#[test]
#[should_panic(expected = "outside its temp folder")]
fn guard_stops_a_climb_out_of_the_sandbox() {
    let sandbox = Sandbox::new();
    let _ = sys::delete_file(&sandbox.path(r"..\perli-never.txt"));
}

#[test]
#[should_panic(expected = "outside its temp folder")]
fn guard_stops_a_recycle_outside_the_sandbox() {
    let _sandbox = Sandbox::new();
    go(Job::Recycle {
        paths: vec![PathBuf::from(r"C:\Windows\win.ini")],
    });
}

#[test]
#[should_panic(expected = "never empty")]
fn tests_can_never_empty_the_real_bin() {
    let _sandbox = Sandbox::new();
    go(Job::Empty);
}

// Copy.

#[test]
fn copies_a_folder_tree_as_one_undoable_record() {
    let sandbox = Sandbox::new();
    sandbox.file(r"from\tree\a.txt", "a");
    sandbox.file(r"from\tree\sub\b.txt", "b");
    let empty = sandbox.folder(r"from\tree\empty");
    let target = sandbox.folder("to");

    let outcome = go(copy(&sandbox.path(r"from\tree"), &target));

    assert_eq!(read(&sandbox.path(r"to\tree\sub\b.txt")), "b");
    assert!(sandbox.path(r"to\tree\empty").is_dir());
    assert!(empty.is_dir());
    assert_eq!(
        outcome.done,
        [Done::Created {
            path: sandbox.path(r"to\tree")
        }]
    );
    assert!(outcome.touched.contains(&target));
    assert_eq!(sandbox.names(r"to\tree"), ["a.txt", "empty", "sub"]);
}

#[test]
fn copy_keeps_modified_time_and_read_only() {
    let sandbox = Sandbox::new();
    let source = sandbox.file(r"from\a.txt", "a");
    let mut permissions = fs::metadata(&source).unwrap().permissions();
    permissions.set_readonly(true);
    fs::set_permissions(&source, permissions).unwrap();
    let target = sandbox.folder("to");

    go(copy(&source, &target));

    let copied = fs::metadata(sandbox.path(r"to\a.txt")).unwrap();
    assert!(copied.permissions().readonly());
    assert_eq!(copied.modified().unwrap(), fs::metadata(&source).unwrap().modified().unwrap());
    for path in [source, sandbox.path(r"to\a.txt")] {
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        permissions.set_readonly(false);
        fs::set_permissions(&path, permissions).unwrap();
    }
}

#[test]
fn copy_onto_its_own_folder_makes_numbered_copies() {
    let sandbox = Sandbox::new();
    let source = sandbox.file(r"here\a.txt", "a");
    let folder = sandbox.path("here");

    go(copy(&source, &folder));
    go(copy(&source, &folder));

    assert_eq!(sandbox.names("here"), ["a - Copy (2).txt", "a - Copy.txt", "a.txt"]);
}

#[test]
fn folder_cannot_be_copied_into_itself() {
    let sandbox = Sandbox::new();
    sandbox.file(r"tree\a.txt", "a");
    let inner = sandbox.folder(r"tree\inner");
    let script = Script::default();

    let outcome = run_with(copy(&sandbox.path("tree"), &inner), &script);

    assert!(outcome.done.is_empty());
    assert_eq!(script.asked(), 1);
    assert!(matches!(
        &script.questions.borrow()[0],
        Question::Problem { choices, .. } if !choices.contains(&Answer::Retry)
    ));
    assert_eq!(sandbox.names(r"tree\inner"), [""; 0]);
}

#[test]
fn folder_cannot_be_copied_into_itself_through_a_junction() {
    let sandbox = Sandbox::new();
    let tree = sandbox.folder("tree");
    sandbox.file(r"tree\a.txt", "a");
    let alias = sandbox.junction("alias", &tree);
    let script = Script::default();

    let outcome = run_with(copy(&tree, &alias), &script);

    assert!(outcome.done.is_empty());
    assert_eq!(script.asked(), 1);
    assert_eq!(sandbox.names("tree"), ["a.txt"]);
}

#[test]
fn replace_sends_the_old_file_to_the_bin_and_undo_brings_it_back() {
    let sandbox = Sandbox::new();
    let source = sandbox.file(r"from\a.txt", "new");
    let old = sandbox.file(r"to\a.txt", "old");
    let script = Script::answering(&[Answer::Replace]);

    let outcome = run_with(copy(&source, &sandbox.path("to")), &script);

    assert_eq!(read(&old), "new");
    assert!(matches!(outcome.done[0], Done::Recycled { .. }));
    assert!(matches!(outcome.done[1], Done::Created { .. }));
    assert_eq!(sandbox.names("to"), ["a.txt"]);

    // The new file goes to the bin, and the old one returns.
    let undone = undo(outcome);
    assert_eq!(read(&old), "old");
    purge(&undone);
}

#[test]
fn keep_both_numbers_the_new_file() {
    let sandbox = Sandbox::new();
    let source = sandbox.file(r"from\a.txt", "new");
    let old = sandbox.file(r"to\a.txt", "old");
    sandbox.file(r"to\a (2).txt", "older");
    let script = Script::answering(&[Answer::KeepBoth]);

    run_with(copy(&source, &sandbox.path("to")), &script);

    assert_eq!(read(&old), "old");
    assert_eq!(read(&sandbox.path(r"to\a (3).txt")), "new");
}

#[test]
fn skip_leaves_both_files_alone() {
    let sandbox = Sandbox::new();
    let source = sandbox.file(r"from\a.txt", "new");
    let old = sandbox.file(r"to\a.txt", "old");
    let script = Script::answering(&[Answer::Skip]);

    let outcome = run_with(copy(&source, &sandbox.path("to")), &script);

    assert_eq!(read(&old), "old");
    assert!(outcome.done.is_empty());
}

#[test]
fn apply_to_all_asks_once() {
    let sandbox = Sandbox::new();
    let sources = vec![sandbox.file(r"from\a.txt", "new"), sandbox.file(r"from\b.txt", "new")];
    sandbox.file(r"to\a.txt", "old");
    sandbox.file(r"to\b.txt", "old");
    let script = Script::always(Answer::KeepBoth);

    run_with(
        Job::Copy {
            sources,
            folder: sandbox.path("to"),
        },
        &script,
    );

    assert_eq!(script.asked(), 1);
    assert_eq!(sandbox.names("to"), ["a (2).txt", "a.txt", "b (2).txt", "b.txt"]);
}

#[test]
fn merge_fills_the_existing_folder_and_asks_about_each_clash() {
    let sandbox = Sandbox::new();
    sandbox.file(r"from\tree\new.txt", "new");
    sandbox.file(r"from\tree\same.txt", "theirs");
    sandbox.file(r"to\tree\same.txt", "ours");
    sandbox.file(r"to\tree\kept.txt", "kept");
    let script = Script::answering(&[Answer::Merge, Answer::Skip]);

    let outcome = run_with(copy(&sandbox.path(r"from\tree"), &sandbox.path("to")), &script);

    assert_eq!(sandbox.names(r"to\tree"), ["kept.txt", "new.txt", "same.txt"]);
    assert_eq!(read(&sandbox.path(r"to\tree\same.txt")), "ours");
    assert_eq!(script.asked(), 2);
    // Only what is new: the folder was already there, so undo must keep it.
    assert_eq!(
        outcome.done,
        [Done::Created {
            path: sandbox.path(r"to\tree\new.txt")
        }]
    );
}

#[test]
fn file_against_folder_offers_no_replace_or_merge() {
    let sandbox = Sandbox::new();
    let source = sandbox.file(r"from\thing", "file");
    sandbox.file(r"to\thing\inside.txt", "kept");
    let script = Script::answering(&[Answer::KeepBoth]);

    run_with(copy(&source, &sandbox.path("to")), &script);

    assert!(matches!(
        &script.questions.borrow()[0],
        Question::Conflict { choices, .. }
            if *choices == [Answer::KeepBoth, Answer::Skip, Answer::Cancel]
    ));
    assert_eq!(read(&sandbox.path(r"to\thing\inside.txt")), "kept");
    assert_eq!(read(&sandbox.path(r"to\thing (2)")), "file");
}

#[test]
fn copy_makes_a_junction_a_junction_and_stays_out_of_it() {
    let sandbox = Sandbox::new();
    let outside = sandbox.file(r"outside\secret.txt", "secret");
    sandbox.file(r"from\tree\a.txt", "a");
    sandbox.junction(r"from\tree\link", outside.parent().unwrap());

    go(copy(&sandbox.path(r"from\tree"), &sandbox.folder("to")));

    let copied = sys::stat(&sandbox.path(r"to\tree\link")).unwrap().unwrap();
    assert!(copied.is_link());
    assert_eq!(read(&sandbox.path(r"to\tree\link\secret.txt")), "secret");
    assert_eq!(sandbox.names("outside"), ["secret.txt"]);
}

#[test]
fn copy_makes_a_symlink_a_symlink_or_reports_why_not() {
    let sandbox = Sandbox::new();
    let outside = sandbox.file("outside.txt", "secret");
    let link = sandbox.path(r"from\link.txt");
    fs::create_dir(sandbox.path("from")).unwrap();
    if std::os::windows::fs::symlink_file(&outside, &link).is_err() {
        // This account can't make symlinks, so a copy can't either.
        return;
    }
    let target = sandbox.folder("to");

    go(copy(&link, &target));

    assert!(sys::stat(&sandbox.path(r"to\link.txt")).unwrap().unwrap().is_link());
    assert_eq!(read(&outside), "secret");
}

#[test]
fn cancel_leaves_no_partial_file_and_keeps_the_source() {
    let sandbox = Sandbox::new();
    let source = sandbox.path(r"from\big.bin");
    fs::create_dir(sandbox.path("from")).unwrap();
    fs::write(&source, vec![7u8; 8 * 1024 * 1024]).unwrap();
    let target = sandbox.folder("to");
    let control = Arc::new(Control::default());
    let stopper = control.clone();
    let script = Script {
        during: Some(Box::new(move |progress: &Progress| {
            if progress.bytes > 0 {
                stopper.cancel();
            }
        })),
        ..Script::default()
    };

    let outcome = run(copy(&source, &target), &script, &control);

    assert!(outcome.cancelled);
    assert!(outcome.done.is_empty());
    assert_eq!(sandbox.names("to"), [""; 0]);
    assert_eq!(fs::metadata(&source).unwrap().len(), 8 * 1024 * 1024);
}

#[test]
fn pause_holds_the_job_until_resume() {
    let sandbox = Sandbox::new();
    let source = sandbox.file(r"from\a.txt", "a");
    let target = sandbox.folder("to");
    let root = sandbox.0.clone();
    let control = Arc::new(Control::default());
    control.pause();

    let job = {
        let control = control.clone();
        thread::spawn(move || {
            test_guard::enter(&root);
            run(copy(&source, &target), &Script::default(), &control).done.len()
        })
    };
    thread::sleep(Duration::from_millis(150));
    assert!(!job.is_finished());
    assert_eq!(sandbox.names("to"), [""; 0]);

    control.resume();
    assert_eq!(job.join().unwrap(), 1);
    assert_eq!(sandbox.names("to"), ["a.txt"]);
}

#[test]
fn locked_source_can_be_retried_after_it_unlocks() {
    let sandbox = Sandbox::new();
    let source = sandbox.file(r"from\a.txt", "a");
    let target = sandbox.folder("to");
    let held = RefCell::new(Some(lock(&source)));
    // Copying reads the whole file, so the lock stops it with a sharing error.
    struct Unlocks<'a>(Script, &'a RefCell<Option<fs::File>>);
    impl Host for Unlocks<'_> {
        fn progress(&self, progress: &Progress) {
            self.0.progress(progress);
        }
        fn ask(&self, question: Question) -> Reply {
            self.1.borrow_mut().take();
            self.0.ask(question)
        }
    }
    let host = Unlocks(Script::answering(&[Answer::Retry]), &held);

    let outcome = run(copy(&source, &target), &host, &Arc::new(Control::default()));

    assert_eq!(host.0.asked(), 1);
    assert_eq!(outcome.done.len(), 1);
    assert_eq!(read(&sandbox.path(r"to\a.txt")), "a");
}

#[test]
fn name_ending_in_a_dot_is_a_different_file_from_the_one_without() {
    let sandbox = Sandbox::new();
    let plain = sandbox.file(r"from\thing", "plain");
    let dotted = sandbox.path(r"from\thing.");
    write_extended(&dotted, "dotted");
    let target = sandbox.folder("to");

    go(copy(&dotted, &target));
    assert_eq!(read_extended(&sandbox.path(r"to\thing.")), "dotted");

    go(Job::Delete {
        paths: vec![dotted.clone()],
    });
    assert!(!exists(&dotted));
    assert_eq!(read(&plain), "plain");
}

// Move.

#[test]
fn move_on_one_drive_renames_and_undo_moves_back() {
    let sandbox = Sandbox::new();
    let source = sandbox.file(r"from\tree\a.txt", "a");
    let tree = sandbox.path(r"from\tree");
    let target = sandbox.folder("to");

    let outcome = go(moving(&tree, &target));

    assert_eq!(read(&sandbox.path(r"to\tree\a.txt")), "a");
    assert!(!tree.exists());
    assert_eq!(
        outcome.done,
        [Done::Moved {
            from: tree.clone(),
            to: sandbox.path(r"to\tree")
        }]
    );

    undo(outcome);
    assert_eq!(read(&source), "a");
    assert_eq!(sandbox.names("to"), [""; 0]);
}

#[test]
fn move_onto_its_own_folder_does_nothing() {
    let sandbox = Sandbox::new();
    let source = sandbox.file(r"here\a.txt", "a");
    let script = Script::default();

    let outcome = run_with(moving(&source, &sandbox.path("here")), &script);

    assert_eq!(script.asked(), 0);
    assert!(outcome.done.is_empty());
    assert_eq!(read(&source), "a");
}

#[test]
fn folder_cannot_be_moved_into_itself() {
    let sandbox = Sandbox::new();
    sandbox.file(r"tree\a.txt", "a");
    let inner = sandbox.folder(r"tree\inner");
    let script = Script::default();

    let outcome = run_with(moving(&sandbox.path("tree"), &inner), &script);

    assert!(outcome.done.is_empty());
    assert_eq!(script.asked(), 1);
    assert_eq!(sandbox.names("tree"), ["a.txt", "inner"]);
}

#[test]
fn move_replace_keeps_the_old_file_in_the_bin() {
    let sandbox = Sandbox::new();
    let source = sandbox.file(r"from\a.txt", "new");
    let old = sandbox.file(r"to\a.txt", "old");
    let script = Script::answering(&[Answer::Replace]);

    let outcome = run_with(moving(&source, &sandbox.path("to")), &script);

    assert_eq!(read(&old), "new");
    assert!(!source.exists());
    assert_eq!(sandbox.names("to"), ["a.txt"]);

    undo(outcome);
    assert_eq!(read(&old), "old");
    assert_eq!(read(&source), "new");
}

#[test]
fn failed_replace_keeps_both_files_where_they_were() {
    let sandbox = Sandbox::new();
    let source = sandbox.file(r"from\a.txt", "new");
    let old = sandbox.file(r"to\a.txt", "old");
    let _held = lock(&old);
    let script = Script::answering(&[Answer::Replace, Answer::Skip]);

    let outcome = run_with(moving(&source, &sandbox.path("to")), &script);

    drop(_held);
    assert!(outcome.done.is_empty());
    assert_eq!(read(&source), "new");
    assert_eq!(read(&old), "old");
    assert_eq!(sandbox.names("to"), ["a.txt"]);
}

#[test]
fn replace_through_a_junction_alias_never_destroys_the_source() {
    let sandbox = Sandbox::new();
    let source = sandbox.file(r"real\a.txt", "a");
    let alias = sandbox.junction("alias", &sandbox.path("real"));
    let script = Script::always(Answer::Replace);

    let outcome = run_with(moving(&alias.join("a.txt"), &sandbox.path("real")), &script);

    assert_eq!(script.asked(), 0);
    assert!(outcome.done.is_empty());
    assert_eq!(read(&source), "a");
}

#[test]
fn merge_on_one_drive_moves_the_contents_and_removes_the_emptied_folder() {
    let sandbox = Sandbox::new();
    sandbox.file(r"from\tree\sub\a.txt", "a");
    sandbox.file(r"to\tree\sub\b.txt", "b");
    let script = Script::always(Answer::Merge);

    let outcome = run_with(moving(&sandbox.path(r"from\tree"), &sandbox.path("to")), &script);

    assert_eq!(sandbox.names(r"to\tree\sub"), ["a.txt", "b.txt"]);
    assert_eq!(sandbox.names("from"), [""; 0]);

    undo(outcome);
    assert_eq!(read(&sandbox.path(r"from\tree\sub\a.txt")), "a");
    assert_eq!(sandbox.names(r"to\tree\sub"), ["b.txt"]);
}

#[test]
fn move_across_drives_copies_then_removes_and_undo_moves_back() {
    let sandbox = Sandbox::new();
    sandbox.file(r"from\tree\a.txt", "a");
    sandbox.file(r"from\tree\sub\b.txt", "b");
    sandbox.folder(r"from\tree\empty");
    let tree = sandbox.path(r"from\tree");
    let target = sandbox.folder("to");
    test_guard::pretend_other_drive(true);

    let outcome = go(moving(&tree, &target));

    assert_eq!(read(&sandbox.path(r"to\tree\sub\b.txt")), "b");
    assert!(sandbox.path(r"to\tree\empty").is_dir());
    assert!(!tree.exists());
    assert_eq!(
        outcome.done,
        [Done::Moved {
            from: tree.clone(),
            to: sandbox.path(r"to\tree")
        }]
    );

    undo(outcome);
    test_guard::pretend_other_drive(false);
    assert_eq!(read(&tree.join(r"sub\b.txt")), "b");
    assert_eq!(sandbox.names("to"), [""; 0]);
}

#[test]
fn move_across_drives_keeps_a_folders_dates() {
    let sandbox = Sandbox::new();
    sandbox.file(r"from\tree\a.txt", "a");
    let tree = sandbox.path(r"from\tree");
    let target = sandbox.folder("to");
    sys::set_times(&tree, 131_000_000_000_000_000, 132_000_000_000_000_000).unwrap();
    test_guard::pretend_other_drive(true);

    go(moving(&tree, &target));

    test_guard::pretend_other_drive(false);
    let moved = sys::stat(&sandbox.path(r"to\tree")).unwrap().unwrap();
    assert_eq!(moved.modified, 132_000_000_000_000_000);
    assert_eq!(moved.created, 131_000_000_000_000_000);
}

#[test]
fn cancelled_move_across_drives_keeps_every_source() {
    let sandbox = Sandbox::new();
    sandbox.file(r"from\tree\a.txt", "a");
    sandbox.file(r"from\tree\b.txt", "b");
    let tree = sandbox.path(r"from\tree");
    let target = sandbox.folder("to");
    test_guard::pretend_other_drive(true);
    let control = Arc::new(Control::default());
    let stopper = control.clone();
    let script = Script {
        during: Some(Box::new(move |progress: &Progress| {
            if progress.items >= 2 {
                stopper.cancel();
            }
        })),
        ..Script::default()
    };

    let outcome = run(moving(&tree, &target), &script, &control);

    test_guard::pretend_other_drive(false);
    assert!(outcome.cancelled);
    assert_eq!(sandbox.names(r"from\tree"), ["a.txt", "b.txt"]);
    // What landed is logged as a copy, so undo can remove it.
    assert_eq!(
        outcome.done,
        [Done::Created {
            path: sandbox.path(r"to\tree")
        }]
    );
}

#[test]
fn source_that_changes_during_a_move_across_drives_is_kept() {
    let sandbox = Sandbox::new();
    let changing = sandbox.file(r"from\tree\a.txt", "a");
    let tree = sandbox.path(r"from\tree");
    let target = sandbox.folder("to");
    test_guard::pretend_other_drive(true);
    let path = changing.clone();
    let script = Script {
        during: Some(Box::new(move |progress: &Progress| {
            if progress.items >= 2 {
                fs::write(&path, "a much newer version").unwrap();
            }
        })),
        ..Script::default()
    };

    let outcome = run_with(moving(&tree, &target), &script);

    test_guard::pretend_other_drive(false);
    assert_eq!(read(&changing), "a much newer version");
    assert_eq!(read(&sandbox.path(r"to\tree\a.txt")), "a");
    assert_eq!(outcome.kept, [changing]);
    assert!(tree.is_dir());
}

#[test]
fn folder_that_gains_a_file_during_a_move_across_drives_stays() {
    let sandbox = Sandbox::new();
    sandbox.file(r"from\tree\a.txt", "a");
    let tree = sandbox.path(r"from\tree");
    let target = sandbox.folder("to");
    test_guard::pretend_other_drive(true);
    let late = tree.join("late.txt");
    let written = late.clone();
    let script = Script {
        during: Some(Box::new(move |progress: &Progress| {
            if progress.items >= 2 {
                fs::write(&written, "late").unwrap();
            }
        })),
        ..Script::default()
    };

    run_with(moving(&tree, &target), &script);

    test_guard::pretend_other_drive(false);
    assert_eq!(read(&late), "late");
    assert_eq!(sandbox.names(r"from\tree"), ["late.txt"]);
}

#[test]
fn junction_moved_across_drives_leaves_its_target_alone() {
    let sandbox = Sandbox::new();
    let outside = sandbox.file(r"outside\secret.txt", "secret");
    let link = sandbox.junction(r"from\link", outside.parent().unwrap());
    let target = sandbox.folder("to");
    test_guard::pretend_other_drive(true);

    go(moving(&link, &target));

    test_guard::pretend_other_drive(false);
    assert!(!exists(&link));
    assert!(sys::stat(&sandbox.path(r"to\link")).unwrap().unwrap().is_link());
    assert_eq!(read(&outside), "secret");
}

// Rename and new items.

#[test]
fn rename_and_undo() {
    let sandbox = Sandbox::new();
    let path = sandbox.file(r"here\a.txt", "a");

    let outcome = go(Job::Rename {
        path: path.clone(),
        name: "b.txt".to_string(),
    });

    assert_eq!(sandbox.names("here"), ["b.txt"]);
    undo(outcome);
    assert_eq!(read(&path), "a");
}

#[test]
fn rename_that_only_changes_case_and_its_undo() {
    let sandbox = Sandbox::new();
    let path = sandbox.file(r"here\a.txt", "a");

    let outcome = go(Job::Rename {
        path,
        name: "A.txt".to_string(),
    });

    assert_eq!(sandbox.names("here"), ["A.txt"]);
    undo(outcome);
    assert_eq!(sandbox.names("here"), ["a.txt"]);
}

#[test]
fn rename_onto_a_taken_name_asks_and_replaces_nothing() {
    let sandbox = Sandbox::new();
    let path = sandbox.file(r"here\a.txt", "a");
    let other = sandbox.file(r"here\b.txt", "b");
    let script = Script::default();

    let outcome = run_with(
        Job::Rename {
            path: path.clone(),
            name: "b.txt".to_string(),
        },
        &script,
    );

    assert_eq!(script.asked(), 1);
    assert!(outcome.done.is_empty());
    assert_eq!(read(&path), "a");
    assert_eq!(read(&other), "b");
}

#[test]
fn new_items_take_free_names_and_undo_recycles_them() {
    let sandbox = Sandbox::new();
    let folder = sandbox.folder("here");
    let new = |directory| {
        go(Job::New {
            folder: folder.clone(),
            directory,
        })
    };

    new(true);
    new(true);
    new(false);
    let outcome = new(false);

    assert_eq!(
        sandbox.names("here"),
        ["New file (2).txt", "New file.txt", "New folder", "New folder (2)"]
    );
    let undone = undo(outcome);
    assert_eq!(sandbox.names("here"), ["New file.txt", "New folder", "New folder (2)"]);
    purge(&undone);
}

#[test]
fn name_rules() {
    for bad in ["", ".", "..", "a/b", "a\\b", "a:b", "a*b", "a?b", "a\"b", "a<b", "a>b", "a|b"] {
        assert!(check_name(bad).is_err(), "{bad}");
    }
    for bad in ["a.", "a ", "CON", "con", "nul.txt", "COM1", "lpt9.tar.gz", "a\tb"] {
        assert!(check_name(bad).is_err(), "{bad}");
    }
    assert!(check_name(&"x".repeat(256)).is_err());
    for good in ["a", "a.txt", ".gitignore", "CONSOLE", "COM10", "lpt", "ä b", &"x".repeat(255)] {
        assert!(check_name(good).is_ok(), "{good}");
    }
}

// Permanent delete.

#[test]
fn permanent_delete_removes_a_tree_with_read_only_files() {
    let sandbox = Sandbox::new();
    let file = sandbox.file(r"tree\sub\a.txt", "a");
    let mut permissions = fs::metadata(&file).unwrap().permissions();
    permissions.set_readonly(true);
    fs::set_permissions(&file, permissions).unwrap();

    let outcome = go(Job::Delete {
        paths: vec![sandbox.path("tree")],
    });

    assert!(!sandbox.path("tree").exists());
    assert!(outcome.done.is_empty());
    assert!(outcome.touched.contains(&sandbox.0));
}

#[test]
fn deleting_a_junction_leaves_its_target_alone() {
    let sandbox = Sandbox::new();
    let outside = sandbox.file(r"outside\secret.txt", "secret");
    sandbox.file(r"tree\a.txt", "a");
    sandbox.junction(r"tree\link", outside.parent().unwrap());

    go(Job::Delete {
        paths: vec![sandbox.path("tree")],
    });

    assert!(!sandbox.path("tree").exists());
    assert_eq!(read(&outside), "secret");
}

#[test]
fn locked_file_stops_only_its_own_folder_from_going() {
    let sandbox = Sandbox::new();
    let locked = sandbox.file(r"tree\keep\locked.txt", "a");
    sandbox.file(r"tree\keep\free.txt", "b");
    sandbox.file(r"tree\gone\c.txt", "c");
    let _held = lock(&locked);
    let script = Script::default();

    run_with(
        Job::Delete {
            paths: vec![sandbox.path("tree")],
        },
        &script,
    );

    assert_eq!(script.asked(), 1);
    assert_eq!(sandbox.names("tree"), ["keep"]);
    assert_eq!(sandbox.names(r"tree\keep"), ["locked.txt"]);
}

#[test]
fn deleting_something_already_gone_is_fine() {
    let sandbox = Sandbox::new();
    let script = Script::default();

    run_with(
        Job::Delete {
            paths: vec![sandbox.path("nope")],
        },
        &script,
    );

    assert_eq!(script.asked(), 0);
}

// Long paths.

#[test]
fn long_paths_work_for_copy_move_rename_and_delete() {
    let sandbox = Sandbox::new();
    let long = long_folder(&sandbox);
    let file = long.join("a.txt");
    write_extended(&file, "a");
    let to = long.join("to");
    sys::create_dir(&to).unwrap();

    go(copy(&file, &to));
    assert_eq!(read_extended(&to.join("a.txt")), "a");

    go(Job::Rename {
        path: to.join("a.txt"),
        name: "b.txt".to_string(),
    });
    go(moving(&to.join("b.txt"), &long));
    assert_eq!(read_extended(&long.join("b.txt")), "a");

    test_guard::pretend_other_drive(true);
    go(moving(&file, &to));
    test_guard::pretend_other_drive(false);
    assert_eq!(read_extended(&to.join("a.txt")), "a");
    assert!(!exists(&file));

    go(Job::Delete {
        paths: vec![sandbox.path("a-rather-long-folder-name")],
    });
    assert_eq!(sandbox.names(""), [""; 0]);
}

#[test]
fn long_path_recycle_works_or_asks_and_never_deletes_quietly() {
    let sandbox = Sandbox::new();
    let long = long_folder(&sandbox);
    let file = long.join("a.txt");
    write_extended(&file, "a");
    let script = Script::default();

    let outcome = run_with(
        Job::Recycle {
            paths: vec![file.clone()],
        },
        &script,
    );

    if outcome.done.is_empty() {
        assert_eq!(script.asked(), 1);
        assert_eq!(read_extended(&file), "a");
    } else {
        purge(&outcome);
    }
}

// Recycle Bin.

#[test]
fn recycled_file_lands_in_the_bin_and_undo_restores_it() {
    let sandbox = Sandbox::new();
    let file = sandbox.file(r"here\a.txt", "a");

    let outcome = go(Job::Recycle {
        paths: vec![file.clone()],
    });

    assert!(!file.exists());
    let Done::Recycled { original, item } = &outcome.done[0] else {
        panic!("{:?}", outcome.done);
    };
    assert_eq!(original, &file);
    assert_eq!(read(item), "a");

    undo(outcome);
    assert_eq!(read(&file), "a");
}

#[test]
fn several_items_recycle_in_one_job_and_a_folder_goes_whole() {
    let sandbox = Sandbox::new();
    let paths = vec![sandbox.file(r"here\a.txt", "a"), sandbox.file(r"here\tree\b.txt", "b")];
    let tree = sandbox.path(r"here\tree");

    let outcome = go(Job::Recycle {
        paths: vec![paths[0].clone(), tree.clone()],
    });

    assert_eq!(sandbox.names("here"), [""; 0]);
    assert_eq!(outcome.done.len(), 2);
    undo(outcome);
    assert_eq!(read(&paths[1]), "b");
}

#[test]
fn drive_with_no_bin_asks_before_deleting_for_good() {
    let sandbox = Sandbox::new();
    sandbox.file(r"drive\a.txt", "a");
    let drive = SubstDrive::new(&sandbox.path("drive"));
    let root = PathBuf::from(format!(r"{}\", drive.0));
    test_guard::enter(&root);
    let file = root.join("a.txt");
    let script = Script::answering(&[Answer::Skip, Answer::Permanent]);
    let recycle = || Job::Recycle {
        paths: vec![file.clone()],
    };

    let skipped = run_with(recycle(), &script);
    assert!(skipped.done.is_empty());
    assert!(exists(&file), "skip keeps the file");
    assert!(matches!(&script.questions.borrow()[0], Question::NoBin { .. }));

    run_with(recycle(), &script);
    assert!(!exists(&file), "answering permanent deletes it");
    assert_eq!(script.asked(), 2);
    test_guard::enter(&sandbox.0);
}

#[test]
fn a_job_names_each_folder_before_writing_temp_files_there() {
    let sandbox = Sandbox::new();
    sandbox.file(r"from\a.txt", "a");
    sandbox.file(r"from\b.txt", "b");
    let folder = sandbox.folder("to");
    let host = Noting::default();

    let job = Job::Copy {
        sources: vec![sandbox.path(r"from\a.txt"), sandbox.path(r"from\b.txt")],
        folder: folder.clone(),
    };
    run(job, &host, &Arc::new(Control::default()));

    assert_eq!(*host.folders.borrow(), [folder]);
}

#[test]
fn leftovers_go_only_for_the_exact_process_and_name() {
    let sandbox = Sandbox::new();
    let gone = sandbox.file(r"here\~perli-4242-7.part", "half");
    let kept = [
        sandbox.file(r"here\~perli-4243-7.part", "another process"),
        sandbox.file(r"here\~perli-4242-x.part", "not a number"),
        sandbox.file(r"here\~perli-4242-.part", "no number"),
        sandbox.file(r"here\~perli-4242-7.part.txt", "another name"),
        sandbox.file(r"here\a.txt", "a"),
    ];
    let folder = sandbox.folder(r"here\~perli-4242-8.part");
    sandbox.file(r"here\~perli-4242-8.part\inside.txt", "a folder is never ours");

    remove_leftovers(&sandbox.path("here"), 4242).unwrap();

    assert!(!gone.exists());
    assert!(kept.iter().all(|path| path.exists()));
    assert!(folder.exists());
}

#[test]
fn only_a_process_that_ended_counts_as_gone() {
    assert!(sys::is_running(std::process::id()));

    let mut ended = Command::new("cmd").args(["/c", "exit"]).spawn().unwrap();
    let id = ended.id();
    ended.wait().unwrap();
    drop(ended);
    assert!(!sys::is_running(id));
}

#[test]
fn undo_never_offers_to_delete_for_good() {
    let sandbox = Sandbox::new();
    sandbox.file(r"drive\a.txt", "a");
    let drive = SubstDrive::new(&sandbox.path("drive"));
    let root = PathBuf::from(format!(r"{}\", drive.0));
    test_guard::enter(&root);
    let file = root.join("a.txt");
    let script = Script::answering(&[Answer::Permanent]);

    let outcome = run_with(
        Job::Undo {
            records: vec![Done::Created { path: file.clone() }],
        },
        &script,
    );

    assert!(exists(&file), "undo leaves what the bin refuses");
    assert!(outcome.done.is_empty());
    let questions = script.questions.borrow();
    assert!(
        matches!(&questions[0], Question::Problem { choices, .. } if !choices.contains(&Answer::Permanent)),
        "{:?}",
        questions[0]
    );
    test_guard::enter(&sandbox.0);
}

#[test]
fn an_existing_target_does_not_prove_an_elevated_copy() {
    let sandbox = Sandbox::new();
    let target = sandbox.file("to.txt", "untouched");
    let script = Script::default();
    let control = Arc::new(Control::default());
    let mut run = Run::new(&script, &control);
    // The missing source stops this before anything could ask for admin rights.
    run.elevated.push(Elevated::Copy {
        source: sandbox.path("missing.txt"),
        target: target.clone(),
    });

    assert!(run.finish_elevated().is_ok());

    assert!(run.done.is_empty(), "undo would recycle the untouched file");
}

#[test]
fn replace_on_a_drive_with_no_bin_keeps_the_old_file_on_skip() {
    let sandbox = Sandbox::new();
    sandbox.file(r"drive\to\a.txt", "old");
    let source = sandbox.file(r"from\a.txt", "new");
    let drive = SubstDrive::new(&sandbox.path("drive"));
    let root = PathBuf::from(format!(r"{}\", drive.0));
    test_guard::enter(&root);
    let script = Script::answering(&[Answer::Replace, Answer::Skip]);

    run_with(copy(&source, &root.join("to")), &script);

    assert_eq!(read(&sandbox.path(r"drive\to\a.txt")), "old");
    assert_eq!(sandbox.names(r"drive\to"), ["a.txt"]);
    test_guard::enter(&sandbox.0);
}

fn write_bin_item(sandbox: &Sandbox, id: &str, original: &Path, text: &str) -> BinItem {
    let wide: Vec<u16> = original.to_string_lossy().encode_utf16().collect();
    let mut info = Vec::new();
    info.extend(2u64.to_le_bytes());
    info.extend((text.len() as u64).to_le_bytes());
    info.extend(133_000_000_000_000_000u64.to_le_bytes());
    info.extend((wide.len() as u32 + 1).to_le_bytes());
    info.extend(wide.iter().chain(&[0]).flat_map(|unit| unit.to_le_bytes()));
    fs::create_dir_all(sandbox.path("bin")).unwrap();
    fs::write(sandbox.path(&format!(r"bin\$I{id}")), info).unwrap();
    let item = sandbox.file(&format!(r"bin\$R{id}"), text);
    BinItem {
        item,
        original: original.to_path_buf(),
        size: text.len() as u64,
        deleted: 133_000_000_000_000_000,
        is_dir: false,
    }
}

#[test]
fn reads_both_info_file_formats() {
    let mut old = Vec::new();
    old.extend(1u64.to_le_bytes());
    old.extend(5u64.to_le_bytes());
    old.extend(9u64.to_le_bytes());
    let name: Vec<u16> = r"C:\a.txt".encode_utf16().collect();
    old.extend(name.iter().flat_map(|unit| unit.to_le_bytes()));
    old.resize(24 + 520, 0);

    assert_eq!(parse_info(&old), Some((5, 9, PathBuf::from(r"C:\a.txt"))));
    assert_eq!(parse_info(&[0; 8]), None);
    assert_eq!(parse_info(&[2, 0, 0]), None);
}

#[test]
fn bin_listing_skips_info_files_with_no_data() {
    let sandbox = Sandbox::new();
    let item = write_bin_item(&sandbox, "ABC.txt", &sandbox.path(r"gone\a.txt"), "a");
    write_bin_item(&sandbox, "XYZ.txt", &sandbox.path(r"gone\b.txt"), "b");
    fs::remove_file(sandbox.path(r"bin\$RXYZ.txt")).unwrap();

    assert_eq!(read_root(&sandbox.path("bin")), [item]);
}

#[test]
fn restore_recreates_parents_removes_both_bin_files_and_undo_recycles_again() {
    let sandbox = Sandbox::new();
    let original = sandbox.path(r"gone\deep\a.txt");
    let item = write_bin_item(&sandbox, "ABC.txt", &original, "a");

    let outcome = go(Job::Restore { items: vec![item] });

    assert_eq!(read(&original), "a");
    assert_eq!(sandbox.names("bin"), [""; 0]);
    assert_eq!(outcome.done, [Done::Created { path: original.clone() }]);

    let undone = undo(outcome);
    assert!(!original.exists());
    purge(&undone);
}

#[test]
fn restore_onto_a_taken_name_uses_the_conflict_answers() {
    let sandbox = Sandbox::new();
    let original = sandbox.file(r"here\a.txt", "new");
    let item = write_bin_item(&sandbox, "ABC.txt", &original, "old");
    let script = Script::answering(&[Answer::KeepBoth]);

    run_with(Job::Restore { items: vec![item] }, &script);

    assert_eq!(read(&original), "new");
    assert_eq!(read(&sandbox.path(r"here\a (2).txt")), "old");
}

#[test]
fn purge_removes_both_bin_files_and_a_skipped_restore_keeps_them() {
    let sandbox = Sandbox::new();
    let original = sandbox.file(r"here\a.txt", "new");
    let item = write_bin_item(&sandbox, "ABC.txt", &original, "old");

    run_with(
        Job::Restore {
            items: vec![item.clone()],
        },
        &Script::answering(&[Answer::Skip]),
    );
    assert_eq!(sandbox.names("bin"), ["$IABC.txt", "$RABC.txt"]);

    go(Job::Purge { items: vec![item] });
    assert_eq!(sandbox.names("bin"), [""; 0]);
    assert_eq!(read(&original), "new");
}

// Measuring.

#[test]
fn measure_counts_a_tree_and_stays_out_of_junctions() {
    let sandbox = Sandbox::new();
    let outside = sandbox.file(r"outside\big.txt", "0123456789");
    sandbox.file(r"tree\a.txt", "abc");
    sandbox.junction(r"tree\link", outside.parent().unwrap());

    assert_eq!(measure(&[sandbox.path("tree")]), (3, 3));
}

// The guard itself.

#[test]
#[should_panic(expected = "outside its temp folder")]
fn guard_stops_a_write_outside_the_temp_folder() {
    let sandbox = Sandbox::new();
    let outside = sandbox.0.parent().unwrap().join("perli-guard-outside.txt");
    let _ = sys::create_file(&outside);
}

#[test]
#[should_panic(expected = "outside its temp folder")]
fn guard_stops_a_write_when_no_test_folder_is_set() {
    let path = std::env::temp_dir().join("perli-guard-no-root.txt");
    thread::spawn(move || sys::create_file(&path))
        .join()
        .unwrap_or_else(|panic| std::panic::resume_unwind(panic))
        .unwrap();
}

#[test]
#[should_panic(expected = "outside its temp folder")]
fn guard_stops_a_path_that_climbs_out() {
    let sandbox = Sandbox::new();
    let _ = sys::create_file(&sandbox.0.join(r"..\perli-guard-climb.txt"));
}

#[test]
#[should_panic(expected = "tests never empty")]
fn tests_can_never_empty_the_recycle_bin() {
    let _ = sys::empty_bin();
}

#[test]
fn rename_checks_catch_taken_names_but_allow_a_new_case() {
    let sandbox = Sandbox::new();
    let file = sandbox.file("a.txt", "a");
    sandbox.file("b.txt", "b");

    assert_eq!(check_rename(&file, "b.txt"), Err("That name is already taken."));
    assert_eq!(check_rename(&file, "A.TXT"), Ok(()));
    assert_eq!(check_rename(&file, "c.txt"), Ok(()));
    assert!(check_rename(&file, "c?.txt").is_err());
}
