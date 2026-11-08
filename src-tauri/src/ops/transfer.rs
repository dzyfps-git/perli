//! Copy and move.

use std::ffi::OsStr;
use std::fs;
use std::io;
use std::mem;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use super::sys::{self, Stat};
use super::tree::Node;
use super::{names, Answer, Done, Elevated, Facts, Flow, Key, Question, Run};

const TEMP_PREFIX: &str = "~perli-";

static TEMP_NUMBER: AtomicU64 = AtomicU64::new(0);

/// A copy is written here and renamed when whole, so a real name never holds half a file.
fn temp_path(folder: &Path) -> PathBuf {
    let number = TEMP_NUMBER.fetch_add(1, Ordering::Relaxed);
    folder.join(format!("{TEMP_PREFIX}{}-{number}.part", std::process::id()))
}

/// Holds the source of a move while the file it replaces leaves. This is the only copy of
/// that file, so unlike a `temp_path` file it never counts as a leftover.
pub(super) fn staged_path(folder: &Path) -> PathBuf {
    temp_path(folder).with_extension("moved")
}

/// True for a name `temp_path` or `staged_path` gave out. These are Perli's working files.
pub fn is_temp_name(name: &str) -> bool {
    let digits = |text: &str| !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit());
    let numbers = name
        .strip_prefix(TEMP_PREFIX)
        .and_then(|rest| rest.strip_suffix(".part").or_else(|| rest.strip_suffix(".moved")));
    numbers
        .and_then(|numbers| numbers.split_once('-'))
        .is_some_and(|(process, number)| digits(process) && digits(number))
}

/// Returns a staged file to `source`, or beside it if something took that name meanwhile.
pub fn put_back(staged: &Path, source: &Path) -> windows::core::Result<()> {
    let folder = sys::parent(source);
    sys::create_dirs(&folder)?;
    if sys::rename(staged, source).is_ok() {
        return Ok(());
    }
    sys::rename(staged, &names::keep_both(&folder, file_name(source), false))
}

/// Removes what a process that is gone left behind in `folder`, as `temp_path` named it.
pub fn remove_leftovers(folder: &Path, process: u32) -> io::Result<()> {
    let prefix = format!("{TEMP_PREFIX}{process}-");
    for entry in fs::read_dir(folder)? {
        let entry = entry?;
        let name = entry.file_name();
        let number = name
            .to_str()
            .and_then(|name| name.strip_prefix(&prefix)?.strip_suffix(".part"));
        let digits = number.is_some_and(|number| {
            !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit())
        });
        if digits && entry.file_type()?.is_file() {
            let _ = sys::delete_file(&entry.path());
        }
    }
    Ok(())
}

pub(super) fn file_name(path: &Path) -> &OsStr {
    path.file_name().unwrap_or(path.as_os_str())
}

/// True for undoing a rename that only changed case, the one rename onto its own file.
fn same_but_for_case(a: &Path, b: &Path) -> bool {
    a != b && a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
}

/// What to do at a target, once any conflict has an answer.
#[derive(Clone)]
pub(super) enum Plan {
    /// Nothing is there.
    Write(PathBuf),
    /// A file is there and goes to the Recycle Bin once the new one is ready.
    Replace(PathBuf),
    /// A folder is there and takes the contents.
    Merge(PathBuf),
    Skip,
}

/// An item a rename could not move because its target is on another drive.
struct Crossing {
    source: PathBuf,
    stat: Stat,
    plan: Plan,
}

impl Run<'_> {
    pub(super) fn copy(&mut self, sources: Vec<PathBuf>, folder: &Path) -> Flow {
        let Some(identity) = self.folder_identity(folder)? else {
            return Ok(());
        };
        let mut nodes = Vec::with_capacity(sources.len());
        for source in sources {
            let Some(stat) = self.check_source(&source, &identity)? else {
                continue;
            };
            if let Some(node) = self.scan(&source, stat)? {
                self.add_total(node.items, node.bytes);
                nodes.push(node);
            }
        }
        let copied = self.copy_nodes(&mut nodes, folder, &identity);
        for node in &nodes {
            self.settle(node, false);
        }
        copied
    }

    fn copy_nodes(&mut self, nodes: &mut [Node], folder: &Path, identity: &str) -> Flow {
        for node in nodes {
            let name = file_name(&node.path);
            let same_folder = sys::final_path(&sys::parent(&node.path))
                .is_ok_and(|parent| parent == identity);
            let plan = if same_folder {
                Plan::Write(names::copy_of(folder, name, node.stat.is_dir()))
            } else {
                self.resolve(Some(&node.path), node.stat, &folder.join(name))?
            };
            self.place(node, plan, false)?;
        }
        Ok(())
    }

    pub(super) fn move_sources(&mut self, sources: Vec<PathBuf>, folder: &Path) -> Flow {
        let moves = sources
            .into_iter()
            .map(|source| {
                let target = folder.join(file_name(&source));
                (source, target)
            })
            .collect();
        self.move_all(moves)
    }

    /// Moves each source to the exact path paired with it.
    pub(super) fn move_all(&mut self, moves: Vec<(PathBuf, PathBuf)>) -> Flow {
        self.add_total(moves.len() as u64, 0);
        let mut crossing = Vec::new();
        let moved = self
            .move_each(moves, &mut crossing)
            .and_then(|()| self.cross_drives(crossing));
        for folder in mem::take(&mut self.emptied) {
            // Windows refuses if something stayed behind, which is what we want.
            let _ = sys::remove_dir(&folder);
        }
        moved
    }

    fn move_each(
        &mut self,
        moves: Vec<(PathBuf, PathBuf)>,
        crossing: &mut Vec<Crossing>,
    ) -> Flow {
        for (source, target) in moves {
            let folder = sys::parent(&target);
            let made = self.attempt(&folder, None, |_| sys::create_dirs(&folder))?;
            let identity = match made {
                Some(()) => self.folder_identity(&folder)?,
                None => None,
            };
            let Some(identity) = identity else {
                self.step(1, 0);
                continue;
            };
            let Some(stat) = self.check_source(&source, &identity)? else {
                continue;
            };
            let same_place = file_name(&source) == file_name(&target)
                && sys::final_path(&sys::parent(&source)).is_ok_and(|parent| parent == identity);
            if same_place {
                self.step(1, 0);
                continue;
            }
            // Undoing a ring of renames steps through a spare name, which only the list leads back from.
            if is_temp_name(&file_name(&target).to_string_lossy()) {
                self.host.staged(&target, &source);
            }
            self.move_item(&source, stat, &target, crossing)?;
        }
        Ok(())
    }

    /// Moves one item by rename, which is one step however big it is.
    fn move_item(
        &mut self,
        source: &Path,
        stat: Stat,
        target: &Path,
        crossing: &mut Vec<Crossing>,
    ) -> Flow {
        let plan = self.resolve(Some(source), stat, target)?;
        let cross_drive = |plan: Plan, crossing: &mut Vec<Crossing>| {
            crossing.push(Crossing {
                source: source.to_path_buf(),
                stat,
                plan,
            });
        };
        match &plan {
            Plan::Skip => self.step(1, 0),
            Plan::Merge(folder) => {
                let listed = self.attempt(source, None, |_| sys::read_dir(source))?;
                let entries = listed.unwrap_or_default();
                self.add_total(entries.len() as u64, 0);
                for (name, stat) in entries {
                    self.move_item(&source.join(&name), stat, &folder.join(&name), crossing)?;
                }
                self.emptied.push(source.to_path_buf());
                self.touched.insert(sys::parent(source));
                self.step(1, 0);
            }
            Plan::Write(target) => {
                let elevated = Elevated::Move {
                    source: source.to_path_buf(),
                    target: target.clone(),
                };
                match self.first_rename(source, target, elevated)? {
                    Renamed::Done => {
                        self.done.push(Done::Moved {
                            from: source.to_path_buf(),
                            to: target.clone(),
                        });
                        self.step(1, 0);
                    }
                    Renamed::Skipped => self.step(1, 0),
                    Renamed::OtherDrive => cross_drive(plan.clone(), crossing),
                }
            }
            Plan::Replace(target) => {
                let staged = staged_path(&sys::parent(target));
                self.host.staged(&staged, source);
                let elevated = Elevated::Move {
                    source: source.to_path_buf(),
                    target: target.clone(),
                };
                match self.first_rename(source, &staged, elevated)? {
                    Renamed::Done => {
                        let swapped = self.swap_in(&staged, target, true);
                        if !matches!(swapped, Ok(true)) {
                            // If this fails too, the list stays and the next start tries again.
                            let _ = put_back(&staged, source);
                        }
                        if swapped? {
                            self.done.push(Done::Moved {
                                from: source.to_path_buf(),
                                to: target.clone(),
                            });
                        }
                        self.step(1, 0);
                    }
                    Renamed::Skipped => self.step(1, 0),
                    Renamed::OtherDrive => cross_drive(plan.clone(), crossing),
                }
            }
        }
        Ok(())
    }

    /// Tells a rename that worked from one that needs the slower way across drives.
    fn first_rename(&mut self, from: &Path, to: &Path, elevated: Elevated) -> Flow<Renamed> {
        let mut other_drive = false;
        let renamed = self.attempt(from, Some(elevated), |_| match sys::move_path(from, to) {
            Err(error) if sys::is_cross_drive(&error) => {
                other_drive = true;
                Ok(())
            }
            renamed => renamed,
        })?;
        Ok(match renamed {
            Some(()) if other_drive => Renamed::OtherDrive,
            Some(()) => Renamed::Done,
            None => Renamed::Skipped,
        })
    }

    /// Copies everything first and removes sources only if the whole job got that far, so a
    /// cancelled move leaves every source in place.
    fn cross_drives(&mut self, crossing: Vec<Crossing>) -> Flow {
        let mut nodes = Vec::with_capacity(crossing.len());
        for Crossing { source, stat, plan } in crossing {
            if let Some(node) = self.scan(&source, stat)? {
                // `move_all` already counted the item itself.
                self.add_total(node.items - 1, node.bytes);
                nodes.push((node, plan));
            }
        }
        let copied = nodes
            .iter_mut()
            .try_for_each(|(node, plan)| self.place(node, plan.clone(), true));
        for (node, _) in &nodes {
            self.settle(node, copied.is_ok());
        }
        copied
    }

    /// Stands in for the real location of `folder`, for comparing.
    fn folder_identity(&mut self, folder: &Path) -> Flow<Option<String>> {
        self.attempt(folder, None, |_| sys::final_path(folder))
    }

    /// Reads the source's facts, refusing a folder aimed at its own inside.
    fn check_source(&mut self, source: &Path, identity: &str) -> Flow<Option<Stat>> {
        let found = self.attempt(source, None, |_| sys::stat(source))?;
        let Some(found) = found else {
            self.step(1, 0);
            return Ok(None);
        };
        let Some(stat) = found else {
            self.refuse(source, "This item no longer exists.")?;
            return Ok(None);
        };
        if stat.is_folder() {
            let inside = sys::final_path(source).is_ok_and(|own| sys::is_inside(identity, &own));
            if inside {
                self.refuse(source, "The destination is inside this folder.")?;
                return Ok(None);
            }
        }
        Ok(Some(stat))
    }

    /// Looks at `target` and settles what to do there, asking if something is in the way.
    /// With no `source`, what lands has no file of its own to compare.
    pub(super) fn resolve(&mut self, source: Option<&Path>, stat: Stat, target: &Path) -> Flow<Plan> {
        let found = self.attempt(target, None, |_| sys::stat(target))?;
        let Some(found) = found else {
            return Ok(Plan::Skip);
        };
        let Some(existing) = found else {
            return Ok(Plan::Write(target.to_path_buf()));
        };
        // A replace through a junction alias would destroy the source.
        if let Some(source) = source {
            match self.attempt(target, None, |_| sys::same_file(source, target))? {
                Some(false) => {}
                Some(true) if same_but_for_case(source, target) => {
                    return Ok(Plan::Write(target.to_path_buf()));
                }
                _ => return Ok(Plan::Skip),
            }
        }

        let (key, choices): (Key, &[Answer]) = if stat.is_folder() && existing.is_folder() {
            (Key::Folders, &[Answer::Merge, Answer::KeepBoth, Answer::Skip, Answer::Cancel])
        } else if stat.is_file() && existing.is_file() {
            (Key::Files, &[Answer::Replace, Answer::KeepBoth, Answer::Skip, Answer::Cancel])
        } else {
            (Key::Mixed, &[Answer::KeepBoth, Answer::Skip, Answer::Cancel])
        };
        let question = Question::Conflict {
            name: file_name(target).to_string_lossy().into_owned(),
            source: Facts::from(stat),
            target: Facts::from(existing),
            choices: choices.to_vec(),
        };
        Ok(match self.ask(key, question)? {
            Answer::Replace => Plan::Replace(target.to_path_buf()),
            Answer::Merge => Plan::Merge(target.to_path_buf()),
            Answer::KeepBoth => {
                let folder = sys::parent(target);
                Plan::Write(names::keep_both(&folder, file_name(target), stat.is_dir()))
            }
            _ => Plan::Skip,
        })
    }

    /// Copies a snapshot to its planned target. `moving` makes sure each file is on the disk
    /// before the source can go.
    fn place(&mut self, node: &mut Node, plan: Plan, moving: bool) -> Flow {
        let (target, replace) = match plan {
            Plan::Skip => {
                self.step(node.items, node.bytes);
                return Ok(());
            }
            Plan::Merge(target) => {
                self.step(1, 0);
                node.landed = Some(target.clone());
                return self.fill(node, &target, moving);
            }
            Plan::Write(target) => (target, false),
            Plan::Replace(target) => (target, true),
        };
        if node.stat.is_folder() {
            self.place_folder(node, &target, moving)
        } else if node.stat.is_link() {
            self.place_link(node, &target)
        } else {
            self.place_file(node, &target, replace, moving)
        }
    }

    fn elevated_copy(node: &Node, target: &Path, moving: bool) -> Elevated {
        let (source, target) = (node.path.clone(), target.to_path_buf());
        if moving {
            Elevated::Move { source, target }
        } else {
            Elevated::Copy { source, target }
        }
    }

    fn place_folder(&mut self, node: &mut Node, target: &Path, moving: bool) -> Flow {
        let elevated = Self::elevated_copy(node, target, moving);
        let stat = node.stat;
        let made = self.attempt(&node.path.clone(), Some(elevated), |_| {
            sys::create_dir_like(target, stat)
        })?;
        if made.is_none() {
            self.step(node.items, node.bytes);
            return Ok(());
        }
        self.step(1, 0);
        node.landed = Some(target.to_path_buf());
        node.fresh = true;
        self.fill(node, target, moving)?;
        if moving {
            let _ = sys::set_times(target, stat.created, stat.modified);
        }
        Ok(())
    }

    fn fill(&mut self, node: &mut Node, target: &Path, moving: bool) -> Flow {
        let fresh = node.fresh;
        for child in node.children.iter_mut().flatten() {
            let child_target = target.join(file_name(&child.path));
            let plan = if fresh {
                Plan::Write(child_target)
            } else {
                self.resolve(Some(&child.path.clone()), child.stat, &child_target)?
            };
            self.place(child, plan, moving)?;
        }
        Ok(())
    }

    fn place_link(&mut self, node: &mut Node, target: &Path) -> Flow {
        let directory = node.stat.is_dir();
        let path = node.path.clone();
        let made = self.attempt(&path, None, |_| {
            sys::write_link(target, &sys::read_link(&path)?, directory)
        })?;
        node.landed = made.map(|()| target.to_path_buf());
        self.step(1, 0);
        Ok(())
    }

    /// A temp name in the folder of `target`.
    pub(super) fn temp_beside(&mut self, target: &Path) -> PathBuf {
        let folder = sys::parent(target);
        if self.temp_folders.insert(folder.clone()) {
            self.host.temp_folder(&folder);
        }
        temp_path(&folder)
    }

    fn place_file(&mut self, node: &mut Node, target: &Path, replace: bool, moving: bool) -> Flow {
        let temp = self.temp_beside(target);
        let base = self.progress.bytes;
        let path = node.path.clone();
        let elevated = Self::elevated_copy(node, target, moving);
        let copied = self.attempt(&path, Some(elevated), |run| {
            sys::copy_file(&path, &temp, moving, |bytes| run.copied(base + bytes))
        });
        if !matches!(copied, Ok(Some(()))) {
            let _ = sys::delete_file(&temp);
        }
        let landed = match copied? {
            Some(()) => {
                let swapped = self.swap_in(&temp, target, replace);
                if !matches!(swapped, Ok(true)) {
                    let _ = sys::delete_file(&temp);
                }
                swapped?
            }
            None => false,
        };
        if landed {
            node.landed = Some(target.to_path_buf());
        }
        self.progress.bytes = base + node.bytes;
        self.step(1, 0);
        Ok(())
    }

    /// Gives a finished temp file its real name. An old file goes to the Recycle Bin first and
    /// stays if the user skips. False if the file did not land.
    pub(super) fn swap_in(&mut self, temp: &Path, target: &Path, replace: bool) -> Flow<bool> {
        if replace {
            self.add_total(1, 0);
            self.recycle(vec![target.to_path_buf()])?;
            if !matches!(sys::stat(target), Ok(None)) {
                return Ok(false);
            }
        }
        Ok(self.attempt(target, None, |_| sys::rename(temp, target))?.is_some())
    }

    /// Writes down what landed. With `remove_sources` it also removes each source that is
    /// safely at its target. True when this node's source is gone.
    fn settle(&mut self, node: &Node, remove_sources: bool) -> bool {
        let Some(target) = &node.landed else {
            return false;
        };
        let Some(children) = &node.children else {
            let gone = remove_sources && self.remove_source(node);
            self.done.push(if gone {
                Done::Moved {
                    from: node.path.clone(),
                    to: target.clone(),
                }
            } else {
                Done::Created {
                    path: target.clone(),
                }
            });
            return gone;
        };

        let mark = self.done.len();
        if node.fresh {
            // First, so undo reaches the folder after its contents.
            self.done.push(Done::Created {
                path: target.clone(),
            });
        }
        let mut gone = node.whole;
        for child in children {
            gone &= self.settle(child, remove_sources);
        }
        if !remove_sources {
            if node.fresh {
                self.done.truncate(mark);
                self.done.push(Done::Created {
                    path: target.clone(),
                });
            }
            return false;
        }
        // Windows refuses a folder that gained a file meanwhile, and that folder stays.
        let gone = gone && sys::remove_dir(&node.path).is_ok();
        if gone && node.fresh {
            self.done.truncate(mark);
            self.done.push(Done::Moved {
                from: node.path.clone(),
                to: target.clone(),
            });
        }
        gone
    }

    /// A file that changed since the snapshot may hold data the copy lacks, so it stays.
    fn remove_source(&mut self, node: &Node) -> bool {
        if self.control.cancelled() {
            return false;
        }
        let path = &node.path;
        let unchanged = sys::stat(path).is_ok_and(|now| {
            now.is_some_and(|now| now.size == node.stat.size && now.modified == node.stat.modified)
        });
        if !unchanged {
            self.kept.push(path.clone());
            return false;
        }
        let directory = node.stat.is_dir();
        let elevated = Elevated::Delete { path: path.clone() };
        let removed = self.attempt(path, Some(elevated), |_| {
            if directory {
                sys::remove_dir(path)
            } else {
                sys::delete_file(path)
            }
        });
        matches!(removed, Ok(Some(())))
    }
}

enum Renamed {
    Done,
    Skipped,
    OtherDrive,
}
