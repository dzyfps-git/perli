//! Cloud places: S3-style storage, OneDrive, Dropbox and Google Drive, shown as folders under
//! `\\Perli Cloud\<place>`. A server name with a space never resolves, so a path of one that
//! reaches a plain file call fails at once instead of waiting on the network. Like a ZIP opened
//! as a folder, a place lists through its service, and a file of one opens from a copy taken
//! down into the cache.

mod dropbox;
mod gdrive;
pub mod http;

/// Why a job that changes files in place refuses cloud ones.
pub const ON_THIS_PC: &str = "This works on files on this PC. Copy them here first.";
mod onedrive;
pub mod s3;

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// What a transfer stopped by the user fails with.
pub const STOPPED: &str = "Stopped";
/// Where every place shows, as a server shows its shares.
pub const ROOT: &str = r"\\Perli Cloud";
const PLACES_FILE: &str = "cloud-places.json";
/// A folder read this recently is shown as read, so going back and forth costs no wait.
const LIST_KEEP: Duration = Duration::from_secs(15);

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    S3,
    OneDrive,
    Dropbox,
    Google,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub id: String,
    pub name: String,
    pub kind: Kind,
    /// Who signed in, or the bucket, shown under the name.
    #[serde(default)]
    pub account: String,
    #[serde(default)]
    pub s3: Option<s3::Setup>,
    /// Google's own Docs, Sheets and Slides come down as PDFs rather than Office files.
    #[serde(default)]
    pub pdf: bool,
}

/// One file or folder of a place.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Item {
    pub name: String,
    pub folder: bool,
    pub size: u64,
    /// FILETIME ticks, 0 when the service keeps none, as S3 for a folder.
    pub modified: u64,
    /// Changes whenever the content does: an ETag or a revision.
    pub version: String,
    /// The service's own id for it, where it goes by ids.
    pub id: String,
    /// What else a row says of it: a storage class, or "Google Doc".
    pub note: String,
}

/// An older version of a file the service keeps.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    pub id: String,
    pub size: u64,
    pub modified: u64,
}

/// Called as bytes go by with how many have so far. False stops.
pub type Tick<'a> = &'a mut dyn FnMut(u64) -> bool;

/// What a place's service does. Paths inside a place have `/` between parts, `""` for its top.
pub trait Service: Send + Sync {
    fn list(&self, folder: &str) -> Result<Vec<Item>, String>;
    /// Writes the file from byte `from` on, as a download picked up again.
    fn read(&self, path: &str, item: &Item, from: u64, out: &mut dyn Write, tick: Tick) -> Result<(), String>;
    /// Sends a file on this PC to `folder` as `name`, over `replace` if given. Big files go in
    /// parts, and a send cut off goes on from the last part that landed.
    fn write(&self, folder: &str, name: &str, file: &Path, replace: Option<&Item>, tick: Tick) -> Result<(), String>;
    fn make_folder(&self, folder: &str, name: &str) -> Result<(), String>;
    /// Deletes it, to the service's own bin where it has one. Gives what brings it back, or `""`.
    fn remove(&self, path: &str, item: &Item) -> Result<String, String>;
    fn restore(&self, path: &str, token: &str) -> Result<(), String>;
    /// Moves it within the place, renamed to `name`.
    fn relocate(&self, path: &str, item: &Item, folder: &str, name: &str) -> Result<(), String>;
    /// A copy made by the service itself, with nothing passing through this PC.
    fn duplicate(&self, path: &str, item: &Item, folder: &str, name: &str) -> Result<(), String>;
    /// Whether a delete can be undone.
    fn has_bin(&self) -> bool;
    fn thumbnail(&self, _path: &str, _item: &Item, _edge: u32) -> Result<Option<Vec<u8>>, String> {
        Ok(None)
    }
    /// Files whose names hold `text`, each with the folder it is in.
    fn search(&self, folder: &str, text: &str) -> Result<Vec<(String, Item)>, String>;
    /// Bytes used and in all.
    fn space(&self) -> Result<Option<(u64, u64)>, String> {
        Ok(None)
    }
    /// A link anyone may open, to see or take down the file.
    fn share(&self, path: &str, item: &Item) -> Result<String, String>;
    fn versions(&self, _path: &str, _item: &Item) -> Result<Vec<Version>, String> {
        Ok(Vec::new())
    }
    fn bring_back(&self, _path: &str, _item: &Item, _version: &str) -> Result<(), String> {
        Err("This place keeps no older versions".into())
    }
}

/// Uploads in parts cut off before their end, kept so the next send of the same file to the same
/// place goes on from the last part that landed, even after a restart.
pub mod resume {
    use std::collections::HashMap;
    use std::fs::File;
    use std::sync::Mutex;

    use serde::{Deserialize, Serialize};

    #[derive(Clone, Debug, Default, Deserialize, Serialize)]
    pub struct Session {
        /// The service's own name for the upload: an upload id or an address to send parts to.
        pub id: String,
        /// Bytes that landed.
        pub done: u64,
        /// What each part that landed was called back, where the service wants them at the end.
        pub parts: Vec<String>,
    }

    static FILE: Mutex<()> = Mutex::new(());

    fn read() -> HashMap<String, Session> {
        let text = crate::session::data_file("cloud-uploads.json").and_then(|file| std::fs::read_to_string(file).ok());
        text.and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default()
    }

    fn write(all: &HashMap<String, Session>) {
        if let (Some(file), Ok(text)) = (crate::session::data_file("cloud-uploads.json"), serde_json::to_string(all)) {
            let _ = std::fs::write(file, text);
        }
    }

    /// Names an upload by where it goes and the file's size and time, so a changed file starts again.
    pub fn key(target: &str, file: &File, size: u64) -> String {
        let modified = file.metadata().and_then(|metadata| metadata.modified()).ok().and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |time| time.as_secs());
        format!("{target}|{size}|{modified}")
    }

    pub fn load(key: &str) -> Option<Session> {
        let _held = FILE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        read().remove(key)
    }

    pub fn save(key: &str, session: &Session) {
        let _held = FILE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut all = read();
        all.insert(key.to_string(), session.clone());
        write(&all);
    }

    pub fn clear(key: &str) {
        let _held = FILE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut all = read();
        if all.remove(key).is_some() {
            write(&all);
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Whether `path` is the cloud root or inside it.
pub fn is_remote(path: &Path) -> bool {
    let text = path.as_os_str().to_string_lossy();
    text.len() >= ROOT.len()
        && text.is_char_boundary(ROOT.len())
        && text[..ROOT.len()].eq_ignore_ascii_case(ROOT)
        && matches!(text.as_bytes().get(ROOT.len()), None | Some(b'\\'))
}

/// A path inside a place: the place, its service and the path inside it.
pub struct At {
    pub place: Place,
    pub service: Arc<dyn Service>,
    pub inner: String,
}

impl At {
    /// The path Perli shows for `inner` of this place.
    pub fn shown(&self, inner: &str) -> PathBuf {
        shown(&self.place, inner)
    }

    pub fn parent(&self) -> String {
        parent_of(&self.inner).to_string()
    }

    pub fn name(&self) -> &str {
        self.inner.rsplit('/').next().unwrap_or("")
    }

    /// What the place knows of the item: from the folder's listing, read again if it's old.
    pub fn item(&self) -> Result<Item, String> {
        if self.inner.is_empty() {
            return Ok(Item { name: self.place.name.clone(), folder: true, ..Item::default() });
        }
        let find = |items: &[Item]| items.iter().find(|item| item.name == self.name()).cloned();
        if let Some(found) = find(&listed(self, &self.parent(), false)?) {
            return Ok(found);
        }
        find(&listed(self, &self.parent(), true)?).ok_or_else(|| format!("{} isn't there any more", self.name()))
    }
}

pub fn shown(place: &Place, inner: &str) -> PathBuf {
    let mut path = format!(r"{ROOT}\{}", place.name);
    for part in inner.split('/').filter(|part| !part.is_empty()) {
        path.push('\\');
        path.push_str(part);
    }
    PathBuf::from(path)
}

pub fn parent_of(inner: &str) -> &str {
    inner.rsplit_once('/').map_or("", |(parent, _)| parent)
}

pub fn join(folder: &str, name: &str) -> String {
    if folder.is_empty() { name.to_string() } else { format!("{folder}/{name}") }
}

/// The place and the path in it, `None` outside the cloud or for the cloud root itself.
pub fn at(path: &Path) -> Option<Result<At, String>> {
    spot(path).map(|found| found.and_then(|(place, inner)| service(&place).map(|service| At { place, service, inner })))
}

/// The place and the path in it, with no service made, `None` outside the cloud or for the cloud root itself.
fn spot(path: &Path) -> Option<Result<(Place, String), String>> {
    if !is_remote(path) {
        return None;
    }
    let text = path.to_string_lossy();
    let rest = text[ROOT.len()..].trim_matches('\\');
    if rest.is_empty() {
        return None;
    }
    let (name, inner) = rest.split_once('\\').unwrap_or((rest, ""));
    let Some(place) = places().into_iter().find(|place| place.name.eq_ignore_ascii_case(name)) else {
        return Some(Err(format!("There is no cloud place called {name}")));
    };
    let inner = inner.split('\\').filter(|part| !part.is_empty()).collect::<Vec<_>>().join("/");
    Some(Ok((place, inner)))
}

fn places_file() -> Option<PathBuf> {
    crate::session::data_file(PLACES_FILE)
}

/// The places, read from their file once and again after each change.
static PLACES: Mutex<Option<Vec<Place>>> = Mutex::new(None);

pub fn places() -> Vec<Place> {
    let mut known = lock(&PLACES);
    if known.is_none() {
        let read = places_file().and_then(|file| fs::read_to_string(file).ok());
        *known = Some(read.and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default());
    }
    known.clone().unwrap_or_default()
}

fn save_places(places: &[Place]) -> Result<(), String> {
    let file = places_file().ok_or("There is no folder for Perli's own files")?;
    if let Some(folder) = file.parent() {
        fs::create_dir_all(folder).map_err(|error| error.to_string())?;
    }
    let text = serde_json::to_string_pretty(places).map_err(|error| error.to_string())?;
    let staged = file.with_extension("json.new");
    fs::write(&staged, text).and_then(|()| fs::rename(&staged, &file)).map_err(|error| error.to_string())?;
    *lock(&PLACES) = Some(places.to_vec());
    Ok(())
}

/// A name for a new place that no other has.
fn free_place_name(wanted: &str) -> String {
    let taken = places();
    let clean: String = wanted.chars().filter(|character| !r#"\/:*?"<>|"#.contains(*character)).collect();
    let clean = clean.trim().trim_end_matches('.').to_string();
    let base = if clean.is_empty() { "Cloud".to_string() } else { clean };
    (1..).map(|number| if number == 1 { base.clone() } else { format!("{base} ({number})") }).find(|name| !taken.iter().any(|place| place.name.eq_ignore_ascii_case(name))).unwrap_or(base)
}

/// Adds a place, its secret kept by Windows. Gives it as saved.
pub fn add_place(kind: Kind, name: &str, account: String, s3: Option<s3::Setup>, secret: &str) -> Result<Place, String> {
    let id = http::random_text(12);
    http::keep_secret(&id, secret)?;
    let place = Place { id, name: free_place_name(name), kind, account, s3, pdf: false };
    let mut all = places();
    all.push(place.clone());
    save_places(&all)?;
    Ok(place)
}

/// Adds an S3 bucket once a look at it works, so a wrong key or name shows now.
pub fn add_s3(setup: s3::Setup, secret: &str, name: &str) -> Result<Place, String> {
    s3::S3::new(setup.clone(), secret.to_string()).list("")?;
    let account = setup.bucket.clone();
    add_place(Kind::S3, name, account, Some(setup), secret)
}

/// Signs in to a service in the browser and adds the place it opens.
pub fn sign_in(kind: Kind) -> Result<Place, String> {
    let ((account, refresh), name) = match kind {
        Kind::OneDrive => (onedrive::OneDrive::sign_in()?, "OneDrive"),
        Kind::Dropbox => (dropbox::Dropbox::sign_in()?, "Dropbox"),
        Kind::Google => (gdrive::Google::sign_in()?, "Google Drive"),
        Kind::S3 => return Err("S3 storage opens with a key, not a sign-in".into()),
    };
    add_place(kind, name, account, None, &refresh)
}

pub fn rename_place(id: &str, name: &str) -> Result<Place, String> {
    let fresh = free_place_name(name);
    let mut all = places();
    let place = all.iter_mut().find(|place| place.id == id).ok_or("That place is gone")?;
    place.name = fresh;
    let renamed = place.clone();
    save_places(&all)?;
    Ok(renamed)
}

/// Forgets a place and its secret. Nothing in the cloud changes.
pub fn remove_place(id: &str) -> Result<(), String> {
    let mut all = places();
    all.retain(|place| place.id != id);
    save_places(&all)?;
    http::forget_secret(id);
    lock(services()).remove(id);
    Ok(())
}

/// Whether a Google place's Docs come down as PDFs. Its rows are named again to match.
pub fn set_pdf(id: &str, pdf: bool) -> Result<(), String> {
    let mut all = places();
    all.iter_mut().filter(|place| place.id == id).for_each(|place| place.pdf = pdf);
    save_places(&all)?;
    lock(services()).remove(id);
    lock(lists()).retain(|(place, _), _| place != id);
    Ok(())
}

pub fn reorder_places(ids: &[String]) -> Result<(), String> {
    let mut all = places();
    all.sort_by_key(|place| ids.iter().position(|id| *id == place.id).unwrap_or(usize::MAX));
    save_places(&all)
}

fn services() -> &'static Mutex<HashMap<String, Arc<dyn Service>>> {
    static SERVICES: std::sync::OnceLock<Mutex<HashMap<String, Arc<dyn Service>>>> = std::sync::OnceLock::new();
    SERVICES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn service(place: &Place) -> Result<Arc<dyn Service>, String> {
    if let Some(known) = lock(services()).get(&place.id) {
        return Ok(known.clone());
    }
    let secret = http::secret(&place.id).ok_or_else(|| format!("Sign in to {} again: Windows no longer holds its key", place.name))?;
    let made: Arc<dyn Service> = match place.kind {
        Kind::S3 => Arc::new(s3::S3::new(place.s3.clone().ok_or("This place lost its settings")?, secret)),
        Kind::OneDrive => Arc::new(onedrive::OneDrive::new(&place.id, &secret)?),
        Kind::Dropbox => Arc::new(dropbox::Dropbox::new(&place.id, &secret)?),
        Kind::Google => Arc::new(gdrive::Google::new(&place.id, &secret, place.pdf)?),
    };
    lock(services()).insert(place.id.clone(), made.clone());
    Ok(made)
}

type Lists = HashMap<(String, String), (Instant, Arc<Vec<Item>>)>;

fn lists() -> &'static Mutex<Lists> {
    static LISTS: std::sync::OnceLock<Mutex<Lists>> = std::sync::OnceLock::new();
    LISTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// What `folder` of the place holds, read again when `fresh` or when it's old.
pub fn listed(at: &At, folder: &str, fresh: bool) -> Result<Arc<Vec<Item>>, String> {
    let key = (at.place.id.clone(), folder.to_string());
    if !fresh {
        if let Some((read, items)) = lock(lists()).get(&key) {
            if read.elapsed() < LIST_KEEP {
                return Ok(items.clone());
            }
        }
    }
    let items = Arc::new(at.service.list(folder)?);
    lock(lists()).insert(key, (Instant::now(), items.clone()));
    Ok(items)
}

/// How many times jobs changed each cloud folder: (place, folder, false) counts what the folder
/// holds, and (place, path, true) the path with all below it. The watcher reads these, as it
/// can't list the cloud itself.
type Edits = BTreeMap<(String, String, bool), u64>;
static EDITS: Mutex<Edits> = Mutex::new(BTreeMap::new());

fn note_edit(edits: &mut Edits, place: &str, inner: &str) {
    *edits.entry((place.to_string(), parent_of(inner).to_string(), false)).or_default() += 1;
    *edits.entry((place.to_string(), inner.to_string(), true)).or_default() += 1;
}

fn edits_of(edits: &Edits, place: &str, folder: &str) -> u64 {
    let count = |inner: &str, tree: bool| edits.get(&(place.to_string(), inner.to_string(), tree)).copied().unwrap_or(0);
    let mut total = count(folder, false);
    let mut above = folder;
    loop {
        total += count(above, true);
        if above.is_empty() {
            return total;
        }
        above = parent_of(above);
    }
}

/// A count that moves each time a job changes what the cloud folder at `path` shows, or the
/// places when it is the cloud root. `None` outside the cloud.
pub fn edits(path: &Path) -> Option<u64> {
    match spot(path) {
        Some(Ok((place, inner))) => Some(edits_of(&lock(&EDITS), &place.id, &inner)),
        _ if is_remote(path) => Some(hashed(&places().iter().map(|place| place.name.as_str()).collect::<Vec<_>>().join("/"))),
        _ => None,
    }
}

/// Forgets what was read of the folder holding each path, and of each path, after a job changed them.
pub fn forget(paths: &[PathBuf]) {
    for path in paths {
        let Some(Ok((place, inner))) = spot(path) else { continue };
        note_edit(&mut lock(&EDITS), &place.id, &inner);
        let mut lists = lock(lists());
        lists.remove(&(place.id.clone(), parent_of(&inner).to_string()));
        lists.retain(|(id, folder), _| *id != place.id || !(folder == &inner || folder.starts_with(&format!("{inner}/"))));
    }
}

/// What the service says of the item at `path` beyond its name, such as an S3 storage class or
/// "Google Doc", or a place's account. `None` when it says nothing, or outside the cloud.
pub fn note(path: &Path) -> Option<String> {
    let at = at(path)?.ok()?;
    let note = if at.inner.is_empty() { at.place.account.clone() } else { at.item().ok()?.note };
    Some(note).filter(|note| !note.is_empty())
}

/// The rows of the cloud root: every place, as a folder.
pub fn place_items() -> Vec<Item> {
    places().into_iter().map(|place| Item { name: place.name, folder: true, note: place.account, ..Item::default() }).collect()
}

/// What a cloud folder holds, each with whether it is kept on this PC: the places at the top,
/// else the folder's own, read again when `fresh`. `None` outside the cloud.
pub fn rows(path: &Path, fresh: bool) -> Option<Result<Vec<(Item, bool)>, String>> {
    if !is_remote(path) {
        return None;
    }
    let Some(found) = at(path) else {
        return Some(Ok(place_items().into_iter().map(|item| (item, false)).collect()));
    };
    Some(found.and_then(|at| {
        let items = listed(&at, &at.inner, fresh)?;
        let kept = |item: &Item| {
            let child = At { place: at.place.clone(), service: at.service.clone(), inner: join(&at.inner, &item.name) };
            !item.folder && offline_slot(&child).is_some_and(|slot| slot.join(".version").exists())
        };
        Ok(items.iter().map(|item| (item.clone(), kept(item))).collect())
    }))
}

fn hashed(text: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    text.hash(&mut hasher);
    hasher.finish()
}

/// Where kept-offline files live: Perli's own folder, which no sweep empties.
fn offline_root() -> Option<PathBuf> {
    crate::session::data_file("cloud-offline")
}

fn offline_slot(at: &At) -> Option<PathBuf> {
    Some(offline_root()?.join(&at.place.id).join(format!("{:016x}", hashed(&at.inner))))
}

/// The version a kept-offline copy was taken at, or `None` when it isn't kept.
fn offline_version(at: &At) -> Option<String> {
    fs::read_to_string(offline_slot(at)?.join(".version")).ok()
}

/// Whether the file at `path` is kept on this PC, to open with no network.
pub fn is_offline(path: &Path) -> bool {
    matches!(at(path), Some(Ok(at)) if offline_version(&at).is_some())
}

/// Keeps a copy of each file on this PC, taken again whenever it changes in the cloud, or lets it go.
pub fn keep_offline(paths: &[PathBuf], keep: bool) -> Result<(), String> {
    for path in paths {
        let Some(found) = at(path) else { continue };
        let at = found?;
        let slot = offline_slot(&at).ok_or("There is no folder for Perli's own files")?;
        if !keep {
            let _ = fs::remove_dir_all(&slot);
            continue;
        }
        let item = at.item()?;
        if item.folder {
            return Err(format!("{} is a folder: keep its files one by one", item.name));
        }
        take_down(&at, &item, &slot)?;
        fs::write(slot.join(".version"), &item.version).map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// A name a service gave as one name on this PC: no folder parts and nothing Windows refuses or
/// reads as a device, so a file a service calls `..\x` or `CON` lands where it was sent.
pub fn local_name(name: &str) -> String {
    let mut safe: String = name.chars().map(|c| if c < ' ' || "<>:\"/\\|?*".contains(c) { '_' } else { c }).collect();
    // Windows drops dots and spaces at the end of a name, so `..` would be no name at all.
    while safe.ends_with(['.', ' ']) {
        safe.pop();
    }
    if safe.is_empty() {
        return "_".into();
    }
    let stem = safe.split('.').next().unwrap_or_default().trim_end().to_ascii_uppercase();
    let numbered = stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && stem.as_bytes()[3].is_ascii_digit();
    if numbered || ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"].contains(&stem.as_str()) {
        safe.insert(0, '_');
    }
    safe
}

/// Takes the file down into `slot`, under its own name, unless it is there already.
fn take_down(at: &At, item: &Item, slot: &Path) -> Result<PathBuf, String> {
    let name = local_name(&item.name);
    let target = slot.join(&name);
    if target.exists() {
        return Ok(target);
    }
    fs::create_dir_all(slot).map_err(|error| error.to_string())?;
    let part = slot.join(format!("{name}.part"));
    let from = fs::metadata(&part).map_or(0, |metadata| metadata.len());
    let mut file = fs::OpenOptions::new().create(true).append(true).open(&part).map_err(|error| error.to_string())?;
    at.service.read(&at.inner, item, from, &mut file, &mut |_| true)?;
    drop(file);
    fs::rename(&part, &target).map_err(|error| error.to_string())?;
    Ok(target)
}

/// A file or folder of a place as a real one on disk: kept offline, or taken down into the
/// cache once for each version. `None` outside the cloud.
pub fn real(path: &Path) -> Option<Result<PathBuf, String>> {
    if !is_remote(path) {
        return None;
    }
    Some(real_at(path))
}

fn real_at(path: &Path) -> Result<PathBuf, String> {
    let at = at(path).ok_or("The cloud itself has no files to open")??;
    // A kept file opens with no network: when the place can't be asked, the copy kept is it.
    let kept = offline_slot(&at).map(|slot| slot.join(local_name(at.name()))).filter(|kept| offline_version(&at).is_some() && kept.exists());
    let item = match at.item() {
        Ok(item) => item,
        Err(message) => return kept.ok_or(message),
    };
    if !item.folder && offline_version(&at).as_deref() == Some(item.version.as_str()) {
        if let Some(kept) = kept {
            return Ok(kept);
        }
    }
    let slot = crate::zipped::cache_root().join(format!("cloud-{}-{:016x}-{:016x}", at.place.id, hashed(&at.inner), hashed(&item.version)));
    if item.folder {
        // Taken down afresh each time: a folder's version can stay the same while what it holds
        // changes, as S3's always does, and an old copy would keep files changed or gone since.
        let _ = fs::remove_dir_all(&slot);
        let target = slot.join(local_name(&item.name));
        take_down_folder(&at, &at.inner, &target)?;
        return Ok(target);
    }
    let taken = take_down(&at, &item, &slot)?;
    // A kept file changed in the cloud: its offline copy follows.
    if offline_version(&at).is_some() {
        if let Some(kept) = offline_slot(&at) {
            let _ = fs::remove_dir_all(&kept);
            if fs::create_dir_all(&kept).is_ok() && fs::copy(&taken, kept.join(local_name(&item.name))).is_ok() {
                let _ = fs::write(kept.join(".version"), &item.version);
            }
        }
    }
    Ok(taken)
}

/// Takes down everything a folder holds now, as the place lists it afresh.
fn take_down_folder(at: &At, inner: &str, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|error| error.to_string())?;
    for item in listed(at, inner, true)?.iter() {
        let path = join(inner, &item.name);
        if item.folder {
            take_down_folder(at, &path, &target.join(local_name(&item.name)))?;
        } else {
            let child = At { place: at.place.clone(), service: at.service.clone(), inner: path };
            take_down(&child, item, target)?;
        }
    }
    Ok(())
}

/// What a folder of a place holds all the way down, as the place lists it now, as one number:
/// it differs once anything inside was added, changed or taken away.
pub fn tree_print(at: &At) -> Result<u64, String> {
    fn walk(at: &At, inner: &str, hasher: &mut DefaultHasher) -> Result<(), String> {
        for item in listed(at, inner, true)?.iter() {
            let path = join(inner, &item.name);
            (&path, item.folder, item.size, item.modified, &item.version).hash(hasher);
            if item.folder {
                walk(at, &path, hasher)?;
            }
        }
        Ok(())
    }
    let mut hasher = DefaultHasher::new();
    walk(at, &at.inner, &mut hasher)?;
    Ok(hasher.finish())
}

/// Whether two places are one storage under two names, such as a bucket added twice, so a path
/// in one is the same path in the other.
pub fn same_store(a: &Place, b: &Place) -> bool {
    if a.id == b.id {
        return true;
    }
    if a.kind != b.kind {
        return false;
    }
    match (&a.s3, &b.s3) {
        (Some(one), Some(two)) => one.endpoint.trim_end_matches('/').eq_ignore_ascii_case(two.endpoint.trim_end_matches('/')) && one.bucket == two.bucket,
        // Signed in as the same account; one with no address said is never taken for another.
        (None, None) => a.account.contains('@') && a.account.eq_ignore_ascii_case(&b.account),
        _ => false,
    }
}

/// Pictures at most this big come down whole for their row's picture where the service makes none.
const SMALL_PICTURE: u64 = 8 * 1024 * 1024;

/// A row's picture, `edge` pixels on its longest side, in the form `thumbs::read` gives, or empty
/// for none: the service's own, else a small picture's whole file.
pub fn picture(path: &Path, edge: u32) -> Vec<u8> {
    let Some(Ok(at)) = at(path) else { return Vec::new() };
    let Ok(item) = at.item() else { return Vec::new() };
    if item.folder {
        return Vec::new();
    }
    let made = at.service.thumbnail(&at.inner, &item, edge).ok().flatten();
    let small = || {
        let fits = crate::inside::is_picture(&item.name) && item.size <= SMALL_PICTURE;
        fits.then(|| real(path)?.ok()).flatten().and_then(|file| fs::read(file).ok())
    };
    made.or_else(small).and_then(|bytes| crate::inside::decode(&bytes, edge).ok()).unwrap_or_default()
}

/// What a place tells of itself: its space, and whether a delete can be undone.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct About {
    pub used: Option<u64>,
    pub total: Option<u64>,
    pub has_bin: bool,
    pub kind: Kind,
}

pub fn about(path: &Path) -> Result<About, String> {
    let at = at(path).ok_or("Not in a cloud place")??;
    let space = at.service.space().unwrap_or(None);
    Ok(About { used: space.map(|(used, _)| used), total: space.map(|(_, total)| total), has_bin: at.service.has_bin(), kind: at.place.kind })
}

pub fn share(path: &Path) -> Result<String, String> {
    let at = at(path).ok_or("Not in a cloud place")??;
    let item = at.item()?;
    at.service.share(&at.inner, &item)
}

pub fn versions(path: &Path) -> Result<Vec<Version>, String> {
    let at = at(path).ok_or("Not in a cloud place")??;
    let item = at.item()?;
    at.service.versions(&at.inner, &item)
}

pub fn bring_back(path: &Path, version: &str) -> Result<(), String> {
    let at = at(path).ok_or("Not in a cloud place")??;
    let item = at.item()?;
    at.service.bring_back(&at.inner, &item, version)?;
    forget(&[path.to_path_buf()]);
    Ok(())
}

/// Files of a place whose names hold `text`, as shown paths with what is known of each.
pub fn search(folder: &Path, text: &str) -> Result<Vec<(PathBuf, Item)>, String> {
    let at = at(folder).ok_or("Not in a cloud place")??;
    let found = at.service.search(&at.inner, text)?;
    Ok(found.into_iter().map(|(parent, item)| (at.shown(&join(&parent, &item.name)), item)).collect())
}

/// Seconds since 1970 as FILETIME ticks.
pub fn ticks_from_unix(seconds: i64) -> u64 {
    const UNIX_START: i64 = 116_444_736_000_000_000;
    (seconds.saturating_mul(10_000_000) + UNIX_START).max(0) as u64
}

/// An RFC 3339 time, such as `2026-11-18T09:30:00Z` or with a fraction or an offset, as
/// FILETIME ticks. 0 for anything else.
pub fn ticks_from_text(text: &str) -> u64 {
    parse_time(text.trim()).unwrap_or(0)
}

fn parse_time(text: &str) -> Option<u64> {
    let number = |range: std::ops::Range<usize>| text.get(range)?.parse::<i64>().ok();
    let (year, month, day) = (number(0..4)?, number(5..7)?, number(8..10)?);
    let (hour, minute, second) = (number(11..13)?, number(14..16)?, number(17..19)?);
    let mut rest = text.get(19..)?;
    let mut fraction = 0u64;
    if let Some(after) = rest.strip_prefix('.') {
        let digits = after.chars().take_while(char::is_ascii_digit).count();
        let seven: String = after[..digits].chars().chain(std::iter::repeat('0')).take(7).collect();
        fraction = seven.parse().ok()?;
        rest = &after[digits..];
    }
    let offset = match rest {
        "Z" | "z" | "" => 0,
        zone => {
            let sign = match zone.as_bytes().first()? { b'+' => 1, b'-' => -1, _ => return None };
            let (hours, minutes) = (zone.get(1..3)?.parse::<i64>().ok()?, zone.get(4..6)?.parse::<i64>().ok()?);
            sign * (hours * 3600 + minutes * 60)
        }
    };
    // Days from 1970 to the date, by the civil calendar.
    let (y, m) = if month <= 2 { (year - 1, month + 9) } else { (year, month - 3) };
    let era = y.div_euclid(400);
    let of_era = y - era * 400;
    let of_year = (153 * m + 2) / 5 + day - 1;
    let of_era_days = of_era * 365 + of_era / 4 - of_era / 100 + of_year;
    let days = era * 146_097 + of_era_days - 719_468;
    let seconds = days * 86_400 + hour * 3600 + minute * 60 + second - offset;
    Some(ticks_from_unix(seconds) + fraction)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_from_a_service_is_one_safe_name_here() {
        assert_eq!(local_name("photo.jpg"), "photo.jpg");
        assert_eq!(local_name(r"..\..\Windows\evil.dll"), ".._.._Windows_evil.dll");
        assert_eq!(local_name("a/b:c?.txt"), "a_b_c_.txt");
        assert_eq!(local_name(".."), "_");
        assert_eq!(local_name("name. "), "name");
        assert_eq!(local_name("CON"), "_CON");
        assert_eq!(local_name("com1.txt"), "_com1.txt");
        assert_eq!(local_name("Console.txt"), "Console.txt");
        assert_eq!(local_name("tab\there"), "tab_here", "a tab is no part of a name");
    }

    #[test]
    fn two_places_on_one_storage_are_told_apart_from_two_on_two() {
        let s3 = |id: &str, endpoint: &str, bucket: &str| Place {
            id: id.into(),
            name: id.into(),
            kind: Kind::S3,
            account: bucket.into(),
            s3: Some(s3::Setup { preset: String::new(), endpoint: endpoint.into(), region: String::new(), bucket: bucket.into(), path_style: false, key_id: String::new() }),
            pdf: false,
        };
        assert!(same_store(&s3("a", "https://s3.example.com/", "photos"), &s3("b", "https://S3.example.com", "photos")));
        assert!(!same_store(&s3("a", "https://s3.example.com", "photos"), &s3("b", "https://s3.example.com", "films")));
        let drive = |id: &str, account: &str| Place { id: id.into(), name: id.into(), kind: Kind::OneDrive, account: account.into(), s3: None, pdf: false };
        assert!(same_store(&drive("a", "me@example.com"), &drive("b", "Me@Example.com")));
        assert!(!same_store(&drive("a", "OneDrive"), &drive("b", "OneDrive")), "no address said is never the same");
        assert!(!same_store(&drive("a", "me@example.com"), &drive("b", "you@example.com")));
    }

    #[test]
    fn a_job_moves_the_count_of_the_folders_it_changed_and_no_others() {
        let mut edits = Edits::new();
        let of = |edits: &Edits| ["", "a", "a/b", "a/b/c", "z"].map(|folder| edits_of(edits, "p", folder));
        let before = of(&edits);
        // A new file in a/b: a/b's listing changed, and below b is gone stale too.
        note_edit(&mut edits, "p", "a/b");
        let after = of(&edits);
        assert_eq!(after[0], before[0], "the top doesn't change");
        assert_ne!(after[1], before[1], "a holds b, whose time may move");
        assert_ne!(after[2], before[2]);
        assert_ne!(after[3], before[3], "below a/b, read again");
        assert_eq!(after[4], before[4], "a folder beside it doesn't change");
        assert_eq!(edits_of(&edits, "other place", "a/b"), 0);
    }

    #[test]
    fn cloud_paths_are_told_apart_from_real_servers() {
        assert!(is_remote(Path::new(r"\\Perli Cloud")));
        assert!(is_remote(Path::new(r"\\perli cloud\Work\a.txt")));
        assert!(!is_remote(Path::new(r"\\Perli Cloudy\x")));
        assert!(!is_remote(Path::new(r"C:\Perli Cloud")));
        assert_eq!(parent_of("a/b/c"), "a/b");
        assert_eq!(parent_of("a"), "");
        assert_eq!(join("", "a"), "a");
        assert_eq!(join("a", "b"), "a/b");
    }

    #[test]
    fn times_turn_into_ticks() {
        assert_eq!(ticks_from_unix(0), 116_444_736_000_000_000);
        assert_eq!(ticks_from_text("1970-01-01T00:00:01Z"), 116_444_736_010_000_000);
        assert_eq!(ticks_from_text("1970-01-01T01:00:00.5+01:00"), 116_444_736_005_000_000);
        assert_eq!(ticks_from_text("nonsense"), 0);
        // 2026-11-18T09:30:00Z is 1_794_994_200 seconds after 1970.
        assert_eq!(ticks_from_text("2026-11-18T09:30:00Z"), ticks_from_unix(1_794_994_200));
        assert_eq!(ticks_from_text("2000-02-29T00:00:00Z"), ticks_from_unix(951_782_400));
    }
}
