//! Two folders compared by everything under them, and two files by their content, for the marks of
//! panes compared side by side. What is learned is kept, so stepping in and back again costs nothing.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering::SeqCst};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use crate::folder::{Entry, Mark, Sight};
use crate::ops::sys::{self, Stat};
use crate::{preview, zipped};

/// A walk past this many entries on its two sides together gives up: no mark beats a long wait.
// ponytail: such a folder shows no mark at all; a "too big to tell" word would say why.
const MOST_ENTRIES: usize = 200_000;
/// How many of what sets two folders apart are kept to name.
const MOST_NAMES: usize = 12;
/// How long one round of settling runs before the marks show what it learned.
const ROUND: Duration = Duration::from_millis(400);
/// Checksum lanes of comparing count down from here, one for each pair of panes, so a compare
/// cancels no other checksum and none cancels it.
const LANES: u32 = u32::MAX - 1;
/// Past this many pairs, what is known starts over.
const MOST_KNOWN: usize = 100_000;
/// FAT drives keep times to 2 seconds, so a copy there reads a little apart.
const CLOSE_TICKS: u64 = 2 * 10_000_000;

/// One side of a pair: where it is, and its size and time in FILETIME ticks.
#[derive(Clone, Debug)]
pub struct Side {
    pub path: PathBuf,
    pub size: u64,
    pub modified: u64,
    /// Its content is in the cloud, where reading it would fetch it.
    pub cloud: bool,
}

/// What sets two folders apart.
#[derive(Clone, Debug, PartialEq)]
pub struct Insides {
    pub mark: Mark,
    /// The files and folders under them that differ, lean one way or are on one side only.
    pub count: u32,
    /// The first few of those, by their path inside the folder.
    pub names: Vec<String>,
}

/// A pair a mark waits on: two folders to walk, or two files to read.
#[derive(Debug)]
pub struct Pair {
    pub mine: Side,
    pub theirs: Side,
    pub folder: bool,
}

/// Two folders, whether by content, and what the walk showed of what is hidden.
type Key = (String, String, bool, Sight);
type Known<K, V> = Mutex<Option<HashMap<K, V>>>;
/// Folder pairs walked already, with the folders' times then. A folder's time changes when
/// something right inside it does.
// ponytail: a change deeper down leaves a folder's time be, so its mark holds until compare is
// turned off and on again, which forgets them all.
static FOLDERS: Known<Key, (u64, u64, Insides)> = Mutex::new(None);
/// File pairs read already, with their sizes and times then: the same content or not, or None
/// for a pair that couldn't be read.
static CONTENTS: Known<(String, String), ([u64; 4], Option<bool>)> = Mutex::new(None);
/// The latest round of each pair of panes, so an older one stops. Pairs compare on their own.
static ROUNDS: Mutex<Option<HashMap<(u32, u32), u64>>> = Mutex::new(None);
static TICKETS: AtomicU64 = AtomicU64::new(0);

fn lower(path: &Path) -> String {
    path.to_string_lossy().to_lowercase()
}

/// How two files of the same name stand: by time, then by size. With `content`, files alike in
/// size are read: the same content is Same whatever the times, and other content leans by time or
/// Differs. `same` says whether the content is the same, Some(None) when it can't be read, or None
/// while not known yet, which leaves the mark Pending.
fn lean(mine: &Side, theirs: &Side, content: bool, same: impl FnOnce() -> Option<Option<bool>>) -> Mark {
    let apart = mine.modified.abs_diff(theirs.modified) > CLOSE_TICKS;
    let by_time = if apart && mine.modified > theirs.modified {
        Mark::Newer
    } else if apart {
        Mark::Older
    } else if mine.size != theirs.size {
        Mark::Differs
    } else {
        Mark::Same
    };
    if !content || mine.size != theirs.size || mine.cloud || theirs.cloud {
        return by_time;
    }
    match same() {
        Some(Some(true)) => Mark::Same,
        Some(Some(false)) if by_time == Mark::Same => Mark::Differs,
        Some(_) => by_time,
        None => Mark::Pending,
    }
}

/// How two files stand, from what is known of their content.
pub fn files(mine: &Side, theirs: &Side, content: bool) -> Mark {
    lean(mine, theirs, content, || {
        let known = CONTENTS.lock().unwrap_or_else(PoisonError::into_inner);
        let (stamps, same) = known.as_ref()?.get(&(lower(&mine.path), lower(&theirs.path)))?;
        (*stamps == [mine.size, mine.modified, theirs.size, theirs.modified]).then_some(*same)
    })
}

/// What two folders were found to hold, if walked with `sight` since either changed right inside.
pub fn folders(mine: &Side, theirs: &Side, content: bool, sight: Sight) -> Option<Insides> {
    let known = FOLDERS.lock().unwrap_or_else(PoisonError::into_inner);
    let (a, b, insides) = known.as_ref()?.get(&(lower(&mine.path), lower(&theirs.path), content, sight))?;
    (*a == mine.modified && *b == theirs.modified).then(|| insides.clone())
}

/// The two panes' ids, in either order.
fn panes(one: u32, two: u32) -> (u32, u32) {
    (one.min(two), one.max(two))
}

/// Forgets every folder pair walked, as a compare ended: a change deep down that left the
/// folders' own times be shows once compare is turned on again.
pub fn forget_folders() {
    FOLDERS.lock().unwrap_or_else(PoisonError::into_inner).take();
}

/// Starts a round for two panes, which stops any older one of theirs.
pub fn round(one: u32, two: u32) -> u64 {
    let ticket = TICKETS.fetch_add(1, SeqCst) + 1;
    ROUNDS.lock().unwrap_or_else(PoisonError::into_inner).get_or_insert_default().insert(panes(one, two), ticket);
    ticket
}

/// Works through `pairs` for a while, learning what the marks of panes `one` and `two` wait on,
/// and says how many it settled: none once a newer round of theirs has taken over.
pub fn settle(pairs: Vec<Pair>, content: bool, sight: Sight, (one, two): (u32, u32), round: u64) -> usize {
    let started = Instant::now();
    let key = panes(one, two);
    let live = || ROUNDS.lock().unwrap_or_else(PoisonError::into_inner).as_ref().and_then(|rounds| rounds.get(&key)) == Some(&round);
    let lane = LANES - (key.0.wrapping_mul(31) ^ key.1) % 0x10000;
    let mut settled = 0;
    for pair in pairs {
        if !live() || started.elapsed() > ROUND {
            break;
        }
        let (mine, theirs) = (lower(&pair.mine.path), lower(&pair.theirs.path));
        if pair.folder {
            let walked = walk(&pair.mine.path, &pair.theirs.path, content, sight, lane, &live);
            // A checksum a newer round cut short reads as no content at all.
            let Some(insides) = walked.filter(|_| live()) else { break };
            let mirrored = Insides { mark: mirror(insides.mark), ..insides.clone() };
            let mut known = FOLDERS.lock().unwrap_or_else(PoisonError::into_inner);
            let known = known.get_or_insert_default();
            if known.len() > MOST_KNOWN {
                known.clear();
            }
            known.insert((mine.clone(), theirs.clone(), content, sight), (pair.mine.modified, pair.theirs.modified, insides));
            known.insert((theirs, mine, content, sight), (pair.theirs.modified, pair.mine.modified, mirrored));
        } else {
            let same = same_content(&pair.mine, &pair.theirs, lane);
            if !live() {
                break;
            }
            let mut known = CONTENTS.lock().unwrap_or_else(PoisonError::into_inner);
            let known = known.get_or_insert_default();
            if known.len() > MOST_KNOWN {
                known.clear();
            }
            let (a, b) = (&pair.mine, &pair.theirs);
            known.insert((mine.clone(), theirs.clone()), ([a.size, a.modified, b.size, b.modified], same));
            known.insert((theirs, mine), ([b.size, b.modified, a.size, a.modified], same));
        }
        settled += 1;
    }
    settled
}

/// How the other side of a pair stands against this one.
fn mirror(mark: Mark) -> Mark {
    match mark {
        Mark::Newer => Mark::Older,
        Mark::Older => Mark::Newer,
        mark => mark,
    }
}

/// Whether two files hold the same bytes, or None when either can't be read.
fn same_content(mine: &Side, theirs: &Side, lane: u32) -> Option<bool> {
    let sum = |side: &Side| preview::hash(&side.path, "sha256", lane).ok().flatten();
    Some(sum(mine)? == sum(theirs)?)
}

/// An entry of a folder walked, by its name in lowercase.
struct Item {
    name: String,
    side: Side,
    dir: bool,
    link: bool,
}

/// What `sight` shows right inside `folder`, a folder inside an archive too. None when it can't be
/// read, which no compare can call the same as anything.
fn listed(folder: &Path, sight: Sight) -> Option<HashMap<String, Item>> {
    let mut items = HashMap::new();
    if let Some(zip) = zipped::opened(folder) {
        if zip.failed.is_some() {
            return None;
        }
        let (nodes, locked) = zipped::list(&zip.archive, &zip.inner, false).ok()?;
        // An archive whose names are locked lists nothing it could be told by.
        if locked && nodes.is_empty() {
            return None;
        }
        for node in nodes {
            let side = Side { path: folder.join(&node.name), size: node.size, modified: node.modified, cloud: false };
            items.insert(node.name.to_lowercase(), Item { name: node.name, side, dir: node.folder, link: false });
        }
        return Some(items);
    }
    sys::each_entry(&sys::extended(&folder.join("*")), |data| {
        let Some(entry) = Entry::from_find_data(data) else { return };
        if !sight.shows(&entry) {
            return;
        }
        let stat = Stat::from_find_data(data);
        let name = entry.file_name().to_string_lossy().into_owned();
        let side = Side { path: folder.join(&name), size: entry.size(), modified: entry.modified(), cloud: entry.is_cloud() };
        items.insert(name.to_lowercase(), Item { name, side, dir: entry.is_dir(), link: stat.is_link() });
    })
    .ok()?;
    Some(items)
}

/// Everything under two folders, side by side. Only on this side reads as newer and only on that
/// side as older, as Copy over would see it: what all leans one way makes the folder lean that way.
/// Links to folders aren't walked into, and a folder that can't be read on either side leaves no
/// mark. None once `live` says to stop.
fn walk(mine: &Path, theirs: &Path, content: bool, sight: Sight, lane: u32, live: &dyn Fn() -> bool) -> Option<Insides> {
    let (mut newer, mut older, mut count, mut names) = (false, false, 0, Vec::new());
    let mut note = |inside: &Path, mark: Mark| {
        match mark {
            Mark::Same | Mark::None | Mark::Pending => return,
            Mark::Newer | Mark::Only => newer = true,
            Mark::Older => older = true,
            Mark::Differs => (newer, older) = (true, true),
        }
        count += 1;
        if names.len() < MOST_NAMES {
            names.push(inside.to_string_lossy().into_owned());
        }
    };
    let mut seen = 0;
    let mut below = vec![PathBuf::new()];
    while let Some(relative) = below.pop() {
        if !live() {
            return None;
        }
        let unknown = Insides { mark: Mark::None, count: 0, names: Vec::new() };
        let (Some(a), Some(b)) = (listed(&mine.join(&relative), sight), listed(&theirs.join(&relative), sight)) else {
            return Some(unknown);
        };
        seen += a.len() + b.len();
        if seen > MOST_ENTRIES {
            return Some(unknown);
        }
        let mut sorted: Vec<(&String, &Item)> = a.iter().collect();
        sorted.sort_by(|x, y| x.0.cmp(y.0));
        for (key, x) in sorted {
            let inside = relative.join(&x.name);
            match b.get(key) {
                None => note(&inside, Mark::Only),
                Some(y) if x.dir != y.dir => note(&inside, Mark::Differs),
                Some(y) if x.dir => {
                    if !x.link && !y.link {
                        below.push(inside);
                    }
                }
                Some(y) => note(&inside, lean(&x.side, &y.side, content, || Some(same_content(&x.side, &y.side, lane)))),
            }
        }
        for (key, y) in &b {
            if !a.contains_key(key) {
                note(&relative.join(&y.name), Mark::Older);
            }
        }
    }
    let mark = match (newer, older) {
        (false, false) => Mark::Same,
        (true, false) => Mark::Newer,
        (false, true) => Mark::Older,
        (true, true) => Mark::Differs,
    };
    Some(Insides { mark, count, names })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn side(path: &str, size: u64, seconds: u64) -> Side {
        Side { path: path.into(), size, modified: seconds * 10_000_000, cloud: false }
    }

    #[test]
    fn files_lean_by_time_then_size_and_by_content_when_asked() {
        let (a, b) = (side("x:/a", 3, 100), side("x:/b", 3, 101));
        assert_eq!(lean(&a, &b, false, || None), Mark::Same, "a second apart is the same time");
        assert_eq!(lean(&side("x:/a", 3, 200), &b, false, || None), Mark::Newer);
        assert_eq!(lean(&side("x:/a", 4, 100), &b, false, || None), Mark::Differs);
        assert_eq!(lean(&a, &b, true, || None), Mark::Pending, "content not read yet");
        assert_eq!(lean(&a, &b, true, || Some(Some(false))), Mark::Differs);
        assert_eq!(lean(&side("x:/a", 3, 200), &b, true, || Some(Some(true))), Mark::Same, "same bytes, whatever the time");
        assert_eq!(lean(&a, &b, true, || Some(None)), Mark::Same, "unreadable falls back on time and size");
        assert_eq!(mirror(Mark::Newer), Mark::Older);
    }

    #[test]
    fn a_folder_that_cant_be_read_is_never_the_same_and_a_walk_is_forgotten_when_compare_ends() {
        let root = std::env::temp_dir().join(format!("perli-compare-{}", std::process::id()));
        let (mine, empty) = (root.join("mine"), root.join("empty"));
        std::fs::create_dir_all(mine.join("deep")).unwrap();
        std::fs::create_dir_all(&empty).unwrap();
        std::fs::write(mine.join("deep").join("a.txt"), b"a").unwrap();
        let sight = Sight::default();
        let always = || true;
        let missing = root.join("missing");
        assert_eq!(walk(&missing, &empty, false, sight, LANES, &always).unwrap().mark, Mark::None, "unreadable is not empty");
        assert_eq!(walk(&missing, &root.join("gone"), false, sight, LANES, &always).unwrap().mark, Mark::None);
        assert_eq!(walk(&mine, &empty, false, sight, LANES, &always).unwrap().mark, Mark::Newer);

        let (a, b) = (side(mine.to_str().unwrap(), 0, 1), side(empty.to_str().unwrap(), 0, 1));
        let round = round(900, 901);
        assert_eq!(settle(vec![Pair { mine: a.clone(), theirs: b.clone(), folder: true }], false, sight, (900, 901), round), 1);
        assert!(folders(&a, &b, false, sight).is_some());
        assert!(folders(&a, &b, false, Sight { hidden: true, system: false }).is_none(), "walked with other sight");
        forget_folders();
        assert!(folders(&a, &b, false, sight).is_none(), "forgotten once compare ends");
        let _ = std::fs::remove_dir_all(&root);
    }
}
