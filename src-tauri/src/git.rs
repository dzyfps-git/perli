//! What git says about the rows of a folder in a repository: changed, added, new or ignored,
//! and the branch. It asks `git.exe`, so a computer without git shows no marks.

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use serde::Serialize;
use windows::Win32::System::Threading::CREATE_NO_WINDOW;

use crate::ops::sys;

/// How a row stands in git, weakest first, so a folder shows the strongest of what it holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mark {
    Ignored,
    /// Not tracked yet.
    New,
    Added,
    Modified,
    Conflict,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Status {
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
    /// The rows of the folder git has something to say of, by lowercase name.
    pub marks: Vec<(String, Mark)>,
}

/// Reads kept by lowercase folder, each with the ground it stood on.
static KNOWN: Mutex<Option<HashMap<String, (u64, Status)>>> = Mutex::new(None);
/// Past this many folders, the reads kept start over.
const MOST_KNOWN: usize = 256;
/// When git last read each folder, by lowercase path, and how long it took.
static ASKED: Mutex<Option<HashMap<String, (Instant, Duration)>>> = Mutex::new(None);
/// `recheck` waits this many times as long as git last took, so asking again costs at most about
/// one part in this many of the time, and never less than `RECHECK_GAP`.
const RECHECK_SHARE: u32 = 20;
const RECHECK_GAP: Duration = Duration::from_secs(5);

/// The status of `folder`'s rows, or none outside a repository or without git. A read is kept
/// while the repository's index, HEAD and remote branches and the folder's own rows stay as they
/// were, so a huge repository is asked once; `fresh` asks git anyway.
pub fn status(folder: &Path, fresh: bool) -> Option<Status> {
    // Most folders are in no repository, and finding that out needs no git.
    let root = repository(folder)?;
    let prefix = folder.strip_prefix(root).ok()?.to_string_lossy().replace('\\', "/");
    let key = folder.to_string_lossy().to_lowercase();
    // Taken before git reads, so a change while it reads leaves a ground that no longer holds.
    let ground = ground(root, folder);
    if !fresh {
        let known = KNOWN.lock().unwrap_or_else(PoisonError::into_inner);
        let kept = known.as_ref().and_then(|known| known.get(&key)).filter(|(stood, _)| Some(*stood) == ground);
        if let Some((_, status)) = kept {
            return Some(status.clone());
        }
    }
    let started = Instant::now();
    let output = Command::new("git")
        .args(["status", "--porcelain=v1", "-z", "--branch", "--ignored", "--untracked-files=normal", "--", "."])
        .current_dir(folder)
        // A look must not take the index lock from the user's own git.
        .env("GIT_OPTIONAL_LOCKS", "0")
        .creation_flags(CREATE_NO_WINDOW.0)
        .output()
        .ok()?;
    let mut asked = ASKED.lock().unwrap_or_else(PoisonError::into_inner);
    let asked = asked.get_or_insert_default();
    if asked.len() >= MOST_KNOWN {
        asked.clear();
    }
    asked.insert(key.clone(), (Instant::now(), started.elapsed()));
    let status = output.status.success().then(|| parse(&output.stdout, &prefix))?;
    if let Some(ground) = ground {
        let mut known = KNOWN.lock().unwrap_or_else(PoisonError::into_inner);
        let known = known.get_or_insert_default();
        if known.len() >= MOST_KNOWN {
            known.clear();
        }
        known.insert(key, (ground, status.clone()));
    }
    Some(status)
}

/// Git asked again for `folder`, as an edit deep inside a subfolder changes nothing a look at the
/// folder sees. None while it isn't time yet: git has to have been quiet for a while, the longer
/// the slower it was last time, so a huge repository is asked seldom.
pub fn recheck(folder: &Path) -> Option<Status> {
    let key = folder.to_string_lossy().to_lowercase();
    let asked = ASKED.lock().unwrap_or_else(PoisonError::into_inner).as_ref().and_then(|asked| asked.get(&key).copied());
    if !due(asked) {
        return None;
    }
    status(folder, true)
}

/// Whether git, last asked at a time and taking so long, may be asked again.
fn due(asked: Option<(Instant, Duration)>) -> bool {
    asked.is_none_or(|(at, took)| at.elapsed() >= (took * RECHECK_SHARE).max(RECHECK_GAP))
}

fn repository(folder: &Path) -> Option<&Path> {
    folder.ancestors().find(|folder| folder.join(".git").exists())
}

/// What git's marks on `folder` change with, to watch: its repository's index and HEAD, its
/// remote branches, which a push or a fetch moves on for the ahead and behind counts, the packed
/// refs, and the file of the branch HEAD names, which a commit or a soft reset moves while HEAD
/// stays. Nothing outside a repository, or where `.git` is a file, as in a worktree.
pub fn watched(folder: &Path) -> Vec<PathBuf> {
    let Some(git) = repository(folder).map(|root| root.join(".git")).filter(|git| git.is_dir()) else { return Vec::new() };
    let mut files = vec![git.join("index"), git.join("HEAD"), git.join("packed-refs"), git.join("refs").join("remotes")];
    let head = std::fs::read_to_string(git.join("HEAD")).unwrap_or_default();
    if let Some(branch) = head.trim().strip_prefix("ref: ") {
        files.push(git.join(branch.replace('/', "\\")));
    }
    files
}

/// What a read of `folder` stands on: the sizes and times of what `watched` gives, and of the
/// folder's own rows. Git updates a remote branch by renaming a new file over it, which moves on
/// the time of the remote's folder, seen in the listing of `refs/remotes`. None when the index or
/// HEAD is missing, and the read goes unkept. Packed refs and a branch's own file come and go, so
/// whether each is there counts too.
fn ground(root: &Path, folder: &Path) -> Option<u64> {
    let mut hasher = DefaultHasher::new();
    let files = watched(root);
    if files.is_empty() {
        return None;
    }
    for (at, file) in files.iter().enumerate() {
        let stat = sys::stat(file).ok().flatten();
        match stat {
            None if at < 2 => return None,
            Some(stat) if stat.is_dir() => {
                for (name, stat) in sys::read_dir(file).ok()? {
                    (name, stat.size, stat.modified).hash(&mut hasher);
                }
            }
            stat => stat.map(|stat| (stat.size, stat.modified)).hash(&mut hasher),
        }
    }
    for (name, stat) in sys::read_dir(folder).ok()? {
        (name, stat.size, stat.modified, stat.is_dir()).hash(&mut hasher);
    }
    Some(hasher.finish())
}

/// Reads `git status --porcelain=v1 -z --branch` for the folder at `prefix` in the repository.
fn parse(output: &[u8], prefix: &str) -> Status {
    let mut status = Status::default();
    let prefix = if prefix.is_empty() { String::new() } else { format!("{}/", prefix.to_lowercase()) };
    let mut fields = output.split(|&byte| byte == 0).map(String::from_utf8_lossy);
    while let Some(field) = fields.next() {
        if let Some(branch) = field.strip_prefix("## ") {
            read_branch(branch, &mut status);
            continue;
        }
        let (Some(code), Some(path)) = (field.get(..2), field.get(3..)) else { continue };
        // A rename or copy names where it came from next, which is no row here.
        if code.contains(['R', 'C']) {
            fields.next();
        }
        let Some(mark) = mark_of(code) else { continue };
        let lower = path.to_lowercase();
        let Some(inside) = lower.strip_prefix(&prefix) else { continue };
        let (name, rest) = inside.split_once('/').unwrap_or((inside, ""));
        // An ignored file deep inside leaves the folder it is in as it was.
        if name.is_empty() || (mark == Mark::Ignored && !rest.is_empty()) {
            continue;
        }
        match status.marks.iter_mut().find(|(known, _)| known == name) {
            Some((_, known)) => *known = (*known).max(mark),
            None => status.marks.push((name.to_owned(), mark)),
        }
    }
    status
}

fn mark_of(code: &str) -> Option<Mark> {
    let (index, tree) = (code.as_bytes()[0], code.as_bytes()[1]);
    Some(match (index, tree) {
        (b'?', b'?') => Mark::New,
        (b'!', b'!') => Mark::Ignored,
        (b'U', _) | (_, b'U') | (b'A', b'A') | (b'D', b'D') => Mark::Conflict,
        (b'A', _) => Mark::Added,
        (b' ', b' ') => return None,
        _ => Mark::Modified,
    })
}

/// `main...origin/main [ahead 1, behind 2]`, `main`, `No commits yet on main` or `HEAD (no branch)`.
fn read_branch(line: &str, status: &mut Status) {
    if let Some(branch) = line.strip_prefix("No commits yet on ") {
        status.branch = branch.to_owned();
        return;
    }
    if line.starts_with("HEAD (no branch)") {
        status.branch = "Detached".to_owned();
        return;
    }
    let (name, rest) = line.split_once("...").unwrap_or((line, ""));
    status.branch = name.split(' ').next().unwrap_or(name).to_owned();
    let count = |word: &str| {
        let at = rest.find(word)? + word.len();
        rest[at..].split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()
    };
    status.ahead = count("ahead ").unwrap_or(0);
    status.behind = count("behind ").unwrap_or(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_read_stands_while_the_index_head_and_rows_stay() {
        let root = std::env::temp_dir().join(format!("perli-git-ground-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join(".git").join("index"), "one").unwrap();
        std::fs::write(root.join(".git").join("HEAD"), "ref: refs/heads/main\n").unwrap();
        let before = ground(&root, &root).unwrap();
        assert_eq!(ground(&root, &root), Some(before));

        std::fs::write(root.join("new.txt"), "x").unwrap();
        let with_file = ground(&root, &root).unwrap();
        assert_ne!(with_file, before);
        std::fs::write(root.join(".git").join("index"), "two!").unwrap();
        assert_ne!(ground(&root, &root).unwrap(), with_file);
        let git = root.join(".git");
        assert_eq!(watched(&root.join("deeper")), [git.join("index"), git.join("HEAD"), git.join("packed-refs"), git.join("refs").join("remotes"), git.join("refs\\heads\\main")]);

        // A push moves the remote branch on as git does it, by renaming a new file over it.
        let origin = git.join("refs").join("remotes").join("origin");
        std::fs::create_dir_all(&origin).unwrap();
        std::fs::write(origin.join("main"), "aaaa\n").unwrap();
        let fetched = ground(&root, &root).unwrap();
        assert_eq!(ground(&root, &root), Some(fetched));
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(origin.join("main.lock"), "bbbb\n").unwrap();
        std::fs::rename(origin.join("main.lock"), origin.join("main")).unwrap();
        assert_ne!(ground(&root, &root).unwrap(), fetched, "the ahead count is asked for again");
        std::fs::write(git.join("packed-refs"), "# pack-refs\n").unwrap();
        assert!(ground(&root, &root).is_some(), "packed branches are watched when there are some");

        // A soft reset moves the branch, HEAD and the index staying as they were.
        let before_reset = ground(&root, &root).unwrap();
        std::fs::create_dir_all(git.join("refs").join("heads")).unwrap();
        std::fs::write(git.join("refs").join("heads").join("main"), "1111\n").unwrap();
        let on_branch = ground(&root, &root).unwrap();
        assert_ne!(on_branch, before_reset);
        std::fs::write(git.join("refs").join("heads").join("main"), "22222\n").unwrap();
        assert_ne!(ground(&root, &root).unwrap(), on_branch);
        std::fs::write(git.join("packed-refs"), "# pack-refs with: peeled\n").unwrap();
        assert_ne!(ground(&root, &root).unwrap(), on_branch, "packed refs count too");

        // A worktree's .git is a file that says where the repository is, and its reads go unkept.
        let tree = root.join("tree");
        std::fs::create_dir(&tree).unwrap();
        std::fs::write(tree.join(".git"), "gitdir: elsewhere").unwrap();
        assert_eq!(ground(&tree, &tree), None);
        assert!(watched(&tree).is_empty());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn git_is_asked_again_only_once_it_has_been_quiet_long_enough() {
        let ago = |seconds: u64, took: u64| Some((Instant::now() - Duration::from_secs(seconds), Duration::from_millis(took)));
        assert!(due(None), "never asked");
        assert!(!due(ago(0, 1)), "asked a moment ago");
        assert!(due(ago(6, 1)), "a quick git is asked every few seconds");
        assert!(!due(ago(6, 400)), "a slow one waits twenty times as long as it took");
        assert!(due(ago(9, 400)));
    }

    #[test]
    fn rows_take_the_strongest_mark_of_what_they_hold_and_the_branch_its_counts() {
        let output = [
            "## main...origin/main [ahead 2, behind 1]",
            " M src/app.ts",
            "?? src/new.ts",
            "A  src/Lib/added.rs",
            "!! src/lib/build.log",
            "R  src/moved.ts",
            "src/old.ts",
            "UU src/both.ts",
            " M src/inner/deep/file.ts",
            "?? src/fresh/",
            "!! src/node_modules/",
            "?? README.md",
        ]
        .join("\0");
        let status = parse(output.as_bytes(), "Src");
        assert_eq!((status.branch.as_str(), status.ahead, status.behind), ("main", 2, 1));
        assert_eq!(
            status.marks,
            [
                ("app.ts".into(), Mark::Modified),
                ("new.ts".into(), Mark::New),
                ("lib".into(), Mark::Added),
                ("moved.ts".into(), Mark::Modified),
                ("both.ts".into(), Mark::Conflict),
                ("inner".into(), Mark::Modified),
                ("fresh".into(), Mark::New),
                ("node_modules".into(), Mark::Ignored),
            ]
        );
        let fresh = parse(b"## No commits yet on trunk\0?? a.txt\0", "");
        assert_eq!((fresh.branch.as_str(), fresh.marks), ("trunk", vec![("a.txt".into(), Mark::New)]));
        assert_eq!(parse(b"## HEAD (no branch)\0", "").branch, "Detached");
        assert_eq!(parse(b"## topic\0", "").branch, "topic");
    }
}
