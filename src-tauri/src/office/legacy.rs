//! Office 97 to 2003 files (.doc, .xls, .ppt), which keep their parts in a compound file. Perli
//! reads their words and values only: looks, pictures and layout stay for Office to show.

use std::io::Read as _;
use std::path::Path;

use super::sheet::{number_cell, shape_of, Cell, Grid, Shape};
use super::slides::{Line, Slide};
use super::{Doc, Family, Reading};
use crate::preview::escape;

/// The most of one stream that is read.
const MOST_STREAM: u64 = 256 * 1024 * 1024;

type Compound = cfb::CompoundFile<std::fs::File>;

fn stream(file: &mut Compound, name: &str) -> Option<Vec<u8>> {
    stream_head(file, name, MOST_STREAM)
}

/// The first `most` bytes of a stream.
fn stream_head(file: &mut Compound, name: &str, most: u64) -> Option<Vec<u8>> {
    let mut found = file.open_stream(name).ok()?;
    let mut bytes = Vec::new();
    (&mut found).take(most).read_to_end(&mut bytes).ok()?;
    Some(bytes)
}

fn u16_at(bytes: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(bytes.get(at..at + 2)?.try_into().ok()?))
}

fn u32_at(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

/// Whether an old file carries macros, and whether it is under a password.
pub(super) fn marks(path: &Path) -> (bool, bool) {
    let Ok(mut file) = cfb::open(path) else { return (false, false) };
    let macros = file.is_storage("/Macros") || file.is_storage("/_VBA_PROJECT_CUR");
    let locked = if file.is_stream("/WordDocument") {
        stream_head(&mut file, "/WordDocument", 16).and_then(|fib| u16_at(&fib, 0x0A)).is_some_and(|flags| flags & 0x0100 != 0)
    } else if file.is_stream("/Workbook") {
        // FILEPASS comes right after the workbook's first record, long before the sheets.
        stream_head(&mut file, "/Workbook", 64 * 1024).is_some_and(|book| records(&book).take(8).any(|(kind, _)| kind == FILEPASS))
    } else {
        file.is_stream("/EncryptedSummary")
    };
    (macros, locked)
}

pub(super) fn read(path: &Path, family: Family) -> Result<Reading, String> {
    let mut file = cfb::open(path).map_err(|_| "It isn't a document Perli can read".to_string())?;
    let (_, locked) = marks(path);
    if locked {
        return Err("It is under a password of the old Office kind, which only Office opens".into());
    }
    match family {
        Family::Word => word(&mut file),
        Family::Sheet => sheet(&mut file),
        Family::Slides => slides(&mut file),
    }
}

/// Characters 0x80 to 0x9F of Windows-1252, which a Word piece of one-byte text uses.
const CP1252: [char; 32] = [
    '€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{8d}', 'Ž', '\u{8f}', '\u{90}', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š',
    '›', 'œ', '\u{9d}', 'ž', 'Ÿ',
];

/// A Word document's main text, read piece by piece through its piece table.
fn word(file: &mut Compound) -> Result<Reading, String> {
    let damaged = || "It looks damaged, so its words can't be read".to_string();
    let fib = stream(file, "/WordDocument").ok_or_else(damaged)?;
    if u16_at(&fib, 0) != Some(0xA5EC) {
        return Err(damaged());
    }
    let flags = u16_at(&fib, 0x0A).ok_or_else(damaged)?;
    let table = stream(file, if flags & 0x0200 != 0 { "/1Table" } else { "/0Table" }).ok_or_else(damaged)?;
    // FibBase, then FibRgW, FibRgLw and FibRgFcLcb, each led by its length.
    let words = usize::from(u16_at(&fib, 32).ok_or_else(damaged)?);
    let longs_at = 34 + words * 2;
    let longs = usize::from(u16_at(&fib, longs_at).ok_or_else(damaged)?);
    let main_length = u32_at(&fib, longs_at + 2 + 3 * 4).ok_or_else(damaged)? as usize;
    let pairs_at = longs_at + 2 + longs * 4 + 2;
    let clx_at = u32_at(&fib, pairs_at + 33 * 8).ok_or_else(damaged)? as usize;
    let clx_length = u32_at(&fib, pairs_at + 33 * 8 + 4).ok_or_else(damaged)? as usize;
    let clx = table.get(clx_at..clx_at + clx_length).ok_or_else(damaged)?;
    // Skip the property runs before the piece table.
    let mut at = 0;
    while clx.get(at) == Some(&1) {
        at += 3 + usize::from(u16_at(clx, at + 1).ok_or_else(damaged)?);
    }
    if clx.get(at) != Some(&2) {
        return Err(damaged());
    }
    let pieces_length = u32_at(clx, at + 1).ok_or_else(damaged)? as usize;
    let pieces = clx.get(at + 5..at + 5 + pieces_length).ok_or_else(damaged)?;
    let count = pieces_length.saturating_sub(4) / 12;
    let mut text = String::new();
    for piece in 0..count {
        let (start, end) = (u32_at(pieces, piece * 4).ok_or_else(damaged)? as usize, u32_at(pieces, piece * 4 + 4).ok_or_else(damaged)? as usize);
        if start >= main_length {
            break;
        }
        let end = end.min(main_length);
        let place = u32_at(pieces, (count + 1) * 4 + piece * 8 + 2).ok_or_else(damaged)?;
        let length = end.saturating_sub(start);
        if place & 0x4000_0000 != 0 {
            let from = ((place & 0x3FFF_FFFF) / 2) as usize;
            for &byte in fib.get(from..from + length).unwrap_or_default() {
                text.push(if (0x80..0xA0).contains(&byte) { CP1252[usize::from(byte - 0x80)] } else { char::from(byte) });
            }
        } else {
            let from = place as usize;
            let units: Vec<u16> = fib.get(from..from + length * 2).unwrap_or_default().as_chunks::<2>().0.iter().map(|pair| u16::from_le_bytes(*pair)).collect();
            text.push_str(&String::from_utf16_lossy(&units));
        }
    }
    let text = word_text(&text);
    let html: String = text
        .split('\n')
        .map(|paragraph| if paragraph.trim().is_empty() { "<p class=\"office-gap\"></p>".to_string() } else { format!("<p>{}</p>", escape(paragraph).replace('\t', "<span class=\"office-tab\"></span>")) })
        .collect();
    Ok(Reading { doc: Doc::Word { html, text }, note: Some("An old .doc shows its words only. Office shows it as laid out.".into()) })
}

/// Word's own marks taken out: a field shows its result, not its code, and a cell end becomes a tab.
pub(super) fn word_text(raw: &str) -> String {
    let mut out = String::new();
    // For each field open: whether its code is still going, so it is hidden.
    let mut fields: Vec<bool> = Vec::new();
    let mut last = '\0';
    for letter in raw.chars() {
        match letter {
            '\u{13}' => fields.push(true),
            '\u{14}' => {
                if let Some(code) = fields.last_mut() {
                    *code = false;
                }
            }
            '\u{15}' => {
                fields.pop();
            }
            _ if fields.iter().any(|code| *code) => {}
            '\r' | '\u{0c}' => out.push('\n'),
            '\u{0b}' => out.push(' '),
            // Two cell marks in a row end a table row.
            '\u{07}' if last == '\u{07}' => out.push('\n'),
            '\u{07}' => out.push('\t'),
            '\u{1e}' => out.push('-'),
            '\t' => out.push('\t'),
            letter if letter < ' ' => {}
            letter => out.push(letter),
        }
        last = letter;
    }
    out.trim_end().to_string()
}

const BOF: u16 = 0x0809;
const EOF: u16 = 0x000A;
const BOUNDSHEET: u16 = 0x0085;
const DATEMODE: u16 = 0x0022;
const FILEPASS: u16 = 0x002F;
const SST: u16 = 0x00FC;
const CONTINUE: u16 = 0x003C;
const FORMAT: u16 = 0x041E;
const XF: u16 = 0x00E0;
const LABELSST: u16 = 0x00FD;
const LABEL: u16 = 0x0204;
const NUMBER: u16 = 0x0203;
const RK: u16 = 0x027E;
const MULRK: u16 = 0x00BD;
const FORMULA: u16 = 0x0006;
const STRING: u16 = 0x0207;
const BOOLERR: u16 = 0x0205;

/// The records of an Excel stream from `at`, each its kind and its body.
fn records(book: &[u8]) -> impl Iterator<Item = (u16, &[u8])> {
    records_from(book, 0)
}

fn records_from(book: &[u8], mut at: usize) -> impl Iterator<Item = (u16, &[u8])> {
    std::iter::from_fn(move || {
        let kind = u16_at(book, at)?;
        let length = usize::from(u16_at(book, at + 2)?);
        let body = book.get(at + 4..at + 4 + length)?;
        at += 4 + length;
        Some((kind, body))
    })
}

/// A string as BIFF8 keeps it: `count` letters, one or two bytes each by the flag after the count.
fn unicode(bytes: &[u8], count: usize, at: usize) -> Option<(String, usize)> {
    let wide = bytes.get(at)? & 1 != 0;
    let start = at + 1;
    if wide {
        let units: Vec<u16> = bytes.get(start..start + count * 2)?.as_chunks::<2>().0.iter().map(|pair| u16::from_le_bytes(*pair)).collect();
        Some((String::from_utf16_lossy(&units), start + count * 2))
    } else {
        Some((bytes.get(start..start + count)?.iter().map(|&byte| char::from(byte)).collect(), start + count))
    }
}

/// The shared strings, which run on through CONTINUE records. A string cut by one goes on
/// after a fresh flag byte saying how wide its letters are from there.
fn shared_strings(segments: &[&[u8]]) -> Vec<String> {
    struct Cursor<'a> {
        segments: &'a [&'a [u8]],
        segment: usize,
        at: usize,
    }
    impl Cursor<'_> {
        fn left(&self) -> usize {
            self.segments.get(self.segment).map_or(0, |segment| segment.len() - self.at)
        }
        fn next_segment(&mut self) -> bool {
            self.segment += 1;
            self.at = 0;
            self.segment < self.segments.len()
        }
        fn byte(&mut self) -> Option<u8> {
            while self.left() == 0 {
                if !self.next_segment() {
                    return None;
                }
            }
            let byte = self.segments[self.segment][self.at];
            self.at += 1;
            Some(byte)
        }
        fn skip(&mut self, mut count: usize) -> Option<()> {
            while count > 0 {
                if self.left() == 0 && !self.next_segment() {
                    return None;
                }
                let step = count.min(self.left());
                self.at += step;
                count -= step;
            }
            Some(())
        }
        fn u16(&mut self) -> Option<u16> {
            Some(u16::from_le_bytes([self.byte()?, self.byte()?]))
        }
        fn u32(&mut self) -> Option<u32> {
            Some(u32::from_le_bytes([self.byte()?, self.byte()?, self.byte()?, self.byte()?]))
        }
        fn letters(&mut self, mut count: usize, mut wide: bool) -> Option<String> {
            let mut units = Vec::with_capacity(count);
            while count > 0 {
                if self.left() == 0 {
                    if !self.next_segment() {
                        return None;
                    }
                    wide = self.byte()? & 1 != 0;
                }
                units.push(if wide { self.u16()? } else { u16::from(self.byte()?) });
                count -= 1;
            }
            Some(String::from_utf16_lossy(&units))
        }
    }
    let mut cursor = Cursor { segments, segment: 0, at: 0 };
    let mut found = Vec::new();
    let Some(_total) = cursor.u32() else { return found };
    let Some(unique) = cursor.u32() else { return found };
    for _ in 0..unique {
        let Some(count) = cursor.u16() else { break };
        let Some(flags) = cursor.byte() else { break };
        let runs = if flags & 0x08 != 0 { cursor.u16().map_or(0, usize::from) } else { 0 };
        let extra = if flags & 0x04 != 0 { cursor.u32().map_or(0, |size| size as usize) } else { 0 };
        let Some(text) = cursor.letters(usize::from(count), flags & 1 != 0) else { break };
        found.push(text);
        if cursor.skip(runs * 4 + extra).is_none() {
            break;
        }
    }
    found
}

/// An RK number: an integer or the top of a double, maybe a hundredth of itself.
fn rk_number(rk: u32) -> f64 {
    let number = if rk & 2 != 0 { f64::from((rk as i32) >> 2) } else { f64::from_bits(u64::from(rk & 0xFFFF_FFFC) << 32) };
    if rk & 1 != 0 { number / 100.0 } else { number }
}

fn sheet(file: &mut Compound) -> Result<Reading, String> {
    let Some(book) = stream(file, "/Workbook") else {
        return Err("It is an Excel 95 file or older, which only Excel opens".into());
    };
    let mut sheets_listed: Vec<(String, bool, usize)> = Vec::new();
    let mut formats: std::collections::HashMap<u32, String> = std::collections::HashMap::new();
    let mut styles: Vec<u32> = Vec::new();
    let mut from_1904 = false;
    let mut sst: Vec<&[u8]> = Vec::new();
    let mut in_sst = false;
    for (kind, body) in records(&book) {
        if in_sst && kind != CONTINUE {
            in_sst = false;
        }
        match kind {
            BOUNDSHEET => {
                let (Some(position), Some(&state), Some(&sheet_type), Some(&count)) = (u32_at(body, 0), body.get(4), body.get(5), body.get(6)) else { continue };
                if sheet_type != 0 {
                    continue;
                }
                if let Some((name, _)) = unicode(body, usize::from(count), 7) {
                    sheets_listed.push((name, state != 0, position as usize));
                }
            }
            DATEMODE => from_1904 = u16_at(body, 0) == Some(1),
            FORMAT => {
                if let (Some(id), Some(count)) = (u16_at(body, 0), u16_at(body, 2)) {
                    if let Some((code, _)) = unicode(body, usize::from(count), 4) {
                        formats.insert(u32::from(id), code);
                    }
                }
            }
            XF => styles.push(u16_at(body, 2).map_or(0, u32::from)),
            SST => {
                sst = vec![body];
                in_sst = true;
            }
            CONTINUE if in_sst => sst.push(body),
            EOF => break,
            _ => {}
        }
    }
    let strings = shared_strings(&sst);
    let shape = |style: u16| styles.get(usize::from(style)).map_or(Shape::Plain, |&id| shape_of(id, formats.get(&id).map(String::as_str)));
    let mut sheets = Vec::new();
    for (name, hidden, position) in sheets_listed {
        let mut grid = Grid::default();
        let mut waiting: Option<(usize, usize)> = None;
        for (kind, body) in records_from(&book, position).skip(1) {
            let row = u16_at(body, 0).map_or(0, usize::from);
            let column = u16_at(body, 2).map_or(0, usize::from);
            let style = u16_at(body, 4).unwrap_or(0);
            match kind {
                BOF => break,
                EOF => break,
                LABELSST => {
                    let text = u32_at(body, 6).and_then(|at| strings.get(at as usize)).cloned().unwrap_or_default();
                    grid.put(row, column, Cell::Text(text));
                }
                LABEL => {
                    if let Some((text, _)) = u16_at(body, 6).and_then(|count| unicode(body, usize::from(count), 8)) {
                        grid.put(row, column, Cell::Text(text));
                    }
                }
                NUMBER => {
                    if let Some(bits) = body.get(6..14) {
                        grid.put(row, column, number_cell(f64::from_le_bytes(bits.try_into().unwrap_or_default()), shape(style), from_1904));
                    }
                }
                RK => {
                    if let Some(rk) = u32_at(body, 6) {
                        grid.put(row, column, number_cell(rk_number(rk), shape(style), from_1904));
                    }
                }
                MULRK => {
                    let last = u16_at(body, body.len().saturating_sub(2)).map_or(0, usize::from);
                    for (offset, one) in (column..=last).enumerate() {
                        let at = 4 + offset * 6;
                        if let (Some(style), Some(rk)) = (u16_at(body, at), u32_at(body, at + 2)) {
                            grid.put(row, one, number_cell(rk_number(rk), shape(style), from_1904));
                        }
                    }
                }
                FORMULA => {
                    let Some(value) = body.get(6..14) else { continue };
                    if value[6] == 0xFF && value[7] == 0xFF {
                        match value[0] {
                            0 => waiting = Some((row, column)),
                            1 => grid.put(row, column, Cell::Text(if value[2] != 0 { "TRUE" } else { "FALSE" }.into())),
                            _ => {}
                        }
                    } else {
                        grid.put(row, column, number_cell(f64::from_le_bytes(value.try_into().unwrap_or_default()), shape(style), from_1904));
                    }
                }
                STRING => {
                    if let (Some((row, column)), Some(count)) = (waiting.take(), u16_at(body, 0)) {
                        if let Some((text, _)) = unicode(body, usize::from(count), 2) {
                            grid.put(row, column, Cell::Text(text));
                        }
                    }
                }
                BOOLERR => {
                    if let (Some(&value), Some(&error)) = (body.get(6), body.get(7)) {
                        let text = if error != 0 { "#ERROR".to_string() } else if value != 0 { "TRUE".into() } else { "FALSE".into() };
                        grid.put(row, column, Cell::Text(text));
                    }
                }
                _ => {}
            }
        }
        sheets.push(grid.sheet(name, hidden));
    }
    let note = super::sheet::note_of(&sheets).or(Some("An old .xls shows its values only. Excel shows it as laid out.".into()));
    Ok(Reading { doc: Doc::Sheet { sheets }, note })
}

const SLIDE_LIST: u16 = 0x0FF0;
const SLIDE_PERSIST: u16 = 0x03F3;
const TEXT_HEADER: u16 = 0x0F9F;
const TEXT_CHARS: u16 = 0x0FA0;
const TEXT_BYTES: u16 = 0x0FA8;

/// A PowerPoint file's slides from its outline: the text each slide's placeholders hold. Text
/// boxes drawn outside placeholders are left out.
fn slides(file: &mut Compound) -> Result<Reading, String> {
    let document = stream(file, "/PowerPoint Document").ok_or("It looks damaged, so its slides can't be read")?;
    let mut slides: Vec<Slide> = Vec::new();
    // Where each open container ends, and whether it is the slides' outline.
    let mut open: Vec<(usize, bool)> = Vec::new();
    let mut title = false;
    let mut at = 0;
    while let (Some(head), Some(kind), Some(length)) = (u16_at(&document, at), u16_at(&document, at + 2), u32_at(&document, at + 4)) {
        let start = at + 8;
        let end = start.saturating_add(length as usize);
        while open.last().is_some_and(|(closes, _)| *closes <= at) {
            open.pop();
        }
        let in_outline = open.last().is_some_and(|(_, outline)| *outline);
        if head & 0x000F == 0x000F {
            open.push((end, kind == SLIDE_LIST && head >> 4 == 0 || in_outline));
            at = start;
            continue;
        }
        if in_outline {
            match kind {
                SLIDE_PERSIST => slides.push(Slide::default()),
                TEXT_HEADER => title = matches!(u32_at(&document, start), Some(0 | 6)),
                TEXT_CHARS | TEXT_BYTES => {
                    let body = document.get(start..end.min(document.len())).unwrap_or_default();
                    let text = if kind == TEXT_CHARS {
                        String::from_utf16_lossy(&body.as_chunks::<2>().0.iter().map(|pair| u16::from_le_bytes(*pair)).collect::<Vec<_>>())
                    } else {
                        body.iter().map(|&byte| char::from(byte)).collect()
                    };
                    if let Some(slide) = slides.last_mut() {
                        for line in text.split('\r').map(|line| line.replace('\u{0b}', "\n")).filter(|line| !line.trim().is_empty()) {
                            if title && slide.title.is_empty() {
                                slide.title = line.trim().to_string();
                            } else {
                                slide.lines.push(Line { text: line, depth: 0 });
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        at = end;
    }
    Ok(Reading { doc: Doc::Slides { slides }, note: Some("An old .ppt shows its outline only. PowerPoint shows it as laid out.".into()) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn word_marks_become_plain_text() {
        let raw = "Hi\u{13} PAGE \u{14}3\u{15} there\rCell\u{07}Next\u{07}\u{07}After\u{0b}line\u{1e}x";
        assert_eq!(word_text(raw), "Hi3 there\nCell\tNext\t\nAfter line-x");
    }

    #[test]
    fn reads_rk_numbers() {
        assert_eq!(rk_number((5 << 2) | 2), 5.0);
        assert_eq!(rk_number((1234 << 2) | 3), 12.34);
        let bits = (1.5f64.to_bits() >> 32) as u32;
        assert_eq!(rk_number(bits), 1.5);
    }

    #[test]
    fn reads_shared_strings_across_continues() {
        // Two strings: "Hello" in one-byte letters, cut after "He", going on as two-byte letters.
        let mut first = vec![2, 0, 0, 0, 2, 0, 0, 0];
        first.extend([5, 0, 0, b'H', b'e']);
        let mut second = vec![1];
        second.extend("llo".encode_utf16().flat_map(u16::to_le_bytes));
        second.extend([2, 0, 0x08, 1, 0, b'O', b'k', 9, 9, 9, 9]);
        assert_eq!(shared_strings(&[&first, &second]), ["Hello", "Ok"]);
    }

    fn compound(streams: &[(&str, Vec<u8>)]) -> std::path::PathBuf {
        let folder = std::env::temp_dir().join(format!("perli-legacy-{}-{}", std::process::id(), streams[0].0.trim_start_matches('/')));
        let _ = std::fs::remove_dir_all(&folder);
        std::fs::create_dir_all(&folder).unwrap();
        let path = folder.join("old.bin");
        use std::io::Write;
        let mut file = cfb::create(&path).unwrap();
        for (name, bytes) in streams {
            file.create_stream(name).unwrap().write_all(bytes).unwrap();
        }
        file.flush().unwrap();
        path
    }

    fn record(kind: u16, body: &[u8]) -> Vec<u8> {
        [&kind.to_le_bytes()[..], &(body.len() as u16).to_le_bytes(), body].concat()
    }

    #[test]
    fn reads_an_old_workbook() {
        let mut globals = record(BOF, &[0; 16]);
        let sst = [&[1u8, 0, 0, 0, 1, 0, 0, 0][..], &[3, 0, 0], b"Tea"].concat();
        globals.extend(record(SST, &sst));
        globals.extend(record(XF, &[0, 0, 0, 0]));
        globals.extend(record(XF, &[0, 0, 14, 0]));
        let sheet_at = globals.len() + record(BOUNDSHEET, &[0; 12]).len() + 4;
        let mut bound = (sheet_at as u32).to_le_bytes().to_vec();
        bound.extend([0, 0, 4, 0]);
        bound.extend(b"Plan");
        globals.extend(record(BOUNDSHEET, &bound));
        globals.extend(record(EOF, &[]));
        let mut book = globals;
        assert_eq!(book.len(), sheet_at);
        book.extend(record(BOF, &[0; 16]));
        book.extend(record(LABELSST, &[0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
        book.extend(record(NUMBER, &[[0u8, 0, 1, 0, 0, 0].as_slice(), &2.5f64.to_le_bytes()].concat()));
        book.extend(record(RK, &[[1u8, 0, 0, 0, 1, 0].as_slice(), &(((45_292u32) << 2) | 2).to_le_bytes()].concat()));
        book.extend(record(EOF, &[]));
        let path = compound(&[("/Workbook", book)]);
        let Doc::Sheet { sheets } = read(&path, Family::Sheet).unwrap().doc else { panic!("not a workbook") };
        assert_eq!(sheets[0].name, "Plan");
        assert_eq!(sheets[0].rows[0], [Cell::Text("Tea".into()), Cell::Number(2.5)]);
        assert_eq!(sheets[0].rows[1][0], Cell::Text("2024-01-01".into()));
    }

    #[test]
    fn reads_an_old_presentation_outline() {
        let atom = |kind: u16, body: &[u8]| [&0u16.to_le_bytes()[..], &kind.to_le_bytes(), &(body.len() as u32).to_le_bytes(), body].concat();
        let text = |value: &str| value.encode_utf16().flat_map(u16::to_le_bytes).collect::<Vec<u8>>();
        let mut inside = atom(SLIDE_PERSIST, &[0; 20]);
        inside.extend(atom(TEXT_HEADER, &0u32.to_le_bytes()));
        inside.extend(atom(TEXT_CHARS, &text("Title here")));
        inside.extend(atom(TEXT_HEADER, &1u32.to_le_bytes()));
        inside.extend(atom(TEXT_BYTES, b"One\rTwo"));
        let list = [&0x000Fu16.to_le_bytes()[..], &SLIDE_LIST.to_le_bytes(), &(inside.len() as u32).to_le_bytes(), &inside].concat();
        let document = [&0x000Fu16.to_le_bytes()[..], &0x03E8u16.to_le_bytes(), &(list.len() as u32).to_le_bytes(), &list].concat();
        let path = compound(&[("/PowerPoint Document", document)]);
        let Doc::Slides { slides } = read(&path, Family::Slides).unwrap().doc else { panic!("not slides") };
        assert_eq!(slides.len(), 1);
        assert_eq!(slides[0].title, "Title here");
        let lines: Vec<_> = slides[0].lines.iter().map(|line| line.text.as_str()).collect();
        assert_eq!(lines, ["One", "Two"]);
    }
}
