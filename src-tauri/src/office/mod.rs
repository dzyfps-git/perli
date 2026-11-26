//! Word, Excel and PowerPoint files, and their LibreOffice cousins, read by Perli itself: for a
//! PC without Office, for a file from the internet, and for the facts strip over Office's own
//! previewer. Nothing in a document runs and nothing is fetched: pictures come only from inside
//! the file, and links show where they lead without going there.

mod legacy;
mod locked;
mod sheet;
mod slides;
mod word;

use std::collections::HashMap;
use std::fs::File;
use std::io::{Cursor, Read as _, Seek};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use serde::Serialize;

pub use sheet::Sheet;
pub use slides::Slide;

/// What Rust says when a password doesn't open a file, as the password card knows it.
pub const WRONG_PASSWORD: &str = "Wrong password";
/// The most of one part of a document that is read: a huge sheet stops here.
const MOST_PART_BYTES: u64 = 96 * 1024 * 1024;
/// The most a locked file may be, since it is unlocked in memory.
const MOST_LOCKED_BYTES: u64 = 256 * 1024 * 1024;
/// A saved thumbnail bigger than this is not a thumbnail.
const MOST_THUMBNAIL_BYTES: u64 = 8 * 1024 * 1024;
/// How many unlocked files stay in memory, for their pictures and a step back to them.
const MOST_UNLOCKED: usize = 2;
const COMPOUND: &[u8] = b"\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1";

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Family {
    Word,
    Sheet,
    Slides,
}

/// What shows before the document itself: which kind, its facts, and what Perli knows of it.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Facts {
    pub family: Family,
    /// Label and value pairs, such as "Pages" and "12".
    pub facts: Vec<[String; 2]>,
    /// It carries macros, which Perli never runs.
    pub macros: bool,
    /// It is under a password.
    pub locked: bool,
    /// It came from the internet, so Office's own previewer isn't used unless asked for.
    pub marked: bool,
    /// Windows has a previewer for it, such as Office's.
    pub handler: bool,
}

/// A document as Perli's own reader shows it.
#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "family", rename_all = "camelCase")]
pub enum Doc {
    /// A page of HTML that runs nothing, with pictures as `canvas[data-picture]` named by their
    /// part, and the plain text for find and compare.
    Word { html: String, text: String },
    Sheet { sheets: Vec<Sheet> },
    Slides { slides: Vec<Slide> },
}

/// A document and what Perli left out of it, if anything.
#[derive(Debug, PartialEq, Serialize)]
pub struct Reading {
    #[serde(flatten)]
    pub doc: Doc,
    pub note: Option<String>,
}

/// The kind of document a name says, if it is one Perli reads.
pub fn family_of(path: &Path) -> Option<Family> {
    let extension = path.extension()?.to_string_lossy().to_lowercase();
    Some(match extension.as_str() {
        "docx" | "docm" | "dotx" | "dotm" | "odt" | "ott" | "doc" | "dot" => Family::Word,
        "xlsx" | "xlsm" | "xltx" | "xltm" | "ods" | "ots" | "xls" | "xlt" => Family::Sheet,
        "pptx" | "pptm" | "potx" | "potm" | "ppsx" | "ppsm" | "odp" | "otp" | "ppt" | "pps" | "pot" => Family::Slides,
        _ => return None,
    })
}

fn is_open_document(path: &Path) -> bool {
    path.extension().is_some_and(|extension| matches!(extension.to_string_lossy().to_lowercase().as_str(), "odt" | "ott" | "ods" | "ots" | "odp" | "otp"))
}

/// Whether Windows marked the file as from the internet, as a browser does for a download.
/// Zone 3 is the internet and 4 is restricted sites.
pub fn from_internet(path: &Path) -> bool {
    let mut stream = path.as_os_str().to_owned();
    stream.push(":Zone.Identifier");
    let Ok(text) = std::fs::read_to_string(PathBuf::from(stream)) else { return false };
    text.lines()
        .find_map(|line| line.trim().strip_prefix("ZoneId="))
        .and_then(|zone| zone.trim().parse::<u32>().ok())
        .is_some_and(|zone| zone >= 3)
}

/// The light part of a preview: the facts, read from the document's own summary.
pub fn facts(path: &Path, handler: bool) -> Option<Facts> {
    let family = family_of(path)?;
    let marked = from_internet(path);
    let mut facts = Facts { family, facts: Vec::new(), macros: has_macro_name(path), locked: false, marked, handler };
    match Package::open(path, None, None) {
        Ok(mut package) => {
            facts.facts = if is_open_document(path) { package.open_document_facts() } else { package.facts() };
            facts.macros |= package.has_macros();
        }
        Err(Opened::Locked) => facts.locked = true,
        Err(Opened::Compound) => {
            let (macros, locked) = legacy::marks(path);
            facts.macros |= macros;
            facts.locked = locked;
        }
        Err(Opened::Failed(_)) => {}
    }
    Some(facts)
}

fn has_macro_name(path: &Path) -> bool {
    path.extension().is_some_and(|extension| {
        let extension = extension.to_string_lossy().to_lowercase();
        extension.len() == 4 && extension.ends_with('m') && ["doc", "dot", "xls", "xlt", "ppt", "pot", "pps"].contains(&&extension[..3])
    })
}

/// The whole document, for Perli's own reader. A locked one needs its password once; it then
/// stays open in memory until the preview lets it go.
pub fn read(path: &Path, password: Option<&str>) -> Result<Reading, String> {
    read_for(path, password, None)
}

/// Like `read`, for one preview: a document it unlocks stays open for that preview only, until
/// `forget` lets it go.
pub fn read_for(path: &Path, password: Option<&str>, session: Option<u64>) -> Result<Reading, String> {
    let family = family_of(path).ok_or("Perli doesn't read this kind of document")?;
    let mut package = match Package::open(path, password, session) {
        Ok(package) => package,
        Err(Opened::Compound) => return legacy::read(path, family),
        Err(Opened::Locked) => return Err(WRONG_PASSWORD.into()),
        Err(Opened::Failed(reason)) => return Err(reason),
    };
    let open_document = is_open_document(path);
    if open_document && package.text("META-INF/manifest.xml").is_some_and(|manifest| manifest.contains("encryption-data")) {
        return Err("It is under a LibreOffice password, which only LibreOffice opens".into());
    }
    match family {
        Family::Word if open_document => word::open_document(&mut package),
        Family::Word => word::read(&mut package),
        Family::Sheet if open_document => sheet::open_document(&mut package),
        Family::Sheet => sheet::read(&mut package),
        Family::Slides if open_document => slides::open_document(&mut package),
        Family::Slides => slides::read(&mut package),
    }
}

/// A document's words alone, for a compare. `None` when it isn't a document Perli reads, or is
/// locked.
pub fn plain_text(path: &Path) -> Option<String> {
    family_of(path)?;
    let read = read(path, None).ok()?;
    Some(match read.doc {
        Doc::Word { text, .. } => text,
        Doc::Sheet { sheets } => sheets.iter().map(Sheet::text).collect::<Vec<_>>().join("\n\n"),
        Doc::Slides { slides } => slides.iter().map(Slide::text).collect::<Vec<_>>().join("\n\n"),
    })
}

/// A picture inside a document, `edge` pixels on its longest side at most.
/// A preview's `session` reaches what it unlocked.
pub fn picture(path: &Path, entry: &str, edge: u32, session: Option<u64>) -> Result<Vec<u8>, String> {
    let mut package = match Package::open(path, None, session) {
        Ok(package) => package,
        Err(Opened::Locked) => return Err("Unlock it first".into()),
        Err(Opened::Compound) => return Err("Old documents keep their pictures in a way Perli doesn't read".into()),
        Err(Opened::Failed(reason)) => return Err(reason),
    };
    let bytes = package.bytes(entry, MOST_PART_BYTES).ok_or_else(|| format!("{entry} is missing"))?;
    crate::inside::decode(&bytes, edge.clamp(1, 4096)).map_err(|error| error.message())
}

/// The small picture Office or LibreOffice saved into the file, for a tile when Windows has
/// none. Read straight from the file, so a locked one never shows what is under its password.
/// EMF and WMF pictures are left out, since Perli can't draw them.
pub fn thumbnail(path: &Path, edge: u32) -> Option<Vec<u8>> {
    family_of(path)?;
    let mut zip = zip::ZipArchive::new(std::io::BufReader::new(File::open(path).ok()?)).ok()?;
    let name = zip.file_names().filter_map(Result::ok).find(|name| is_thumbnail(name))?.to_string();
    let entry = zip.by_name(&name).ok()?;
    if entry.size() > MOST_THUMBNAIL_BYTES {
        return None;
    }
    let mut bytes = Vec::new();
    entry.take(MOST_THUMBNAIL_BYTES).read_to_end(&mut bytes).ok()?;
    crate::inside::decode(&bytes, edge.clamp(1, 4096)).ok()
}

fn is_thumbnail(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    (name.starts_with("docprops/thumbnail.") || name.starts_with("thumbnails/thumbnail."))
        && [".png", ".jpg", ".jpeg", ".gif", ".bmp"].iter().any(|kind| name.ends_with(kind))
}

/// Lets go of what a preview unlocked, as it closes. An unlock still running for it is dropped
/// when it ends.
pub fn forget(session: u64) {
    let mut kept = UNLOCKED.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    kept.open.retain(|unlocked| unlocked.session != session);
    kept.closed.push(session);
    if kept.closed.len() > MOST_CLOSED {
        kept.closed.remove(0);
    }
}

/// A document unlocked with its password for one preview, with how the file stood, so a change
/// to the file locks it again.
struct Unlocked {
    session: u64,
    path: PathBuf,
    seen: Option<crate::ops::Seen>,
    bytes: Arc<Vec<u8>>,
}

struct Kept {
    open: Vec<Unlocked>,
    /// Previews that have closed, so an unlock that ends after its preview keeps nothing.
    closed: Vec<u64>,
}

static UNLOCKED: Mutex<Kept> = Mutex::new(Kept { open: Vec::new(), closed: Vec::new() });
/// Closed previews remembered; an unlock outlives its preview by seconds, not by this many.
const MOST_CLOSED: usize = 256;

fn unlocked(path: &Path, session: u64) -> Option<Arc<Vec<u8>>> {
    let seen = crate::ops::seen(path);
    let kept = UNLOCKED.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    kept.open.iter().find(|unlocked| unlocked.session == session && unlocked.path == path && unlocked.seen == seen).map(|unlocked| unlocked.bytes.clone())
}

fn keep_unlocked(path: &Path, session: u64, bytes: Arc<Vec<u8>>) {
    let mut kept = UNLOCKED.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if kept.closed.contains(&session) {
        return;
    }
    kept.open.retain(|unlocked| unlocked.session != session);
    kept.open.push(Unlocked { session, path: path.to_path_buf(), seen: crate::ops::seen(path), bytes });
    if kept.open.len() > MOST_UNLOCKED {
        kept.open.remove(0);
    }
}

trait Source: std::io::Read + Seek + Send {}
impl<T: std::io::Read + Seek + Send> Source for T {}

pub(crate) enum Opened {
    /// Under a password that wasn't given or didn't open it.
    Locked,
    /// A compound file of the 97 to 2003 kind, which `legacy` reads.
    Compound,
    Failed(String),
}

/// A ZIP of XML parts, as Office since 2007 and LibreOffice write.
pub(crate) struct Package {
    zip: zip::ZipArchive<Box<dyn Source>>,
}

/// Where a relationship leads: a part inside, or an address outside.
pub(crate) struct Target {
    pub part: String,
    pub external: bool,
    pub kind: String,
}

impl Package {
    pub(crate) fn open(path: &Path, password: Option<&str>, session: Option<u64>) -> Result<Package, Opened> {
        if let Some(bytes) = session.and_then(|session| unlocked(path, session)) {
            return Self::from_bytes(Arc::unwrap_or_clone(bytes));
        }
        let mut file = File::open(path).map_err(|error| Opened::Failed(error.to_string()))?;
        let mut start = [0u8; 8];
        let read = file.read(&mut start).map_err(|error| Opened::Failed(error.to_string()))?;
        if read == 8 && start == COMPOUND {
            if !locked::is_locked(path) {
                return Err(Opened::Compound);
            }
            let Some(password) = password else { return Err(Opened::Locked) };
            if std::fs::metadata(path).map_or(0, |data| data.len()) > MOST_LOCKED_BYTES {
                return Err(Opened::Failed("It is too big to unlock here".into()));
            }
            let bytes = locked::unlock(path, password)?;
            let package = Self::from_bytes(bytes.clone())?;
            if let Some(session) = session {
                keep_unlocked(path, session, Arc::new(bytes));
            }
            return Ok(package);
        }
        file.rewind().map_err(|error| Opened::Failed(error.to_string()))?;
        let source: Box<dyn Source> = Box::new(std::io::BufReader::new(file));
        let zip = zip::ZipArchive::new(source).map_err(|_| Opened::Failed("It isn't a document Perli can read".into()))?;
        Ok(Package { zip })
    }

    fn from_bytes(bytes: Vec<u8>) -> Result<Package, Opened> {
        let source: Box<dyn Source> = Box::new(Cursor::new(bytes));
        let zip = zip::ZipArchive::new(source).map_err(|_| Opened::Failed("It unlocked, but what is inside isn't a document".into()))?;
        Ok(Package { zip })
    }

    /// A part's bytes, up to `most`. A part named with a leading slash is found too.
    pub(crate) fn bytes(&mut self, name: &str, most: u64) -> Option<Vec<u8>> {
        let name = name.trim_start_matches('/');
        let entry = self.zip.by_name(name).ok()?;
        if entry.size() > most {
            return None;
        }
        let mut bytes = Vec::with_capacity(entry.size() as usize);
        entry.take(most).read_to_end(&mut bytes).ok()?;
        Some(bytes)
    }

    pub(crate) fn text(&mut self, name: &str) -> Option<String> {
        let bytes = self.bytes(name, MOST_PART_BYTES)?;
        Some(match String::from_utf8(bytes) {
            Ok(text) => text,
            Err(error) => String::from_utf8_lossy(error.as_bytes()).into_owned(),
        })
    }

    /// The relationships of `part`, by their ids, with targets made whole.
    pub(crate) fn rels(&mut self, part: &str) -> HashMap<String, Target> {
        let (folder, file) = part.rsplit_once('/').unwrap_or(("", part));
        let rels_name = if folder.is_empty() { format!("_rels/{file}.rels") } else { format!("{folder}/_rels/{file}.rels") };
        let mut found = HashMap::new();
        let Some(xml) = self.text(&rels_name) else { return found };
        walk(&xml, |node| {
            if let Node::Open(name, start) = node {
                if name == "Relationship" {
                    let (Some(id), Some(target)) = (attribute(start, "Id"), attribute(start, "Target")) else { return };
                    let external = attribute(start, "TargetMode").is_some_and(|mode| mode == "External");
                    let kind = attribute(start, "Type").unwrap_or_default();
                    let part = if external { target } else { resolve(folder, &target) };
                    found.insert(id, Target { part, external, kind });
                }
            }
        });
        found
    }

    fn has_macros(&self) -> bool {
        self.zip.file_names().filter_map(Result::ok).any(|name| name.ends_with("vbaProject.bin") || name.starts_with("Basic/") || name.starts_with("Scripts/"))
    }

    /// The summary Office writes in docProps.
    fn facts(&mut self) -> Vec<[String; 2]> {
        let mut found: Vec<[String; 2]> = Vec::new();
        let mut add = |label: &str, value: String| {
            if !value.trim().is_empty() {
                found.push([label.into(), value.trim().into()]);
            }
        };
        let core = self.text("docProps/core.xml").map(|xml| fields(&xml)).unwrap_or_default();
        let app = self.text("docProps/app.xml").map(|xml| fields(&xml)).unwrap_or_default();
        let get = |from: &HashMap<String, String>, name: &str| from.get(name).cloned().unwrap_or_default();
        add("Title", get(&core, "title"));
        for (name, label) in [("Pages", "Pages"), ("Words", "Words"), ("Slides", "Slides"), ("Notes", "Notes")] {
            let value = get(&app, name);
            if value.parse::<u64>().is_ok_and(|count| count > 0) {
                add(label, value.parse::<u64>().map(group).unwrap_or(value));
            }
        }
        add("Author", get(&core, "creator"));
        add("Last saved by", get(&core, "lastModifiedBy"));
        add("Saved", day_of(&get(&core, "modified")));
        add("Revision", get(&core, "revision"));
        found
    }

    /// The summary LibreOffice writes in meta.xml.
    fn open_document_facts(&mut self) -> Vec<[String; 2]> {
        let mut found: Vec<[String; 2]> = Vec::new();
        let Some(xml) = self.text("meta.xml") else { return found };
        let meta = fields(&xml);
        let mut statistics = HashMap::new();
        walk(&xml, |node| {
            if let Node::Open("document-statistic", start) = node {
                for key in ["page-count", "word-count", "object-count"] {
                    if let Some(value) = attribute(start, key) {
                        statistics.insert(key, value);
                    }
                }
            }
        });
        let mut add = |label: &str, value: Option<String>| {
            if let Some(value) = value.filter(|value| !value.trim().is_empty()) {
                found.push([label.into(), value.trim().into()]);
            }
        };
        add("Title", meta.get("title").cloned());
        add("Pages", statistics.get("page-count").cloned());
        add("Words", statistics.get("word-count").and_then(|count| count.parse().ok()).map(group));
        add("Author", meta.get("initial-creator").cloned());
        add("Last saved by", meta.get("creator").cloned());
        add("Saved", meta.get("date").map(|date| day_of(date)));
        found
    }
}

/// `target` read from inside `folder`, with `..` steps taken and a leading slash meaning the top.
fn resolve(folder: &str, target: &str) -> String {
    let target = target.split(['#', '?']).next().unwrap_or(target);
    let mut parts: Vec<&str> = if target.starts_with('/') { Vec::new() } else { folder.split('/').filter(|part| !part.is_empty()).collect() };
    for part in target.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            part => parts.push(part),
        }
    }
    parts.join("/")
}

/// Each simple element's text, by its local name: enough for the summary parts.
fn fields(xml: &str) -> HashMap<String, String> {
    let mut found = HashMap::new();
    let mut open: Option<String> = None;
    let mut text = String::new();
    walk(xml, |node| match node {
        Node::Open(name, _) => {
            open = Some(name.to_string());
            text.clear();
        }
        Node::Text(piece) => text.push_str(piece),
        Node::Close(name) => {
            if open.as_deref() == Some(name) {
                found.entry(open.take().unwrap_or_default()).or_insert_with(|| text.clone());
            }
            open = None;
        }
    });
    found
}

/// "2024-03-05T10:00:00Z" as its day.
fn day_of(stamp: &str) -> String {
    stamp.get(..10).filter(|day| day.as_bytes().get(4) == Some(&b'-')).unwrap_or(stamp).to_string()
}

/// 12345 as "12,345".
pub(crate) fn group(number: u64) -> String {
    let digits = number.to_string();
    let mut out = String::new();
    for (at, digit) in digits.chars().enumerate() {
        if at > 0 && (digits.len() - at).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

/// One step through an XML part, by local names so prefixes don't matter. An empty element
/// comes as an open and a close, so readers need only follow opens and closes.
pub(crate) enum Node<'a, 'b> {
    Open(&'a str, &'a BytesStart<'b>),
    Close(&'a str),
    Text(&'a str),
}

pub(crate) fn walk(xml: &str, mut each: impl FnMut(Node)) {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    // Office writes some things twice, a new way and a fallback for old readers; only the new one counts.
    let mut fallback = 0usize;
    loop {
        let event = reader.read_event();
        match &event {
            Ok(Event::Start(start)) if fallback > 0 || start.local_name().as_ref() == "Fallback" => {
                fallback += 1;
                continue;
            }
            Ok(Event::End(_)) if fallback > 0 => {
                fallback -= 1;
                continue;
            }
            Ok(Event::Eof) | Err(_) => {}
            _ if fallback > 0 => continue,
            _ => {}
        }
        match event {
            Ok(Event::Start(start)) => each(Node::Open(start.local_name().as_ref(), &start)),
            Ok(Event::Empty(start)) => {
                let name = start.local_name();
                each(Node::Open(name.as_ref(), &start));
                each(Node::Close(name.as_ref()));
            }
            Ok(Event::End(end)) => each(Node::Close(end.local_name().as_ref())),
            Ok(Event::Text(text)) => each(Node::Text(&text.xml10_content())),
            Ok(Event::CData(text)) => each(Node::Text(&text)),
            Ok(Event::GeneralRef(reference)) => {
                let character = reference.resolve_char_ref().ok().flatten().map(String::from);
                if let Some(text) = character.as_deref().or_else(|| crate::inside::entity(&reference)) {
                    each(Node::Text(text));
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
}

pub(crate) fn attribute(start: &BytesStart, name: &str) -> Option<String> {
    crate::inside::attribute(start, name)
}

/// The relationship id of an element, `r:id`, which a plain `id` beside it must not hide.
pub(crate) fn relation(start: &BytesStart) -> Option<String> {
    start
        .attributes()
        .flatten()
        .find(|attribute| attribute.key.prefix().is_some() && attribute.key.local_name().as_ref() == "id")
        .and_then(|attribute| attribute.normalized_value_with(quick_xml::XmlVersion::Implicit1_0, 1, crate::inside::entity).ok())
        .map(|value| value.into_owned())
}

/// Whether a switch such as `<w:b/>` or `<w:b w:val="0"/>` is on.
pub(crate) fn switched_on(start: &BytesStart) -> bool {
    attribute(start, "val").is_none_or(|value| !matches!(value.as_str(), "0" | "false" | "off" | "none"))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    /// A ZIP holding `parts`, written to `name` in a fresh folder.
    pub fn package(name: &str, parts: &[(&str, &[u8])]) -> PathBuf {
        let folder = std::env::temp_dir().join(format!("perli-office-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&folder);
        std::fs::create_dir_all(&folder).unwrap();
        let path = folder.join(name);
        let mut zip = zip::ZipWriter::new(File::create(&path).unwrap());
        for (part, bytes) in parts {
            zip.start_file(*part, SimpleFileOptions::default()).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
        path
    }

    #[test]
    fn an_unlocked_document_stays_with_its_own_preview() {
        let path = package("session.docx", &[("word/document.xml", b"<w:document/>")]);
        let bytes = Arc::new(std::fs::read(&path).unwrap());
        keep_unlocked(&path, 901, bytes.clone());
        assert!(unlocked(&path, 901).is_some());
        assert!(unlocked(&path, 902).is_none(), "another preview needs the password too");
        forget(901);
        assert!(unlocked(&path, 901).is_none());
        // An unlock that ends after its preview closed keeps nothing.
        forget(903);
        keep_unlocked(&path, 903, bytes);
        assert!(unlocked(&path, 903).is_none());
    }

    #[test]
    fn a_saved_thumbnail_is_found_but_not_a_metafile() {
        assert!(is_thumbnail("docProps/thumbnail.jpeg"));
        assert!(is_thumbnail("Thumbnails/thumbnail.png"));
        assert!(!is_thumbnail("docProps/thumbnail.wmf"));
        assert!(!is_thumbnail("word/media/thumbnail.png"));
        let path = package("plain.docx", &[("word/document.xml", b"<w:document/>")]);
        assert!(thumbnail(&path, 64).is_none());
    }

    #[test]
    fn resolves_targets_from_their_folder() {
        assert_eq!(resolve("word", "media/image1.png"), "word/media/image1.png");
        assert_eq!(resolve("ppt/slides", "../media/image2.jpeg"), "ppt/media/image2.jpeg");
        assert_eq!(resolve("xl", "/xl/worksheets/sheet1.xml"), "xl/worksheets/sheet1.xml");
        assert_eq!(resolve("", "word/document.xml"), "word/document.xml");
    }

    #[test]
    fn names_say_the_family_and_macros() {
        assert_eq!(family_of(Path::new("a.DOCX")), Some(Family::Word));
        assert_eq!(family_of(Path::new("a.ods")), Some(Family::Sheet));
        assert_eq!(family_of(Path::new("a.ppsx")), Some(Family::Slides));
        assert_eq!(family_of(Path::new("a.txt")), None);
        assert!(has_macro_name(Path::new("a.xlsm")));
        assert!(!has_macro_name(Path::new("a.xlsx")));
    }

    #[test]
    fn skips_what_office_writes_twice() {
        let mut texts = Vec::new();
        walk(r#"<a><mc:AlternateContent><mc:Choice><t>new</t></mc:Choice><mc:Fallback><t>old</t><x/></mc:Fallback></mc:AlternateContent><t>after</t></a>"#, |node| {
            if let Node::Text(text) = node {
                texts.push(text.to_string());
            }
        });
        assert_eq!(texts, ["new", "after"]);
    }

    #[test]
    fn groups_thousands() {
        assert_eq!(group(7), "7");
        assert_eq!(group(1234), "1,234");
        assert_eq!(group(1234567), "1,234,567");
    }

    #[test]
    fn reads_the_summary() {
        let core = br#"<cp:coreProperties xmlns:cp="c" xmlns:dc="d" xmlns:dcterms="t"><dc:title>Plan</dc:title><dc:creator>Ana</dc:creator><cp:lastModifiedBy>Ben</cp:lastModifiedBy><dcterms:modified>2024-03-05T10:00:00Z</dcterms:modified></cp:coreProperties>"#;
        let app = br#"<Properties><Pages>3</Pages><Words>1500</Words></Properties>"#;
        let path = package("facts.docx", &[("docProps/core.xml", core), ("docProps/app.xml", app), ("word/vbaProject.bin", b"x")]);
        let facts = facts(&path, false).unwrap();
        assert_eq!(facts.family, Family::Word);
        assert!(facts.macros && !facts.locked && !facts.marked);
        let pairs: Vec<_> = facts.facts.iter().map(|[label, value]| format!("{label}={value}")).collect();
        assert_eq!(pairs, ["Title=Plan", "Pages=3", "Words=1,500", "Author=Ana", "Last saved by=Ben", "Saved=2024-03-05"]);
    }

    /// Reads real documents named in PERLI_OFFICE_SAMPLES, split by `;`, and prints what came out.
    #[test]
    #[ignore]
    fn reads_real_samples() {
        for path in std::env::var("PERLI_OFFICE_SAMPLES").unwrap_or_default().split(';').filter(|path| !path.is_empty()) {
            let path = Path::new(path);
            let facts = facts(path, false).unwrap();
            let read = read(path, None).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
            let shown = match &read.doc {
                Doc::Word { html, text } => format!("word: {} bytes of html, text starts {:?}", html.len(), text.chars().take(80).collect::<String>()),
                Doc::Sheet { sheets } => sheets.iter().map(|sheet| format!("{} {}x{} first {:?}", sheet.name, sheet.total_rows, sheet.total_columns, sheet.rows.iter().flatten().find(|cell| !cell.is_empty()))).collect::<Vec<_>>().join(" | "),
                Doc::Slides { slides } => format!("{} slides, first {:?}, pictures {}", slides.len(), slides.first().map(|slide| &slide.title), slides.iter().map(|slide| slide.pictures.len()).sum::<usize>()),
            };
            println!("{}
  facts {:?}
  {shown}
  note {:?}
  thumbnail {:?}", path.display(), facts.facts, read.note, thumbnail(path, 256).map(|bytes| (u32::from_le_bytes(bytes[..4].try_into().unwrap()), u32::from_le_bytes(bytes[4..8].try_into().unwrap()))));
        }
    }

    #[test]
    fn sees_the_mark_of_the_internet() {
        let path = package("marked.docx", &[("word/document.xml", b"<w:document/>")]);
        assert!(!from_internet(&path));
        let mut stream = path.as_os_str().to_owned();
        stream.push(":Zone.Identifier");
        std::fs::write(PathBuf::from(stream), "[ZoneTransfer]\r\nZoneId=3\r\n").unwrap();
        assert!(from_internet(&path));
    }
}
