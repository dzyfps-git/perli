//! What the quick preview finds inside archives: the list of a ZIP, the pages of a CBZ comic and
//! the chapters of an EPUB book. Nothing is unpacked to disk. All of it blocks, so call it off the
//! main thread.

use std::cmp::Ordering;
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};

use quick_xml::events::{BytesStart, Event};
use quick_xml::{Reader, XmlVersion};
use serde::Serialize;
use windows::core::HSTRING;
use windows::Win32::Foundation::GENERIC_READ;
use windows::core::{w, Interface};
use windows::Win32::Graphics::Imaging::{
    CLSID_WICImagingFactory, GUID_WICPixelFormat32bppRGBA, IWICBitmapFrameDecode, IWICBitmapSource, IWICImagingFactory,
    WICBitmapInterpolationModeFant, WICBitmapTransformFlipHorizontal, WICBitmapTransformFlipVertical,
    WICBitmapTransformOptions, WICBitmapTransformRotate180, WICBitmapTransformRotate270, WICBitmapTransformRotate90,
    WICConvertBitmapSource, WICDecodeMetadataCacheOnDemand,
};
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Variant::VT_UI2;
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
use windows::Win32::UI::Shell::StrCmpLogicalW;
use zip::result::ZipError;
use zip::ZipArchive;

use crate::ops::Com;
use crate::preview::{escape, is_web_link};

pub(crate) type Zip = ZipArchive<BufReader<File>>;

/// A list this long is enough to see what an archive holds.
const MOST_ENTRIES: usize = 10_000;
/// A page or picture bigger than this unpacked is not drawn, so a ZIP bomb can't fill memory.
const MOST_PICTURE_BYTES: u64 = 128 * 1024 * 1024;
const MOST_CHAPTER_BYTES: u64 = 16 * 1024 * 1024;
const MOST_EDGE: u32 = 4096;
/// A look at a text file inside shows this much of its start.
const MOST_TEXT_BYTES: u64 = 256 * 1024;
const PICTURES: [&str; 7] = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "tif"];

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub size: u64,
    pub folder: bool,
    /// As the archive wrote it, which is the time where it was made.
    pub modified: Option<String>,
    /// Protected by a password.
    pub locked: bool,
}

/// What the UI looks for to ask for the password again.
pub const WRONG_PASSWORD: &str = "Wrong password";

/// ponytail: the `zip` crate is built without `aes-crypto`, to keep the installer small; turn
/// it on if AES-locked ZIPs turn out to be common.
const AES_LOCKED: &str = "This ZIP is locked with AES, which Perli can't open yet.";

pub(crate) fn reason(error: ZipError) -> String {
    match error {
        ZipError::InvalidPassword => WRONG_PASSWORD.into(),
        ZipError::UnsupportedArchive(text) if text.starts_with("AES") => AES_LOCKED.into(),
        other => other.to_string(),
    }
}

/// Said of a locked file whose password reads others of the archive whole.
const DAMAGED_LOCKED: &str = "This file is damaged in the archive. The password is right.";

/// A wrong ZipCrypto password passes its one-byte check about once in 256 tries, and then the
/// file reads as garbage: a broken compressed stream, or a checksum that does not match. A right
/// password on a damaged file reads the same way, so another locked file of the archive tells
/// them apart: if the password reads that one whole, it is right.
pub(crate) fn read_failed(error: std::io::Error, path: &Path, name: &str, password: Option<&str>) -> String {
    use std::io::ErrorKind::{InvalidData, InvalidInput};
    match password.filter(|_| matches!(error.kind(), InvalidData | InvalidInput)) {
        Some(password) if opens_another(path, name, password) => DAMAGED_LOCKED.into(),
        Some(_) => WRONG_PASSWORD.into(),
        None => error.to_string(),
    }
}

/// Whether `password` reads the smallest other locked file of the archive whole.
// ponytail: tries one other file. If that one is damaged too, the password reads as wrong.
fn opens_another(path: &Path, name: &str, password: &str) -> bool {
    let Ok(mut zip) = open(path) else { return false };
    let smallest = (0..zip.len())
        .filter_map(|index| {
            let entry = zip.by_index_data(index).ok()?;
            let other = entry.encrypted() && !entry.is_dir() && entry.name().ok()?.as_ref() != name;
            other.then(|| (entry.size(), index))
        })
        .min();
    let Some((_, index)) = smallest else { return false };
    zip.by_index_decrypt(index, password.as_bytes())
        .is_ok_and(|mut entry| std::io::copy(&mut entry, &mut std::io::sink()).is_ok())
}

/// One entry, opened with the password if it has one.
fn entry<'a>(zip: &'a mut Zip, name: &str, password: Option<&str>) -> Result<zip::read::ZipFile<'a, BufReader<File>>, String> {
    match password {
        Some(password) => zip.by_name_decrypt(name, password.as_bytes()),
        None => zip.by_name(name),
    }
    .map_err(reason)
}

#[derive(Debug, PartialEq, Serialize)]
pub struct Book {
    pub title: String,
    /// Each chapter's name inside the archive, in reading order.
    pub chapters: Vec<String>,
    /// The book's own table of contents, or empty if it has none.
    pub contents: Vec<Heading>,
}

/// One line of a book's table of contents.
#[derive(Debug, PartialEq, Serialize)]
pub struct Heading {
    pub title: String,
    /// Which chapter it opens, by its place in `Book::chapters`.
    pub chapter: usize,
    /// 0 for the top level.
    pub depth: usize,
}

pub(crate) fn open(path: &Path) -> Result<Zip, String> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    ZipArchive::new(BufReader::new(file)).map_err(|error| error.to_string())
}

fn extension(name: &str) -> String {
    name.rsplit_once('.').map(|(_, extension)| extension.to_ascii_lowercase()).unwrap_or_default()
}

/// Whether `name` is a picture `picture` can draw.
pub fn is_picture(name: &str) -> bool {
    PICTURES.contains(&extension(name).as_str())
}

/// The entries of a ZIP, and whether there were more than the list holds.
pub fn entries(path: &Path) -> Result<(Vec<Entry>, bool), String> {
    let zip = open(path)?;
    let mut list = Vec::new();
    for index in 0..zip.len().min(MOST_ENTRIES) {
        let entry = zip.by_index_data(index).map_err(|error| error.to_string())?;
        let modified = entry.last_modified().map(|time| {
            let (year, month, day) = (time.year(), time.month(), time.day());
            format!("{year}-{month:02}-{day:02} {:02}:{:02}", time.hour(), time.minute())
        });
        let name = entry.name().map_err(|error| error.to_string())?.into_owned();
        list.push(Entry { name, size: entry.size(), folder: entry.is_dir(), modified, locked: entry.encrypted() });
    }
    Ok((list, zip.len() > MOST_ENTRIES))
}

fn natural(a: &str, b: &str) -> Ordering {
    unsafe { StrCmpLogicalW(&HSTRING::from(a), &HSTRING::from(b)) }.cmp(&0)
}

/// The pictures of a comic, in the order a person would read them: `page 2` before `page 10`.
pub fn pages(path: &Path) -> Result<Vec<String>, String> {
    let zip = open(path)?;
    let mut names: Vec<String> = zip
        .file_names()
        .flatten()
        .filter(|name| !name.ends_with('/') && PICTURES.contains(&extension(name).as_str()))
        // Mac archives carry a hidden copy of each file's extra data.
        .filter(|name| !name.starts_with("__MACOSX/"))
        .map(|name| name.into_owned())
        .collect();
    names.sort_by(|a, b| natural(a, b));
    Ok(names)
}

/// The start of a text file inside the archive, for a look without taking it out. `None` if it
/// is not text.
pub fn text(path: &Path, name: &str, password: Option<&str>) -> Result<Option<String>, String> {
    let mut zip = open(path)?;
    let entry = entry(&mut zip, name, password)?;
    let mut bytes = Vec::new();
    entry.take(MOST_TEXT_BYTES).read_to_end(&mut bytes).map_err(|error| read_failed(error, path, name, password))?;
    Ok(crate::preview::as_text(&bytes, true))
}

/// Reads all of a locked file, so its checksum proves `password`. A wrong one can pass the quick
/// header check of ZipCrypto and show only once the file is read through.
pub fn check_password(path: &Path, name: &str, password: &str) -> Result<(), String> {
    let mut zip = open(path)?;
    let mut entry = entry(&mut zip, name, Some(password))?;
    std::io::copy(&mut entry, &mut std::io::sink()).map_err(|error| read_failed(error, path, name, Some(password)))?;
    Ok(())
}

fn read_entry(zip: &mut Zip, name: &str, most: u64) -> Result<Vec<u8>, String> {
    read_locked(zip, name, most, None)
}

fn read_locked(zip: &mut Zip, name: &str, most: u64, password: Option<&str>) -> Result<Vec<u8>, String> {
    let entry = entry(zip, name, password)?;
    if entry.size() > most {
        return Err(format!("{name} is too big to show"));
    }
    let mut bytes = Vec::with_capacity(entry.size() as usize);
    entry.take(most).read_to_end(&mut bytes).map_err(|error| error.to_string())?;
    Ok(bytes)
}

/// One picture inside an archive, `edge` pixels on its longest side at most, in the format
/// `thumbs::read` describes.
pub fn picture(path: &Path, name: &str, edge: u32, password: Option<&str>) -> Result<Vec<u8>, String> {
    let bytes = read_locked(&mut open(path)?, name, MOST_PICTURE_BYTES, password)?;
    decode(&bytes, edge.clamp(1, MOST_EDGE)).map_err(|error| error.message())
}

/// What a test of an archive found: how many files read back whole, which did not, and how many
/// stayed locked for want of a password.
#[derive(Debug, PartialEq, Serialize)]
pub struct Tested {
    pub sound: u32,
    pub damaged: Vec<String>,
    pub locked: u32,
}

/// Reads every file of a ZIP to its end, which checks each against the checksum the archive keeps.
pub fn test(path: &Path, password: Option<&str>) -> Result<Tested, String> {
    let mut zip = open(path)?;
    let mut found = Tested { sound: 0, damaged: Vec::new(), locked: 0 };
    for index in 0..zip.len() {
        let (name, folder, locked) = match zip.by_index_data(index) {
            Ok(entry) => (entry.name().map(|name| name.into_owned()).unwrap_or_default(), entry.is_dir(), entry.encrypted()),
            Err(error) => return Err(error.to_string()),
        };
        if folder {
            continue;
        }
        if locked && password.is_none() {
            found.locked += 1;
            continue;
        }
        let read = match password.filter(|_| locked) {
            Some(password) => zip.by_index_decrypt(index, password.as_bytes()),
            None => zip.by_index(index),
        }
        .map_err(reason)
        .and_then(|mut entry| std::io::copy(&mut entry, &mut std::io::sink()).map_err(|error| error.to_string()));
        match read {
            Ok(_) => found.sound += 1,
            Err(wrong) if wrong == WRONG_PASSWORD => return Err(wrong),
            Err(_) => found.damaged.push(name),
        }
    }
    Ok(found)
}

/// Writes one file of a ZIP into `folder` under its own name, for a drag out of the preview.
pub fn take_out(path: &Path, name: &str, password: Option<&str>, folder: &Path) -> Result<PathBuf, String> {
    let mut zip = open(path)?;
    let mut entry = entry(&mut zip, name, password)?;
    let own = entry.enclosed_name().and_then(|inside| inside.file_name().map(PathBuf::from)).ok_or("This name in the archive isn't safe to use")?;
    if entry.is_dir() {
        return Err("Only a file can be dragged out".into());
    }
    let target = folder.join(own);
    let mut file = File::create(&target).map_err(|error| error.to_string())?;
    std::io::copy(&mut entry, &mut file).map_err(|error| error.to_string())?;
    Ok(target)
}

/// Whether the list shows this file's own cover in place of an icon.
pub fn has_cover(path: &Path) -> bool {
    matches!(path.extension().map(|extension| extension.to_string_lossy().to_lowercase()).as_deref(), Some("epub" | "cbz"))
}

/// A book's cover or a comic's first page, in the format `thumbs::read` describes.
pub fn cover(path: &Path, edge: u32) -> Option<Vec<u8>> {
    let name = if path.extension()?.eq_ignore_ascii_case("cbz") {
        pages(path).ok()?.into_iter().next()?
    } else {
        book_cover(&mut open(path).ok()?)?
    };
    picture(path, &name, edge, None).ok()
}

/// The picture a book names as its cover: marked as one, pointed to by the old `cover` note, or
/// failing both, the first picture with "cover" in its name.
fn book_cover(zip: &mut Zip) -> Option<String> {
    let (package, index) = package(zip).ok()?;
    let mut reader = Reader::from_str(&index);
    let (mut noted, mut marked, mut pictures) = (None, None, Vec::new());
    loop {
        match reader.read_event().ok()? {
            Event::Start(start) | Event::Empty(start) => match start.local_name().as_ref() {
                "meta" if attribute(&start, "name").as_deref() == Some("cover") => noted = attribute(&start, "content"),
                "item" => {
                    let (Some(id), Some(href)) = (attribute(&start, "id"), attribute(&start, "href")) else { continue };
                    if attribute(&start, "properties").is_some_and(|properties| properties.split(' ').any(|one| one == "cover-image")) {
                        marked = Some(href.clone());
                    }
                    if attribute(&start, "media-type").is_some_and(|kind| kind.starts_with("image/")) {
                        pictures.push((id, href));
                    }
                }
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
    }
    let by_note = noted.and_then(|id| pictures.iter().find(|(item, _)| *item == id)).map(|(_, href)| href.clone());
    let by_name = || {
        let named = |text: &str| text.to_lowercase().contains("cover");
        pictures.iter().find(|(id, href)| named(id) || named(href)).map(|(_, href)| href.clone())
    };
    marked.or(by_note).or_else(by_name).map(|href| resolve(&package, &href))
}

/// The turn a photo's EXIF orientation asks for, 1 to 8, as Windows' flip-rotator says it. A
/// flip is applied before the turn.
fn transform(orientation: u16) -> Option<WICBitmapTransformOptions> {
    let both = |a: WICBitmapTransformOptions, b: WICBitmapTransformOptions| WICBitmapTransformOptions(a.0 | b.0);
    Some(match orientation {
        2 => WICBitmapTransformFlipHorizontal,
        3 => WICBitmapTransformRotate180,
        4 => WICBitmapTransformFlipVertical,
        5 => both(WICBitmapTransformRotate270, WICBitmapTransformFlipHorizontal),
        6 => WICBitmapTransformRotate90,
        7 => both(WICBitmapTransformRotate90, WICBitmapTransformFlipHorizontal),
        8 => WICBitmapTransformRotate270,
        _ => return None,
    })
}

/// A JPEG's EXIF orientation, or nothing for any other picture or one without it.
unsafe fn orientation(frame: &IWICBitmapFrameDecode) -> Option<u16> {
    let reader = frame.GetMetadataQueryReader().ok()?;
    let mut value = PROPVARIANT::default();
    reader.GetMetadataByName(w!("/app1/ifd/{ushort=274}"), &raw mut value).ok()?;
    let inner = &value.Anonymous.Anonymous;
    (inner.vt == VT_UI2).then(|| inner.Anonymous.uiVal)
}

/// Windows' own imaging reads the picture, so every format Windows can show works. A photo is
/// turned the way its EXIF says, as a camera or phone leaves it.
pub(crate) fn decode(bytes: &[u8], edge: u32) -> windows::core::Result<Vec<u8>> {
    let _com = Com::enter();
    unsafe {
        let factory: IWICImagingFactory = CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)?;
        let stream = factory.CreateStream()?;
        stream.InitializeFromMemory(bytes)?;
        let decoder = factory.CreateDecoderFromStream(&stream, std::ptr::null(), WICDecodeMetadataCacheOnDemand)?;
        let frame = decoder.GetFrame(0)?;
        let (mut width, mut height) = (0, 0);
        frame.GetSize(&raw mut width, &raw mut height)?;
        let scale = (edge as f64 / width.max(height).max(1) as f64).min(1.0);
        let width = ((width as f64 * scale).round() as u32).max(1);
        let height = ((height as f64 * scale).round() as u32).max(1);
        let scaler = factory.CreateBitmapScaler()?;
        scaler.Initialize(&frame, width, height, WICBitmapInterpolationModeFant)?;
        let mut turned: IWICBitmapSource = scaler.cast()?;
        if let Some(transform) = orientation(&frame).and_then(transform) {
            let rotator = factory.CreateBitmapFlipRotator()?;
            rotator.Initialize(&turned, transform)?;
            turned = rotator.cast()?;
        }
        let (mut width, mut height) = (0, 0);
        turned.GetSize(&raw mut width, &raw mut height)?;
        let pixels = WICConvertBitmapSource(&GUID_WICPixelFormat32bppRGBA, &turned)?;
        let mut out = vec![0; 8 + width as usize * height as usize * 4];
        out[..4].copy_from_slice(&width.to_le_bytes());
        out[4..8].copy_from_slice(&height.to_le_bytes());
        pixels.CopyPixels(std::ptr::null(), width * 4, &mut out[8..])?;
        Ok(out)
    }
}

/// A picture file's own width and height, read from its header by Windows' imaging, or `None`
/// for a format only the shell can draw. A file in the cloud stays there.
pub fn pixel_size(path: &Path) -> Option<(u32, u32)> {
    if crate::thumbs::is_online_only(path) {
        return None;
    }
    let _com = Com::enter();
    unsafe {
        let factory: IWICImagingFactory = CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).ok()?;
        let decoder = factory
            .CreateDecoderFromFilename(&HSTRING::from(path), None, GENERIC_READ, WICDecodeMetadataCacheOnDemand)
            .ok()?;
        let (mut width, mut height) = (0, 0);
        decoder.GetFrame(0).ok()?.GetSize(&raw mut width, &raw mut height).ok()?;
        Some((width, height))
    }
}

/// `href` from a file at `from` inside the archive, as the name of another entry.
fn resolve(from: &str, href: &str) -> String {
    let href = href.split(['#', '?']).next().unwrap_or_default();
    let href = percent_decoded(href);
    let mut parts: Vec<&str> = from.split('/').collect();
    parts.pop();
    for part in href.split('/') {
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

fn percent_decoded(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        let hex = bytes.get(at + 1..at + 3).and_then(|pair| std::str::from_utf8(pair).ok());
        match (bytes[at], hex.and_then(|pair| u8::from_str_radix(pair, 16).ok())) {
            (b'%', Some(byte)) => {
                out.push(byte);
                at += 3;
            }
            (byte, _) => {
                out.push(byte);
                at += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn attribute(start: &BytesStart, name: &str) -> Option<String> {
    start
        .attributes()
        .flatten()
        .find(|attribute| attribute.key.local_name().as_ref() == name)
        .and_then(|attribute| attribute.normalized_value_with(XmlVersion::Implicit1_0, 1, entity).ok())
        .map(|value| value.into_owned())
}

/// The named characters books use most. Others are left out.
fn entity(name: &str) -> Option<&'static str> {
    Some(match name {
        "amp" => "&",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "apos" => "'",
        "nbsp" => "\u{a0}",
        "shy" => "\u{ad}",
        "ndash" => "–",
        "mdash" => "—",
        "hellip" => "…",
        "lsquo" => "‘",
        "rsquo" => "’",
        "ldquo" => "“",
        "rdquo" => "”",
        "laquo" => "«",
        "raquo" => "»",
        "copy" => "©",
        "reg" => "®",
        "trade" => "™",
        "deg" => "°",
        "middot" => "·",
        "bull" => "•",
        "times" => "×",
        _ => return None,
    })
}

/// Reads the book's own index: where its parts are, and the order they are read in.
pub fn book(path: &Path) -> Result<Book, String> {
    let mut zip = open(path)?;
    let (package, index) = package(&mut zip)?;
    read_book(&mut zip, &package, &index)
}

/// The book's index file: its name inside the archive, and its text.
fn package(zip: &mut Zip) -> Result<(String, String), String> {
    let container = read_entry(zip, "META-INF/container.xml", MOST_CHAPTER_BYTES)?;
    let container = String::from_utf8_lossy(&container);
    let mut reader = Reader::from_str(&container);
    let mut package = None;
    loop {
        match reader.read_event().map_err(|error| error.to_string())? {
            Event::Start(start) | Event::Empty(start) if start.local_name().as_ref() == "rootfile" => {
                package = attribute(&start, "full-path");
                break;
            }
            Event::Eof => break,
            _ => {}
        }
    }
    let package = package.ok_or("This book has no index")?;
    let index = read_entry(zip, &package, MOST_CHAPTER_BYTES)?;
    Ok((package, String::from_utf8_lossy(&index).into_owned()))
}

fn read_book(zip: &mut Zip, package: &str, index: &str) -> Result<Book, String> {
    let mut reader = Reader::from_str(index);
    let (mut title, mut in_title) = (String::new(), false);
    let mut items = Vec::new();
    let mut order = Vec::new();
    // EPUB 3 marks its contents page. EPUB 2 names an NCX file from the spine.
    let (mut nav, mut ncx_id) = (None, None);
    loop {
        match reader.read_event().map_err(|error| error.to_string())? {
            Event::Start(start) if start.local_name().as_ref() == "title" && title.is_empty() => in_title = true,
            Event::Text(text) if in_title => title.push_str(&text.xml10_content()),
            Event::End(_) => in_title = false,
            Event::Start(start) | Event::Empty(start) => match start.local_name().as_ref() {
                "item" => {
                    if let (Some(id), Some(href)) = (attribute(&start, "id"), attribute(&start, "href")) {
                        if attribute(&start, "properties").is_some_and(|properties| properties.split(' ').any(|one| one == "nav")) {
                            nav = Some(resolve(package, &href));
                        }
                        items.push((id, href));
                    }
                }
                "spine" => ncx_id = attribute(&start, "toc"),
                "itemref" => order.extend(attribute(&start, "idref")),
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
    }
    // Only chapters that can be read count: there, small enough, and not locked. A book with none
    // shows as the archive it is.
    let locked = locked(zip);
    let chapters: Vec<String> = order
        .iter()
        .filter_map(|id| items.iter().find(|(item, _)| item == id))
        .map(|(_, href)| resolve(package, href))
        .filter(|name| !locked.contains(name) && zip.by_name(name).is_ok_and(|entry| entry.size() <= MOST_CHAPTER_BYTES))
        .collect();
    let ncx = ncx_id.and_then(|id| items.iter().find(|(item, _)| *item == id)).map(|(_, href)| resolve(package, href));
    // A book with a broken contents page still reads, just without it.
    let contents = match nav.or(ncx) {
        Some(file) => read_entry(zip, &file, MOST_CHAPTER_BYTES)
            .map(|source| contents_of(&file, &String::from_utf8_lossy(&source), &chapters))
            .unwrap_or_default(),
        None => Vec::new(),
    };
    Ok(Book { title: title.trim().to_string(), chapters, contents })
}

/// The lines of an EPUB 3 contents page (`<nav epub:type="toc">`) or an EPUB 2 NCX file, each
/// with the chapter it opens. Lines that point outside the reading order are left out.
fn contents_of(file: &str, source: &str, chapters: &[String]) -> Vec<Heading> {
    let mut reader = Reader::from_str(source);
    let mut found = Vec::new();
    // In a nav page: inside the contents nav, how deep its lists go, and the link being read.
    let (mut in_toc, mut depth, mut link): (bool, usize, Option<(String, String)>) = (false, 0, None);
    // In an NCX: how deep its points go, and the label read so far.
    let (mut points, mut label, mut in_label) = (0, String::new(), false);
    let mut push = |title: &str, href: &str, depth: usize| {
        let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
        if let Some(chapter) = chapters.iter().position(|name| *name == resolve(file, href)) {
            if !title.is_empty() {
                found.push(Heading { title, chapter, depth });
            }
        }
    };
    while let Ok(event) = reader.read_event() {
        match event {
            Event::Start(start) => match start.local_name().as_ref() {
                "nav" if !in_toc => in_toc = attribute(&start, "type").is_some_and(|kind| kind.split(' ').any(|one| one == "toc")),
                "ol" if in_toc => depth += 1,
                "a" if in_toc => link = attribute(&start, "href").map(|href| (href, String::new())),
                "navPoint" => {
                    points += 1;
                    label.clear();
                }
                "text" => in_label = true,
                _ => {}
            },
            Event::Empty(start) if start.local_name().as_ref() == "content" => {
                if let Some(src) = attribute(&start, "src") {
                    push(&label, &src, points.max(1) - 1);
                }
            }
            Event::Text(text) => {
                let text = text.xml10_content();
                if let Some((_, title)) = link.as_mut() {
                    title.push_str(&text);
                } else if in_label {
                    label.push_str(&text);
                }
            }
            Event::GeneralRef(reference) => {
                let character = reference.resolve_char_ref().ok().flatten().map(String::from);
                if let Some(text) = character.as_deref().or_else(|| entity(&reference)) {
                    if let Some((_, title)) = link.as_mut() {
                        title.push_str(text);
                    } else if in_label {
                        label.push_str(text);
                    }
                }
            }
            Event::End(end) => match end.local_name().as_ref() {
                "nav" if in_toc => break,
                "ol" if in_toc => depth = depth.saturating_sub(1),
                "a" => {
                    if let Some((href, title)) = link.take() {
                        push(&title, &href, depth.max(1) - 1);
                    }
                }
                "navPoint" => points -= 1,
                "text" => in_label = false,
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
    }
    found
}

/// The parts a book's DRM encrypts, which would read as noise.
fn locked(zip: &mut Zip) -> Vec<String> {
    let Ok(bytes) = read_entry(zip, "META-INF/encryption.xml", MOST_CHAPTER_BYTES) else {
        return Vec::new();
    };
    let text = String::from_utf8_lossy(&bytes);
    let mut reader = Reader::from_str(&text);
    let mut names = Vec::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(start) | Event::Empty(start)) if start.local_name().as_ref() == "CipherReference" => {
                names.extend(attribute(&start, "URI").map(|uri| resolve("", &uri)));
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    names
}

/// Tags a chapter keeps. Anything else is dropped and its text kept, and a few tags are dropped
/// with everything inside them.
const KEPT: [&str; 52] = [
    "a", "abbr", "article", "aside", "b", "bdi", "blockquote", "br", "caption", "cite", "code", "dd", "del", "dfn",
    "div", "dl", "dt", "em", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr",
    "i", "img", "ins", "kbd", "li", "mark", "ol", "p", "pre", "q", "rp", "rt", "ruby", "s", "samp", "section",
    "small", "span", "strong", "sub", "sup", "u", "ul",
];
const TABLES: [&str; 7] = ["table", "thead", "tbody", "tfoot", "tr", "th", "td"];
const DROPPED: [&str; 20] = [
    "applet", "audio", "button", "canvas", "embed", "form", "frame", "frameset", "head", "iframe", "input", "link",
    "math", "meta", "noscript", "object", "script", "select", "style", "textarea",
];
const EMPTY: [&str; 3] = ["br", "hr", "img"];

/// One chapter as safe HTML: no scripts, styles, forms or anything that loads from elsewhere.
/// Pictures become canvases that Perli fills, and links inside the book name the chapter they go to.
pub fn chapter(path: &Path, name: &str) -> Result<String, String> {
    let bytes = read_entry(&mut open(path)?, name, MOST_CHAPTER_BYTES)?;
    Ok(clean(name, &String::from_utf8_lossy(&bytes)))
}

fn clean(name: &str, source: &str) -> String {
    let mut reader = Reader::from_str(source);
    let config = reader.config_mut();
    config.check_end_names = false;
    config.allow_unmatched_ends = true;
    let mut out = String::new();
    // What each open tag became: its name if kept, or nothing if only its text is.
    let mut open: Vec<Option<String>> = Vec::new();
    let mut dropping = 0usize;
    // A chapter that stops making sense keeps what was read up to there.
    while let Ok(event) = reader.read_event() {
        match event {
            Event::Start(start) => {
                let tag = start.local_name().as_ref().to_ascii_lowercase();
                if dropping > 0 || DROPPED.contains(&tag.as_str()) {
                    dropping += 1;
                } else if EMPTY.contains(&tag.as_str()) {
                    out.push_str(&opening(name, &tag, &start));
                } else {
                    let kept = KEPT.contains(&tag.as_str()) || TABLES.contains(&tag.as_str());
                    if kept {
                        out.push_str(&opening(name, &tag, &start));
                    }
                    open.push(kept.then_some(tag));
                }
            }
            Event::Empty(start) if dropping == 0 => {
                let tag = start.local_name().as_ref().to_ascii_lowercase();
                if EMPTY.contains(&tag.as_str()) {
                    out.push_str(&opening(name, &tag, &start));
                } else if KEPT.contains(&tag.as_str()) || TABLES.contains(&tag.as_str()) {
                    out.push_str(&opening(name, &tag, &start));
                    out.push_str(&format!("</{tag}>"));
                }
            }
            Event::End(end) => {
                let tag = end.local_name().as_ref().to_ascii_lowercase();
                if dropping > 0 {
                    dropping -= 1;
                } else if !EMPTY.contains(&tag.as_str()) {
                    if let Some(Some(kept)) = open.pop() {
                        out.push_str(&format!("</{kept}>"));
                    }
                }
            }
            Event::Text(text) if dropping == 0 => out.push_str(&escape(&text.xml10_content())),
            Event::CData(text) if dropping == 0 => out.push_str(&escape(&text)),
            Event::GeneralRef(reference) if dropping == 0 => {
                let character = reference.resolve_char_ref().ok().flatten().map(String::from);
                if let Some(text) = character.as_deref().or_else(|| entity(&reference)) {
                    out.push_str(&escape(text));
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    for kept in open.into_iter().rev().flatten() {
        out.push_str(&format!("</{kept}>"));
    }
    out
}

/// A kept tag with only the attributes that are safe and mean something here.
fn opening(name: &str, tag: &str, start: &BytesStart) -> String {
    match tag {
        "img" => {
            let source = attribute(start, "src").unwrap_or_default();
            let alt = attribute(start, "alt").unwrap_or_default();
            let entry = resolve(name, &source);
            format!(r#"<canvas class="md-picture" data-picture="{}" aria-label="{}"></canvas>"#, escape(&entry), escape(&alt))
        }
        "a" => match attribute(start, "href") {
            Some(href) if is_web_link(&href) => format!(r#"<a href="{}">"#, escape(&href)),
            Some(href) if !href.contains(':') && !href.starts_with('#') => {
                format!(r#"<a href="" data-chapter="{}">"#, escape(&resolve(name, &href)))
            }
            _ => "<a>".to_string(),
        },
        "td" | "th" => {
            let span = |key: &str| {
                attribute(start, key)
                    .and_then(|value| value.trim().parse::<u16>().ok())
                    .map(|value| format!(r#" {key}="{value}""#))
                    .unwrap_or_default()
            };
            format!("<{tag}{}{}>", span("colspan"), span("rowspan"))
        }
        _ => format!("<{tag}>"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    fn archive(name: &str, files: &[(&str, &[u8])]) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("perli-inside-{}-{name}", std::process::id()));
        let mut zip = ZipWriter::new(File::create(&path).unwrap());
        for (entry, bytes) in files {
            zip.start_file(*entry, SimpleFileOptions::default()).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
        path
    }

    #[test]
    fn a_text_file_inside_reads_without_its_mark_and_anything_else_does_not() {
        let path = archive("look.zip", &[("notes/a.txt", b"\xEF\xBB\xBFhello"), ("b.bin", b"\x00\x01\x02")]);
        assert_eq!(text(&path, "notes/a.txt", None).unwrap().as_deref(), Some("hello"));
        assert_eq!(text(&path, "b.bin", None).unwrap(), None);
        assert!(text(&path, "gone.txt", None).is_err());
        assert_eq!(test(&path, None).unwrap(), Tested { sound: 2, damaged: vec![], locked: 0 });
        let folder = std::env::temp_dir().join(format!("perli-inside-out-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        let out = take_out(&path, "notes/a.txt", None, &folder).unwrap();
        assert_eq!(out, folder.join("a.txt"));
        assert_eq!(std::fs::read(&out).unwrap(), b"\xEF\xBB\xBFhello");
        std::fs::remove_dir_all(folder).unwrap();
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn a_locked_file_opens_with_its_password_only() {
        use zip::unstable::write::FileOptionsExt;
        let path = std::env::temp_dir().join(format!("perli-inside-{}-locked.zip", std::process::id()));
        let mut zip = ZipWriter::new(File::create(&path).unwrap());
        zip.start_file("secret.txt", SimpleFileOptions::default().with_deprecated_encryption(b"open sesame").unwrap()).unwrap();
        zip.write_all(b"treasure").unwrap();
        zip.start_file("plain.txt", SimpleFileOptions::default()).unwrap();
        zip.write_all(b"plain").unwrap();
        zip.finish().unwrap();

        let (list, _) = entries(&path).unwrap();
        assert_eq!(list.iter().map(|entry| entry.locked).collect::<Vec<_>>(), [true, false]);
        assert!(text(&path, "secret.txt", None).is_err());
        assert_eq!(text(&path, "secret.txt", Some("open sesame")).unwrap().as_deref(), Some("treasure"));
        // Some wrong passwords get past the one-byte check, and the checksum has to catch them.
        let mut zip = open(&path).unwrap();
        let lucky = (0..5000).map(|n| format!("wrong {n}")).find(|tried| zip.by_name_decrypt("secret.txt", tried.as_bytes()).is_ok()).unwrap();
        assert_eq!(text(&path, "secret.txt", Some(&lucky)), Err(WRONG_PASSWORD.to_string()));
        assert_eq!(text(&path, "secret.txt", Some("nope")), Err(WRONG_PASSWORD.to_string()));
        assert_eq!(reason(ZipError::UnsupportedArchive("AES encrypted files cannot be decrypted without the aes-crypto feature.")), AES_LOCKED);
        assert_eq!(test(&path, None).unwrap(), Tested { sound: 1, damaged: vec![], locked: 1 });
        assert_eq!(test(&path, Some("open sesame")).unwrap(), Tested { sound: 2, damaged: vec![], locked: 0 });
        std::fs::remove_file(path).unwrap();
    }

    /// A 64x32 JPEG in four colours, red, blue / green, black, with `orientation` in its EXIF.
    fn turned_jpeg(orientation: u16) -> Vec<u8> {
        use windows::Win32::Foundation::E_FAIL;
        use windows::Win32::Graphics::Imaging::{GUID_ContainerFormatJpeg, GUID_WICPixelFormat24bppBGR, WICBitmapEncoderNoCache};
        use windows::Win32::System::Com::{IStream, STATFLAG_NONAME, STATSTG, STREAM_SEEK_SET};
        use windows::Win32::UI::Shell::SHCreateMemStream;
        let (width, height) = (64u32, 32u32);
        let mut pixels = Vec::new();
        for y in 0..height {
            for x in 0..width {
                let bgr: [u8; 3] = match (x < 32, y < 16) {
                    (true, true) => [0, 0, 255],
                    (false, true) => [255, 0, 0],
                    (true, false) => [0, 255, 0],
                    (false, false) => [0, 0, 0],
                };
                pixels.extend(bgr);
            }
        }
        let _com = Com::enter();
        let jpeg = unsafe {
            let factory: IWICImagingFactory = CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).unwrap();
            let source = factory.CreateBitmapFromMemory(width, height, &GUID_WICPixelFormat24bppBGR, width * 3, &pixels).unwrap();
            let stream: IStream = SHCreateMemStream(None).ok_or(windows::core::Error::from(E_FAIL)).unwrap();
            let encoder = factory.CreateEncoder(&GUID_ContainerFormatJpeg, std::ptr::null()).unwrap();
            encoder.Initialize(&stream, WICBitmapEncoderNoCache).unwrap();
            let mut frame = None;
            encoder.CreateNewFrame(&raw mut frame, std::ptr::null_mut()).unwrap();
            let frame = frame.unwrap();
            frame.Initialize(None).unwrap();
            frame.WriteSource(&source, std::ptr::null()).unwrap();
            frame.Commit().unwrap();
            encoder.Commit().unwrap();
            let mut facts = STATSTG::default();
            stream.Stat(&raw mut facts, STATFLAG_NONAME).unwrap();
            stream.Seek(0, STREAM_SEEK_SET, None).unwrap();
            let mut bytes = vec![0u8; facts.cbSize as usize];
            let mut read = 0;
            stream.Read(bytes.as_mut_ptr().cast(), bytes.len() as u32, Some(&raw mut read)).ok().unwrap();
            bytes
        };
        // APP1 with a little-endian TIFF header and one IFD entry: orientation, a SHORT.
        let mut app1 = b"Exif\0\0II*\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0".to_vec();
        app1.extend(orientation.to_le_bytes());
        app1.extend([0, 0, 0, 0, 0, 0]);
        let mut out = jpeg[..2].to_vec();
        out.extend([0xFF, 0xE1]);
        out.extend(((app1.len() + 2) as u16).to_be_bytes());
        out.extend(app1);
        out.extend(&jpeg[2..]);
        out
    }

    #[test]
    fn a_photo_is_turned_the_way_its_exif_says() {
        let size = |out: &[u8]| (u32::from_le_bytes(out[..4].try_into().unwrap()) as usize, u32::from_le_bytes(out[4..8].try_into().unwrap()) as usize);
        let colour = |out: &[u8], x: usize, y: usize| {
            let at = 8 + (y * size(out).0 + x) * 4;
            match (out[at] > 128, out[at + 1] > 128, out[at + 2] > 128) {
                (true, false, false) => "red",
                (false, true, false) => "green",
                (false, false, true) => "blue",
                (false, false, false) => "black",
                _ => "mixed",
            }
        };
        // The size it comes out, then the colour of its top left and top right quarters.
        let seen = |orientation: u16| {
            let out = decode(&turned_jpeg(orientation), 256).unwrap();
            let (width, height) = size(&out);
            ((width, height), colour(&out, width / 4, height / 4), colour(&out, width * 3 / 4, height / 4))
        };
        assert_eq!(seen(1), ((64, 32), "red", "blue"));
        assert_eq!(seen(2), ((64, 32), "blue", "red"));
        assert_eq!(seen(3), ((64, 32), "black", "green"));
        assert_eq!(seen(4), ((64, 32), "green", "black"));
        assert_eq!(seen(5), ((32, 64), "red", "green"));
        assert_eq!(seen(6), ((32, 64), "green", "red"));
        assert_eq!(seen(7), ((32, 64), "black", "blue"));
        assert_eq!(seen(8), ((32, 64), "blue", "black"));
    }

    #[test]
    fn a_damaged_locked_file_says_so_when_the_password_opens_another() {
        use zip::unstable::write::FileOptionsExt;
        let path = std::env::temp_dir().join(format!("perli-inside-{}-damaged.zip", std::process::id()));
        let mut zip = ZipWriter::new(File::create(&path).unwrap());
        let locked = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored).with_deprecated_encryption(b"key").unwrap();
        for name in ["a.txt", "b.txt"] {
            zip.start_file(name, locked).unwrap();
            zip.write_all(b"some words to keep").unwrap();
        }
        zip.finish().unwrap();
        // The first byte of a.txt's own data, after its header and the 12 bytes of the lock.
        let mut bytes = std::fs::read(&path).unwrap();
        let field = |at: usize| u16::from_le_bytes([bytes[at], bytes[at + 1]]) as usize;
        let data = 30 + field(26) + field(28) + 12;
        bytes[data] ^= 0xFF;
        std::fs::write(&path, bytes).unwrap();

        assert_eq!(text(&path, "a.txt", Some("key")), Err(DAMAGED_LOCKED.to_string()));
        assert_eq!(check_password(&path, "a.txt", "key"), Err(DAMAGED_LOCKED.to_string()));
        assert_eq!(text(&path, "a.txt", Some("nope")), Err(WRONG_PASSWORD.to_string()));
        assert_eq!(text(&path, "b.txt", Some("key")).unwrap().as_deref(), Some("some words to keep"));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn a_book_names_its_cover_three_ways() {
        let container: &[u8] = br#"<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>"#;
        let cover_of = |name: &str, package: &str| {
            let files: [(&str, &[u8]); 2] = [("META-INF/container.xml", container), ("OEBPS/content.opf", package.as_bytes())];
            let path = archive(name, &files);
            let found = book_cover(&mut open(&path).unwrap());
            std::fs::remove_file(path).unwrap();
            found
        };
        let marked = r#"<package><manifest><item id="a" href="img/a.jpg" media-type="image/jpeg"/>
            <item id="b" href="img/b.jpg" media-type="image/jpeg" properties="cover-image"/></manifest></package>"#;
        assert_eq!(cover_of("c1.epub", marked).as_deref(), Some("OEBPS/img/b.jpg"));
        let noted = r#"<package><metadata><meta name="cover" content="a"/></metadata><manifest>
            <item id="x" href="img/x.jpg" media-type="image/jpeg"/><item id="a" href="img/a.jpg" media-type="image/jpeg"/></manifest></package>"#;
        assert_eq!(cover_of("c2.epub", noted).as_deref(), Some("OEBPS/img/a.jpg"));
        let named = r#"<package><manifest><item id="x" href="one.xhtml" media-type="application/xhtml+xml"/>
            <item id="y" href="Cover.png" media-type="image/png"/></manifest></package>"#;
        assert_eq!(cover_of("c3.epub", named).as_deref(), Some("OEBPS/Cover.png"));
        assert_eq!(cover_of("c4.epub", "<package><manifest/></package>"), None);
    }

    #[test]
    fn a_chapter_keeps_its_text_and_loses_everything_that_could_act() {
        let source = r#"<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>T</title>
            <style>p{}</style><script>alert(1)</script></head><body onload="x()">
            <h1 class="big" style="color:red">One&nbsp;&#8212; &amp; <b onclick="x()">two</b></h1>
            <p>See <a href="../text/ch2.xhtml#top">next</a>, <a href="https://example.com">web</a>,
            <a href="javascript:alert(1)">bad</a>.</p><img src="../images/a%20b.png" alt="A &quot;pic&quot;"/>
            <svg><text>drawn</text></svg><iframe src="https://x"><p>inside</p></iframe><br/>
            <table><tr><td colspan="2" onclick="x">c</td><td rowspan="x">d</td></tr></table>
            <p>unclosed <i>still</p></body></html>"#;
        let html = clean("OEBPS/text/ch1.xhtml", source);
        assert_eq!(
            html.replace('\u{a0}', "~").split_whitespace().collect::<Vec<_>>().join(" "),
            "<h1>One~— &amp; <b>two</b></h1> <p>See <a href=\"\" data-chapter=\"OEBPS/text/ch2.xhtml\">next</a>, \
             <a href=\"https://example.com\">web</a>, <a>bad</a>.</p>\
             <canvas class=\"md-picture\" data-picture=\"OEBPS/images/a b.png\" aria-label=\"A &quot;pic&quot;\"></canvas> \
             drawn<br> <table><tr><td colspan=\"2\">c</td><td>d</td></tr></table> <p>unclosed <i>still</i></p>"
        );
    }

    #[test]
    fn paths_inside_a_book_stay_inside_it() {
        assert_eq!(resolve("OEBPS/content.opf", "text/one.xhtml"), "OEBPS/text/one.xhtml");
        assert_eq!(resolve("OEBPS/text/one.xhtml", "../../../../etc/x.png"), "etc/x.png");
        assert_eq!(resolve("a.xhtml", "b%2Fc.png?x#y"), "b/c.png");
    }

    #[test]
    fn a_book_reads_its_index_in_order() {
        let container = br#"<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>"#;
        let package = br#"<package><metadata><dc:title xmlns:dc="x"> A Book </dc:title></metadata>
            <manifest><item id="b" href="two.xhtml"/><item id="a" href="text/one.xhtml"/></manifest>
            <spine><itemref idref="a"/><itemref idref="b"/><itemref idref="gone"/></spine></package>"#;
        let files: [(&str, &[u8]); 4] = [
            ("META-INF/container.xml", container),
            ("OEBPS/content.opf", package),
            ("OEBPS/text/one.xhtml", b"<p>1</p>"),
            ("OEBPS/two.xhtml", b"<p>2</p>"),
        ];
        let path = archive("book.epub", &files);
        let book = book(&path).unwrap();
        let chapters = vec!["OEBPS/text/one.xhtml".to_string(), "OEBPS/two.xhtml".to_string()];
        assert_eq!(book, Book { title: "A Book".into(), chapters, contents: vec![] });
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn a_book_lists_its_contents_from_its_nav_page_or_ncx() {
        let chapters = ["OEBPS/text/one.xhtml".to_string(), "OEBPS/two.xhtml".to_string()];
        let heading = |title: &str, chapter, depth| Heading { title: title.into(), chapter, depth };
        let nav = r#"<html><body><nav epub:type="landmarks"><ol><li><a href="two.xhtml">Skip me</a></li></ol></nav>
            <nav epub:type="toc"><ol><li><a href="one.xhtml#top">Part   <b>One</b></a>
            <ol><li><a href="../two.xhtml">Tom &amp; Jerry</a></li><li><a href="gone.xhtml">Gone</a></li></ol></li></ol></nav></body></html>"#;
        assert_eq!(
            contents_of("OEBPS/text/nav.xhtml", nav, &chapters),
            [heading("Part One", 0, 0), heading("Tom & Jerry", 1, 1)]
        );
        let ncx = r#"<ncx><navMap><navPoint><navLabel><text>One</text></navLabel><content src="text/one.xhtml"/>
            <navPoint><navLabel><text>Two</text></navLabel><content src="two.xhtml"/></navPoint></navPoint></navMap></ncx>"#;
        assert_eq!(contents_of("OEBPS/toc.ncx", ncx, &chapters), [heading("One", 0, 0), heading("Two", 1, 1)]);
    }

    #[test]
    fn a_book_drops_chapters_that_are_missing_or_locked() {
        let container = br#"<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>"#;
        let package = br#"<package><manifest><item id="a" href="one.xhtml"/><item id="b" href="two.xhtml"/></manifest>
            <spine><itemref idref="a"/><itemref idref="b"/></spine></package>"#;
        let lock = br#"<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><EncryptedData>
            <CipherData><CipherReference URI="OEBPS/one.xhtml"/></CipherData></EncryptedData></encryption>"#;
        let files: [(&str, &[u8]); 4] = [
            ("META-INF/container.xml", container),
            ("META-INF/encryption.xml", lock),
            ("OEBPS/content.opf", package),
            ("OEBPS/one.xhtml", b"noise"),
        ];
        let path = archive("locked.epub", &files);
        assert!(book(&path).unwrap().chapters.is_empty());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn comic_pages_come_in_reading_order_and_draw() {
        // A 2 by 1 BMP: one red pixel, one blue.
        let mut bmp = vec![b'B', b'M'];
        bmp.extend(62u32.to_le_bytes());
        bmp.extend([0; 4]);
        bmp.extend(54u32.to_le_bytes());
        bmp.extend(40u32.to_le_bytes());
        bmp.extend(2i32.to_le_bytes());
        bmp.extend(1i32.to_le_bytes());
        bmp.extend(1u16.to_le_bytes());
        bmp.extend(24u16.to_le_bytes());
        bmp.extend([0; 24]);
        bmp.extend([0, 0, 255, 255, 0, 0, 0, 0]);
        let files: [(&str, &[u8]); 5] = [
            ("p10.bmp", &bmp),
            ("p2.bmp", &bmp),
            ("notes.txt", b"x"),
            ("__MACOSX/p1.bmp", b"x"),
            ("sub/p1.bmp", &bmp),
        ];
        let path = archive("comic.cbz", &files);
        assert_eq!(pages(&path).unwrap(), ["p2.bmp", "p10.bmp", "sub/p1.bmp"]);
        let bytes = picture(&path, "p2.bmp", 100, None).unwrap();
        assert_eq!(&bytes[..8], &[2, 0, 0, 0, 1, 0, 0, 0]);
        assert_eq!(&bytes[8..], &[255, 0, 0, 255, 0, 0, 255, 255]);
        assert!(picture(&path, "notes.txt", 100, None).is_err());
        assert_eq!(cover(&path, 100).unwrap(), bytes, "a comic's cover is its first page");
        assert!(has_cover(&path) && !has_cover(Path::new("a.zip")));
        let (list, more) = entries(&path).unwrap();
        assert_eq!((list.len(), more), (5, false));
        assert_eq!((list[0].name.as_str(), list[0].size, list[0].folder), ("p10.bmp", bmp.len() as u64, false));
        std::fs::remove_file(path).unwrap();
    }
}
