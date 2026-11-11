//! What the quick preview and the details panel show: text in pieces, Markdown made safe, every
//! property Windows knows, and a SHA-256 checksum. All of it blocks, so call it off the main thread.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use pulldown_cmark::{html, CowStr, Event, Options, Parser, Tag, TagEnd};
use serde::Serialize;
use windows::core::{Interface, HSTRING, PWSTR};
use windows::Win32::Foundation::PROPERTYKEY;
use windows::Win32::Security::Cryptography::{
    BCryptCreateHash, BCryptDestroyHash, BCryptFinishHash, BCryptHashData, BCRYPT_HASH_HANDLE,
    BCRYPT_MD5_ALG_HANDLE, BCRYPT_SHA1_ALG_HANDLE, BCRYPT_SHA256_ALG_HANDLE, BCRYPT_SHA512_ALG_HANDLE,
};
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::UI::Shell::PropertiesSystem::{
    IPropertyDescription, IPropertyStore, PSFormatPropertyValue, PSGetPropertyDescription, PSGetPropertyKeyFromName,
    SHGetPropertyStoreFromParsingName, GPS_DEFAULT, GPS_FASTPROPERTIESONLY, PDFF_DEFAULT, PDTF_ISVIEWABLE,
};

use crate::inside;
use crate::ops::Com;
use crate::thumbs;

/// One piece of a text file. Big files come in many, as the user scrolls.
const PIECE_BYTES: usize = 256 * 1024;
/// Bigger Markdown shows as plain text, since rendering needs all of it at once.
const MARKDOWN_BYTES: u64 = 4 * 1024 * 1024;
const HASH_BYTES: usize = 1024 * 1024;
/// The most a 3D model, or one file it points to, may take.
const MODEL_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Preview {
    /// `next` is where the following piece starts, if there is one.
    #[serde(rename_all = "camelCase")]
    Text { text: String, next: Option<u64> },
    Markdown { html: String },
    /// What a ZIP holds, and whether there was more than the list.
    Archive { entries: Vec<inside::Entry>, more: bool },
    /// A comic's pages, by their names inside it.
    Comic { pages: Vec<String> },
    /// A book's title, its chapters by their names inside it, and its table of contents.
    Book { title: String, chapters: Vec<String>, contents: Vec<inside::Heading> },
    /// A 3D model, drawn by the window from the file's bytes.
    Model,
    /// A MIDI file, played through the bundled SoundFont.
    Song,
    /// A sound file the window plays itself, streamed from disk.
    Audio,
    /// Anything else shows Windows' own picture of it.
    Picture,
}

/// The part of `bytes` that is whole UTF-8 text, or `None` if it is not text at all. A cut in the
/// middle of a character is fine when more follows.
pub fn as_text(bytes: &[u8], more: bool) -> Option<&str> {
    let text = match std::str::from_utf8(bytes) {
        Ok(text) => text,
        Err(cut) if more && cut.error_len().is_none() => std::str::from_utf8(&bytes[..cut.valid_up_to()]).ok()?,
        Err(_) => return None,
    };
    let plain = |c: char| !c.is_control() || matches!(c, '\n' | '\r' | '\t' | '\x0c');
    text.chars().all(plain).then_some(text)
}

fn is_markdown(path: &Path) -> bool {
    let extension = path.extension().map(|extension| extension.to_string_lossy().to_lowercase());
    matches!(extension.as_deref(), Some("md" | "markdown" | "mdown" | "mkd"))
}

/// What a file shows, starting at `offset` for the later pieces of a text.
pub fn read(path: &Path, offset: u64) -> Preview {
    if path.is_dir() || thumbs::is_online_only(path) {
        return Preview::Picture;
    }
    if offset == 0 {
        if let Some(preview) = inside_of(path) {
            return preview;
        }
    }
    let size = path.metadata().map_or(0, |data| data.len());
    if offset == 0 && is_markdown(path) && size <= MARKDOWN_BYTES {
        if let Some(text) = std::fs::read(path).ok().and_then(|bytes| as_text(strip_bom(&bytes), false).map(markdown)) {
            return Preview::Markdown { html: text };
        }
    }
    piece(path, offset).unwrap_or(Preview::Picture)
}

/// A comic or a book that can't be read still shows what it holds, as any ZIP does.
fn inside_of(path: &Path) -> Option<Preview> {
    let extension = path.extension()?.to_string_lossy().to_lowercase();
    let listed = || inside::entries(path).ok().map(|(entries, more)| Preview::Archive { entries, more });
    match extension.as_str() {
        "zip" => listed(),
        "cbz" => match inside::pages(path) {
            Ok(pages) if !pages.is_empty() => Some(Preview::Comic { pages }),
            _ => listed(),
        },
        "epub" => match inside::book(path) {
            Ok(book) if !book.chapters.is_empty() => Some(Preview::Book { title: book.title, chapters: book.chapters, contents: book.contents }),
            _ => listed(),
        },
        "glb" | "gltf" | "obj" | "stl" | "usdz" | "usd" | "usda" | "usdc" | "fbx" | "ply" | "3mf" => Some(Preview::Model),
        "mid" | "midi" => Some(Preview::Song),
        "mp3" | "m4a" | "aac" | "wav" | "flac" | "ogg" | "oga" | "opus" | "weba" => Some(Preview::Audio),
        _ => None,
    }
}

/// A 3D model's file or, with `part`, a file it points to. Like Markdown pictures, parts come
/// only from this PC, by a path relative to the model's folder, never from the web, and never
/// from outside that folder, even through `..` or a link.
pub fn model_file(path: &Path, part: Option<&str>) -> Result<Vec<u8>, String> {
    let path = match part {
        None => path.to_path_buf(),
        Some(part) if !part.is_empty() && !part.contains(':') && !part.starts_with(['/', '\\']) => {
            let folder = path.parent().ok_or("The model has no folder")?;
            let folder = folder.canonicalize().map_err(|error| error.to_string())?;
            let found = folder.join(part).canonicalize().map_err(|error| error.to_string())?;
            if !found.starts_with(&folder) {
                return Err("Only files beside the model can load".into());
            }
            found
        }
        Some(_) => return Err("Only files beside the model can load".into()),
    };
    let size = path.metadata().map_err(|error| error.to_string())?.len();
    if size > MODEL_BYTES {
        return Err(format!("Files over {} MB don't show", MODEL_BYTES / 1024 / 1024));
    }
    std::fs::read(&path).map_err(|error| error.to_string())
}

fn strip_bom(bytes: &[u8]) -> &[u8] {
    bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes)
}

fn piece(path: &Path, offset: u64) -> Option<Preview> {
    let mut file = File::open(path).ok()?;
    file.seek(SeekFrom::Start(offset)).ok()?;
    let mut bytes = Vec::with_capacity(PIECE_BYTES);
    file.take(PIECE_BYTES as u64 + 1).read_to_end(&mut bytes).ok()?;
    let more = bytes.len() > PIECE_BYTES;
    bytes.truncate(PIECE_BYTES);
    let body = if offset == 0 { strip_bom(&bytes) } else { &bytes };
    let skipped = bytes.len() - body.len();
    let text = as_text(body, more)?;
    if offset == 0 && text.is_empty() {
        return None;
    }
    // A piece ends after a whole line, so no line is split between two of them.
    let shown = if more { text.rfind('\n').map_or(text, |end| &text[..=end]) } else { text };
    let next = more.then(|| offset + (skipped + shown.len()) as u64);
    Some(Preview::Text { text: shown.to_string(), next })
}

/// HTML for Markdown, with no HTML of its own: tags in the text show as text, links that are not
/// web or mail links do nothing, and only pictures on this PC show. Their `<canvas>` carries the
/// full path for the window to draw.
pub fn markdown(text: &str) -> String {
    let parser = Parser::new_ext(text, Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS);
    let mut events = Vec::new();
    let mut picture: Option<(CowStr, String)> = None;
    for event in parser {
        if let Some((_, alt)) = &mut picture {
            match event {
                Event::End(TagEnd::Image) => {
                    let (dest, alt) = picture.take().unwrap();
                    events.push(Event::Html(picture_html(&dest, &alt).into()));
                }
                Event::Text(text) | Event::Code(text) => alt.push_str(&text),
                _ => {}
            }
            continue;
        }
        match event {
            Event::Start(Tag::Image { dest_url, .. }) => picture = Some((dest_url, String::new())),
            Event::Start(Tag::Link { link_type, dest_url, title, id }) => {
                let safe = is_web_link(&dest_url);
                let dest_url = if safe { dest_url } else { CowStr::Borrowed("") };
                events.push(Event::Start(Tag::Link { link_type, dest_url, title, id }));
            }
            Event::Html(raw) | Event::InlineHtml(raw) => events.push(Event::Text(raw)),
            other => events.push(other),
        }
    }
    let mut out = String::new();
    html::push_html(&mut out, events.into_iter());
    out
}

pub(crate) fn is_web_link(dest: &str) -> bool {
    let lower = dest.to_ascii_lowercase();
    ["https://", "http://", "mailto:"].iter().any(|scheme| lower.starts_with(scheme))
}

pub(crate) fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// A picture beside the file stays on this PC, so it shows. One from the web would tell a server
/// the file was opened, so it never loads.
fn picture_html(dest: &str, alt: &str) -> String {
    let local = !dest.contains(':') && !dest.starts_with("//") && !dest.is_empty();
    if local {
        format!(r#"<canvas class="md-picture" data-picture="{}" aria-label="{}"></canvas>"#, escape(dest), escape(alt))
    } else {
        let label = if alt.is_empty() { "Picture from the web" } else { alt };
        format!(r#"<span class="md-blocked">{}</span>"#, escape(label))
    }
}

/// A song's own name, artist and album, from its tags, where it has them.
#[derive(Debug, Default, Serialize)]
pub struct Tags {
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
}

pub fn tags(path: &Path) -> Tags {
    let _com = Com::enter();
    let flags = if thumbs::is_online_only(path) { GPS_FASTPROPERTIESONLY } else { GPS_DEFAULT };
    let Ok(store) = (unsafe { SHGetPropertyStoreFromParsingName::<_, _, IPropertyStore>(&HSTRING::from(path.as_os_str()), None, flags) })
    else {
        return Tags::default();
    };
    let read = |name: &str| -> Option<String> {
        let mut key = PROPERTYKEY::default();
        unsafe { PSGetPropertyKeyFromName(&HSTRING::from(name), &raw mut key) }.ok()?;
        let mut raw = std::ptr::null_mut();
        unsafe { PSGetPropertyDescription(&raw const key, &IPropertyDescription::IID, &raw mut raw) }.ok()?;
        let description = unsafe { IPropertyDescription::from_raw(raw) };
        let value = owned(unsafe { PSFormatPropertyValue(&store, &description, PDFF_DEFAULT) }.ok()?);
        let value = value.trim();
        (!value.is_empty()).then(|| value.to_string())
    };
    Tags { title: read("System.Title"), artist: read("System.Music.Artist"), album: read("System.Music.AlbumTitle") }
}

/// Takes a string Windows allocated.
fn owned(text: PWSTR) -> String {
    let value = unsafe { text.to_string() }.unwrap_or_default();
    unsafe { CoTaskMemFree(Some(text.0 as _)) };
    value
}

/// The heading a property goes under, from Windows' own name for it, such as `System.Image.Dimensions`.
fn group_of(canonical: &str) -> &'static str {
    let name = canonical.strip_prefix("System.").unwrap_or(canonical);
    let area = name.split('.').next().unwrap_or_default();
    match area {
        "Image" | "Photo" | "GPS" => "Picture",
        "Audio" | "Music" | "Media" | "Video" | "DRM" => "Media",
        "Document" | "Author" | "Title" | "Subject" | "Comment" | "Keywords" | "Category" | "Company" => "Document",
        _ if area.starts_with("Date") => "Dates",
        _ if canonical.starts_with("System.") && !name.contains('.') => "File",
        _ => "More",
    }
}

/// The order the headings show in.
const GROUPS: [&str; 6] = ["File", "Dates", "Picture", "Media", "Document", "More"];

/// Every property Windows can show for the item, as heading, display name and value. Headings
/// come in `GROUPS` order, and each keeps Windows' own order inside.
pub fn properties(path: &Path) -> windows::core::Result<Vec<(&'static str, String, String)>> {
    let _com = Com::enter();
    // Reading a file in the cloud for its properties would download it.
    let flags = if thumbs::is_online_only(path) { GPS_FASTPROPERTIESONLY } else { GPS_DEFAULT };
    let store: IPropertyStore = unsafe { SHGetPropertyStoreFromParsingName(&HSTRING::from(path.as_os_str()), None, flags) }?;
    let mut found = Vec::new();
    for at in 0..unsafe { store.GetCount() }? {
        let mut key = PROPERTYKEY::default();
        if unsafe { store.GetAt(at, &raw mut key) }.is_err() {
            continue;
        }
        let mut raw = std::ptr::null_mut();
        if unsafe { PSGetPropertyDescription(&raw const key, &IPropertyDescription::IID, &raw mut raw) }.is_err() {
            continue;
        }
        let description = unsafe { IPropertyDescription::from_raw(raw) };
        let viewable = unsafe { description.GetTypeFlags(PDTF_ISVIEWABLE) }.is_ok_and(|flags| flags == PDTF_ISVIEWABLE);
        let Ok(label) = (unsafe { description.GetDisplayName() }).map(owned) else { continue };
        let group = group_of(&unsafe { description.GetCanonicalName() }.map(owned).unwrap_or_default());
        let Ok(value) = (unsafe { PSFormatPropertyValue(&store, &description, PDFF_DEFAULT) }).map(owned) else {
            continue;
        };
        // Windows marks some text with direction marks, which only get in the way here.
        let value: String = value.chars().filter(|c| !matches!(c, '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}')).collect();
        if viewable && !label.is_empty() && !value.trim().is_empty() && !found.iter().any(|(_, known, _)| known == &label) {
            found.push((group, label, value));
        }
    }
    // Stable, so each heading keeps Windows' order.
    found.sort_by_key(|(group, ..)| GROUPS.iter().position(|known| known == group));
    Ok(found)
}

static LATEST_HASH: AtomicU64 = AtomicU64::new(0);

/// The file's checksum by `algorithm` (md5, sha1, sha256 or sha512) in lowercase hex, through
/// Windows' own crypto. `None` once a newer checksum was asked for, because only one is ever shown.
// ponytail: one checksum at a time for the whole app, which fits one details panel. A ticket per
// view would let two panels hash side by side.
pub fn hash(path: &Path, algorithm: &str) -> std::io::Result<Option<String>> {
    let (handle, length) = match algorithm {
        "md5" => (BCRYPT_MD5_ALG_HANDLE, 16),
        "sha1" => (BCRYPT_SHA1_ALG_HANDLE, 20),
        "sha256" => (BCRYPT_SHA256_ALG_HANDLE, 32),
        "sha512" => (BCRYPT_SHA512_ALG_HANDLE, 64),
        _ => return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "Unknown checksum kind")),
    };
    let ticket = LATEST_HASH.fetch_add(1, Ordering::SeqCst) + 1;
    let mut file = File::open(path)?;
    let mut hash = BCRYPT_HASH_HANDLE::default();
    unsafe { BCryptCreateHash(handle, &raw mut hash, None, None, 0) }.ok()?;
    let digest = (|| {
        let mut buffer = vec![0; HASH_BYTES];
        loop {
            if LATEST_HASH.load(Ordering::SeqCst) != ticket {
                return Ok(None);
            }
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            unsafe { BCryptHashData(hash, &buffer[..count], 0) }.ok()?;
        }
        let mut digest = vec![0u8; length];
        unsafe { BCryptFinishHash(hash, &mut digest, 0) }.ok()?;
        Ok(Some(digest.iter().map(|byte| format!("{byte:02x}")).collect()))
    })();
    let _ = unsafe { BCryptDestroyHash(hash) };
    digest
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use super::*;

    fn folder(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("perli-preview-{name}-{}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn big_text_comes_in_whole_lines_that_join_up() {
        let folder = folder("pieces");
        let file = folder.join("big.log");
        let line = "é line of text\n";
        let whole = format!("\u{FEFF}{}", line.repeat(PIECE_BYTES * 2 / line.len()));
        fs::write(&file, &whole).unwrap();

        let mut joined = String::new();
        let mut offset = 0;
        let mut pieces = 0;
        loop {
            let Preview::Text { text, next } = read(&file, offset) else { panic!("not text") };
            assert!(text.ends_with('\n'));
            joined.push_str(&text);
            pieces += 1;
            match next {
                Some(at) => offset = at,
                None => break,
            }
        }
        assert_eq!(joined, whole.trim_start_matches('\u{FEFF}'));
        assert!(pieces >= 2);
        fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn markdown_renders_but_its_html_links_and_web_pictures_do_not() {
        let html = markdown(
            "# Hi\n\n<script>alert(1)</script>\n\n[web](https://a.b) [bad](javascript:alert(1)) [file](notes.md)\n\n\
             ![cat *pic*](pics/cat.png) ![](https://evil.example/t.png)\n\n| a | b |\n|---|---|\n| 1 | 2 |\n",
        );
        assert!(html.contains("<h1>Hi</h1>"), "{html}");
        assert!(html.contains("&lt;script&gt;"), "{html}");
        assert!(!html.contains("<script"), "{html}");
        assert!(html.contains(r#"<a href="https://a.b">web</a>"#), "{html}");
        assert!(!html.contains("javascript"), "{html}");
        assert!(!html.contains("notes.md"), "{html}");
        assert!(html.contains(r#"data-picture="pics/cat.png" aria-label="cat pic""#), "{html}");
        assert!(!html.contains("evil.example"), "{html}");
        assert!(html.contains("<table>"), "{html}");
    }

    #[test]
    fn markdown_files_render_and_others_fall_back() {
        let folder = folder("kinds");
        fs::write(folder.join("read.md"), "*hi*").unwrap();
        fs::write(folder.join("a.bin"), b"MZ\0\0").unwrap();
        fs::write(folder.join("empty.txt"), "").unwrap();

        assert_eq!(read(&folder.join("read.md"), 0), Preview::Markdown { html: "<p><em>hi</em></p>\n".into() });
        assert_eq!(read(&folder.join("a.bin"), 0), Preview::Picture);
        assert_eq!(read(&folder.join("empty.txt"), 0), Preview::Picture);
        assert_eq!(read(&folder, 0), Preview::Picture);
        fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn model_parts_load_only_from_beside_the_model() {
        let folder = folder("model");
        std::fs::create_dir_all(folder.join("textures")).unwrap();
        let model = folder.join("ship.gltf");
        std::fs::write(&model, "{}").unwrap();
        std::fs::write(folder.join("textures").join("hull.png"), "png").unwrap();

        assert_eq!(read(&model, 0), Preview::Model);
        assert_eq!(model_file(&model, None).unwrap(), b"{}");
        assert_eq!(model_file(&model, Some("textures/hull.png")).unwrap(), b"png");
        assert_eq!(model_file(&model, Some("textures/../textures/hull.png")).unwrap(), b"png");
        let inner = folder.join("inner");
        std::fs::create_dir_all(&inner).unwrap();
        let inner_model = inner.join("cube.gltf");
        std::fs::write(&inner_model, "{}").unwrap();
        for outside in ["../ship.gltf", r"..\ship.gltf", r"..\textures\hull.png", "../textures/hull.png"] {
            assert!(model_file(&inner_model, Some(outside)).is_err(), "{outside}");
        }
        for outside in ["https://example.com/hull.png", "C:/Windows/win.ini", "//server/share/x", r"\\server\x", "/x", ""] {
            assert!(model_file(&model, Some(outside)).is_err(), "{outside}");
        }
    }

    #[test]
    fn every_checksum_kind_matches_its_known_answer() {
        let folder = folder("hash");
        let file = folder.join("abc.txt");
        fs::write(&file, "abc").unwrap();
        for (kind, known) in [
            ("md5", "900150983cd24fb0d6963f7d28e17f72"),
            ("sha1", "a9993e364706816aba3e25717850c26c9cd0d89d"),
            ("sha256", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"),
            (
                "sha512",
                "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a\
                 2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f",
            ),
        ] {
            assert_eq!(hash(&file, kind).unwrap().unwrap(), known, "{kind}");
        }
        assert!(hash(&file, "crc").is_err());
        fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn a_file_lists_its_properties_by_name() {
        let folder = folder("props");
        let file = folder.join("a.txt");
        fs::write(&file, "hello").unwrap();
        let found = properties(&file).unwrap();
        assert!(found.len() >= 3, "{found:?}");
        assert!(found.iter().any(|(_, _, value)| value.contains("a.txt")), "{found:?}");
        // Headings never go back to one already left.
        let places: Vec<_> = found.iter().map(|(group, ..)| GROUPS.iter().position(|known| known == group).unwrap()).collect();
        assert!(places.is_sorted(), "{found:?}");
        assert!(found.iter().any(|(group, ..)| *group == "Dates"), "{found:?}");
        fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn properties_go_under_the_heading_their_name_says() {
        for (name, group) in [
            ("System.Size", "File"),
            ("System.ItemTypeText", "File"),
            ("System.DateModified", "Dates"),
            ("System.Image.Dimensions", "Picture"),
            ("System.Photo.CameraModel", "Picture"),
            ("System.Music.Artist", "Media"),
            ("System.Video.FrameRate", "Media"),
            ("System.Document.PageCount", "Document"),
            ("System.Title", "Document"),
            ("System.Link.TargetParsingPath", "More"),
            ("Vendor.Thing", "More"),
        ] {
            assert_eq!(group_of(name), group, "{name}");
        }
    }
}
