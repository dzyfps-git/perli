//! Finds files under a folder. The folder's own entries match loosely and arrive at once. Entries
//! further down match the exact text and arrive as a thread of their own finds them, added after
//! the rows on screen so that none of those move.

use std::cmp::Reverse;
use std::collections::{HashMap, VecDeque};
use std::ffi::OsString;
use std::mem;
use std::os::windows::ffi::OsStringExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use windows::core::Result;

#[cfg(test)]
use crate::folder::Filter;
use crate::folder::{self, Entry, Found, GroupBy, Listing, Order, Sight, SortKey};
use crate::network;
use crate::ops::sys::{self, Stat};
use crate::tags;

/// How many rows past the user the walk keeps ready. Scrolling never catches up, so the list
/// feels endless, while a search nobody scrolls goes no further than this.
const AHEAD: usize = 100_000;
const REPORT_GAP: Duration = Duration::from_millis(200);

const LETTER: i32 = 1;
const IN_A_ROW: i32 = 8;
const WORD_START: i32 = 6;
const SKIPPED_COST: i32 = 1;
/// Stands for every file under a folder, which makes a flat view of it. No file name can hold it.
const EVERY_FILE: &str = "*";
/// Starts a search for the files that have a tag, by its name. No file name can hold a colon.
const TAGGED: &str = "tag:";
/// Past this a file takes too long to read for a search that reads every one it passes.
const INSIDE_MAX: u64 = 2 * 1024 * 1024;
/// Files whose content is text a search inside files may read.
const TEXT_TYPES: &[&str] = &[
    "txt", "md", "markdown", "log", "csv", "tsv", "json", "jsonc", "xml", "yaml", "yml", "toml", "ini", "cfg",
    "conf", "html", "htm", "css", "scss", "js", "mjs", "cjs", "ts", "tsx", "jsx", "rs", "py", "go", "c", "h",
    "cpp", "hpp", "cs", "java", "kt", "swift", "rb", "php", "lua", "sql", "sh", "bat", "cmd", "ps1", "srt",
    "vtt", "tex", "rst", "nfo", "svg", "vue", "svelte", "env", "properties",
];

// ponytail: each report copies every row found so far, so reports thin out as rows grow. Rows
// that share their memory would lift this.
fn report_gap(rows: usize) -> Duration {
    REPORT_GAP * (1 + rows / AHEAD) as u32
}

fn lower(letter: char) -> char {
    letter.to_lowercase().next().unwrap_or(letter)
}

/// What the user typed.
struct Query {
    text: String,
    letters: Vec<char>,
    every_file: bool,
    /// Text files whose content holds the text fit too.
    inside: bool,
    /// How many parts the path of the deepest folder read may have.
    deepest: usize,
}

impl Query {
    fn new(text: &str) -> Self {
        Self {
            text: text.to_lowercase(),
            letters: text.chars().map(lower).collect(),
            every_file: text == EVERY_FILE,
            inside: false,
            deepest: usize::MAX,
        }
    }

    fn reaches(&self, folder: &Path) -> bool {
        folder.components().count() <= self.deepest
    }

    fn is_in(&self, entry: &Entry, folder: &Path) -> bool {
        if self.every_file {
            return !entry.is_dir();
        }
        String::from_utf16_lossy(entry.name()).to_lowercase().contains(&self.text) || self.holds(entry, folder)
    }

    /// How well an entry of the searched folder itself fits. A file that only holds the text
    /// comes after every name that fits.
    fn fit_of(&self, entry: &Entry, folder: &Path) -> Option<i32> {
        if self.every_file {
            return (!entry.is_dir()).then_some(0);
        }
        self.fit(entry.name()).or_else(|| self.holds(entry, folder).then_some(i32::MIN))
    }

    /// Whether a small text file's content holds the text, in any case. A file in the cloud
    /// stays there.
    // ponytail: reads UTF-8 only, so UTF-16 text never fits. A BOM check would add it.
    fn holds(&self, entry: &Entry, folder: &Path) -> bool {
        self.inside
            && !entry.is_dir()
            && !entry.is_cloud()
            && entry.size() <= INSIDE_MAX
            && TEXT_TYPES.contains(&entry.extension_text().as_str())
            && std::fs::read(folder.join(entry.file_name()))
                .is_ok_and(|bytes| String::from_utf8_lossy(&bytes).to_lowercase().contains(&self.text))
    }

    /// How well a name fits if its letters match from `start`, which holds the query's first.
    fn fit_from(&self, name: &[char], lowered: &[char], start: usize) -> Option<i32> {
        let (mut at, mut fit) = (start, 0);
        let mut last: Option<usize> = None;
        for &letter in &self.letters {
            let found = at + lowered[at..].iter().position(|&other| other == letter)?;
            fit += LETTER;
            fit += match last {
                Some(last) if last + 1 == found => IN_A_ROW,
                Some(last) => -((found - last) as i32) * SKIPPED_COST,
                None => 0,
            };
            let begins_word = found == 0 || {
                let (before, here) = (name[found - 1], name[found]);
                !before.is_alphanumeric() || (before.is_lowercase() && here.is_uppercase())
            };
            if begins_word {
                fit += WORD_START;
            }
            last = Some(found);
            at = found + 1;
        }
        Some(fit)
    }

    /// How well `name` fits, if it holds the query's letters in order. Letters in a row and
    /// letters that start a word count most.
    fn fit(&self, name: &[u16]) -> Option<i32> {
        let name: Vec<char> = String::from_utf16_lossy(name).chars().collect();
        let lowered: Vec<char> = name.iter().copied().map(lower).collect();
        let first = *self.letters.first()?;
        let starts = (0..lowered.len()).filter(|&at| lowered[at] == first);
        starts.filter_map(|start| self.fit_from(&name, &lowered, start)).max()
    }
}

/// The positions of the `names` that fit `query`, best first, ties in their given order.
pub fn rank(query: &str, names: &[String]) -> Vec<u32> {
    let query = Query::new(query);
    let mut fits: Vec<(i32, u32)> = (0..names.len() as u32)
        .filter_map(|index| {
            let name: Vec<u16> = names[index as usize].encode_utf16().collect();
            Some((query.fit(&name)?, index))
        })
        .collect();
    fits.sort_by_key(|&(fit, _)| Reverse(fit));
    fits.into_iter().map(|(_, index)| index).collect()
}

/// Calls `visit` for each entry of `folder`, and adds the folders to walk next to `below`. A link
/// could lead back around, and hidden folders hold what the user chose not to see.
fn read_folder(
    folder: &Path,
    sight: Sight,
    below: &mut VecDeque<PathBuf>,
    mut visit: impl FnMut(Entry),
) -> Result<()> {
    let mut take = |entry: Entry, is_folder: bool| {
        if is_folder && sight.shows(&entry) {
            below.push_back(folder.join(OsString::from_wide(entry.name())));
        }
        visit(entry);
    };
    if let Some(server) = folder.to_str().filter(|path| network::is_server(path)) {
        for share in folder::read_shares(server)? {
            take(share, true);
        }
        return Ok(());
    }
    sys::each_entry(&sys::extended(&folder.join("*")), |data| {
        if let Some(entry) = Entry::from_find_data(data) {
            take(entry, Stat::from_find_data(data).is_folder());
        }
    })
}

/// The folder's own matches, best first, and the folders under it.
fn read_top(folder: &Path, query: &Query, sight: Sight) -> Result<(Found, VecDeque<PathBuf>)> {
    let mut below = VecDeque::new();
    let mut fits = Vec::new();
    read_folder(folder, sight, &mut below, |entry| {
        if let Some(fit) = query.fit_of(&entry, folder) {
            fits.push((fit, entry));
        }
    })?;
    fits.sort_by_key(|(fit, _)| Reverse(*fit));

    let location: Arc<[u16]> = folder::null_terminated(folder).into();
    let mut found = Found::default();
    for (_, entry) in fits {
        found.push(entry, location.clone());
    }
    Ok((found, below))
}

/// Where a search's walk has got, as the UI hears it.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Walk {
    /// More rows are on the way.
    Going,
    /// It has rows to spare, and goes on once the user scrolls closer to them.
    Waiting,
    /// It has seen everything.
    Done,
}

struct Search {
    found: Mutex<Found>,
    stopped: AtomicBool,
    /// How many rows in sight the walk may hold before it waits.
    room: AtomicUsize,
    /// Wakes a waiting walk.
    changed: Condvar,
}

impl Search {
    fn new(found: Found, room: usize) -> Self {
        Self {
            found: Mutex::new(found),
            stopped: AtomicBool::new(false),
            room: AtomicUsize::new(room),
            changed: Condvar::new(),
        }
    }

    fn found(&self) -> MutexGuard<'_, Found> {
        self.found.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }

    fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.wake();
    }

    fn room(&self) -> usize {
        self.room.load(Ordering::SeqCst)
    }

    fn make_room(&self, room: usize) {
        if self.room.fetch_max(room, Ordering::SeqCst) < room {
            self.wake();
        }
    }

    /// A walk about to wait holds the lock until it does, so it can't miss this.
    fn wake(&self) {
        drop(self.found());
        self.changed.notify_all();
    }

    /// Holds the walk until there is room again or the search stops.
    fn wait_for_room(&self, in_sight: usize) {
        let full = |_: &mut Found| in_sight >= self.room() && !self.stopped();
        drop(self.changed.wait_while(self.found(), full).unwrap_or_else(PoisonError::into_inner));
    }

    /// Puts what the walk holds on show. The first rows of a quiet walk replace the old ones.
    fn show(&self, rows: &mut Found, quiet: &mut bool) {
        if mem::take(quiet) {
            *self.found() = mem::take(rows);
        } else {
            self.found().append(rows);
        }
    }

    /// Walks everything in `below`, nearest first. `rows` is what a quiet search starts from,
    /// because it only shows its rows once it has as many as it will wait with.
    fn walk(
        &self,
        query: &Query,
        mut rows: Found,
        mut below: VecDeque<PathBuf>,
        sight: Sight,
        mut quiet: bool,
        report: impl Fn(Walk),
    ) {
        let mut reported = Instant::now();
        let mut in_sight = if quiet { rows.in_sight(sight) } else { self.found().in_sight(sight) };
        while let Some(folder) = below.pop_front() {
            if in_sight >= self.room() && !self.stopped() {
                self.show(&mut rows, &mut quiet);
                report(Walk::Waiting);
                self.wait_for_room(in_sight);
            }
            if self.stopped() {
                return;
            }
            if !query.reaches(&folder) {
                continue;
            }
            let location: Arc<[u16]> = folder::null_terminated(&folder).into();
            // A folder that can't be read has nothing to show, which is no reason to stop.
            let _ = read_folder(&folder, sight, &mut below, |entry| {
                if query.is_in(&entry, &folder) {
                    in_sight += usize::from(sight.shows(&entry));
                    rows.push(entry, location.clone());
                }
            });
            if !quiet && !rows.is_empty() && reported.elapsed() >= report_gap(in_sight) {
                self.show(&mut rows, &mut quiet);
                report(Walk::Going);
                reported = Instant::now();
            }
        }
        if self.stopped() {
            return;
        }
        self.show(&mut rows, &mut quiet);
        report(Walk::Done);
    }
}

/// What a view wants from its search.
#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Step {
    /// A new query. The old rows go.
    Start,
    /// The same query again, because files changed. The rows stay until the new ones are all in.
    Again,
    /// The rows found so far.
    Grown,
}

/// How far from the shown folder a search looks.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Scope {
    /// The folder and everything under it.
    #[default]
    Below,
    /// The folder's own entries, and no deeper.
    Folder,
    /// The whole drive the folder is on.
    Drive,
    /// Every drive, the folder's own first.
    Drives,
}

#[derive(Deserialize)]
pub struct Asked {
    pub step: Step,
    pub query: String,
    #[serde(default)]
    pub scope: Scope,
    /// Look in the content of text files as well as at names.
    #[serde(default)]
    pub inside: bool,
    /// How many folders deep to look, where 1 is the folder itself. None is all the way.
    #[serde(default)]
    pub depth: Option<u32>,
}

/// The top of the drive or share `folder` is on.
fn root_of(folder: &Path) -> PathBuf {
    folder.ancestors().last().unwrap_or(folder).to_path_buf()
}

/// Every drive with a letter, but for `own`.
fn other_drives(own: &Path) -> Vec<PathBuf> {
    let letters = unsafe { windows::Win32::Storage::FileSystem::GetLogicalDrives() };
    let roots = (0..26u8).filter(|bit| letters & (1 << bit) != 0).map(|bit| PathBuf::from(format!("{}:\\", char::from(b'A' + bit))));
    roots.filter(|root| !root.as_os_str().eq_ignore_ascii_case(own.as_os_str())).collect()
}

/// True when `path` is `folder` or under it, whatever the case of either.
fn is_under(path: &Path, folder: &Path) -> bool {
    let lowered = |path: &Path| PathBuf::from(path.to_string_lossy().to_lowercase());
    lowered(path).starts_with(lowered(folder))
}

/// The files that have the tag called `name`, as far from `folder` as `scope` reaches. The
/// database of tags knows them all, so no folder is walked.
fn tagged(name: &str, scope: Scope, folder: &Path) -> Found {
    let mut found = Found::default();
    let Some(tag) = tags::named_id(name.trim()) else {
        return found;
    };
    let mut locations = HashMap::<PathBuf, Arc<[u16]>>::new();
    let with_tag = tags::files_with(tag);
    let reached = |parent: &Path| match scope {
        Scope::Drives => true,
        Scope::Drive => is_under(parent, &root_of(folder)),
        Scope::Below => is_under(parent, folder),
        Scope::Folder => is_under(parent, folder) && is_under(folder, parent),
    };
    // A file never seen by a path counts only in a look over every drive.
    let away = |last: &Option<PathBuf>| match last.as_deref().and_then(Path::parent) {
        Some(parent) => reached(parent),
        None => scope == Scope::Drives,
    };
    found.away = with_tag.away.iter().filter(|last| away(last)).count();
    for (path, tags) in with_tag.files {
        let Some(parent) = path.parent() else { continue };
        if !reached(parent) {
            continue;
        }
        let mut entry = None;
        let _ = sys::each_entry(&sys::extended(&path), |data| entry = Entry::from_find_data(data));
        if let Some(entry) = entry {
            let location = locations.entry(parent.to_path_buf()).or_insert_with(|| folder::null_terminated(parent).into());
            found.push_tagged(entry, location.clone(), tags);
        }
    }
    found
}

/// A filter can leave so few rows that scrolling never asks for more. Groups count every row
/// they hold, and a folded one shows none, so scrolling can't ask for those either.
fn needs_every_row(order: &Order) -> bool {
    order.key != SortKey::Found || order.filter.is_active() || order.group_by != GroupBy::None
}

/// The search of each view that has one.
#[derive(Default)]
pub struct Searches(Mutex<HashMap<u32, Arc<Search>>>);

impl Searches {
    fn all(&self) -> MutexGuard<'_, HashMap<u32, Arc<Search>>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn stop(&self, view: u32) {
        if let Some(search) = self.all().remove(&view) {
            search.stop();
        }
    }

    /// The user reached `row`. Room comes in big steps once they near the end of it, because
    /// each step of the walk makes the list read its rows again.
    pub fn reached(&self, view: u32, row: usize) {
        if let Some(search) = self.all().get(&view) {
            if row + AHEAD / 2 > search.room() {
                search.make_room(row + AHEAD);
            }
        }
    }

    /// Any order but found is only right with every row there.
    pub fn arranged(&self, view: u32, order: &Order) {
        if let Some(search) = self.all().get(&view).filter(|_| needs_every_row(order)) {
            search.make_room(usize::MAX);
        }
    }

    /// The rows to show now. `report` hears when more are waiting and how the walk is doing.
    pub fn rows(
        &self,
        view: u32,
        asked: Asked,
        path: &str,
        order: Order,
        report: impl Fn(Walk) + Send + 'static,
    ) -> Result<Listing> {
        let running = self.all().get(&view).cloned();
        if asked.step == Step::Grown {
            let found = running.map_or_else(Found::default, |search| search.found().clone());
            return Ok(Listing::searched(found, order));
        }

        let shown_folder = PathBuf::from(folder::resolve(path)?);
        if let Some(name) = asked.query.strip_prefix(TAGGED) {
            let found = tagged(name, asked.scope, &shown_folder);
            self.stop(view);
            self.all().insert(view, Arc::new(Search::new(found.clone(), usize::MAX)));
            report(Walk::Done);
            return Ok(Listing::searched(found, order));
        }
        let folder = match asked.scope {
            Scope::Drive | Scope::Drives => root_of(&shown_folder),
            Scope::Below | Scope::Folder => shown_folder,
        };
        let deepest = asked.depth.map_or(usize::MAX, |depth| folder.components().count() + depth.max(1) as usize - 1);
        let query = Query { inside: asked.inside, deepest, ..Query::new(&asked.query) };
        let (first, mut below) = read_top(&folder, &query, order.sight())?;
        match asked.scope {
            Scope::Folder => below.clear(),
            Scope::Drives => below.extend(other_drives(&folder)),
            Scope::Below | Scope::Drive => (),
        }
        let quiet = asked.step == Step::Again;
        let kept = running.filter(|_| quiet);
        let room = match &kept {
            _ if needs_every_row(&order) => usize::MAX,
            Some(search) => search.room(),
            None => AHEAD,
        };
        let shown = kept.map_or_else(|| first.clone(), |search| search.found().clone());
        self.stop(view);
        let search = Arc::new(Search::new(shown.clone(), room));
        self.all().insert(view, search.clone());
        let rows = if quiet { first } else { Found::default() };
        let sight = order.sight();
        thread::spawn(move || search.walk(&query, rows, below, sight, quiet, report));
        Ok(Listing::searched(shown, order))
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::process::Command;
    use std::sync::mpsc;

    use super::*;

    const WAIT: Duration = Duration::from_secs(5);

    struct Tree(PathBuf);

    impl Tree {
        fn new(name: &str) -> Self {
            let root = std::env::temp_dir().join(format!("perli-search-{name}-{}", std::process::id()));
            let tree = Self(root);
            tree.file(r"report.txt");
            tree.file(r"other.txt");
            tree.file(r"deep\inner\report final.txt");
            tree.file(r"deep\inner\plain.txt");
            tree.file(r"deep\Report.md");
            tree
        }

        fn file(&self, relative: &str) {
            let path = self.0.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "").unwrap();
        }

        fn path(&self) -> &str {
            self.0.to_str().unwrap()
        }
    }

    impl Drop for Tree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn found_order() -> Order {
        Order { key: SortKey::Found, ..Order::default() }
    }

    #[test]
    fn rank_puts_the_best_fit_first_and_leaves_out_the_rest() {
        let names = ["Show hidden files", "Split view", "Settings", "New tab"].map(String::from);

        let ranked = rank("se", &names);

        assert_eq!(ranked[0], 2);
        assert_eq!(ranked.len(), 3);
        assert_eq!(rank("sv", &names), [1]);
    }

    fn fit(query: &str, name: &str) -> Option<i32> {
        Query::new(query).fit(&name.encode_utf16().collect::<Vec<_>>())
    }

    fn start(searches: &Searches, tree: &Tree, query: &str, order: Order) -> (Listing, mpsc::Receiver<Walk>) {
        let (reports, heard) = mpsc::channel();
        let report = move |done| {
            let _ = reports.send(done);
        };
        let asked = Asked { step: Step::Start, query: query.to_string(), scope: Scope::Below, inside: false, depth: None };
        (searches.rows(1, asked, tree.path(), order, report).unwrap(), heard)
    }

    #[test]
    fn a_search_of_this_folder_only_goes_no_deeper() {
        let tree = Tree::new("scope");
        let searches = Searches::default();
        let (reports, heard) = mpsc::channel();
        let asked = Asked { step: Step::Start, query: "report".to_string(), scope: Scope::Folder, inside: false, depth: None };
        let report = move |walk| {
            let _ = reports.send(walk);
        };
        searches.rows(1, asked, tree.path(), found_order(), report).unwrap();
        wait_until_done(&heard);
        assert_eq!(grown(&searches, &tree, found_order()).len(), 1);
    }

    #[test]
    fn a_flat_view_goes_only_as_deep_as_asked() {
        let tree = Tree::new("depth");
        let searches = Searches::default();
        let deep = |depth| {
            let (reports, heard) = mpsc::channel();
            let asked = Asked { step: Step::Start, query: EVERY_FILE.to_string(), scope: Scope::Below, inside: false, depth };
            let report = move |walk| {
                let _ = reports.send(walk);
            };
            searches.rows(1, asked, tree.path(), found_order(), report).unwrap();
            wait_until_done(&heard);
            grown(&searches, &tree, found_order()).len()
        };

        assert_eq!(deep(Some(1)), 2);
        assert_eq!(deep(Some(2)), 3);
        assert_eq!(deep(None), 5);
    }

    #[test]
    fn a_drive_search_starts_from_the_top_of_the_drive() {
        assert_eq!(root_of(Path::new(r"C:\Users\me\Docs")), Path::new(r"C:\"));
        assert_eq!(root_of(Path::new(r"\\server\share\deep\er")), Path::new(r"\\server\share\"));
        assert!(!other_drives(Path::new(r"c:\")).contains(&PathBuf::from(r"C:\")));
    }

    fn grown(searches: &Searches, tree: &Tree, order: Order) -> Listing {
        let asked = Asked { step: Step::Grown, query: String::new(), scope: Scope::Below, inside: false, depth: None };
        searches.rows(1, asked, tree.path(), order, |_| ()).unwrap()
    }

    fn wait_until_done(heard: &mpsc::Receiver<Walk>) {
        while heard.recv_timeout(WAIT).expect("the search ended") != Walk::Done {}
    }

    /// How the walk stands the next time it is not going.
    fn next_stop(heard: &mpsc::Receiver<Walk>) -> Walk {
        loop {
            let walk = heard.recv_timeout(WAIT).expect("the walk stopped");
            if walk != Walk::Going {
                return walk;
            }
        }
    }

    /// Finds `report` under `tree` on a thread of its own, and a folder at a time.
    fn walk_tree(search: &Arc<Search>, tree: &Tree, quiet: bool) -> mpsc::Receiver<Walk> {
        let (reports, heard) = mpsc::channel();
        let (search, below) = (search.clone(), VecDeque::from([tree.0.clone()]));
        thread::spawn(move || {
            let report = move |walk| {
                let _ = reports.send(walk);
            };
            search.walk(&Query::new("report"), Found::default(), below, Sight::default(), quiet, report);
        });
        heard
    }

    fn found_names(search: &Search) -> Vec<String> {
        names(&Listing::searched(search.found().clone(), found_order()))
    }

    /// One row in each of its folders, on top of the root's `report.txt` and two under `deep`.
    fn tree_of_folders(name: &str) -> Tree {
        let tree = Tree::new(name);
        for folder in ["a", "b", "c"] {
            tree.file(&format!(r"{folder}\report.txt"));
        }
        tree
    }

    fn names(listing: &Listing) -> Vec<String> {
        listing.names(&(0..listing.len() as u32).collect::<Vec<_>>())
    }

    #[test]
    fn a_flat_view_lists_every_file_and_no_folder() {
        let searches = Searches::default();
        let tree = Tree::new("flat");

        let (_, heard) = start(&searches, &tree, "*", found_order());
        heard.recv_timeout(WAIT).unwrap();

        let mut all = names(&grown(&searches, &tree, found_order()));
        all.sort();
        assert_eq!(all, ["Report.md", "other.txt", "plain.txt", "report final.txt", "report.txt"]);
    }

    #[test]
    fn letters_must_all_be_there_in_order() {
        assert!(fit("rprt", "report.txt").is_some());
        assert!(fit("RPRT", "report.txt").is_some());
        assert_eq!(fit("trp", "report"), None);
        assert_eq!(fit("reportx", "report"), None);
    }

    #[test]
    fn letters_in_a_row_and_word_starts_fit_best() {
        assert!(fit("rep", "report") > fit("rep", "r_e_p"));
        assert!(fit("mp", "MyPhoto") > fit("mp", "stamped"));
        assert!(fit("port", "report") < fit("port", "port"));
        assert!(fit("ab", "xa-ab") > fit("ab", "xa-xb"));
    }

    #[test]
    fn the_folder_comes_first_best_fit_on_top_and_rows_below_are_added_after() {
        let tree = Tree::new("rows");
        tree.file("r e p.txt");
        let searches = Searches::default();

        let (first, heard) = start(&searches, &tree, "rep", found_order());
        assert_eq!(names(&first), ["report.txt", "r e p.txt"]);

        wait_until_done(&heard);
        let all = names(&grown(&searches, &tree, found_order()));
        assert_eq!(all[..2], names(&first));
        assert_eq!(all[2..4], ["Report.md", "report final.txt"]);
    }

    #[test]
    fn rows_below_need_the_exact_text() {
        let tree = Tree::new("exact");
        let searches = Searches::default();

        let (first, heard) = start(&searches, &tree, "rprt", found_order());
        assert_eq!(names(&first), ["report.txt"]);

        wait_until_done(&heard);
        assert_eq!(names(&grown(&searches, &tree, found_order())), ["report.txt"]);
    }

    #[test]
    fn each_row_knows_where_it_is() {
        let tree = Tree::new("where");
        tree.file(r"deep\report.txt");
        let searches = Searches::default();

        let (_, heard) = start(&searches, &tree, "report.txt", found_order());
        wait_until_done(&heard);
        let listing = grown(&searches, &tree, found_order());

        let paths = listing.paths(&[0, 1]);
        assert_eq!(paths, [tree.0.join("report.txt"), tree.0.join(r"deep\report.txt")]);
        let keys = listing.keys(&[0, 1]);
        assert_ne!(keys[0], keys[1], "one name in two folders");
        assert_eq!(listing.rows_keyed(&[keys[1].clone()]), [1]);
    }

    #[test]
    fn a_link_is_not_followed_and_a_hidden_folder_waits_to_be_asked() {
        let tree = Tree::new("skip");
        let junction = tree.0.join("loop");
        let made = Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .args([&junction, &tree.0])
            .output()
            .unwrap();
        assert!(made.status.success());
        tree.file(r"secret\report hidden.txt");
        let attributes = Command::new("attrib").arg("+h").arg(tree.0.join("secret")).status();
        assert!(attributes.unwrap().success());
        let searches = Searches::default();

        let (_, heard) = start(&searches, &tree, "report", found_order());
        wait_until_done(&heard);
        let plain = names(&grown(&searches, &tree, found_order()));
        assert_eq!(plain.iter().filter(|name| name.starts_with("report.txt")).count(), 1);
        assert!(!plain.contains(&"report hidden.txt".to_string()));

        let shown = Order { show_hidden: true, ..found_order() };
        let (_, heard) = start(&searches, &tree, "report", shown.clone());
        wait_until_done(&heard);
        assert!(names(&grown(&searches, &tree, shown)).contains(&"report hidden.txt".to_string()));

        fs::remove_dir(junction).unwrap();
    }

    #[test]
    fn searching_again_keeps_the_rows_until_the_new_ones_are_in() {
        let tree = Tree::new("again");
        let searches = Searches::default();
        let (_, heard) = start(&searches, &tree, "plain", found_order());
        wait_until_done(&heard);
        assert_eq!(names(&grown(&searches, &tree, found_order())), ["plain.txt"]);

        fs::rename(tree.0.join(r"deep\inner\plain.txt"), tree.0.join(r"deep\inner\plainer.txt")).unwrap();
        let (reports, heard) = mpsc::channel();
        let asked = Asked { step: Step::Again, query: "plain".to_string(), scope: Scope::Below, inside: false, depth: None };
        let report = move |done| {
            let _ = reports.send(done);
        };
        let shown = searches.rows(1, asked, tree.path(), found_order(), report).unwrap();
        assert_eq!(names(&shown), ["plain.txt"]);

        wait_until_done(&heard);
        assert_eq!(names(&grown(&searches, &tree, found_order())), ["plainer.txt"]);
    }

    #[test]
    fn a_stopped_search_says_nothing_more() {
        let tree = Tree::new("stop");
        let searches = Searches::default();
        let (reports, heard) = mpsc::channel();
        let search = Search::new(Found::default(), AHEAD);
        search.stop();
        let below = VecDeque::from([tree.0.clone()]);

        search.walk(&Query::new("report"), Found::default(), below, Sight::default(), false, move |walk| {
            let _ = reports.send(walk);
        });

        assert!(heard.try_recv().is_err());
        assert_eq!(search.found().len(), 0);
        assert_eq!(grown(&searches, &tree, found_order()).len(), 0);
    }

    #[test]
    fn a_walk_waits_with_rows_to_spare_until_there_is_room() {
        let tree = tree_of_folders("room");
        let search = Arc::new(Search::new(Found::default(), 2));

        let heard = walk_tree(&search, &tree, false);
        assert_eq!(next_stop(&heard), Walk::Waiting);
        assert_eq!(search.found().len(), 2, "the root's row and one folder's");

        search.make_room(3);
        assert_eq!(next_stop(&heard), Walk::Waiting);
        assert_eq!(search.found().len(), 3);

        search.make_room(usize::MAX);
        assert_eq!(next_stop(&heard), Walk::Done);
        assert_eq!(search.found().len(), 6);
    }

    #[test]
    fn stopping_ends_a_waiting_walk() {
        let tree = tree_of_folders("wake");
        let search = Arc::new(Search::new(Found::default(), 1));
        let heard = walk_tree(&search, &tree, false);
        assert_eq!(next_stop(&heard), Walk::Waiting);

        search.stop();

        assert_eq!(heard.recv_timeout(WAIT), Err(mpsc::RecvTimeoutError::Disconnected));
    }

    #[test]
    fn a_quiet_walk_shows_its_rows_when_it_starts_to_wait() {
        let tree = tree_of_folders("quiet");
        let (old, _) = read_top(&tree.0, &Query::new("other"), Sight::default()).unwrap();
        let search = Arc::new(Search::new(old, 2));

        let heard = walk_tree(&search, &tree, true);
        assert_eq!(next_stop(&heard), Walk::Waiting);

        assert_eq!(found_names(&search), ["report.txt", "report.txt"]);
    }

    #[test]
    fn hidden_rows_take_no_room() {
        let tree = tree_of_folders("sight");
        let attributes = Command::new("attrib").arg("+h").arg(tree.0.join("report.txt")).status();
        assert!(attributes.unwrap().success());
        let search = Arc::new(Search::new(Found::default(), 1));

        let heard = walk_tree(&search, &tree, false);
        assert_eq!(next_stop(&heard), Walk::Waiting);

        assert_eq!(search.found().len(), 2, "the hidden row and one in sight");
    }

    #[test]
    fn room_comes_in_steps_as_the_user_nears_the_end_of_it() {
        let searches = Searches::default();
        let search = Arc::new(Search::new(Found::default(), AHEAD));
        searches.all().insert(1, search.clone());

        searches.reached(1, AHEAD / 2);
        assert_eq!(search.room(), AHEAD, "still far from the end");

        searches.reached(1, AHEAD / 2 + 1);
        assert_eq!(search.room(), AHEAD / 2 + 1 + AHEAD);
    }

    #[test]
    fn only_rows_in_found_order_can_wait() {
        let searches = Searches::default();
        let search = Arc::new(Search::new(Found::default(), AHEAD));
        searches.all().insert(1, search.clone());

        searches.arranged(1, &found_order());
        assert_eq!(search.room(), AHEAD);

        let filter = Filter { name: "a".to_string(), ..Filter::default() };
        searches.arranged(1, &Order { filter, ..found_order() });
        assert_eq!(search.room(), usize::MAX);

        let grouped = Arc::new(Search::new(Found::default(), AHEAD));
        searches.all().insert(2, grouped.clone());
        searches.arranged(2, &Order { group_by: GroupBy::Kind, ..found_order() });
        assert_eq!(grouped.room(), usize::MAX);

        let tree = Tree::new("order");
        let (_, heard) = start(&searches, &tree, "report", Order::default());
        wait_until_done(&heard);
        assert_eq!(searches.all()[&1].room(), usize::MAX);
    }

    #[test]
    fn searching_again_keeps_the_room_it_had() {
        let tree = Tree::new("kept");
        let searches = Searches::default();
        let (_, heard) = start(&searches, &tree, "report", found_order());
        wait_until_done(&heard);
        searches.reached(1, AHEAD);

        let asked = Asked { step: Step::Again, query: "report".to_string(), scope: Scope::Below, inside: false, depth: None };
        searches.rows(1, asked, tree.path(), found_order(), |_| ()).unwrap();

        assert_eq!(searches.all()[&1].room(), AHEAD * 2);
    }

    #[test]
    fn a_share_is_searched_like_any_folder() {
        let tree = Tree::new("share");
        let (drive, rest) = tree.path().split_once(':').unwrap();
        let shared = Tree(PathBuf::from(format!(r"\\localhost\{drive}${rest}")));
        let searches = Searches::default();

        let (_, heard) = start(&searches, &shared, "report", found_order());
        wait_until_done(&heard);

        assert_eq!(grown(&searches, &shared, found_order()).len(), 3);
    }

    #[test]
    fn a_server_offers_its_shares_and_walks_those_in_sight() {
        let system = std::env::var("SystemDrive").unwrap().replace(':', "$");
        let read = |hidden| {
            let (mut below, mut seen) = (VecDeque::new(), Vec::new());
            read_folder(Path::new(r"\\localhost"), Sight { hidden, system: false }, &mut below, |entry| {
                seen.push(String::from_utf16_lossy(entry.name()));
            })
            .unwrap();
            (seen.contains(&system), below.contains(&PathBuf::from(format!(r"\\localhost\{system}"))))
        };

        assert_eq!(read(false), (true, false));
        assert_eq!(read(true), (true, true));
    }

    #[test]
    fn a_search_inside_files_finds_text_files_by_what_they_hold() {
        let tree = Tree::new("inside");
        fs::write(tree.0.join("notes.txt"), "Meet at the Harbour").unwrap();
        fs::write(tree.0.join(r"deep\more.md"), "the harbour again").unwrap();
        fs::write(tree.0.join("picture.png"), "harbour").unwrap();
        let searches = Searches::default();
        let (reports, heard) = mpsc::channel();
        let report = move |walk| {
            let _ = reports.send(walk);
        };
        let asked = |inside| Asked { step: Step::Start, query: "harbour".to_string(), scope: Scope::Below, inside, depth: None };

        searches.rows(1, asked(true), tree.path(), found_order(), report).unwrap();
        wait_until_done(&heard);
        assert_eq!(names(&grown(&searches, &tree, found_order())), ["notes.txt", "more.md"]);
        let names_only = searches.rows(1, asked(false), tree.path(), found_order(), |_| ()).unwrap();
        assert_eq!(names_only.len(), 0);
    }

    #[test]
    fn a_missing_folder_is_an_error_and_a_sort_still_works() {
        let tree = Tree::new("sort");
        let searches = Searches::default();
        let missing = tree.0.join("nope");
        let asked = Asked { step: Step::Start, query: "a".to_string(), scope: Scope::Below, inside: false, depth: None };
        assert!(searches.rows(1, asked, missing.to_str().unwrap(), found_order(), |_| ()).is_err());

        let (_, heard) = start(&searches, &tree, "report", found_order());
        wait_until_done(&heard);
        let sorted = names(&grown(&searches, &tree, Order::default()));
        let mut expected = sorted.clone();
        expected.sort_by_key(|name| name.to_lowercase());
        assert_eq!(sorted, expected);
    }
}
