//! Renames many items at once. A new name may be another item's old name, so each item waits for
//! whatever holds its new name, and a ring such as a to b with b to a steps through a spare name.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use super::names::unchanged;
use super::transfer::{put_back, staged_path};
use super::{sys, Done, Flow, Run};

fn key(path: &Path) -> String {
    path.to_string_lossy().to_lowercase()
}

/// An item of a ring, out of the way under a spare name.
struct Spare {
    index: usize,
    staged: PathBuf,
    home: PathBuf,
    /// Where `done` lists the step aside.
    record: usize,
}

impl Run<'_> {
    pub(super) fn rename_all(&mut self, renames: Vec<(PathBuf, String)>) -> Flow {
        self.add_total(renames.len() as u64, 0);
        let mut moves = Vec::with_capacity(renames.len());
        for (path, name) in renames {
            if unchanged(&path, &name) {
                self.step(1, 0);
            } else {
                let target = path.with_file_name(name);
                moves.push((path, target));
            }
        }
        let holders: HashMap<String, usize> =
            moves.iter().enumerate().map(|(index, (source, _))| (key(source), index)).collect();

        // Each item leads to the one holding its new name, so a walk ends at a free name or
        // back on itself, which is a ring. `seen` names the walk that reached an item.
        let mut seen = vec![None; moves.len()];
        for start in 0..moves.len() {
            let (mut chain, mut ring, mut next) = (Vec::new(), None, Some(start));
            while let Some(index) = next {
                match seen[index] {
                    Some(walk) if walk == start => {
                        ring = Some(index);
                        break;
                    }
                    Some(_) => break,
                    None => seen[index] = Some(start),
                }
                chain.push(index);
                next = holders.get(&key(&moves[index].1)).copied().filter(|&holder| holder != index);
            }
            self.rename_chain(&moves, &chain, ring)?;
        }
        Ok(())
    }

    /// Goes last item first, as each one waits for the next to leave. A ring goes whole or not
    /// at all, because stopping half way leaves one item with no free name to go to.
    fn rename_chain(&mut self, moves: &[(PathBuf, PathBuf)], chain: &[usize], ring: Option<usize>) -> Flow {
        let mut spare = None;
        if let Some(index) = ring {
            spare = self.move_aside(index, &moves[index].0)?;
            if spare.is_none() {
                self.step(chain.len() as u64, 0);
                return Ok(());
            }
        }
        let mut finished = Ok(());
        for &index in chain.iter().rev() {
            let (source, target) = &moves[index];
            let held = spare.as_ref().filter(|spare: &&Spare| spare.index == index);
            let from = held.map_or(source.as_path(), |spare| &spare.staged);
            match self.rename_to(from, target, held.is_none()) {
                Ok(renamed) => {
                    if renamed && held.is_some() {
                        spare = None;
                    }
                    self.step(1, 0);
                }
                Err(stopped) => {
                    finished = Err(stopped);
                    break;
                }
            }
        }
        if let Some(spare) = spare {
            self.take_back(&spare);
        }
        finished
    }

    fn move_aside(&mut self, index: usize, source: &Path) -> Flow<Option<Spare>> {
        let staged = staged_path(&sys::parent(source));
        self.host.staged(&staged, source);
        let moved = self.attempt(source, None, |_| sys::rename(source, &staged))?;
        Ok(moved.map(|()| {
            self.done.push(Done::Moved {
                from: source.to_path_buf(),
                to: staged.clone(),
            });
            Spare {
                index,
                staged,
                home: source.to_path_buf(),
                record: self.done.len() - 1,
            }
        }))
    }

    /// Reverses what a ring did so far. Every record from the step aside on is that ring's.
    fn take_back(&mut self, spare: &Spare) {
        for record in self.done.drain(spare.record + 1..).rev() {
            if let Done::Moved { from, to } = record {
                let _ = sys::rename(&to, &from);
            }
        }
        self.done.pop();
        let _ = put_back(&spare.staged, &spare.home);
    }
}
