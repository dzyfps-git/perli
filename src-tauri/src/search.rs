//! Finds files under a folder. The folder's own entries match loosely and arrive at once. Entries
//! further down match the exact text and arrive as a thread of their own finds them, added after
//! the rows on screen so that none of those move.

use std::cmp::Reverse;
use std::collections::{HashMap, VecDeque};
use std::ffi::OsString;
use std::os::windows::ffi::OsStringExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;
use windows::core::Result;

use crate::folder::{self, Entry, Found, Listing, Order};
use crate::ops::sys::{self, Stat};

// ponytail: the walk stops here, because each report copies every row found so far. Rows that
// share their memory would lift this.
const MAX_ROWS: usize = 100_000;
const REPORT_GAP: Duration = Duration::from_millis(200);

const LETTER: i32 = 1;
const IN_A_ROW: i32 = 8;
const WORD_START: i32 = 6;
const SKIPPED_COST: i32 = 1;

fn lower(letter: char) -> char {
    letter.to_lowercase().next().unwrap_or(letter)
}

/// What the user typed.
struct Query {
    text: String,
    letters: Vec<char>,
}

impl Query {
    fn new(text: &str) -> Self {
        Self {
            text: text.to_lowercase(),
            letters: text.chars().map(lower).collect(),
        }
    }

    fn is_in(&self, name: &[u16]) -> bool {
        String::from_utf16_lossy(name).to_lowercase().contains(&self.text)
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

/// Calls `visit` for each entry of `folder`, and adds the folders to walk next to `below`. A link
/// could lead back around, and hidden folders hold what the user chose not to see.
fn read_folder(
    folder: &Path,
    show_hidden: bool,
    below: &mut VecDeque<PathBuf>,
    mut visit: impl FnMut(Entry),
) -> Result<()> {
    sys::each_entry(&sys::extended(&folder.join("*")), |data| {
        let Some(entry) = Entry::from_find_data(data) else {
            return;
        };
        if Stat::from_find_data(data).is_folder() && (show_hidden || !entry.is_hidden()) {
            below.push_back(folder.join(OsString::from_wide(entry.name())));
        }
        visit(entry);
    })
}

/// The folder's own matches, best first, and the folders under it.
fn read_top(folder: &Path, query: &Query, show_hidden: bool) -> Result<(Found, VecDeque<PathBuf>)> {
    let mut below = VecDeque::new();
    let mut fits = Vec::new();
    read_folder(folder, show_hidden, &mut below, |entry| {
        if let Some(fit) = query.fit(entry.name()) {
            fits.push((fit, entry));
        }
    })?;
    fits.sort_by_key(|(fit, _)| Reverse(*fit));

    let location = folder::null_terminated(folder);
    let mut found = Found::default();
    for (_, entry) in fits {
        found.push(entry, location.clone());
    }
    Ok((found, below))
}

struct Search {
    found: Mutex<Found>,
    stopped: AtomicBool,
}

impl Search {
    fn found(&self) -> MutexGuard<'_, Found> {
        self.found.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }

    /// Walks everything in `below`, nearest first. `rows` is what a quiet search starts from,
    /// because it only shows its rows once it has them all.
    fn walk(
        &self,
        query: &Query,
        mut rows: Found,
        mut below: VecDeque<PathBuf>,
        show_hidden: bool,
        quiet: bool,
        report: impl Fn(bool),
    ) {
        let mut reported = Instant::now();
        let mut total = if quiet { rows.len() } else { self.found().len() };
        while let Some(folder) = below.pop_front() {
            if self.stopped() || total >= MAX_ROWS {
                break;
            }
            let before = rows.len();
            let location = folder::null_terminated(&folder);
            // A folder that can't be read has nothing to show, which is no reason to stop.
            let _ = read_folder(&folder, show_hidden, &mut below, |entry| {
                if query.is_in(entry.name()) {
                    rows.push(entry, location.clone());
                }
            });
            total += rows.len() - before;
            if !quiet && !rows.is_empty() && reported.elapsed() >= REPORT_GAP {
                self.found().append(&mut rows);
                report(false);
                reported = Instant::now();
            }
        }
        if self.stopped() {
            return;
        }
        if quiet {
            *self.found() = rows;
        } else {
            self.found().append(&mut rows);
        }
        report(true);
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

#[derive(Deserialize)]
pub struct Asked {
    pub step: Step,
    pub query: String,
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
            search.stopped.store(true, Ordering::SeqCst);
        }
    }

    /// The rows to show now. `report` hears when more are waiting, and true for the last of them.
    pub fn rows(
        &self,
        view: u32,
        asked: Asked,
        path: &str,
        order: Order,
        report: impl Fn(bool) + Send + 'static,
    ) -> Result<Listing> {
        let running = self.all().get(&view).cloned();
        if asked.step == Step::Grown {
            let found = running.map_or_else(Found::default, |search| search.found().clone());
            return Ok(Listing::searched(found, order));
        }

        let folder = PathBuf::from(folder::resolve(path)?);
        let query = Query::new(&asked.query);
        let (first, below) = read_top(&folder, &query, order.show_hidden)?;
        let quiet = asked.step == Step::Again;
        let shown = match running {
            Some(search) if quiet => search.found().clone(),
            _ => first.clone(),
        };
        self.stop(view);
        let search = Arc::new(Search {
            found: Mutex::new(shown.clone()),
            stopped: AtomicBool::new(false),
        });
        self.all().insert(view, search.clone());
        let rows = if quiet { first } else { Found::default() };
        thread::spawn(move || search.walk(&query, rows, below, order.show_hidden, quiet, report));
        Ok(Listing::searched(shown, order))
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::process::Command;
    use std::sync::mpsc;

    use super::*;
    use crate::folder::SortKey;

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

    fn fit(query: &str, name: &str) -> Option<i32> {
        Query::new(query).fit(&name.encode_utf16().collect::<Vec<_>>())
    }

    fn start(searches: &Searches, tree: &Tree, query: &str, order: Order) -> (Listing, mpsc::Receiver<bool>) {
        let (reports, heard) = mpsc::channel();
        let report = move |done| {
            let _ = reports.send(done);
        };
        let asked = Asked { step: Step::Start, query: query.to_string() };
        (searches.rows(1, asked, tree.path(), order, report).unwrap(), heard)
    }

    fn grown(searches: &Searches, tree: &Tree, order: Order) -> Listing {
        let asked = Asked { step: Step::Grown, query: String::new() };
        searches.rows(1, asked, tree.path(), order, |_| ()).unwrap()
    }

    fn wait_until_done(heard: &mpsc::Receiver<bool>) {
        while !heard.recv_timeout(WAIT).expect("the search ended") {}
    }

    fn names(listing: &Listing) -> Vec<String> {
        listing.names(&(0..listing.len() as u32).collect::<Vec<_>>())
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
        let (_, heard) = start(&searches, &tree, "report", shown);
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
        let asked = Asked { step: Step::Again, query: "plain".to_string() };
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
        let search = Search { found: Mutex::new(Found::default()), stopped: AtomicBool::new(true) };
        let below = VecDeque::from([tree.0.clone()]);

        search.walk(&Query::new("report"), Found::default(), below, false, false, move |done| {
            let _ = reports.send(done);
        });

        assert!(heard.try_recv().is_err());
        assert_eq!(search.found().len(), 0);
        assert_eq!(grown(&searches, &tree, found_order()).len(), 0);
    }

    #[test]
    fn a_missing_folder_is_an_error_and_a_sort_still_works() {
        let tree = Tree::new("sort");
        let searches = Searches::default();
        let missing = tree.0.join("nope");
        let asked = Asked { step: Step::Start, query: "a".to_string() };
        assert!(searches.rows(1, asked, missing.to_str().unwrap(), found_order(), |_| ()).is_err());

        let (_, heard) = start(&searches, &tree, "report", found_order());
        wait_until_done(&heard);
        let sorted = names(&grown(&searches, &tree, Order::default()));
        let mut expected = sorted.clone();
        expected.sort_by_key(|name| name.to_lowercase());
        assert_eq!(sorted, expected);
    }
}
