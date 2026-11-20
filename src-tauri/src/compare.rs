//! Two folders compared by everything under them, and two files by their content, for the marks of
//! panes compared side by side. What is learned is kept, so stepping in and back again costs nothing.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering::SeqCst};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use crate::folder::{Entry, Mark, Sight};
use crate::ops::sys::{self, Stat};
use crate::{preview, zipped};

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
/// something right inside it does, and `freshen` walks them again now and then for a change
/// deeper down. Turning compare off forgets them all.
static FOLDERS: Known<Key, (u64, u64, Insides)> = Mutex::new(None);
/// Walks a round's time ran out on, with the folders' times they started at, for the next round
/// to carry on. However big the folders, the marks never wait on one long walk.
static WALKS: Known<Key, ([u64; 2], Walk)> = Mutex::new(None);
/// Walks again of folder pairs already known, which `freshen` carries from round to round.
static REWALKS: Known<Key, Walk> = Mutex::new(None);
/// Which shown pair `freshen` looks at next.
static NEXT_FRESH: AtomicUsize = AtomicUsize::new(0);
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

/// Forgets every folder pair walked or being walked, as a compare ended: a change deep down that
/// left the folders' own times be shows once compare is turned on again.
pub fn forget_folders() {
    FOLDERS.lock().unwrap_or_else(PoisonError::into_inner).take();
    WALKS.lock().unwrap_or_else(PoisonError::into_inner).take();
    REWALKS.lock().unwrap_or_else(PoisonError::into_inner).take();
}

/// Starts a round for two panes, which stops any older one of theirs.
pub fn round(one: u32, two: u32) -> u64 {
    let ticket = TICKETS.fetch_add(1, SeqCst) + 1;
    ROUNDS.lock().unwrap_or_else(PoisonError::into_inner).get_or_insert_default().insert(panes(one, two), ticket);
    ticket
}

/// Works through `pairs` for a while, learning what the marks of panes `one` and `two` wait on,
/// and says how many it settled: none once a newer round of theirs has taken over.
pub fn settle(mut pairs: Vec<Pair>, content: bool, sight: Sight, (one, two): (u32, u32), round: u64) -> usize {
    let started = Instant::now();
    let key = panes(one, two);
    let live = || ROUNDS.lock().unwrap_or_else(PoisonError::into_inner).as_ref().and_then(|rounds| rounds.get(&key)) == Some(&round);
    let lane = LANES - (key.0.wrapping_mul(31) ^ key.1) % 0x10000;
    let walk_key = |pair: &Pair| (lower(&pair.mine.path), lower(&pair.theirs.path), content, sight);
    // A walk carried over from an earlier round goes last, so the pairs around it settle first.
    if let Some(walks) = WALKS.lock().unwrap_or_else(PoisonError::into_inner).as_ref() {
        pairs.sort_by_key(|pair| pair.folder && walks.contains_key(&walk_key(pair)));
    }
    let mut settled = 0;
    for pair in pairs {
        if !live() || started.elapsed() > ROUND {
            break;
        }
        let (mine, theirs) = (lower(&pair.mine.path), lower(&pair.theirs.path));
        if pair.folder {
            let times = [pair.mine.modified, pair.theirs.modified];
            let carried = WALKS.lock().unwrap_or_else(PoisonError::into_inner).get_or_insert_default().remove(&walk_key(&pair));
            let mut walk = carried.filter(|(at, _)| *at == times).map_or_else(Walk::new, |(_, walk)| walk);
            // A checksum a newer round cut short reads as no content at all.
            match walk.go(&pair.mine.path, &pair.theirs.path, content, sight, lane, &live, started) {
                Some(true) if live() => {}
                Some(false) => {
                    WALKS.lock().unwrap_or_else(PoisonError::into_inner).get_or_insert_default().insert(walk_key(&pair), (times, walk));
                    // Further along, so the marks ask again.
                    settled += 1;
                    break;
                }
                _ => break,
            }
            learn(mine, theirs, content, sight, times, walk.insides());
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

/// Keeps what two folders were found to hold, both ways round.
fn learn(mine: String, theirs: String, content: bool, sight: Sight, [a, b]: [u64; 2], insides: Insides) {
    let mirrored = Insides { mark: mirror(insides.mark), ..insides.clone() };
    let mut known = FOLDERS.lock().unwrap_or_else(PoisonError::into_inner);
    let known = known.get_or_insert_default();
    if known.len() > MOST_KNOWN {
        known.clear();
    }
    known.insert((mine.clone(), theirs.clone(), content, sight), (a, b, insides));
    known.insert((theirs, mine, content, sight), (b, a, mirrored));
}

/// Walks shown folder pairs already known again, for a while, as a folder's time misses what
/// changes deeper down, such as a file edited in place. What is known holds until a walk is done,
/// so no mark goes back to waiting. How many pairs it found changed, for the marks to be asked for
/// again. A round of `settle` takes over from it.
pub fn freshen(pairs: Vec<Pair>, content: bool, sight: Sight, (one, two): (u32, u32), round: u64) -> usize {
    let started = Instant::now();
    let key = panes(one, two);
    let live = || ROUNDS.lock().unwrap_or_else(PoisonError::into_inner).as_ref().and_then(|rounds| rounds.get(&key)) == Some(&round);
    let lane = LANES - (key.0.wrapping_mul(31) ^ key.1) % 0x10000;
    let pairs: Vec<Pair> = pairs.into_iter().filter(|pair| pair.folder && folders(&pair.mine, &pair.theirs, content, sight).is_some()).collect();
    let (count, first) = (pairs.len(), NEXT_FRESH.load(SeqCst));
    let mut changed = 0;
    for at in (0..count).map(|step| (first + step) % count.max(1)) {
        if !live() || started.elapsed() > ROUND {
            break;
        }
        let pair = &pairs[at];
        let (mine, theirs) = (lower(&pair.mine.path), lower(&pair.theirs.path));
        let walk_key = (mine.clone(), theirs.clone(), content, sight);
        let carried = REWALKS.lock().unwrap_or_else(PoisonError::into_inner).get_or_insert_default().remove(&walk_key);
        let mut walk = carried.unwrap_or_else(Walk::new);
        match walk.go(&pair.mine.path, &pair.theirs.path, content, sight, lane, &live, started) {
            Some(true) if live() => {}
            Some(false) => {
                REWALKS.lock().unwrap_or_else(PoisonError::into_inner).get_or_insert_default().insert(walk_key, walk);
                NEXT_FRESH.store(at, SeqCst);
                return changed;
            }
            _ => return changed,
        }
        NEXT_FRESH.store(at + 1, SeqCst);
        let insides = walk.insides();
        if folders(&pair.mine, &pair.theirs, content, sight).is_some_and(|known| known != insides) {
            learn(mine, theirs, content, sight, [pair.mine.modified, pair.theirs.modified], insides);
            changed += 1;
        }
    }
    changed
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

/// Everything under two folders, side by side, walked a round at a time. Only on this side reads
/// as newer and only on that side as older, as Copy over would see it: what all leans one way makes
/// the folder lean that way. Links to folders aren't walked into, and a folder that can't be read on
/// either side leaves no mark.
struct Walk {
    newer: bool,
    older: bool,
    /// A folder on the way couldn't be read.
    unknown: bool,
    count: u32,
    names: Vec<String>,
    /// Folders inside, by their path from the two, still to walk.
    todo: Vec<PathBuf>,
}

impl Walk {
    fn new() -> Self {
        Self { newer: false, older: false, unknown: false, count: 0, names: Vec::new(), todo: vec![PathBuf::new()] }
    }

    fn note(&mut self, inside: &Path, mark: Mark) {
        match mark {
            Mark::Same | Mark::None | Mark::Pending => return,
            Mark::Newer | Mark::Only => self.newer = true,
            Mark::Older => self.older = true,
            Mark::Differs => (self.newer, self.older) = (true, true),
        }
        self.count += 1;
        if self.names.len() < MOST_NAMES {
            self.names.push(inside.to_string_lossy().into_owned());
        }
    }

    /// Walks on: true once done, false when the round that began at `started` is up, which always
    /// leaves one folder further along. None once `live` says to stop.
    #[allow(clippy::too_many_arguments)]
    fn go(&mut self, mine: &Path, theirs: &Path, content: bool, sight: Sight, lane: u32, live: &dyn Fn() -> bool, started: Instant) -> Option<bool> {
        let mut first = true;
        while let Some(relative) = self.todo.pop() {
            if !live() {
                return None;
            }
            if !first && started.elapsed() > ROUND {
                self.todo.push(relative);
                return Some(false);
            }
            first = false;
            let (Some(a), Some(b)) = (listed(&mine.join(&relative), sight), listed(&theirs.join(&relative), sight)) else {
                self.unknown = true;
                self.todo.clear();
                return Some(true);
            };
            let mut sorted: Vec<(&String, &Item)> = a.iter().collect();
            sorted.sort_by(|x, y| x.0.cmp(y.0));
            for (key, x) in sorted {
                let inside = relative.join(&x.name);
                match b.get(key) {
                    None => self.note(&inside, Mark::Only),
                    Some(y) if x.dir != y.dir => self.note(&inside, Mark::Differs),
                    Some(y) if x.dir => {
                        if !x.link && !y.link {
                            self.todo.push(inside);
                        }
                    }
                    Some(y) => self.note(&inside, lean(&x.side, &y.side, content, || Some(same_content(&x.side, &y.side, lane)))),
                }
            }
            for (key, y) in &b {
                if !a.contains_key(key) {
                    self.note(&relative.join(&y.name), Mark::Older);
                }
            }
        }
        Some(true)
    }

    fn insides(self) -> Insides {
        if self.unknown {
            return Insides { mark: Mark::None, count: 0, names: Vec::new() };
        }
        let mark = match (self.newer, self.older) {
            (false, false) => Mark::Same,
            (true, false) => Mark::Newer,
            (false, true) => Mark::Older,
            (true, true) => Mark::Differs,
        };
        Insides { mark, count: self.count, names: self.names }
    }
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
    fn a_walk_whose_round_is_up_carries_on_a_folder_at_a_time() {
        let root = std::env::temp_dir().join(format!("perli-walk-{}", std::process::id()));
        for side in ["a", "b"] {
            for folder in ["one", "one/deep", "two"] {
                std::fs::create_dir_all(root.join(side).join(folder)).unwrap();
            }
        }
        std::fs::write(root.join("a").join(r"one\deep\new.txt"), "x").unwrap();
        let (a, b) = (root.join("a"), root.join("b"));
        let live = || true;
        let long_ago = Instant::now().checked_sub(ROUND * 2).unwrap();
        let mut walk = Walk::new();
        let mut rounds = 1;
        while walk.go(&a, &b, false, Sight::default(), LANES, &live, long_ago) == Some(false) {
            rounds += 1;
        }
        assert_eq!(rounds, 4, "the top, two, one and deep, each in a round of its own");
        let insides = walk.insides();
        assert_eq!((insides.mark, insides.count, insides.names), (Mark::Newer, 1, vec![r"one\deep\new.txt".to_string()]));
        let mut whole = Walk::new();
        assert_eq!(whole.go(&a, &b, false, Sight::default(), LANES, &live, Instant::now()), Some(true));
        assert_eq!(whole.insides().count, 1);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_folder_that_cant_be_read_is_never_the_same_and_a_walk_is_forgotten_when_compare_ends() {
        let root = std::env::temp_dir().join(format!("perli-compare-{}", std::process::id()));
        let (mine, empty) = (root.join("mine"), root.join("empty"));
        std::fs::create_dir_all(mine.join("deep")).unwrap();
        std::fs::create_dir_all(&empty).unwrap();
        std::fs::write(mine.join("deep").join("a.txt"), b"a").unwrap();
        let sight = Sight::default();
        let whole = |a: &Path, b: &Path| {
            let mut walk = Walk::new();
            assert_eq!(walk.go(a, b, false, sight, LANES, &|| true, Instant::now()), Some(true));
            walk.insides().mark
        };
        let missing = root.join("missing");
        assert_eq!(whole(&missing, &empty), Mark::None, "unreadable is not empty");
        assert_eq!(whole(&missing, &root.join("gone")), Mark::None);
        assert_eq!(whole(&mine, &empty), Mark::Newer);

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
