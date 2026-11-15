//! Files with the same content under a folder: copies that only take room.

use std::cmp::Reverse;
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::hash::{Hash, Hasher};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::folder::{self, Entry, Found, Sight};
use crate::ops::sys::{self, Stat};
use crate::preview;

/// Files that differ mostly differ early, so this much of each is read before all of it.
const HEAD: usize = 64 * 1024;
/// How often the look says it is still going.
const GOING_GAP: Duration = Duration::from_millis(400);

type Candidate = (Entry, Arc<[u16]>);

/// The files under `folder` (only in it, unless `deep`) that have the same content as another,
/// in sets: the set that wastes the most room first, and the oldest file of each set first. Empty
/// files, files in the cloud (reading would fetch them), links and what `sight` hides take no
/// part. `lane` is the checksum lane, so another look cancels nothing of this one's.
pub fn find(folder: &Path, deep: bool, sight: Sight, lane: u32, stopped: &dyn Fn() -> bool, going: &dyn Fn()) -> Found {
    let mut reported = Instant::now();
    let mut tick = || {
        if reported.elapsed() >= GOING_GAP {
            going();
            reported = Instant::now();
        }
    };

    // Only files of the same size can be the same.
    let mut by_size: HashMap<u64, Vec<Candidate>> = HashMap::new();
    let mut below = VecDeque::from([folder.to_path_buf()]);
    while let Some(at) = below.pop_front() {
        if stopped() {
            return Found::default();
        }
        let location: Arc<[u16]> = folder::null_terminated(&at).into();
        // A folder that can't be read has nothing to give, which is no reason to stop.
        let _ = sys::each_entry(&sys::extended(&at.join("*")), |data| {
            let Some(entry) = Entry::from_find_data(data) else { return };
            let stat = Stat::from_find_data(data);
            if !sight.shows(&entry) {
                return;
            }
            if stat.is_folder() {
                if deep {
                    below.push_back(at.join(entry.file_name()));
                }
            } else if stat.is_file() && !entry.is_cloud() && entry.size() > 0 {
                by_size.entry(entry.size()).or_default().push((entry, location.clone()));
            }
        });
        tick();
    }

    // Then the same first bytes, then the same checksum over all of them.
    let path_of = |(entry, location): &Candidate| path_in(location).join(entry.file_name());
    let mut sets: Vec<(u64, Vec<Candidate>)> = Vec::new();
    for (size, files) in by_size.into_iter().filter(|(_, files)| files.len() > 1) {
        for alike in split_by(files, |file| head_of(&path_of(file))) {
            if stopped() {
                return Found::default();
            }
            tick();
            let same = split_by(alike, |file| preview::hash(&path_of(file), "sha256", lane).ok().flatten());
            sets.extend(same.into_iter().map(|files| (size, files)));
        }
    }
    sets.sort_by_key(|(size, files)| Reverse(size * (files.len() as u64 - 1)));

    let mut found = Found::default();
    for (set, (_, mut files)) in sets.into_iter().enumerate() {
        files.sort_by_key(|(entry, _)| entry.modified());
        for (entry, location) in files {
            found.push_copy(entry, location, set as u32);
        }
    }
    found
}

/// The groups of `files` that share a key, when more than one does. A file without a key, such
/// as one that can't be read, is in none.
fn split_by<K: Hash + Eq>(files: Vec<Candidate>, key: impl Fn(&Candidate) -> Option<K>) -> Vec<Vec<Candidate>> {
    let mut groups: HashMap<K, Vec<Candidate>> = HashMap::new();
    for file in files {
        if let Some(key) = key(&file) {
            groups.entry(key).or_default().push(file);
        }
    }
    groups.into_values().filter(|group| group.len() > 1).collect()
}

/// A quick fingerprint of the file's first bytes. Only a sorting step: the checksum decides.
fn head_of(path: &Path) -> Option<u64> {
    let mut head = Vec::with_capacity(HEAD);
    File::open(path).ok()?.take(HEAD as u64).read_to_end(&mut head).ok()?;
    let mut hasher = DefaultHasher::new();
    head.hash(&mut hasher);
    Some(hasher.finish())
}

fn path_in(location: &[u16]) -> PathBuf {
    PathBuf::from(String::from_utf16_lossy(&location[..location.len() - 1]))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    #[test]
    fn copies_come_in_sets_biggest_waste_first_and_the_rest_stay_out() {
        let root = std::env::temp_dir().join(format!("perli-copies-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("deep")).unwrap();
        let big = vec![7u8; 200 * 1024];
        let mut other = big.clone();
        // Same size and same first bytes, but not the same: only the checksum tells them apart.
        *other.last_mut().unwrap() = 8;
        fs::write(root.join("a.bin"), &big).unwrap();
        fs::write(root.join("deep").join("b.bin"), &big).unwrap();
        fs::write(root.join("c.bin"), &other).unwrap();
        fs::write(root.join("x.txt"), b"same").unwrap();
        fs::write(root.join("y.txt"), b"same").unwrap();
        fs::write(root.join("z.txt"), b"diff").unwrap();
        fs::write(root.join("empty1"), b"").unwrap();
        fs::write(root.join("empty2"), b"").unwrap();
        let sight = Sight { hidden: false, system: false };
        let sets = |found: &Found| found.sets_and_names();
        let set = |pairs: &[(u32, &str)]| pairs.iter().map(|&(set, name)| (set, name.to_string())).collect::<Vec<_>>();

        let found = find(&root, true, sight, 900, &|| false, &|| ());
        assert_eq!(sets(&found), set(&[(0, "a.bin"), (0, "b.bin"), (1, "x.txt"), (1, "y.txt")]));

        // Only in the folder itself, the copy in `deep` is no copy.
        let flat = find(&root, false, sight, 901, &|| false, &|| ());
        assert_eq!(sets(&flat), set(&[(0, "x.txt"), (0, "y.txt")]));

        // A stopped look finds nothing.
        assert_eq!(find(&root, true, sight, 902, &|| true, &|| ()).len(), 0);
        fs::remove_dir_all(&root).unwrap();
    }
}
