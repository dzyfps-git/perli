//! Font files: what each face in one says about itself, and each face on its own for the window
//! to draw with. TrueType, OpenType, WOFF, WOFF2 and collections of faces (`.ttc`) all read.

use std::borrow::Cow;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;
use ttf_parser::{name_id, Face, Language, Permissions, RawFace};

/// The most of a font file that is read, and of what it unpacks to.
const FONT_BYTES: u64 = 64 * 1024 * 1024;
/// A collection shows this many of its faces at most.
const MOST_FACES: u32 = 64;

/// What one face of a font says about itself. Text it doesn't give is empty.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Facts {
    pub family: String,
    pub style: String,
    pub full_name: String,
    pub version: String,
    pub designer: String,
    pub maker: String,
    pub copyright: String,
    pub license: String,
    pub description: String,
    /// The face's own sample text, if its maker gave one.
    pub sample: String,
    pub glyphs: u16,
    pub units_per_em: u16,
    pub weight: u16,
    /// From 1, ultra-condensed, to 9, ultra-expanded; 5 is normal.
    pub width: u16,
    pub italic: bool,
    pub monospaced: bool,
    /// "TrueType", "CFF", "CFF2" or "Bitmap".
    pub outlines: &'static str,
    /// What the maker lets a document that embeds the face do with it.
    pub embedding: &'static str,
    /// The characters it draws, as runs of first and last code points.
    pub characters: Vec<[u32; 2]>,
    pub axes: Vec<Axis>,
}

/// One way a variable font can change, such as its weight.
#[derive(Debug, PartialEq, Serialize)]
pub struct Axis {
    pub tag: String,
    pub name: String,
    pub min: f32,
    pub default: f32,
    pub max: f32,
}

fn read(path: &Path) -> Result<Vec<u8>, String> {
    let size = path.metadata().map_err(|error| error.to_string())?.len();
    if size > FONT_BYTES {
        return Err(format!("Fonts over {} MB don't show", FONT_BYTES / 1024 / 1024));
    }
    std::fs::read(path).map_err(|error| error.to_string())
}

/// Each face of a font file, with what it says about itself.
pub fn faces(path: &Path) -> Result<Vec<Facts>, String> {
    let bytes = read(path)?;
    let count = ttf_parser::fonts_in_collection(&bytes).unwrap_or(1).min(MOST_FACES);
    (0..count).map(|index| facts(&sfnt(&bytes, index)?)).collect()
}

/// One face of a font file as the window can load it: a face of a collection on its own, any
/// other font as it is.
pub fn face_file(path: &Path, index: u32) -> Result<Vec<u8>, String> {
    let bytes = read(path)?;
    if bytes.starts_with(b"ttcf") {
        Ok(split(&bytes, index)?)
    } else {
        Ok(bytes)
    }
}

const UNREADABLE: &str = "This font can't be read";

/// A face as plain TrueType or OpenType, unpacked from WOFF or taken out of a collection.
fn sfnt(bytes: &[u8], index: u32) -> Result<Cow<'_, [u8]>, String> {
    match bytes.get(..4) {
        Some(b"ttcf") => split(bytes, index).map(Cow::Owned),
        Some(b"wOFF") => unwrap_woff(bytes).map(Cow::Owned),
        Some(b"wOF2") => unwrap_woff2(bytes).map(Cow::Owned),
        _ => Ok(Cow::Borrowed(bytes)),
    }
}

fn facts(data: &[u8]) -> Result<Facts, String> {
    let face = Face::parse(data, 0).map_err(|error| format!("{UNREADABLE}: {error}"))?;
    let name = |id: u16| {
        let mut any = None;
        for one in face.names().into_iter().filter(|one| one.name_id == id) {
            if let Some(text) = one.to_string().filter(|text| !text.trim().is_empty()) {
                if one.language() == Language::English_UnitedStates {
                    return text;
                }
                any.get_or_insert(text);
            }
        }
        any.unwrap_or_default()
    };
    let either = |first: u16, then: u16| Some(name(first)).filter(|text| !text.is_empty()).unwrap_or_else(|| name(then));
    let has = |tag: &[u8; 4]| face.raw_face().table(ttf_parser::Tag::from_bytes(tag)).is_some();
    let mut points = Vec::new();
    for table in face.tables().cmap.into_iter().flat_map(|cmap| cmap.subtables).filter(|table| table.is_unicode()) {
        table.codepoints(|point| {
            if table.glyph_index(point).is_some_and(|glyph| glyph.0 != 0) {
                points.push(point);
            }
        });
    }
    points.sort_unstable();
    points.dedup();
    Ok(Facts {
        family: either(name_id::TYPOGRAPHIC_FAMILY, name_id::FAMILY),
        style: either(name_id::TYPOGRAPHIC_SUBFAMILY, name_id::SUBFAMILY),
        full_name: name(name_id::FULL_NAME),
        version: name(name_id::VERSION),
        designer: name(name_id::DESIGNER),
        maker: name(name_id::MANUFACTURER),
        copyright: name(name_id::COPYRIGHT_NOTICE),
        license: name(name_id::LICENSE),
        description: name(name_id::DESCRIPTION),
        sample: name(name_id::SAMPLE_TEXT),
        glyphs: face.number_of_glyphs(),
        units_per_em: face.units_per_em(),
        weight: face.weight().to_number(),
        width: face.width().to_number(),
        italic: face.is_italic(),
        monospaced: face.is_monospaced(),
        outlines: if has(b"glyf") {
            "TrueType"
        } else if has(b"CFF ") {
            "CFF"
        } else if has(b"CFF2") {
            "CFF2"
        } else {
            "Bitmap"
        },
        embedding: match face.permissions() {
            Some(Permissions::Installable) | None => "Installable",
            Some(Permissions::Restricted) => "Restricted",
            Some(Permissions::PreviewAndPrint) => "Preview and print",
            Some(Permissions::Editable) => "Editable",
        },
        characters: runs(&points),
        axes: face
            .variation_axes()
            .into_iter()
            .filter(|axis| !axis.hidden)
            .map(|axis| Axis { tag: axis.tag.to_string(), name: name(axis.name_id), min: axis.min_value, default: axis.def_value, max: axis.max_value })
            .collect(),
    })
}

/// Sorted code points as runs of first and last.
fn runs(points: &[u32]) -> Vec<[u32; 2]> {
    let mut found: Vec<[u32; 2]> = Vec::new();
    for &point in points {
        match found.last_mut() {
            Some(run) if run[1] + 1 == point => run[1] = point,
            _ => found.push([point, point]),
        }
    }
    found
}

fn be16(bytes: &[u8], at: usize) -> Result<u16, String> {
    Ok(u16::from_be_bytes(bytes.get(at..at + 2).ok_or(UNREADABLE)?.try_into().unwrap()))
}

fn be32(bytes: &[u8], at: usize) -> Result<u32, String> {
    Ok(u32::from_be_bytes(bytes.get(at..at + 4).ok_or(UNREADABLE)?.try_into().unwrap()))
}

fn part(bytes: &[u8], at: u32, length: u32) -> Result<&[u8], String> {
    let at = at as usize;
    bytes.get(at..at + length as usize).ok_or_else(|| UNREADABLE.to_string())
}

/// A font file of its own from tables, sorted by tag as the format wants.
fn write_sfnt(flavor: u32, tables: &mut [([u8; 4], &[u8])]) -> Vec<u8> {
    tables.sort_by_key(|(tag, _)| *tag);
    // A broken file can list more tables than fit; what comes out is then as broken as it was.
    let count = tables.len() as u16;
    let log = count.max(1).ilog2() as u16;
    let search = 16u16 << log;
    let mut out = Vec::new();
    out.extend(flavor.to_be_bytes());
    for value in [count, search, log, count.wrapping_mul(16).wrapping_sub(search)] {
        out.extend(value.to_be_bytes());
    }
    let mut offset = 12 + 16 * tables.len();
    for (tag, data) in tables.iter() {
        let sum = data.chunks(4).fold(0u32, |sum, word| {
            let mut padded = [0; 4];
            padded[..word.len()].copy_from_slice(word);
            sum.wrapping_add(u32::from_be_bytes(padded))
        });
        out.extend(tag);
        out.extend(sum.to_be_bytes());
        out.extend((offset as u32).to_be_bytes());
        out.extend((data.len() as u32).to_be_bytes());
        offset += data.len().next_multiple_of(4);
    }
    for (_, data) in tables.iter() {
        out.extend(*data);
        out.resize(out.len().next_multiple_of(4), 0);
    }
    out
}

/// One face of a collection as a font file of its own.
fn split(bytes: &[u8], index: u32) -> Result<Vec<u8>, String> {
    let raw = RawFace::parse(bytes, index).map_err(|error| format!("{UNREADABLE}: {error}"))?;
    let flavor = be32(bytes, be32(bytes, 12 + 4 * index as usize)? as usize)?;
    let mut tables = raw.table_records.into_iter().map(|record| Ok((record.tag.to_bytes(), part(bytes, record.offset, record.length)?))).collect::<Result<Vec<_>, String>>()?;
    Ok(write_sfnt(flavor, &mut tables))
}

fn inflate(data: &[u8], length: u32) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    flate2::read::ZlibDecoder::new(data).take(u64::from(length)).read_to_end(&mut out).map_err(|error| error.to_string())?;
    Ok(out)
}

/// A WOFF file's face: each table squeezed on its own with zlib.
fn unwrap_woff(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let flavor = be32(bytes, 4)?;
    let mut owned = Vec::new();
    let mut total = 0u64;
    for at in 0..be16(bytes, 12)? as usize {
        let entry = 44 + at * 20;
        let tag: [u8; 4] = bytes.get(entry..entry + 4).ok_or(UNREADABLE)?.try_into().unwrap();
        let (offset, packed, length) = (be32(bytes, entry + 4)?, be32(bytes, entry + 8)?, be32(bytes, entry + 12)?);
        total += u64::from(length);
        if total > FONT_BYTES {
            return Err(UNREADABLE.into());
        }
        let data = part(bytes, offset, packed)?;
        owned.push((tag, if packed < length { inflate(data, length)? } else { data.to_vec() }));
    }
    let mut tables: Vec<_> = owned.iter().map(|(tag, data)| (*tag, data.as_slice())).collect();
    Ok(write_sfnt(flavor, &mut tables))
}

/// The tags WOFF2 knows by number, in its order.
const KNOWN_TAGS: [&[u8; 4]; 63] = [
    b"cmap", b"head", b"hhea", b"hmtx", b"maxp", b"name", b"OS/2", b"post", b"cvt ", b"fpgm", b"glyf", b"loca", b"prep", b"CFF ", b"VORG", b"EBDT",
    b"EBLC", b"gasp", b"hdmx", b"kern", b"LTSH", b"PCLT", b"VDMX", b"vhea", b"vmtx", b"BASE", b"GDEF", b"GPOS", b"GSUB", b"EBSC", b"JSTF", b"MATH",
    b"CBDT", b"CBLC", b"COLR", b"CPAL", b"SVG ", b"sbix", b"acnt", b"avar", b"bdat", b"bloc", b"bsln", b"cvar", b"fdsc", b"feat", b"fmtx", b"fvar",
    b"gvar", b"hsty", b"just", b"lcar", b"mort", b"morx", b"opbd", b"prop", b"trak", b"Zapf", b"Silf", b"Glat", b"Gloc", b"Feat", b"Sill",
];

/// WOFF2's numbers of one to five bytes, seven bits in each.
fn base128(bytes: &[u8], at: &mut usize) -> Result<u32, String> {
    let mut value = 0u32;
    for place in 0..5 {
        let byte = *bytes.get(*at).ok_or(UNREADABLE)?;
        *at += 1;
        if (place == 0 && byte == 0x80) || value >> 25 != 0 {
            return Err(UNREADABLE.into());
        }
        value = (value << 7) | u32::from(byte & 0x7f);
        if byte & 0x80 == 0 {
            return Ok(value);
        }
    }
    Err(UNREADABLE.into())
}

/// A WOFF2 file's face, enough of it for its facts: all its tables squeezed together with
/// Brotli. The outlines come rebuilt into a form of WOFF2's own, which nothing here reads, so they
/// are left out; an empty `glyf` keeps the word that the face has TrueType outlines.
fn unwrap_woff2(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let flavor = be32(bytes, 4)?;
    if flavor == u32::from_be_bytes(*b"ttcf") {
        return Err(format!("{UNREADABLE}: a collection in WOFF2"));
    }
    let mut at = 48;
    let mut listed = Vec::new();
    for _ in 0..be16(bytes, 12)? {
        let flags = *bytes.get(at).ok_or(UNREADABLE)?;
        at += 1;
        let tag = match flags & 63 {
            63 => {
                let tag: [u8; 4] = bytes.get(at..at + 4).ok_or(UNREADABLE)?.try_into().unwrap();
                at += 4;
                tag
            }
            known => *KNOWN_TAGS[known as usize],
        };
        let length = base128(bytes, &mut at)?;
        let transformed = match &tag {
            b"glyf" | b"loca" => flags >> 6 != 3,
            _ => flags >> 6 != 0,
        };
        let stored = if transformed { base128(bytes, &mut at)? } else { length };
        listed.push((tag, transformed, stored as usize));
    }
    let packed = bytes.get(at..at + be32(bytes, 20)? as usize).ok_or(UNREADABLE)?;
    let mut stream = Vec::new();
    brotli_decompressor::Decompressor::new(packed, 4096).take(FONT_BYTES).read_to_end(&mut stream).map_err(|error| error.to_string())?;
    let mut tables = Vec::new();
    let mut from = 0;
    for (tag, transformed, stored) in listed {
        let data = stream.get(from..from + stored).ok_or(UNREADABLE)?;
        from += stored;
        if !transformed {
            tables.push((tag, data));
        } else if &tag == b"glyf" {
            tables.push((tag, &[][..]));
        }
    }
    Ok(write_sfnt(flavor, &mut tables))
}

/// Where Windows keeps fonts it shows to every app, in the registry.
const FONTS_KEY: &str = r"Software\Microsoft\Windows NT\CurrentVersion\Fonts";

/// Who a font is installed for.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Installed {
    No,
    /// This user alone, which Perli can undo.
    User,
    /// Everyone on the PC, which takes an admin to change.
    System,
}

fn user_fonts() -> Option<PathBuf> {
    Some(PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join(r"Microsoft\Windows\Fonts"))
}

fn system_fonts() -> Option<PathBuf> {
    Some(PathBuf::from(std::env::var_os("WINDIR")?).join("Fonts"))
}

/// The installed copy's file name. Windows can't use a web font, so the font inside one is
/// installed instead, as `.otf` or `.ttf` by its outlines.
fn installed_name(path: &Path, start: &[u8]) -> String {
    let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
    if !matches!(start.get(..4), Some(b"wOFF" | b"wOF2")) {
        return name;
    }
    let stem = path.file_stem().unwrap_or_default().to_string_lossy();
    match start.get(4..8) {
        Some(b"OTTO") => format!("{stem}.otf"),
        _ => format!("{stem}.ttf"),
    }
}

/// The name Windows lists a font under: each face's full name, then the kind of its outlines.
fn registry_name(faces: &[Facts]) -> String {
    let mut names: Vec<&str> = Vec::new();
    for face in faces {
        let name = if face.full_name.is_empty() { face.family.as_str() } else { face.full_name.as_str() };
        if !names.contains(&name) {
            names.push(name);
        }
    }
    let kind = if faces.first().is_some_and(|face| face.outlines.starts_with("CFF")) { "OpenType" } else { "TrueType" };
    format!("{} ({kind})", names.join(" & "))
}

fn same_folder(a: &Path, b: &Path) -> bool {
    a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy())
}

/// The first bytes of a file, enough to tell a web font and its outlines.
fn start_of(path: &Path) -> Vec<u8> {
    let mut start = Vec::new();
    let _ = fs::File::open(path).map(|file| file.take(8).read_to_end(&mut start));
    start
}

/// Where the font at `path` is installed, by a file of its name and size in Windows' font folders.
pub fn installed(path: &Path) -> Installed {
    let folder = path.parent().unwrap_or(Path::new(""));
    if user_fonts().is_some_and(|fonts| same_folder(folder, &fonts)) {
        return Installed::User;
    }
    if system_fonts().is_some_and(|fonts| same_folder(folder, &fonts)) {
        return Installed::System;
    }
    let start = start_of(path);
    let web = matches!(start.get(..4), Some(b"wOFF" | b"wOF2"));
    let name = installed_name(path, &start);
    let size = path.metadata().map_or(0, |facts| facts.len());
    let there = |fonts: Option<PathBuf>| {
        fonts.and_then(|fonts| fonts.join(&name).metadata().ok()).is_some_and(|facts| web || facts.len() == size)
    };
    if there(user_fonts()) {
        Installed::User
    } else if there(system_fonts()) {
        Installed::System
    } else {
        Installed::No
    }
}

/// Tells every open app the fonts changed, as Windows' own font installer does.
fn tell_apps() {
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_FONTCHANGE};
    unsafe { SendMessageTimeoutW(HWND_BROADCAST, WM_FONTCHANGE, WPARAM(0), LPARAM(0), SMTO_ABORTIFHUNG, 1000, None) };
}

/// Installs the font for this user alone, as Windows does without an admin: a copy in the
/// user's font folder, named in the registry, and loaded for the apps open now.
pub fn install(path: &Path) -> Result<(), String> {
    use windows::Win32::Graphics::Gdi::AddFontResourceW;
    use windows::Win32::System::Registry::HKEY_CURRENT_USER;
    let bytes = read(path)?;
    let content = match bytes.get(..4) {
        Some(b"wOFF" | b"wOF2") => sfnt(&bytes, 0)?.into_owned(),
        _ => bytes.clone(),
    };
    let count = ttf_parser::fonts_in_collection(&content).unwrap_or(1).min(MOST_FACES);
    let faces = (0..count).map(|index| facts(&sfnt(&content, index)?)).collect::<Result<Vec<_>, _>>()?;
    let folder = user_fonts().ok_or("Windows has no font folder for this user")?;
    let target = folder.join(installed_name(path, &bytes));
    if target.exists() {
        return Err(format!("Another font named {} is installed already.", target.file_name().unwrap_or_default().to_string_lossy()));
    }
    fs::create_dir_all(&folder).map_err(|error| error.to_string())?;
    fs::write(&target, &content).map_err(|error| error.to_string())?;
    let named = crate::registry::write_text(HKEY_CURRENT_USER, FONTS_KEY, &registry_name(&faces), &target.to_string_lossy());
    if let Err(error) = named {
        let _ = fs::remove_file(&target);
        return Err(error.message());
    }
    unsafe { AddFontResourceW(&windows::core::HSTRING::from(target.as_path())) };
    tell_apps();
    Ok(())
}

/// True if a Fonts registry value names `target`: by its whole path, or by a bare file name
/// in `folder`.
fn points_at(data: &str, target: &Path, folder: &Path) -> bool {
    let named = Path::new(data.trim());
    let full = if named.is_absolute() { named.to_path_buf() } else { folder.join(named) };
    same_folder(&full, target)
}

/// Takes back a font installed for this user alone.
pub fn uninstall(path: &Path) -> Result<(), String> {
    use windows::Win32::Graphics::Gdi::RemoveFontResourceW;
    use windows::Win32::System::Registry::HKEY_CURRENT_USER;
    if installed(path) != Installed::User {
        return Err("It isn't installed for you alone, so Perli can't take it back.".into());
    }
    let folder = user_fonts().ok_or("Windows has no font folder for this user")?;
    let target = if path.parent().is_some_and(|parent| same_folder(parent, &folder)) {
        path.to_path_buf()
    } else {
        folder.join(installed_name(path, &start_of(path)))
    };
    let faces = faces(&target)?;
    let _ = unsafe { RemoveFontResourceW(&windows::core::HSTRING::from(target.as_path())) };
    // Windows' own installer may have said the other kind of outlines. A .ttf and an .otf of
    // the same name can both be installed, so only the name that points at this file goes.
    let name = registry_name(&faces);
    let base = name.trim_end_matches(" (TrueType)").trim_end_matches(" (OpenType)");
    for kind in ["TrueType", "OpenType"] {
        let value = format!("{base} ({kind})");
        let data = crate::registry::read_text(HKEY_CURRENT_USER, FONTS_KEY, Some(&value));
        if data.is_some_and(|data| points_at(&data, &target, &folder)) {
            crate::registry::delete_value(HKEY_CURRENT_USER, FONTS_KEY, &value);
        }
    }
    tell_apps();
    fs::remove_file(&target).map_err(|_| "Windows took it out, but an app still holds the file, so it stays in your font folder for now.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn arial() -> Vec<u8> {
        std::fs::read(r"C:\Windows\Fonts\arial.ttf").unwrap()
    }

    /// A font's tables by tag, from its own directory.
    fn tables_of(font: &[u8]) -> Vec<([u8; 4], Vec<u8>)> {
        let raw = RawFace::parse(font, 0).unwrap();
        raw.table_records.into_iter().map(|record| (record.tag.to_bytes(), part(font, record.offset, record.length).unwrap().to_vec())).collect()
    }

    #[test]
    fn a_font_tells_its_names_characters_and_outlines() {
        let facts = facts(&arial()).unwrap();
        assert_eq!(facts.family, "Arial");
        assert_eq!(facts.style, "Regular");
        assert_eq!(facts.outlines, "TrueType");
        assert!(!facts.monospaced && !facts.italic);
        assert_eq!(facts.weight, 400);
        assert!(facts.characters.contains(&[0x20, 0x7e]), "{:?}", &facts.characters[..4]);
        assert!(facts.axes.is_empty());
    }

    #[test]
    fn an_installed_font_is_named_the_way_windows_names_it() {
        let arial = facts(&arial()).unwrap();
        assert_eq!(registry_name(&[arial]), "Arial (TrueType)");
        let cambria = std::fs::read(r"C:\Windows\Fonts\cambria.ttc").unwrap();
        let both: Vec<Facts> = (0..2).map(|index| facts(&split(&cambria, index).unwrap()).unwrap()).collect();
        assert_eq!(registry_name(&both), "Cambria & Cambria Math (TrueType)");
        // A web font installs as the plain font inside it.
        assert_eq!(installed_name(Path::new(r"C:\a\Inter.woff2"), b"wOF2OTTO"), "Inter.otf");
        assert_eq!(installed_name(Path::new(r"C:\a\Inter.woff"), b"wOFF\0\x01\0\0"), "Inter.ttf");
        assert_eq!(installed_name(Path::new(r"C:\a\Inter.ttf"), b"\0\x01\0\0"), "Inter.ttf");
        assert_eq!(installed(Path::new(r"C:\Windows\Fonts\arial.ttf")), Installed::System);
    }

    #[test]
    fn uninstall_only_takes_the_registry_name_of_its_own_file() {
        let folder = Path::new(r"C:\Users\me\AppData\Local\Microsoft\Windows\Fonts");
        let ttf = folder.join("Font.ttf");
        assert!(points_at(r"C:\Users\me\AppData\Local\Microsoft\Windows\Fonts\font.TTF", &ttf, folder));
        assert!(points_at("Font.ttf", &ttf, folder));
        assert!(!points_at(r"C:\Users\me\AppData\Local\Microsoft\Windows\Fonts\Font.otf", &ttf, folder));
        assert!(!points_at("Font.otf", &ttf, folder));
    }

    #[test]
    fn code_points_gather_into_runs() {
        assert_eq!(runs(&[1, 2, 3, 7, 9, 10]), [[1, 3], [7, 7], [9, 10]]);
        assert!(runs(&[]).is_empty());
    }

    #[test]
    fn a_face_comes_out_of_a_collection_whole() {
        // Two faces, the second a copy of the first, after a collection's head and directories.
        let font = arial();
        let tables = tables_of(&font);
        let directory = 12 + 16 * tables.len();
        let head = 12 + 4 * 2;
        let data_at = head + 2 * directory;
        let mut collection = b"ttcf\0\x01\0\0\0\0\0\x02".to_vec();
        for face in 0..2 {
            collection.extend(((head + face * directory) as u32).to_be_bytes());
        }
        for _ in 0..2 {
            collection.extend(&font[..12]);
            let mut offset = data_at;
            for (tag, data) in &tables {
                collection.extend(tag);
                collection.extend([0; 4]);
                collection.extend((offset as u32).to_be_bytes());
                collection.extend((data.len() as u32).to_be_bytes());
                offset += data.len().next_multiple_of(4);
            }
        }
        for (_, data) in &tables {
            collection.extend(data);
            collection.resize(collection.len().next_multiple_of(4), 0);
        }
        assert_eq!(ttf_parser::fonts_in_collection(&collection), Some(2));
        let second = split(&collection, 1).unwrap();
        assert_eq!(facts(&second).unwrap().family, "Arial");
        assert_eq!(tables_of(&second), tables_of(&write_sfnt(0x0001_0000, &mut tables.iter().map(|(tag, data)| (*tag, data.as_slice())).collect::<Vec<_>>())));
    }

    #[test]
    fn woff_and_woff2_unpack_to_the_same_face() {
        let font = arial();
        let tables = tables_of(&font);
        let mut woff = b"wOFF\0\x01\0\0".to_vec();
        woff.extend([0; 4]);
        woff.extend((tables.len() as u16).to_be_bytes());
        woff.resize(44 + 20 * tables.len(), 0);
        for (at, (tag, data)) in tables.iter().enumerate() {
            let mut packed = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
            packed.write_all(data).unwrap();
            // A table that doesn't get smaller is kept as it is, as the format says.
            let packed = Some(packed.finish().unwrap()).filter(|packed| packed.len() < data.len()).unwrap_or_else(|| data.clone());
            let entry = 44 + 20 * at;
            let offset = woff.len() as u32;
            woff[entry..entry + 4].copy_from_slice(tag);
            woff[entry + 4..entry + 8].copy_from_slice(&offset.to_be_bytes());
            woff[entry + 8..entry + 12].copy_from_slice(&(packed.len() as u32).to_be_bytes());
            woff[entry + 12..entry + 16].copy_from_slice(&(data.len() as u32).to_be_bytes());
            woff.extend(packed);
            woff.resize(woff.len().next_multiple_of(4), 0);
        }
        assert_eq!(facts(&unwrap_woff(&woff).unwrap()).unwrap(), facts(&font).unwrap());

        // WOFF2 with no table rebuilt: glyf and loca say so with transform 3.
        let mut woff2 = b"wOF2\0\x01\0\0".to_vec();
        woff2.extend([0; 4]);
        woff2.extend((tables.len() as u16).to_be_bytes());
        woff2.resize(48, 0);
        let mut stream = Vec::new();
        for (tag, data) in &tables {
            let known = KNOWN_TAGS.iter().position(|known| *known == tag);
            let null = if matches!(tag, b"glyf" | b"loca") { 3 << 6 } else { 0 };
            woff2.push(known.map_or(63, |known| known as u8) | null);
            if known.is_none() {
                woff2.extend(tag);
            }
            let mut length = Vec::new();
            let mut rest = data.len() as u32;
            loop {
                length.insert(0, (rest & 0x7f) as u8 | if length.is_empty() { 0 } else { 0x80 });
                rest >>= 7;
                if rest == 0 {
                    break;
                }
            }
            woff2.extend(length);
            stream.extend(data);
        }
        let mut packed = Vec::new();
        brotli::BrotliCompress(&mut stream.as_slice(), &mut packed, &brotli::enc::BrotliEncoderParams { quality: 1, ..Default::default() }).unwrap();
        woff2[20..24].copy_from_slice(&(packed.len() as u32).to_be_bytes());
        woff2.extend(packed);
        assert_eq!(facts(&unwrap_woff2(&woff2).unwrap()).unwrap(), facts(&font).unwrap());
    }

    #[test]
    fn base128_numbers_read_and_bad_ones_fail() {
        let mut at = 0;
        assert_eq!(base128(&[0x3f], &mut at), Ok(63));
        at = 0;
        assert_eq!(base128(&[0x81, 0x00], &mut at), Ok(128));
        assert_eq!(at, 2);
        at = 0;
        assert!(base128(&[0x80, 0x01], &mut at).is_err());
        at = 0;
        assert!(base128(&[0xff, 0xff, 0xff, 0xff, 0x7f], &mut at).is_err());
    }
}
