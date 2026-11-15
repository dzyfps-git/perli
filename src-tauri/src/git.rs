//! What git says about the rows of a folder in a repository: changed, added, new or ignored,
//! and the branch. It asks `git.exe`, so a computer without git shows no marks.

use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::Command;

use serde::Serialize;
use windows::Win32::System::Threading::CREATE_NO_WINDOW;

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

#[derive(Debug, Default, PartialEq, Serialize)]
pub struct Status {
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
    /// The rows of the folder git has something to say of, by lowercase name.
    pub marks: Vec<(String, Mark)>,
}

/// The status of `folder`'s rows, or none outside a repository or without git.
/// ponytail: one `git status` a read, which a huge repository makes slow; a cache by index time
/// would spare it.
pub fn status(folder: &Path) -> Option<Status> {
    // Most folders are in no repository, and finding that out needs no git.
    let root = folder.ancestors().find(|folder| folder.join(".git").exists())?;
    let prefix = folder.strip_prefix(root).ok()?.to_string_lossy().replace('\\', "/");
    let output = Command::new("git")
        .args(["status", "--porcelain=v1", "-z", "--branch", "--ignored", "--untracked-files=normal", "--", "."])
        .current_dir(folder)
        // A look must not take the index lock from the user's own git.
        .env("GIT_OPTIONAL_LOCKS", "0")
        .creation_flags(CREATE_NO_WINDOW.0)
        .output()
        .ok()?;
    output.status.success().then(|| parse(&output.stdout, &prefix))
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
