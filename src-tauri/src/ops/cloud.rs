//! Copies and moves to, from and within cloud places, and the renames, new items and deletes
//! there. A file on this PC goes up, a cloud one comes down, one within a place moves there,
//! and one between two places passes through this PC. Each leaves the same undo records a job
//! on this PC does, so Undo, its words and the folders read again all work the same.

use std::fs;
use std::path::{Path, PathBuf};

use windows::core::Error;
use windows::Win32::Foundation::E_FAIL;

use super::{sys, Answer, Done, Facts, Flow, Key, Question, Run};
use crate::remote::{self, At, Item};

/// Marks the undo record of a cloud delete: what follows it is what brings it back.
const TOKEN: &str = "cloud-bin:";

fn failed(message: String) -> Error {
    Error::new(E_FAIL, message)
}

/// Where a copy lands.
enum Spot {
    Cloud(Box<At>),
    Local(PathBuf),
}

/// What a name in the target folder came to after any question.
enum Landing {
    /// Under this name, over `Some` item there.
    Name(String, Option<Item>),
    /// Into a folder of the same name, there already.
    Merge(String),
    Skip,
}

/// The lowest free `name (n)` by what `taken` says.
fn free_name(name: &str, folder: bool, taken: impl Fn(&str) -> bool) -> String {
    let (stem, extension) = match name.rsplit_once('.').filter(|(stem, _)| !folder && !stem.is_empty()) {
        Some((stem, extension)) => (stem.to_string(), format!(".{extension}")),
        None => (name.to_string(), String::new()),
    };
    (1..)
        .map(|number| if number == 1 { name.to_string() } else { format!("{stem} ({number}){extension}") })
        .find(|candidate| !taken(candidate))
        .unwrap_or_else(|| name.to_string())
}

fn facts_of(item: &Item) -> Facts {
    Facts { size: item.size, modified: item.modified, folder: item.folder }
}

fn local_facts(path: &Path) -> Option<Facts> {
    sys::stat(path).ok().flatten().map(Facts::from)
}

impl Run<'_> {
    fn spot(folder: &Path) -> std::result::Result<Spot, String> {
        match remote::at(folder) {
            Some(at) => Ok(Spot::Cloud(Box::new(at?))),
            None if remote::is_remote(folder) => Err("Files go into a cloud place, not next to the places".into()),
            None => Ok(Spot::Local(folder.to_path_buf())),
        }
    }

    /// Tells of a problem with `path` that can't be tried again, and goes on past it.
    fn cloud_refused(&mut self, path: &Path, message: &str) -> Flow {
        self.tell(path, message)
    }

    /// Asks what to do when `name` is taken where it is going. `there` is what holds it.
    fn land(&mut self, name: &str, coming: Facts, source: Option<&Path>, there: Option<Facts>, target: &Path, taken: &dyn Fn(&str) -> bool) -> Flow<Landing> {
        let Some(there) = there else { return Ok(Landing::Name(name.to_string(), None)) };
        if there.folder && coming.folder {
            return Ok(Landing::Merge(name.to_string()));
        }
        let question = Question::Conflict {
            name: name.to_string(),
            source: coming,
            target: there,
            source_path: source.map(|path| path.to_string_lossy().into_owned()),
            target_path: target.to_string_lossy().into_owned(),
            clashes: 0,
            fresh: 0,
            choices: vec![Answer::Replace, Answer::KeepBoth, Answer::Skip, Answer::Cancel],
        };
        let key = if there.folder || coming.folder { Key::Mixed } else { Key::Files };
        Ok(match self.ask(key, question)? {
            Answer::Replace if there.folder == coming.folder => Landing::Name(name.to_string(), None),
            Answer::KeepBoth | Answer::Replace => Landing::Name(free_name(name, coming.folder, taken), None),
            _ => Landing::Skip,
        })
    }

    /// Where `name` lands in a cloud folder, after any question.
    fn land_in_cloud(&mut self, at: &At, folder: &str, name: &str, coming: Facts, source: Option<&Path>) -> Flow<Landing> {
        let items = match remote::listed(at, folder, true) {
            Ok(items) => items,
            Err(message) => {
                self.cloud_refused(&at.shown(folder), &message)?;
                return Ok(Landing::Skip);
            }
        };
        let there = items.iter().find(|item| item.name.eq_ignore_ascii_case(name)).cloned();
        let taken = |candidate: &str| items.iter().any(|item| item.name.eq_ignore_ascii_case(candidate));
        let landing = self.land(name, coming, source, there.as_ref().map(facts_of), &at.shown(&remote::join(folder, name)), &taken)?;
        // A file written over keeps the item it replaces, which some services want named.
        Ok(match landing {
            Landing::Name(chosen, None) if chosen.eq_ignore_ascii_case(name) => Landing::Name(chosen, there),
            other => other,
        })
    }

    fn land_here(&mut self, folder: &Path, name: &str, coming: Facts, source: Option<&Path>) -> Flow<Landing> {
        let target = folder.join(name);
        let taken = |candidate: &str| folder.join(candidate).exists();
        self.land(name, coming, source, local_facts(&target), &target, &taken)
    }

    /// The copy or move of each of `sources` into `folder`, either of which is in the cloud.
    pub(super) fn cloud(&mut self, sources: Vec<PathBuf>, folder: &Path, moving: bool) -> Flow {
        let spot = match Self::spot(folder) {
            Ok(spot) => spot,
            Err(message) => return self.cloud_refused(folder, &message),
        };
        self.add_total(sources.len() as u64, 0);
        for source in sources {
            self.check()?;
            self.send_one(&source, &spot, moving)?;
            self.step(1, 0);
        }
        remote::forget(&[folder.to_path_buf()]);
        Ok(())
    }

    fn send_one(&mut self, source: &Path, spot: &Spot, moving: bool) -> Flow {
        let name = source.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
        let from = match remote::at(source) {
            None => None,
            Some(Ok(at)) => Some(at),
            Some(Err(message)) => return self.cloud_refused(source, &message),
        };
        match (from, spot) {
            (Some(from), Spot::Cloud(to)) if from.place.id == to.place.id => self.within(&from, to, &name, moving),
            (Some(from), spot) => {
                let item = match from.item() {
                    Ok(item) => item,
                    Err(message) => return self.cloud_refused(source, &message),
                };
                let whole = match spot {
                    Spot::Local(folder) => self.download(&from, &item, folder, &name, true)?,
                    Spot::Cloud(to) => {
                        // Between two places, it comes down here first and goes up from here.
                        let Some(here) = self.attempt(source, None, |_| crate::zipped::real(source).map_err(failed))? else { return Ok(()) };
                        let folder = to.inner.clone();
                        self.upload(&here, to, &folder, &name, true)?
                    }
                };
                if moving && whole {
                    self.cloud_remove_one(source)?;
                }
                Ok(())
            }
            (None, Spot::Cloud(to)) => {
                // A row of a ZIP opened as a folder comes out of it first.
                let Some(here) = self.attempt(source, None, |_| crate::zipped::real(source).map_err(failed))? else { return Ok(()) };
                let folder = to.inner.clone();
                let whole = self.upload(&here, to, &folder, &name, true)?;
                if moving && whole && !crate::zipped::is_inside(source) {
                    self.recycle(vec![source.to_path_buf()])?;
                }
                Ok(())
            }
            (None, Spot::Local(folder)) => {
                if moving {
                    self.move_sources(vec![source.to_path_buf()], folder)
                } else {
                    self.copy(vec![source.to_path_buf()], folder)
                }
            }
        }
    }

    /// A move or copy within one place, made by the service itself.
    fn within(&mut self, from: &At, to: &At, name: &str, moving: bool) -> Flow {
        let shown = from.shown(&from.inner);
        if moving && remote::parent_of(&from.inner) == to.inner {
            return Ok(());
        }
        if to.inner == from.inner || to.inner.starts_with(&format!("{}/", from.inner)) {
            return self.cloud_refused(&shown, "A folder can't go inside itself");
        }
        let Some(item) = self.attempt(&shown, None, |_| from.item().map_err(failed))? else { return Ok(()) };
        let landing = self.land_in_cloud(to, &to.inner, name, facts_of(&item), None)?;
        let chosen = match landing {
            Landing::Skip => return Ok(()),
            Landing::Merge(_) => {
                // Two folders of one name: what is inside goes in one by one.
                let inner = remote::join(&to.inner, name);
                let into = At { place: to.place.clone(), service: to.service.clone(), inner: inner.clone() };
                let children = match remote::listed(from, &from.inner, true) {
                    Ok(children) => children,
                    Err(message) => return self.cloud_refused(&shown, &message),
                };
                for child in children.iter() {
                    let child_at = At { place: from.place.clone(), service: from.service.clone(), inner: remote::join(&from.inner, &child.name) };
                    self.within(&child_at, &into, &child.name, moving)?;
                }
                return Ok(());
            }
            Landing::Name(chosen, _) => chosen,
        };
        let target = to.shown(&remote::join(&to.inner, &chosen));
        let done = self.attempt(&shown, None, |_| {
            if moving {
                from.service.relocate(&from.inner, &item, &to.inner, &chosen)
            } else {
                from.service.duplicate(&from.inner, &item, &to.inner, &chosen)
            }
            .map_err(failed)
        })?;
        if done.is_some() {
            self.done.push(if moving { Done::Moved { from: shown.clone(), to: target } } else { Done::Created { path: target } });
            remote::forget(&[shown]);
        }
        Ok(())
    }

    /// Sends `local`, a file or a folder with all it holds, into `folder` of a place as `name`.
    /// True when all of it went.
    fn upload(&mut self, local: &Path, to: &At, folder: &str, name: &str, top: bool) -> Flow<bool> {
        let Some(facts) = local_facts(local) else {
            self.cloud_refused(local, "This isn't there any more")?;
            return Ok(false);
        };
        let landing = self.land_in_cloud(to, folder, name, facts, Some(local))?;
        let (chosen, replace, merge) = match landing {
            Landing::Skip => return Ok(false),
            Landing::Merge(chosen) => (chosen, None, true),
            Landing::Name(chosen, replace) => (chosen, replace, false),
        };
        let target = to.shown(&remote::join(folder, &chosen));
        if facts.folder {
            if !merge && self.attempt(&target, None, |_| to.service.make_folder(folder, &chosen).map_err(failed))?.is_none() {
                return Ok(false);
            }
            if top && !merge {
                self.done.push(Done::Created { path: target.clone() });
            }
            let inner = remote::join(folder, &chosen);
            let mut whole = true;
            for (child, _) in sys::read_dir(local).unwrap_or_default() {
                self.check()?;
                let child_name = child.to_string_lossy().into_owned();
                self.add_total(1, 0);
                whole &= self.upload(&local.join(&child), to, &inner, &child_name, merge && top)?;
                self.step(1, 0);
            }
            return Ok(whole);
        }
        self.add_total(0, facts.size);
        let base = self.progress.bytes;
        let sent = self.attempt(&target, None, |run| {
            to.service.write(folder, &chosen, local, replace.as_ref(), &mut |done| run.copied(base + done)).map_err(failed)
        })?;
        self.progress.bytes = base + facts.size;
        if sent.is_none() {
            return Ok(false);
        }
        if top && replace.is_none() {
            // ponytail: a file written over leaves no undo record; the services keep its old
            // version, which Versions brings back.
            self.done.push(Done::Created { path: target });
        }
        Ok(true)
    }

    /// Brings `item`, a file or a folder with all it holds, into `folder` on this PC as `name`.
    /// True when all of it came.
    fn download(&mut self, from: &At, item: &Item, folder: &Path, name: &str, top: bool) -> Flow<bool> {
        let shown = from.shown(&from.inner);
        let landing = self.land_here(folder, name, facts_of(item), None)?;
        let (chosen, merge) = match landing {
            Landing::Skip => return Ok(false),
            Landing::Merge(chosen) => (chosen, true),
            Landing::Name(chosen, _) => (chosen, false),
        };
        let target = folder.join(&chosen);
        if item.folder {
            if !merge && self.attempt(&target, None, |_| sys::create_dir(&target))?.is_none() {
                return Ok(false);
            }
            if top && !merge {
                self.done.push(Done::Created { path: target.clone() });
            }
            let Some(children) = self.attempt(&shown, None, |_| remote::listed(from, &from.inner, true).map_err(failed))? else { return Ok(false) };
            let mut whole = true;
            for child in children.iter() {
                self.check()?;
                self.add_total(1, 0);
                let child_at = At { place: from.place.clone(), service: from.service.clone(), inner: remote::join(&from.inner, &child.name) };
                whole &= self.download(&child_at, child, &target, &child.name, merge && top)?;
                self.step(1, 0);
            }
            return Ok(whole);
        }
        self.add_total(0, item.size);
        let base = self.progress.bytes;
        let part = super::transfer::temp_path(folder);
        self.host.temp_folder(folder);
        let came = self.attempt(&shown, None, |run| {
            let mut file = fs::File::create(&part).map_err(|error| failed(error.to_string()))?;
            from.service.read(&from.inner, item, 0, &mut file, &mut |done| run.copied(base + done)).map_err(failed)?;
            if item.modified > 0 {
                let _ = file.set_modified(crate::zipped::time_of(item.modified).unwrap_or_else(std::time::SystemTime::now));
            }
            drop(file);
            // Written over, the old file goes to the Recycle Bin first, as a copy here does.
            if target.exists() {
                fs::remove_file(&target).map_err(|error| failed(error.to_string()))?;
            }
            fs::rename(&part, &target).map_err(|error| failed(error.to_string()))
        })?;
        let _ = fs::remove_file(&part);
        self.progress.bytes = base + item.size;
        if came.is_none() {
            return Ok(false);
        }
        if top {
            self.done.push(Done::Created { path: target });
        }
        Ok(true)
    }

    /// Deletes one item of a place, to its bin where it has one, noting what brings it back.
    fn cloud_remove_one(&mut self, path: &Path) -> Flow {
        let at = match remote::at(path) {
            Some(Ok(at)) => at,
            Some(Err(message)) => return self.cloud_refused(path, &message),
            None => return Ok(()),
        };
        let removed = self.attempt(path, None, |_| {
            let item = at.item().map_err(failed)?;
            at.service.remove(&at.inner, &item).map_err(failed)
        })?;
        if let Some(token) = removed {
            if !token.is_empty() {
                self.done.push(Done::Recycled { original: path.to_path_buf(), item: PathBuf::from(format!("{TOKEN}{token}")) });
            }
            remote::forget(&[path.to_path_buf()]);
        }
        Ok(())
    }

    /// The cloud ones of a Recycle or a Delete.
    pub(super) fn cloud_remove(&mut self, paths: &[PathBuf]) -> Flow {
        for path in paths {
            self.check()?;
            self.cloud_remove_one(path)?;
            self.step(1, 0);
        }
        Ok(())
    }

    /// Moves within places, each to the exact path given, as an undo and a rename do.
    pub(super) fn cloud_moves(&mut self, moves: Vec<(PathBuf, PathBuf)>) -> Flow {
        for (from, to) in moves {
            self.check()?;
            let (Some(Ok(source)), Some(Ok(target))) = (remote::at(&from), remote::at(&to)) else {
                self.cloud_refused(&from, "This moves only within one cloud place")?;
                continue;
            };
            if source.place.id != target.place.id {
                self.cloud_refused(&from, "This moves only within one cloud place")?;
                continue;
            }
            let (folder, name) = (target.parent(), target.name().to_string());
            let moved = self.attempt(&from, None, |_| {
                let item = source.item().map_err(failed)?;
                source.service.relocate(&source.inner, &item, &folder, &name).map_err(failed)
            })?;
            if moved.is_some() {
                self.done.push(Done::Moved { from: from.clone(), to: to.clone() });
                remote::forget(&[from, to]);
            }
            self.step(1, 0);
        }
        Ok(())
    }

    /// Brings back what a cloud delete took, from the token its undo record holds.
    pub(super) fn cloud_restore(&mut self, items: Vec<(PathBuf, PathBuf)>) -> Flow {
        self.add_total(items.len() as u64, 0);
        for (item, original) in items {
            self.check()?;
            let token = item.to_string_lossy().strip_prefix(TOKEN).unwrap_or_default().to_string();
            let Some(Ok(at)) = remote::at(&original) else {
                self.cloud_refused(&original, "That cloud place is gone")?;
                continue;
            };
            if self.attempt(&original, None, |_| at.service.restore(&at.inner, &token).map_err(failed))?.is_some() {
                self.done.push(Done::Created { path: original.clone() });
                remote::forget(&[original]);
            }
            self.step(1, 0);
        }
        Ok(())
    }

    /// A new folder or empty file in a cloud folder, under the first free name.
    pub(super) fn cloud_new(&mut self, folder: &Path, directory: bool) -> Flow {
        self.add_total(1, 0);
        let at = match Self::spot(folder) {
            Ok(Spot::Cloud(at)) => at,
            Ok(Spot::Local(_)) => return Ok(()),
            Err(message) => return self.cloud_refused(folder, &message),
        };
        let Some(items) = self.attempt(folder, None, |_| remote::listed(&at, &at.inner, true).map_err(failed))? else { return Ok(()) };
        let wanted = if directory { "New folder" } else { "New file.txt" };
        let name = free_name(wanted, directory, |candidate| items.iter().any(|item| item.name.eq_ignore_ascii_case(candidate)));
        let made = self.attempt(folder, None, |_| {
            if directory {
                return at.service.make_folder(&at.inner, &name).map_err(failed);
            }
            let empty = std::env::temp_dir().join(format!("perli-new-{}", remote::http::random_text(6)));
            fs::write(&empty, b"").map_err(|error| failed(error.to_string()))?;
            let sent = at.service.write(&at.inner, &name, &empty, None, &mut |_| true).map_err(failed);
            let _ = fs::remove_file(&empty);
            sent
        })?;
        if made.is_some() {
            self.done.push(Done::Created { path: at.shown(&remote::join(&at.inner, &name)) });
            remote::forget(&[folder.to_path_buf()]);
        }
        self.step(1, 0);
        Ok(())
    }
}

/// Whether an undo record of a delete is a cloud one.
pub(super) fn is_cloud_token(item: &Path) -> bool {
    item.to_string_lossy().starts_with(TOKEN)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn free_names_number_before_the_type() {
        let taken = ["a.txt", "a (2).txt", "Folder"];
        let free = |name: &str, folder: bool| free_name(name, folder, |candidate| taken.contains(&candidate));
        assert_eq!(free("b.txt", false), "b.txt");
        assert_eq!(free("a.txt", false), "a (3).txt");
        assert_eq!(free("Folder", true), "Folder (2)");
        assert!(is_cloud_token(Path::new("cloud-bin:abc")));
        assert!(!is_cloud_token(Path::new(r"C:\$Recycle.Bin\x")));
    }
}
