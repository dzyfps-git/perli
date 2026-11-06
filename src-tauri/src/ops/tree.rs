//! A snapshot of a file tree, taken before anything changes. Working from it means a junction
//! that leads back into the source can't make a copy recurse forever.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::sys::{self, Stat};
use super::{Answer, Control, Elevated, Flow, Host, Progress, Question, Reply, Run};

pub struct Node {
    pub path: PathBuf,
    pub stat: Stat,
    /// What is inside, for a real folder only. Links have none, so nothing walks through them.
    pub children: Option<Vec<Node>>,
    /// False when part of this tree could not be read, so its folder can't be removed.
    pub whole: bool,
    /// Bytes in this whole tree.
    pub bytes: u64,
    /// Items in this whole tree, counting itself.
    pub items: u64,
    /// Where a copy of this landed.
    pub landed: Option<PathBuf>,
    /// The folder at `landed` is new, not one that was merged into.
    pub fresh: bool,
}

impl Run<'_> {
    pub(super) fn scan(&mut self, path: &Path, stat: Stat) -> Flow<Option<Node>> {
        let mut node = Node {
            path: path.to_path_buf(),
            stat,
            children: None,
            whole: true,
            bytes: stat.size,
            items: 1,
            landed: None,
            fresh: false,
        };
        if stat.is_folder() {
            let Some(entries) = self.attempt(path, None, |_| sys::read_dir(path))? else {
                return Ok(None);
            };
            let mut children = Vec::with_capacity(entries.len());
            for (name, stat) in entries {
                match self.scan(&path.join(name), stat)? {
                    Some(child) => {
                        node.bytes += child.bytes;
                        node.items += child.items;
                        node.whole &= child.whole;
                        children.push(child);
                    }
                    None => node.whole = false,
                }
            }
            node.children = Some(children);
        }
        Ok(Some(node))
    }

    /// Scans for a job that goes on to work through the trees.
    pub(super) fn scan_all(&mut self, paths: &[PathBuf]) -> Flow<Vec<Node>> {
        let mut nodes = Vec::with_capacity(paths.len());
        for path in paths {
            let Some(found) = self.attempt(path, None, |_| sys::stat(path))? else {
                continue;
            };
            // Something gone already needs nothing more.
            let Some(stat) = found else { continue };
            if let Some(node) = self.scan(path, stat)? {
                self.add_total(node.items, node.bytes);
                nodes.push(node);
            }
        }
        Ok(nodes)
    }

    /// Permanently deletes everything in `paths`. Links go, their targets stay.
    pub(super) fn delete_paths(&mut self, paths: &[PathBuf]) -> Flow {
        for node in self.scan_all(paths)? {
            self.touched.insert(sys::parent(&node.path));
            self.delete_node(&node)?;
        }
        Ok(())
    }

    /// Children go first, and a folder goes only if all of them went.
    fn delete_node(&mut self, node: &Node) -> Flow<bool> {
        let mut gone = node.whole;
        for child in node.children.iter().flatten() {
            gone &= self.delete_node(child)?;
        }
        if !gone {
            return Ok(false);
        }
        let path = &node.path;
        let elevated = Elevated::Delete { path: path.clone() };
        let deleted = self.attempt(path, Some(elevated), |_| {
            if node.stat.is_dir() {
                sys::remove_dir(path)
            } else {
                sys::delete_file(path)
            }
        })?;
        self.step(1, node.stat.size);
        Ok(deleted.is_some())
    }
}

struct Quiet;

impl Host for Quiet {
    fn progress(&self, _: &Progress) {}

    fn ask(&self, _: Question) -> Reply {
        Reply {
            answer: Answer::Skip,
            all: true,
        }
    }
}

/// Counts items and bytes in `paths`, skipping whatever can't be read.
pub fn measure(paths: &[PathBuf]) -> (u64, u64) {
    let control = Arc::new(Control::default());
    let mut run = Run::new(&Quiet, &control);
    let _ = run.scan_all(paths);
    (run.progress.total_items, run.progress.total_bytes)
}
