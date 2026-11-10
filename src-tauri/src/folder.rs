//! Reads a folder into memory and serves its rows to the UI as binary pages.
//! The UI only ever holds the rows it is showing.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Deserialize;
use windows::core::{Result, HSTRING, PCWSTR};
use windows::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_OFFLINE, FILE_ATTRIBUTE_PINNED,
    FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS, FILE_ATTRIBUTE_RECALL_ON_OPEN, WIN32_FIND_DATAW,
};
use windows::Win32::UI::Shell::{PathMatchSpecW, StrCmpLogicalW};

use crate::ops::{self, BinItem};
use crate::{network, shell, sizes, tags};

/// Stands for the Recycle Bin, which has no folder of its own to open.
pub const BIN_PATH: &str = "shell:RecycleBinFolder";

const FLAG_FOLDER: u8 = 1;
const FLAG_HIDDEN: u8 = 2;
const FLAG_CLOUD: u8 = 4;
const FLAG_PINNED: u8 = 8;
/// What the row format's one byte can count.
const MAX_ROW_TAGS: usize = u8::MAX as usize;
/// Between FILETIME's start in 1601 and the 1970 start of the UI's times.
const FILETIME_TO_UNIX_MS: i64 = 11_644_473_600_000;
const FILETIME_TICKS_PER_MS: u64 = 10_000;

/// Attributes of a file whose content is in the cloud, so that reading it would fetch it.
pub const ONLINE_ONLY: u32 =
    FILE_ATTRIBUTE_OFFLINE.0 | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS.0 | FILE_ATTRIBUTE_RECALL_ON_OPEN.0;

#[derive(Clone, Copy, Default, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum SortKey {
    #[default]
    Name,
    Modified,
    Created,
    Type,
    Size,
    /// Where a deleted item came from, or where a search found a row.
    Location,
    /// As a search found the rows, so that new ones never move the old ones.
    Found,
    /// Rows of one tag sit together, and rows with none go last.
    Tags,
}

/// Where folders go among files.
#[derive(Clone, Copy, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Grouping {
    #[default]
    FoldersFirst,
    FilesFirst,
    Mixed,
}

/// What a filter lets through, of files and folders.
#[derive(Clone, Copy, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Kinds {
    #[default]
    All,
    Files,
    Folders,
}

/// Conditions a view's rows must all meet. Folders have no extension or size of their own, so a
/// condition on either leaves them out.
#[derive(Clone, Default, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Filter {
    /// Part of the name, in any case.
    pub name: String,
    /// In lowercase with no dots. Any one of them will do.
    pub extensions: Vec<String>,
    pub kinds: Kinds,
    pub min_size: Option<u64>,
    pub max_size: Option<u64>,
    /// Milliseconds since 1970.
    pub modified_from: Option<i64>,
    /// Milliseconds since 1970.
    pub modified_to: Option<i64>,
    /// A row must carry all of these.
    pub tags: Vec<u32>,
}

fn ticks(milliseconds: i64) -> u64 {
    (milliseconds + FILETIME_TO_UNIX_MS).max(0) as u64 * FILETIME_TICKS_PER_MS
}

impl Filter {
    pub fn is_active(&self) -> bool {
        *self != Self::default()
    }

    fn keeps(&self, entry: &Entry, name: &str, tags: &[u32]) -> bool {
        let lowered = || String::from_utf16_lossy(entry.name()).to_lowercase();
        let sized = |within: bool| !entry.is_dir && within;
        (name.is_empty() || lowered().contains(name))
            && (self.extensions.is_empty() || self.extensions.contains(&entry.extension_text()))
            && match self.kinds {
                Kinds::All => true,
                Kinds::Files => !entry.is_dir,
                Kinds::Folders => entry.is_dir,
            }
            && self.min_size.is_none_or(|least| sized(entry.size >= least))
            && self.max_size.is_none_or(|most| sized(entry.size <= most))
            && self.modified_from.is_none_or(|from| entry.modified >= ticks(from))
            && self.modified_to.is_none_or(|to| entry.modified <= ticks(to))
            && self.tags.iter().all(|tag| tags.contains(tag))
    }
}

/// Which rows a view shows and in what order. The default is the first folder's preload.
#[derive(Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Order {
    pub key: SortKey,
    pub descending: bool,
    pub group: Grouping,
    pub show_hidden: bool,
    #[serde(default)]
    pub filter: Filter,
}

#[derive(Clone)]
pub struct Entry {
    /// UTF-16 and null-terminated, ready for `StrCmpLogicalW`.
    name: Box<[u16]>,
    size: u64,
    /// FILETIME ticks.
    modified: u64,
    /// FILETIME ticks.
    created: u64,
    is_dir: bool,
    hidden: bool,
    /// Its content is in the cloud.
    cloud: bool,
    /// The user asked to always keep it on this device.
    pinned: bool,
}

impl Entry {
    pub fn from_find_data(data: &WIN32_FIND_DATAW) -> Option<Self> {
        let length = data.cFileName.iter().position(|&c| c == 0)?;
        let name = &data.cFileName[..length];
        if name == [b'.' as u16] || name == [b'.' as u16, b'.' as u16] {
            return None;
        }
        // A folder that reloads while a copy lands in it must not show the copy's working file.
        if name.first() == Some(&(b'~' as u16)) && ops::is_temp_name(&String::from_utf16_lossy(name)) {
            return None;
        }
        Some(Self {
            name: data.cFileName[..=length].into(),
            size: (u64::from(data.nFileSizeHigh) << 32) | u64::from(data.nFileSizeLow),
            modified: (u64::from(data.ftLastWriteTime.dwHighDateTime) << 32)
                | u64::from(data.ftLastWriteTime.dwLowDateTime),
            created: (u64::from(data.ftCreationTime.dwHighDateTime) << 32)
                | u64::from(data.ftCreationTime.dwLowDateTime),
            is_dir: data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 != 0,
            hidden: data.dwFileAttributes & FILE_ATTRIBUTE_HIDDEN.0 != 0,
            cloud: data.dwFileAttributes & ONLINE_ONLY != 0,
            pinned: data.dwFileAttributes & FILE_ATTRIBUTE_PINNED.0 != 0,
        })
    }

    fn from_bin_item(item: &BinItem) -> Self {
        Self {
            name: null_terminated(item.original.file_name().unwrap_or_default().as_ref()),
            size: item.size,
            modified: item.deleted,
            created: item.deleted,
            is_dir: item.is_dir,
            hidden: false,
            cloud: false,
            pinned: false,
        }
    }

    /// A server's shares have no dates or size to show.
    fn from_share((name, out_of_sight): (String, bool)) -> Self {
        Self {
            name: null_terminated(name.as_ref()),
            size: 0,
            modified: 0,
            created: 0,
            is_dir: true,
            hidden: out_of_sight,
            cloud: false,
            pinned: false,
        }
    }

    pub fn name(&self) -> &[u16] {
        &self.name[..self.name.len() - 1]
    }

    /// The name as Windows gave it, which odd names survive.
    pub fn file_name(&self) -> OsString {
        OsString::from_wide(self.name())
    }

    pub fn size(&self) -> u64 {
        self.size
    }

    pub fn is_dir(&self) -> bool {
        self.is_dir
    }

    pub fn is_hidden(&self) -> bool {
        self.hidden
    }

    /// The null-terminated extension with its dot. Folders have none.
    fn extension(&self) -> &[u16] {
        let dot = self.name.iter().rposition(|&unit| unit == b'.' as u16);
        let start = dot.filter(|_| !self.is_dir);
        &self.name[start.unwrap_or(self.name.len() - 1)..]
    }

    /// In lowercase with no dot.
    fn extension_text(&self) -> String {
        let dotted = &self.extension()[..self.extension().len() - 1];
        String::from_utf16_lossy(dotted.get(1..).unwrap_or_default()).to_lowercase()
    }

    fn starts_with(&self, lowercase_prefix: &str) -> bool {
        let mut name = char::decode_utf16(self.name().iter().copied())
            .map(|unit| unit.unwrap_or(char::REPLACEMENT_CHARACTER))
            .flat_map(char::to_lowercase);
        lowercase_prefix.chars().all(|c| name.next() == Some(c))
    }
}

pub fn null_terminated(text: &Path) -> Box<[u16]> {
    text.as_os_str().encode_wide().chain([0]).collect()
}

/// What the Recycle Bin knows beyond a normal folder, in the same order as `Listing::entries`.
/// It lives apart so normal rows stay small.
struct Bin {
    items: Vec<BinItem>,
    locations: Vec<Arc<[u16]>>,
}

/// Rows from many folders, with where each one is.
#[derive(Clone, Default)]
pub struct Found {
    entries: Vec<Entry>,
    /// Null-terminated, in the same order as `entries`. Rows of one folder share theirs.
    locations: Vec<Arc<[u16]>>,
}

impl Found {
    pub fn push(&mut self, entry: Entry, location: Arc<[u16]>) {
        self.entries.push(entry);
        self.locations.push(location);
    }

    /// Moves all of `other`'s rows to the end of this one.
    pub fn append(&mut self, other: &mut Self) {
        self.entries.append(&mut other.entries);
        self.locations.append(&mut other.locations);
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The rows the list would show.
    pub fn in_sight(&self, show_hidden: bool) -> usize {
        self.entries.iter().filter(|entry| show_hidden || !entry.hidden).count()
    }
}

/// One read of a folder. Rows are positions in `entries`, so a new sort or the hidden
/// toggle needs no new read.
#[derive(Clone, Default)]
pub struct Listing {
    folder: PathBuf,
    entries: Arc<Vec<Entry>>,
    bin: Option<Arc<Bin>>,
    /// Where a search found each of `entries`. Empty for a plain folder.
    found_in: Arc<Vec<Arc<[u16]>>>,
    /// Only entries that have tags are here, so normal rows stay small.
    tags: Arc<tags::Tagged>,
    visible: Vec<u32>,
    order: Order,
}

/// A server's shares as rows.
pub fn read_shares(server: &str) -> Result<Vec<Entry>> {
    Ok(network::shares(server)?.into_iter().map(Entry::from_share).collect())
}

impl Listing {
    pub fn read(path: &str, order: Order) -> Result<Self> {
        if path == BIN_PATH {
            return Self::read_bin(order);
        }
        let full = resolve(path)?;
        let (entries, tagged) = if network::is_server(&full) {
            (read_shares(&full)?, tags::Tagged::new())
        } else {
            let entries = read_entries(&full)?;
            let tagged = tags::in_folder(Path::new(&full), &entries);
            (entries, tagged)
        };
        let listing = Self {
            folder: full.into(),
            entries: Arc::new(entries),
            tags: Arc::new(tagged),
            ..Self::default()
        };
        Ok(listing.arrange(order))
    }

    fn read_bin(order: Order) -> Result<Self> {
        Ok(Self::from_bin(ops::read_bin()?).arrange(order))
    }

    fn from_bin(items: Vec<BinItem>) -> Self {
        let location = |item: &BinItem| -> Arc<[u16]> {
            null_terminated(item.original.parent().unwrap_or(Path::new(""))).into()
        };
        let bin = Bin {
            locations: items.iter().map(location).collect(),
            items,
        };
        Self {
            entries: Arc::new(bin.items.iter().map(Entry::from_bin_item).collect()),
            bin: Some(Arc::new(bin)),
            ..Self::default()
        }
    }

    pub fn searched(found: Found, order: Order) -> Self {
        Self {
            entries: Arc::new(found.entries),
            found_in: Arc::new(found.locations),
            ..Self::default()
        }
        .arrange(order)
    }

    pub fn arranged(self, order: Order) -> Self {
        if order == self.order {
            self
        } else {
            self.arrange(order)
        }
    }

    fn arrange(mut self, order: Order) -> Self {
        let entries = &self.entries;
        let name = order.filter.name.to_lowercase();
        let shown = |entry: &Entry| order.show_hidden || !entry.hidden;
        let fits = |row: u32| {
            let entry = &entries[row as usize];
            shown(entry) && order.filter.keeps(entry, &name, self.tags_of(row))
        };
        let mut visible: Vec<u32> = (0..entries.len() as u32).filter(|&row| fits(row)).collect();
        let locations = self.locations();
        let ranks = match order.key {
            SortKey::Type => type_ranks(entries),
            SortKey::Size if sizes::any() => self.sizes(),
            SortKey::Tags => self.tag_ranks(&tags::places()),
            _ => Vec::new(),
        };
        visible.sort_unstable_by(|&a, &b| compare(entries, locations, &ranks, a, b, &order));
        self.visible = visible;
        self.order = order;
        self
    }

    /// What the Size column shows for one entry.
    fn size_of(&self, entry: usize) -> u64 {
        let row = &self.entries[entry];
        if !row.is_dir || !sizes::any() {
            return row.size;
        }
        sizes::of(&self.full_path(entry)).unwrap_or(row.size)
    }

    fn sizes(&self) -> Vec<u64> {
        (0..self.entries.len()).map(|entry| self.size_of(entry)).collect()
    }

    fn tags_of(&self, entry: u32) -> &[u32] {
        self.tags.get(&entry).map_or(&[], |tags| tags)
    }

    /// Where each entry goes in a sort by tag: by whichever of its tags comes first in `places`.
    fn tag_ranks(&self, places: &HashMap<u32, u64>) -> Vec<u64> {
        let rank = |entry| {
            let ranks = self.tags_of(entry).iter().filter_map(|tag| places.get(tag));
            ranks.min().copied().unwrap_or(u64::MAX)
        };
        (0..self.entries.len() as u32).map(rank).collect()
    }

    fn locations(&self) -> &[Arc<[u16]>] {
        self.bin.as_ref().map_or(&self.found_in, |bin| &bin.locations)
    }

    pub fn len(&self) -> usize {
        self.visible.len()
    }

    /// Hidden entries in the folder, whether or not they are being shown.
    pub fn hidden_count(&self) -> usize {
        self.entries.iter().filter(|entry| entry.hidden).count()
    }

    #[cfg(test)]
    fn rows(&self) -> impl Iterator<Item = &Entry> {
        self.visible.iter().map(|&row| &self.entries[row as usize])
    }

    /// The positions in `entries` of the rows the UI named. Rows no longer shown are left out.
    fn chosen<'a>(&'a self, rows: &'a [u32]) -> impl Iterator<Item = usize> + 'a {
        rows.iter()
            .filter_map(|&row| self.visible.get(row as usize))
            .map(|&entry| entry as usize)
    }

    fn full_path(&self, entry: usize) -> PathBuf {
        let name = OsString::from_wide(self.entries[entry].name());
        match self.found_in.get(entry) {
            Some(location) => PathBuf::from(OsString::from_wide(&location[..location.len() - 1])).join(name),
            None => self.folder.join(name),
        }
    }

    /// What is on disk for each of `rows`: its full path, built from the raw name so that odd
    /// names survive, or its `$R` item in the Recycle Bin.
    pub fn paths(&self, rows: &[u32]) -> Vec<PathBuf> {
        self.chosen(rows)
            .map(|entry| match &self.bin {
                Some(bin) => bin.items[entry].item.clone(),
                None => self.full_path(entry),
            })
            .collect()
    }

    /// The Recycle Bin items at `rows`. Other folders have none.
    pub fn bin_items(&self, rows: &[u32]) -> Vec<BinItem> {
        let Some(bin) = &self.bin else {
            return Vec::new();
        };
        self.chosen(rows).map(|entry| bin.items[entry].clone()).collect()
    }

    /// Each row's name, lossy, and whether it is a folder.
    pub fn facts(&self, rows: &[u32]) -> Vec<(String, bool)> {
        let fact = |entry| {
            let entry: &Entry = &self.entries[entry];
            (String::from_utf16_lossy(entry.name()), entry.is_dir)
        };
        self.chosen(rows).map(fact).collect()
    }

    /// Lossy, which is fine because these are only ever shown or compared.
    pub fn names(&self, rows: &[u32]) -> Vec<String> {
        self.chosen(rows)
            .map(|entry| String::from_utf16_lossy(self.entries[entry].name()))
            .collect()
    }

    /// What tells an entry apart from one read to the next: its name, or where names repeat,
    /// its `$R` item in the Recycle Bin and its full path in a search.
    fn key(&self, entry: usize) -> Vec<u16> {
        match &self.bin {
            Some(bin) => bin.items[entry].item.as_os_str().encode_wide().collect(),
            None if self.found_in.is_empty() => self.entries[entry].name().to_vec(),
            None => self.full_path(entry).as_os_str().encode_wide().collect(),
        }
    }

    pub fn keys(&self, rows: &[u32]) -> Vec<Vec<u16>> {
        self.chosen(rows).map(|entry| self.key(entry)).collect()
    }

    /// Where the entries with `keys` sit, in the same order. Keys no longer shown are left out.
    pub fn rows_keyed(&self, keys: &[Vec<u16>]) -> Vec<u32> {
        if keys.is_empty() {
            return Vec::new();
        }
        let visible = self.visible.iter().map(|&entry| self.key(entry as usize));
        let rows: HashMap<Vec<u16>, u32> = visible.zip(0..).collect();
        keys.iter().filter_map(|key| rows.get(key).copied()).collect()
    }

    /// Where `rows` of `before` sit in this listing, in the same order. Rows no longer
    /// shown are left out.
    pub fn carried_rows(&self, before: &Listing, rows: &[u32]) -> Vec<u32> {
        let mut positions = vec![None; self.entries.len()];
        for (row, &entry) in self.visible.iter().enumerate() {
            positions[entry as usize] = Some(row as u32);
        }
        rows.iter()
            .filter_map(|&row| before.visible.get(row as usize))
            .filter_map(|&entry| positions[entry as usize])
            .collect()
    }

    /// The first row at or after `start` whose name starts with `prefix`, wrapping around.
    pub fn find(&self, prefix: &str, start: usize) -> Option<usize> {
        let prefix = prefix.to_lowercase();
        let start = start.min(self.len());
        (start..self.len())
            .chain(0..start)
            .find(|&row| self.entries[self.visible[row] as usize].starts_with(&prefix))
    }

    /// The rows whose names fit `pattern`, such as `*.jpg;*.png`, in any case.
    pub fn matching(&self, pattern: &str) -> Vec<u32> {
        let patterns: Vec<HSTRING> = pattern
            .split(';')
            .map(str::trim)
            .filter(|one| !one.is_empty())
            .map(HSTRING::from)
            .collect();
        let fits = |entry: u32| {
            let name = PCWSTR(self.entries[entry as usize].name.as_ptr());
            patterns.iter().any(|one| unsafe { PathMatchSpecW(name, one) }.as_bool())
        };
        (0..self.visible.len() as u32).filter(|&row| fits(self.visible[row as usize])).collect()
    }

    /// Encodes rows as: row count (u32), then for each row the name length in bytes (u32),
    /// size (u64), modified (u64), created (u64), flags (u8), the location length in bytes
    /// (u32), the tag count (u8), the UTF-16 name, the UTF-16 location and the tags (u32 each).
    /// All numbers are little-endian. `src/api/index.ts` decodes this.
    pub fn encode_rows(&self, start: usize, count: usize) -> Vec<u8> {
        let start = start.min(self.len());
        let rows = (start + count).min(self.len()) - start;

        let mut bytes = Vec::with_capacity(4 + rows * 64);
        bytes.extend((rows as u32).to_le_bytes());
        for &entry in &self.visible[start..start + rows] {
            let row = &self.entries[entry as usize];
            let folder = if row.is_dir { FLAG_FOLDER } else { 0 };
            let hidden = if row.hidden { FLAG_HIDDEN } else { 0 };
            let cloud = if row.cloud { FLAG_CLOUD } else { 0 };
            let pinned = if row.pinned { FLAG_PINNED } else { 0 };
            let location = location_of(self.locations(), entry);
            let location = &location[..location.len() - 1];
            bytes.extend((row.name().len() as u32 * 2).to_le_bytes());
            bytes.extend(self.size_of(entry as usize).to_le_bytes());
            bytes.extend(row.modified.to_le_bytes());
            bytes.extend(row.created.to_le_bytes());
            bytes.push(folder | hidden | cloud | pinned);
            bytes.extend((location.len() as u32 * 2).to_le_bytes());
            let tags = &self.tags_of(entry)[..self.tags_of(entry).len().min(MAX_ROW_TAGS)];
            bytes.push(tags.len() as u8);
            bytes.extend(row.name().iter().flat_map(|unit| unit.to_le_bytes()));
            bytes.extend(location.iter().flat_map(|unit| unit.to_le_bytes()));
            bytes.extend(tags.iter().flat_map(|tag| tag.to_le_bytes()));
        }
        bytes
    }
}

/// Each entry's place among the names Windows gives file types, so JPG and JPEG sit together
/// and a sort compares numbers rather than text. An extension with no name goes by itself.
fn type_ranks(entries: &[Entry]) -> Vec<u64> {
    let extensions: HashSet<String> = entries.iter().map(Entry::extension_text).collect();
    let names = shell::type_names(extensions.iter().filter(|text| !text.is_empty()).cloned().collect())
        .unwrap_or_default();
    let label = |extension: &String| -> Vec<u16> {
        let name = names.get(extension).unwrap_or(extension);
        name.encode_utf16().chain([0]).collect()
    };
    let mut labels: Vec<(Vec<u16>, String)> =
        extensions.into_iter().map(|extension| (label(&extension), extension)).collect();
    labels.sort_unstable_by(|a, b| natural(&a.0, &b.0));

    let mut ranks = HashMap::new();
    let mut rank = 0;
    for (index, (label, extension)) in labels.iter().enumerate() {
        rank += u32::from(index > 0 && *label != labels[index - 1].0);
        ranks.insert(extension.as_str(), rank);
    }
    entries.iter().map(|entry| u64::from(ranks[entry.extension_text().as_str()])).collect()
}

/// `full` comes from `resolve`.
fn read_entries(full: &str) -> Result<Vec<Entry>> {
    let mut entries = Vec::new();
    ops::sys::each_entry(&ops::sys::extended(&Path::new(full).join("*")), |data| {
        entries.extend(Entry::from_find_data(data));
    })?;
    Ok(entries)
}

/// Resolves relative parts and forward slashes into a full path, with no trailing
/// backslash except on a drive root.
pub fn resolve(path: &str) -> Result<String> {
    if path == BIN_PATH {
        return Ok(path.to_string());
    }
    let full = std::path::absolute(path)?;
    let full = full.to_string_lossy();
    let trimmed = full.trim_end_matches('\\');
    Ok(if trimmed.ends_with(':') {
        format!(r"{trimmed}\")
    } else {
        trimmed.to_string()
    })
}

/// Null-terminated, and empty outside the Recycle Bin.
fn location_of(locations: &[Arc<[u16]>], entry: u32) -> &[u16] {
    locations.get(entry as usize).map_or(&[0], |location| location)
}

fn compare(
    entries: &[Entry],
    locations: &[Arc<[u16]>],
    ranks: &[u64],
    first: u32,
    second: u32,
    order: &Order,
) -> Ordering {
    let (a, b) = (&entries[first as usize], &entries[second as usize]);
    let groups = match order.group {
        Grouping::FoldersFirst => b.is_dir.cmp(&a.is_dir),
        Grouping::FilesFirst => a.is_dir.cmp(&b.is_dir),
        Grouping::Mixed => Ordering::Equal,
    };
    groups.then_with(|| {
        let by_key = match order.key {
            SortKey::Name => natural(&a.name, &b.name),
            SortKey::Modified => a.modified.cmp(&b.modified),
            SortKey::Created => a.created.cmp(&b.created),
            SortKey::Size if ranks.is_empty() => a.size.cmp(&b.size),
            SortKey::Type | SortKey::Size | SortKey::Tags => ranks[first as usize].cmp(&ranks[second as usize]),
            SortKey::Location => natural(location_of(locations, first), location_of(locations, second)),
            SortKey::Found => first.cmp(&second),
        };
        let by_key = if order.descending {
            by_key.reverse()
        } else {
            by_key
        };
        by_key.then_with(|| natural(&a.name, &b.name))
    })
}

/// Explorer's natural order. Both slices must be null-terminated.
fn natural(a: &[u16], b: &[u16]) -> Ordering {
    unsafe { StrCmpLogicalW(PCWSTR(a.as_ptr()), PCWSTR(b.as_ptr())) }.cmp(&0)
}

/// The names of the folders right inside `path`, in Explorer's order, for a path crumb's menu.
pub fn subfolders(path: &Path, show_hidden: bool) -> std::io::Result<Vec<String>> {
    use std::os::windows::fs::MetadataExt;

    let mut names: Vec<Box<[u16]>> = std::fs::read_dir(path)?
        .flatten()
        .filter(|entry| {
            entry.metadata().is_ok_and(|facts| {
                let attributes = facts.file_attributes();
                attributes & FILE_ATTRIBUTE_DIRECTORY.0 != 0 && (show_hidden || attributes & FILE_ATTRIBUTE_HIDDEN.0 == 0)
            })
        })
        .map(|entry| null_terminated(Path::new(&entry.file_name())))
        .collect();
    names.sort_by(|a, b| natural(a, b));
    Ok(names
        .iter()
        .map(|name| String::from_utf16_lossy(&name[..name.len() - 1]))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{Duration, SystemTime};
    use windows::Win32::Storage::FileSystem::SetFileAttributesW;

    struct TempFolder(PathBuf);

    impl TempFolder {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!("perli-{name}-{}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempFolder {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn names(listing: &Listing) -> Vec<String> {
        listing
            .rows()
            .map(|entry| String::from_utf16(entry.name()).unwrap())
            .collect()
    }

    fn sorted(folder: &TempFolder, order: Order) -> Vec<String> {
        names(&Listing::read(folder.0.to_str().unwrap(), order).unwrap())
    }

    fn set_modified(file: &Path, seconds: u64) {
        let time = SystemTime::UNIX_EPOCH + Duration::from_secs(seconds);
        fs::File::options()
            .write(true)
            .open(file)
            .unwrap()
            .set_modified(time)
            .unwrap();
    }

    fn hide(file: &Path) {
        use windows::core::HSTRING;

        unsafe { SetFileAttributesW(&HSTRING::from(file.as_os_str()), FILE_ATTRIBUTE_HIDDEN) }
            .unwrap();
    }

    #[test]
    fn sorts_folders_first_then_natural_order() {
        let folder = TempFolder::new("sort");
        for file in ["file10.txt", "file2.txt", "file1.txt"] {
            fs::write(folder.0.join(file), "").unwrap();
        }
        fs::create_dir(folder.0.join("zebra")).unwrap();

        assert_eq!(
            sorted(&folder, Order::default()),
            ["zebra", "file1.txt", "file2.txt", "file10.txt"]
        );
    }

    #[test]
    fn sorts_by_size_largest_first_with_names_breaking_ties() {
        let folder = TempFolder::new("size");
        fs::write(folder.0.join("small"), "1").unwrap();
        fs::write(folder.0.join("big"), "12345").unwrap();
        fs::write(folder.0.join("also-small"), "2").unwrap();
        fs::create_dir(folder.0.join("sub")).unwrap();

        let order = Order {
            key: SortKey::Size,
            descending: true,
            ..Order::default()
        };

        assert_eq!(sorted(&folder, order), ["sub", "big", "also-small", "small"]);
    }

    #[test]
    fn sorts_by_modified_time() {
        let folder = TempFolder::new("modified");
        for (file, seconds) in [("old", 1_000_000), ("new", 3_000_000), ("mid", 2_000_000)] {
            fs::write(folder.0.join(file), "").unwrap();
            set_modified(&folder.0.join(file), seconds);
        }

        let order = Order {
            key: SortKey::Modified,
            ..Order::default()
        };

        assert_eq!(sorted(&folder, order), ["old", "mid", "new"]);
    }

    #[test]
    fn sorts_by_type_name_so_one_type_sits_together() {
        let folder = TempFolder::new("type");
        for file in ["a.jpg", "b.txt", "c.jpeg", "noext"] {
            fs::write(folder.0.join(file), "").unwrap();
        }

        let order = Order {
            key: SortKey::Type,
            ..Order::default()
        };

        let names = sorted(&folder, order);
        assert_eq!(names[0], "noext");
        let photo = |name: &String| name.ends_with(".jpg") || name.ends_with(".jpeg");
        let first = names.iter().position(photo).unwrap();
        assert!(photo(&names[first + 1]), "{names:?}");
    }

    #[test]
    fn files_first_moves_folders_after_files() {
        let folder = TempFolder::new("files-first");
        fs::write(folder.0.join("z.txt"), "").unwrap();
        fs::create_dir(folder.0.join("a")).unwrap();

        let order = Order {
            group: Grouping::FilesFirst,
            ..Order::default()
        };

        assert_eq!(sorted(&folder, order), ["z.txt", "a"]);
    }

    #[test]
    fn mixed_sorts_folders_among_files() {
        let folder = TempFolder::new("mixed");
        fs::write(folder.0.join("a.txt"), "").unwrap();
        fs::create_dir(folder.0.join("b")).unwrap();
        fs::write(folder.0.join("c.txt"), "").unwrap();

        let order = Order {
            group: Grouping::Mixed,
            ..Order::default()
        };

        assert_eq!(sorted(&folder, order), ["a.txt", "b", "c.txt"]);
    }

    #[test]
    fn hidden_files_stay_out_until_asked_for() {
        let folder = TempFolder::new("hidden");
        fs::write(folder.0.join("seen"), "").unwrap();
        fs::write(folder.0.join("secret"), "").unwrap();
        hide(&folder.0.join("secret"));

        let order = Order {
            show_hidden: true,
            ..Order::default()
        };

        assert_eq!(sorted(&folder, Order::default()), ["seen"]);
        assert_eq!(sorted(&folder, order), ["secret", "seen"]);
    }

    #[test]
    fn a_crumb_lists_its_folders_in_natural_order_without_files_or_hidden_ones() {
        let folder = TempFolder::new("subfolders");
        for name in ["photos 10", "photos 2", "Apps", "secret"] {
            fs::create_dir(folder.0.join(name)).unwrap();
        }
        fs::write(folder.0.join("notes.txt"), "").unwrap();
        hide(&folder.0.join("secret"));

        assert_eq!(subfolders(&folder.0, false).unwrap(), ["Apps", "photos 2", "photos 10"]);
        assert_eq!(subfolders(&folder.0, true).unwrap(), ["Apps", "photos 2", "photos 10", "secret"]);
    }

    #[test]
    fn hidden_count_ignores_whether_they_are_shown() {
        let folder = TempFolder::new("hidden-count");
        fs::write(folder.0.join("seen"), "").unwrap();
        fs::write(folder.0.join("secret"), "").unwrap();
        hide(&folder.0.join("secret"));
        let path = folder.0.to_str().unwrap();
        let shown = Order {
            show_hidden: true,
            ..Order::default()
        };

        assert_eq!(Listing::read(path, Order::default()).unwrap().hidden_count(), 1);
        assert_eq!(Listing::read(path, shown).unwrap().hidden_count(), 1);
    }

    #[test]
    fn rearranging_needs_no_new_read() {
        let folder = TempFolder::new("rearrange");
        fs::write(folder.0.join("seen"), "").unwrap();
        fs::write(folder.0.join("secret"), "").unwrap();
        hide(&folder.0.join("secret"));
        let listing = Listing::read(folder.0.to_str().unwrap(), Order::default()).unwrap();

        fs::remove_file(folder.0.join("seen")).unwrap();
        let order = Order {
            descending: true,
            show_hidden: true,
            ..Order::default()
        };

        assert_eq!(names(&listing.arranged(order)), ["seen", "secret"]);
    }

    #[test]
    fn selected_rows_follow_their_files_to_new_positions() {
        let folder = TempFolder::new("carry");
        for file in ["a", "b", "c"] {
            fs::write(folder.0.join(file), "").unwrap();
        }
        let shown = Order {
            show_hidden: true,
            ..Order::default()
        };
        hide(&folder.0.join("c"));
        let before = Listing::read(folder.0.to_str().unwrap(), shown.clone()).unwrap();

        let reversed = before.clone().arranged(Order {
            descending: true,
            ..shown.clone()
        });
        let without_hidden = before.clone().arranged(Order::default());

        assert_eq!(reversed.carried_rows(&before, &[0, 2]), [2, 0]);
        assert_eq!(without_hidden.carried_rows(&before, &[2, 1]), [1]);
        assert_eq!(without_hidden.carried_rows(&before, &[99]), [0u32; 0]);
    }

    #[test]
    fn find_ignores_case_and_wraps_around() {
        let folder = TempFolder::new("find");
        for file in ["Apple", "avocado", "Banana", "Ärger"] {
            fs::write(folder.0.join(file), "").unwrap();
        }
        let listing = Listing::read(folder.0.to_str().unwrap(), Order::default()).unwrap();
        let at = |name: &str| names(&listing).iter().position(|row| row == name);

        assert_eq!(listing.find("AV", 0), at("avocado"));
        assert_eq!(listing.find("a", at("Apple").unwrap() + 1), at("avocado"));
        assert_eq!(listing.find("a", at("avocado").unwrap() + 1), at("Apple"));
        assert_eq!(listing.find("ärg", 0), at("Ärger"));
        assert_eq!(listing.find("zzz", 0), None);
    }

    fn filtered(folder: &TempFolder, filter: Filter) -> Vec<String> {
        sorted(folder, Order { filter, ..Order::default() })
    }

    #[test]
    fn a_filter_leaves_only_rows_that_meet_every_condition() {
        let folder = TempFolder::new("filter");
        fs::write(folder.0.join("Holiday.JPG"), "12345").unwrap();
        fs::write(folder.0.join("holiday.png"), "1").unwrap();
        fs::write(folder.0.join("notes.txt"), "12345").unwrap();
        fs::create_dir(folder.0.join("holiday pics")).unwrap();
        set_modified(&folder.0.join("Holiday.JPG"), 1_000_000);
        set_modified(&folder.0.join("holiday.png"), 3_000_000);
        set_modified(&folder.0.join("notes.txt"), 3_000_000);

        let name = || Filter { name: "holiday".into(), ..Filter::default() };
        assert_eq!(filtered(&folder, name()), ["holiday pics", "Holiday.JPG", "holiday.png"]);

        let types = || Filter { extensions: vec!["jpg".into(), "txt".into()], ..Filter::default() };
        assert_eq!(filtered(&folder, types()), ["Holiday.JPG", "notes.txt"], "folders have no type");
        assert_eq!(filtered(&folder, Filter { name: "holiday".into(), ..types() }), ["Holiday.JPG"]);

        let kinds = |kinds| Filter { kinds, ..Filter::default() };
        assert_eq!(filtered(&folder, kinds(Kinds::Folders)), ["holiday pics"]);
        assert_eq!(filtered(&folder, kinds(Kinds::Files)).len(), 3);

        let least = Filter { min_size: Some(2), ..Filter::default() };
        assert_eq!(filtered(&folder, least), ["Holiday.JPG", "notes.txt"], "folders have no size");
        let most = Filter { max_size: Some(1), ..Filter::default() };
        assert_eq!(filtered(&folder, most), ["holiday.png"]);

        let file_times = Filter { kinds: Kinds::Files, ..Filter::default() };
        let from = Filter { modified_from: Some(2_000_000_000), ..file_times.clone() };
        assert_eq!(filtered(&folder, from), ["holiday.png", "notes.txt"]);
        let to = Filter { modified_to: Some(2_000_000_000), ..file_times };
        assert_eq!(filtered(&folder, to), ["Holiday.JPG"]);
    }

    /// Files `a` to `c`, with `a` tagged 7 and `c` tagged 7 and 9.
    fn tagged_listing(folder: &TempFolder, order: Order) -> Listing {
        for file in ["a", "b", "c"] {
            fs::write(folder.0.join(file), "").unwrap();
        }
        let tagged = [(0, vec![7].into()), (2, vec![7, 9].into())];
        Listing {
            folder: folder.0.clone(),
            entries: Arc::new(read_entries(folder.0.to_str().unwrap()).unwrap()),
            tags: Arc::new(tagged.into_iter().collect()),
            ..Listing::default()
        }
        .arrange(order)
    }

    #[test]
    fn a_filter_wants_every_tag_it_names() {
        let folder = TempFolder::new("filter-tags");
        let with = |tags| Order { filter: Filter { tags, ..Filter::default() }, ..Order::default() };

        assert_eq!(names(&tagged_listing(&folder, with(vec![7]))), ["a", "c"]);
        assert_eq!(names(&tagged_listing(&folder, with(vec![7, 9]))), ["c"]);
    }

    #[test]
    fn a_rows_tags_come_after_its_text() {
        let folder = TempFolder::new("row-tags");
        let listing = tagged_listing(&folder, Order::default());

        let bytes = listing.encode_rows(2, 1);

        assert_eq!(bytes[37], 2);
        assert_eq!(bytes[38..40], [b'c', 0]);
        assert_eq!(bytes[40..44], 7u32.to_le_bytes());
        assert_eq!(bytes[44..48], 9u32.to_le_bytes());
        assert_eq!(bytes.len(), 48);
        assert_eq!(listing.encode_rows(1, 1)[37], 0);
    }

    #[test]
    fn sorting_by_tag_puts_rows_with_no_tag_last() {
        let folder = TempFolder::new("sort-tags");
        let listing = tagged_listing(&folder, Order::default());

        let ranks = listing.tag_ranks(&HashMap::from([(7, 5), (9, 2)]));

        assert_eq!(ranks, [5, u64::MAX, 2]);
    }

    #[test]
    fn an_empty_filter_is_no_filter() {
        assert!(!Filter::default().is_active());
        assert!(Filter { max_size: Some(0), ..Filter::default() }.is_active());
    }

    #[test]
    fn a_pattern_picks_rows_by_name_in_any_case() {
        let folder = TempFolder::new("pattern");
        for file in ["a.JPG", "b.png", "c.txt", "report1.txt"] {
            fs::write(folder.0.join(file), "").unwrap();
        }
        let listing = Listing::read(folder.0.to_str().unwrap(), Order::default()).unwrap();

        assert_eq!(listing.matching("*.jpg;*.png"), [0, 1]);
        assert_eq!(listing.matching("report?.*"), [3]);
        assert_eq!(listing.matching("*.nope"), [0u32; 0]);
        assert_eq!(listing.matching(" ; "), [0u32; 0]);
    }

    #[test]
    fn reads_size_and_folder_flag() {
        let folder = TempFolder::new("fields");
        fs::write(folder.0.join("five.txt"), "12345").unwrap();
        fs::create_dir(folder.0.join("sub")).unwrap();

        let listing = Listing::read(folder.0.to_str().unwrap(), Order::default()).unwrap();
        let rows: Vec<&Entry> = listing.rows().collect();

        assert!(rows[0].is_dir);
        assert_eq!(rows[1].size, 5);
    }

    #[test]
    fn resolves_relative_paths_and_forward_slashes() {
        // Cargo runs tests from the package folder, which holds `src/main.rs`.
        for path in [r".\src", "src", "src/", r"..\src-tauri\src"] {
            let listing = Listing::read(path, Order::default()).unwrap();
            assert!(names(&listing).contains(&"main.rs".to_string()), "{path}");
        }
    }

    #[test]
    fn resolve_keeps_drive_roots_and_trims_other_trailing_slashes() {
        assert_eq!(resolve(r"C:\").unwrap(), r"C:\");
        assert_eq!(resolve(r"C:\Users\").unwrap(), r"C:\Users");
        assert_eq!(resolve("C:/Users/./Public/..").unwrap(), r"C:\Users");
    }

    fn bin_listing(order: Order) -> Listing {
        let item = |id: &str, original: &str, deleted| BinItem {
            item: PathBuf::from(format!(r"D:\$Recycle.Bin\$R{id}")),
            original: PathBuf::from(original),
            size: 7,
            deleted,
            is_dir: false,
        };
        Listing::from_bin(vec![
            item("A", r"D:\work\b.txt", 1),
            item("B", r"C:\home\a.txt", 2),
        ])
        .arrange(order)
    }

    #[test]
    fn recycle_bin_rows_carry_their_location_and_item() {
        let listing = bin_listing(Order::default());

        assert_eq!(names(&listing), ["a.txt", "b.txt"]);
        assert_eq!(listing.paths(&[1]), [PathBuf::from(r"D:\$Recycle.Bin\$RA")]);
        assert_eq!(listing.bin_items(&[0])[0].original, Path::new(r"C:\home\a.txt"));

        let bytes = listing.encode_rows(0, 1);
        let location_bytes = u32::from_le_bytes(bytes[33..37].try_into().unwrap()) as usize;
        let location: Vec<u16> = bytes[48..48 + location_bytes]
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        assert_eq!(String::from_utf16(&location).unwrap(), r"C:\home");
    }

    #[test]
    fn recycle_bin_sorts_by_location() {
        let order = Order {
            key: SortKey::Location,
            ..Order::default()
        };
        let descending = Order {
            descending: true,
            ..order.clone()
        };

        assert_eq!(names(&bin_listing(order)), ["a.txt", "b.txt"]);
        assert_eq!(names(&bin_listing(descending)), ["b.txt", "a.txt"]);
    }

    #[test]
    fn rows_turn_into_full_paths_with_raw_names() {
        let folder = TempFolder::new("paths");
        fs::write(folder.0.join("a.txt"), "").unwrap();
        fs::write(folder.0.join("b.txt"), "").unwrap();
        let listing = Listing::read(folder.0.to_str().unwrap(), Order::default()).unwrap();

        assert_eq!(listing.paths(&[1, 99]), [folder.0.join("b.txt")]);
        assert_eq!(listing.names(&[1, 0]), ["b.txt", "a.txt"]);
    }

    #[test]
    fn rows_keyed_follows_names_and_drops_missing_ones() {
        let folder = TempFolder::new("named");
        for file in ["a", "b", "c"] {
            fs::write(folder.0.join(file), "").unwrap();
        }
        let listing = Listing::read(folder.0.to_str().unwrap(), Order::default()).unwrap();

        let wanted = ["c", "nope", "a"].map(|name| name.encode_utf16().collect());
        assert_eq!(listing.rows_keyed(&wanted), [2, 0]);
    }

    #[test]
    fn recycle_bin_rows_with_one_name_stay_apart() {
        let item = |id: &str, folder: &str| BinItem {
            item: PathBuf::from(format!(r"C:\$Recycle.Bin\$R{id}.txt")),
            original: PathBuf::from(format!(r"C:\{folder}\same.txt")),
            size: 1,
            deleted: 1,
            is_dir: false,
        };
        let before = Listing::from_bin(vec![item("A", "one"), item("B", "two")]).arrange(Order::default());
        let after = Listing::from_bin(vec![item("C", "new"), item("A", "one"), item("B", "two")])
            .arrange(Order::default());

        assert_eq!(before.len(), 2);
        let first = after.rows_keyed(&before.keys(&[0]));
        assert_eq!(after.paths(&first), before.paths(&[0]));
        let second = after.rows_keyed(&before.keys(&[1]));
        assert_eq!(after.paths(&second), before.paths(&[1]));
        assert_eq!(after.rows_keyed(&before.keys(&[0, 1])).len(), 2);
    }

    #[test]
    fn reads_a_folder_through_a_share() {
        let folder = TempFolder::new("share");
        fs::write(folder.0.join("inside.txt"), "").unwrap();
        let (drive, rest) = folder.0.to_str().unwrap().split_once(':').unwrap();
        let shared = format!(r"\\localhost\{drive}${rest}");

        let listing = Listing::read(&shared, Order::default()).unwrap();

        assert_eq!(names(&listing), ["inside.txt"]);
        assert_eq!(listing.paths(&[0]), [Path::new(&shared).join("inside.txt")]);
    }

    #[test]
    fn a_server_lists_its_shares_as_folders_with_admin_ones_hidden() {
        let order = Order {
            show_hidden: true,
            ..Order::default()
        };
        let all = Listing::read(r"\\localhost", order).unwrap();
        let shown = Listing::read(r"\\localhost", Order::default()).unwrap();

        let system = std::env::var("SystemDrive").unwrap().replace(':', "$");
        let row = names(&all).iter().position(|name| name.eq_ignore_ascii_case(&system)).unwrap() as u32;
        assert_eq!(all.paths(&[row]), [PathBuf::from(format!(r"\\localhost\{}", all.names(&[row])[0]))]);
        assert!(all.rows().all(|entry| entry.is_dir));
        assert!(shown.len() < all.len());
    }

    #[test]
    fn a_rows_sync_state_reaches_its_flags() {
        let cases = [
            (FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS.0, FLAG_CLOUD),
            (FILE_ATTRIBUTE_RECALL_ON_OPEN.0, FLAG_CLOUD),
            (FILE_ATTRIBUTE_OFFLINE.0, FLAG_CLOUD),
            (FILE_ATTRIBUTE_PINNED.0, FLAG_PINNED),
            (0, 0),
        ];
        for (attributes, flag) in cases {
            let mut data = WIN32_FIND_DATAW {
                dwFileAttributes: attributes,
                ..Default::default()
            };
            data.cFileName[0] = u16::from(b'a');
            let listing = Listing {
                entries: Arc::new(vec![Entry::from_find_data(&data).unwrap()]),
                ..Listing::default()
            };

            assert_eq!(listing.arrange(Order::default()).encode_rows(0, 1)[32], flag);
        }
    }

    #[test]
    fn missing_folder_is_an_error() {
        let folder = TempFolder::new("missing");
        let missing = folder.0.join("nope");
        assert!(Listing::read(missing.to_str().unwrap(), Order::default()).is_err());
    }

    #[test]
    fn encodes_only_the_requested_rows() {
        let folder = TempFolder::new("encode");
        for file in ["a", "b", "c"] {
            fs::write(folder.0.join(file), "").unwrap();
        }
        hide(&folder.0.join("b"));
        let order = Order {
            show_hidden: true,
            ..Order::default()
        };
        let listing = Listing::read(folder.0.to_str().unwrap(), order).unwrap();

        let bytes = listing.encode_rows(1, 10);

        assert_eq!(bytes[..4], 2u32.to_le_bytes());
        assert_eq!(bytes[4..8], 2u32.to_le_bytes());
        assert_eq!(bytes[32], FLAG_HIDDEN);
        assert_eq!(bytes[38..40], [b'b', 0]);
        assert_eq!(listing.encode_rows(99, 10)[..4], 0u32.to_le_bytes());
    }
}
