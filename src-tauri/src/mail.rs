//! Mail saved as a file: `.eml`, as most mail apps save it, and `.msg`, as classic Outlook does.
//! Only what the preview shows is read: who, when, the subject, the text and the attachments.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::Serialize;
use windows::Win32::Globalization::{MultiByteToWideChar, MULTI_BYTE_TO_WIDE_CHAR_FLAGS};

/// Bigger mails show Windows' own picture of them.
pub const MOST_BYTES: u64 = 64 * 1024 * 1024;
/// How deep parts may sit inside parts, so a crafted mail can't recurse without end.
const DEEPEST: usize = 8;

#[derive(Debug, Default, PartialEq, Serialize)]
pub struct Mail {
    pub subject: String,
    pub from: String,
    pub to: String,
    pub cc: String,
    /// FILETIME ticks, or 0 when the mail doesn't say.
    pub date: u64,
    pub body: String,
    /// A mail written only in HTML, which shows as it was laid out. Empty when it has plain text.
    pub html: String,
    pub attachments: Vec<Attachment>,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct Attachment {
    pub name: String,
    pub size: u64,
}

/// An attachment's bytes. None for one that holds no file of its own: an embedded object or a link.
/// An Outlook item inside a .msg comes out as a .msg of its own.
type Bytes = Option<Vec<u8>>;

/// The mark Windows puts on a file from the internet, as a mail app puts on an attachment it opens.
const FROM_ELSEWHERE: &[u8] = b"[ZoneTransfer]\r\nZoneId=3\r\n";

/// The class Outlook gives a message's root storage.
const MESSAGE: uuid::Uuid = uuid::Uuid::from_u128(0x0002_0D0B_0000_0000_C000_0000_0000_0046);
/// Embedded objects Perli can make a file of, by their class, with the file's extension. Office
/// 97 to 2003 documents are compound files of their own; later ones keep theirs in a "Package"
/// stream.
const OBJECTS: [(u128, &str); 9] = [
    (0x0002_0906_0000_0000_C000_0000_0000_0046, "doc"),
    (0x0002_0820_0000_0000_C000_0000_0000_0046, "xls"),
    (0x0002_0821_0000_0000_C000_0000_0000_0046, "xls"),
    (0x6481_8D10_4F9B_11CF_86EA_00AA_00B9_29E8, "ppt"),
    (0x6481_8D11_4F9B_11CF_86EA_00AA_00B9_29E8, "ppt"),
    (0xF475_4C9B_64F5_4B40_8AF4_6797_32AC_0607, "docx"),
    (0x0002_0830_0000_0000_C000_0000_0000_0046, "xlsx"),
    (0x0002_0832_0000_0000_C000_0000_0000_0046, "xlsm"),
    (0xCF4F_55F4_8F87_4D47_80BB_5808_164B_B3F8, "pptx"),
];
/// A file packed into a mail as an object, and a Paint picture.
const PACKAGE: u128 = 0x0003_000C_0000_0000_C000_0000_0000_0046;
const PAINT: u128 = 0x0003_000A_0000_0000_C000_0000_0000_0046;

/// What the preview shows of a mail.
pub fn read(path: &Path) -> Result<Mail, String> {
    parse(path, false).map(|(mail, _)| mail)
}

/// Each attachment's name and bytes, in the order the preview lists them.
pub fn attachments(path: &Path) -> Result<Vec<(String, Bytes)>, String> {
    let (mail, data) = parse(path, true)?;
    Ok(mail.attachments.into_iter().map(|attachment| attachment.name).zip(data).collect())
}

/// One attachment written into `folder`, marked as from the internet, so Windows warns about
/// opening it as it would from a mail app.
pub fn take_out(path: &Path, index: usize, folder: &Path) -> Result<PathBuf, String> {
    let (name, bytes) = attachments(path)?.into_iter().nth(index).ok_or("The mail has no such attachment")?;
    let bytes = bytes.ok_or("This attachment is an object kept inside the mail, not a file of its own")?;
    let file = folder.join(file_name(&name));
    std::fs::write(&file, bytes).map_err(|error| error.to_string())?;
    let mut zone = file.clone().into_os_string();
    zone.push(":Zone.Identifier");
    let _ = std::fs::write(zone, FROM_ELSEWHERE);
    Ok(file)
}

/// A name a file may take, from one a mail gives: letters no file name holds become `_`.
fn file_name(name: &str) -> String {
    let clean: String = name.chars().map(|letter| if letter < ' ' || "<>:\"/\\|?*".contains(letter) { '_' } else { letter }).collect();
    let clean = clean.trim().trim_end_matches('.');
    if clean.is_empty() { "Attachment".into() } else { clean.into() }
}

fn parse(path: &Path, with_data: bool) -> Result<(Mail, Vec<Bytes>), String> {
    let size = path.metadata().map_err(|error| error.to_string())?.len();
    if size > MOST_BYTES {
        return Err(format!("Mails over {} MB don't show", MOST_BYTES / 1024 / 1024));
    }
    let msg = path.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("msg"));
    if msg {
        return outlook(path, with_data).map_err(|error| error.to_string());
    }
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    Ok(eml(&bytes, with_data))
}

// .eml

fn eml(bytes: &[u8], with_data: bool) -> (Mail, Vec<Bytes>) {
    let (headers, _) = split_head(bytes);
    let field = |name: &str| words(header(&headers, name).unwrap_or_default());
    let mut found = Found::default();
    walk(bytes, &mut found, with_data, 0);
    let html = if found.plain.is_none() { found.html.clone().unwrap_or_default() } else { String::new() };
    let body = found.plain.or_else(|| found.html.as_deref().map(html_text)).unwrap_or_default();
    let mail = Mail {
        subject: field("subject"),
        from: field("from"),
        to: field("to"),
        cc: field("cc"),
        date: header(&headers, "date").and_then(date).unwrap_or(0),
        body: body.trim_end().to_string(),
        html,
        attachments: found.attachments,
    };
    (mail, found.data.into_iter().map(Some).collect())
}

#[derive(Default)]
struct Found {
    plain: Option<String>,
    html: Option<String>,
    attachments: Vec<Attachment>,
    data: Vec<Vec<u8>>,
}

fn walk(bytes: &[u8], found: &mut Found, with_data: bool, depth: usize) {
    let (headers, body) = split_head(bytes);
    let kind = header(&headers, "content-type").unwrap_or("text/plain");
    let base = kind.split(';').next().unwrap_or_default().trim().to_ascii_lowercase();
    if base.starts_with("multipart/") && depth < DEEPEST {
        if let Some(boundary) = param(kind, "boundary") {
            for part in parts(body, &boundary) {
                walk(part, found, with_data, depth + 1);
            }
            return;
        }
    }
    let disposition = header(&headers, "content-disposition").unwrap_or_default();
    let named = param(disposition, "filename").or_else(|| param(kind, "name")).map(|name| words(&name));
    let encoding = header(&headers, "content-transfer-encoding").unwrap_or_default();
    let attached = disposition.trim_start().to_ascii_lowercase().starts_with("attachment") || named.is_some();
    if attached || base == "message/rfc822" {
        let data = transfer(body, encoding);
        let fallback = if base == "message/rfc822" { "Message.eml" } else { "Attachment" };
        let mut name = named.filter(|name| !name.trim().is_empty()).unwrap_or_else(|| fallback.to_string());
        // A mail inside a mail is named for its subject at times. As .eml it opens as a mail.
        if base == "message/rfc822" && !name.to_ascii_lowercase().ends_with(".eml") {
            name.push_str(".eml");
        }
        found.attachments.push(Attachment { name, size: data.len() as u64 });
        if with_data {
            found.data.push(data);
        }
        return;
    }
    let text = || decode(&transfer(body, encoding), &param(kind, "charset").unwrap_or_default());
    if base == "text/plain" && found.plain.is_none() {
        found.plain = Some(text());
    } else if base == "text/html" && found.html.is_none() {
        found.html = Some(text());
    }
}

/// The headers, unfolded and with lowercase names, and the body after the first empty line.
fn split_head(bytes: &[u8]) -> (Vec<(String, String)>, &[u8]) {
    let find = |needle: &[u8]| bytes.windows(needle.len()).position(|window| window == needle);
    let cut = match (find(b"\r\n\r\n"), find(b"\n\n")) {
        (Some(crlf), Some(lf)) if lf < crlf => Some((lf, 2)),
        (Some(crlf), _) => Some((crlf, 4)),
        (None, Some(lf)) => Some((lf, 2)),
        (None, None) => None,
    };
    let (head, body) = cut.map_or((bytes, &[][..]), |(at, length)| (&bytes[..at], &bytes[at + length..]));
    let mut headers: Vec<(String, String)> = Vec::new();
    for line in String::from_utf8_lossy(head).lines() {
        if line.starts_with([' ', '\t']) {
            if let Some((_, value)) = headers.last_mut() {
                value.push(' ');
                value.push_str(line.trim());
            }
        } else if let Some((name, value)) = line.split_once(':') {
            headers.push((name.trim().to_ascii_lowercase(), value.trim().to_string()));
        }
    }
    (headers, body)
}

fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str())
}

/// A `key=value` after the first `;` of a header, quoted or not. RFC 2231's `key*=utf-8''text` is
/// read too, and so is a long value split into `key*0*=`, `key*1=` pieces, in their order.
fn param(value: &str, key: &str) -> Option<String> {
    let mut pieces: Vec<(u32, bool, &str)> = Vec::new();
    for pair in value.split(';').skip(1) {
        let Some((name, text)) = pair.split_once('=') else { continue };
        let name = name.trim().to_ascii_lowercase();
        let text = text.trim().trim_matches('"');
        if name == key {
            return Some(text.to_string());
        }
        let Some(extended) = name.strip_prefix(key).and_then(|rest| rest.strip_prefix('*')) else { continue };
        if extended.is_empty() {
            let (charset, rest) = text.split_once('\'')?;
            let (_, encoded) = rest.split_once('\'')?;
            return Some(decode(&percent(encoded.as_bytes()), charset));
        }
        let (number, encoded) = extended.strip_suffix('*').map_or((extended, false), |number| (number, true));
        if let Ok(number) = number.parse() {
            pieces.push((number, encoded, text));
        }
    }
    pieces.sort_by_key(|&(number, ..)| number);
    if pieces.first()?.0 != 0 {
        return None;
    }
    // Only the first piece says which characters the pieces spell in.
    let mut charset = "";
    let mut bytes = Vec::new();
    for (number, encoded, mut text) in pieces {
        if number == 0 && encoded {
            let (set, rest) = text.split_once('\'')?;
            charset = set;
            text = rest.split_once('\'')?.1;
        }
        if encoded {
            bytes.extend(percent(text.as_bytes()));
        } else {
            bytes.extend_from_slice(text.as_bytes());
        }
    }
    Some(if charset.is_empty() { String::from_utf8_lossy(&bytes).into_owned() } else { decode(&bytes, charset) })
}

/// The parts of a multipart body, each without the line break before the next boundary.
fn parts<'a>(body: &'a [u8], boundary: &str) -> Vec<&'a [u8]> {
    let marker = format!("--{boundary}");
    let mut found = Vec::new();
    let mut start: Option<usize> = None;
    let mut at = 0;
    for line in body.split_inclusive(|&byte| byte == b'\n') {
        let trimmed = line.trim_ascii_end();
        if let Some(rest) = trimmed.strip_prefix(marker.as_bytes()) {
            if rest.is_empty() || rest == b"--" {
                if let Some(from) = start {
                    let part = &body[from..at];
                    let part = part.strip_suffix(b"\n").map_or(part, |part| part.strip_suffix(b"\r").unwrap_or(part));
                    found.push(part);
                }
                if rest == b"--" {
                    return found;
                }
                start = Some(at + line.len());
            }
        }
        at += line.len();
    }
    found.extend(start.map(|from| &body[from..]));
    found
}

fn transfer(body: &[u8], encoding: &str) -> Vec<u8> {
    match encoding.trim().to_ascii_lowercase().as_str() {
        "base64" => base64(body),
        "quoted-printable" => quoted(body, false),
        _ => body.to_vec(),
    }
}

/// Mail wraps base64 into lines and some senders leave off the padding, so both are let be.
fn base64(text: &[u8]) -> Vec<u8> {
    use base64::engine::{general_purpose::GeneralPurpose, DecodePaddingMode, GeneralPurposeConfig};
    const LOOSE: GeneralPurpose = GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent).with_decode_allow_trailing_bits(true),
    );
    let clean: Vec<u8> = text.iter().copied().filter(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/')).collect();
    LOOSE.decode(clean).unwrap_or_default()
}

fn hex(pair: &[u8]) -> Option<u8> {
    u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok()
}

/// Quoted-printable. In a header `_` stands for a space.
fn quoted(text: &[u8], header: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len());
    let mut at = 0;
    while at < text.len() {
        match (text[at], text.get(at + 1..at + 3)) {
            (b'=', Some(pair)) if hex(pair).is_some() => {
                out.extend(hex(pair));
                at += 3;
            }
            (b'=', Some([b'\r', b'\n'])) => at += 3,
            (b'=', _) if text.get(at + 1) == Some(&b'\n') => at += 2,
            (b'_', _) if header => {
                out.push(b' ');
                at += 1;
            }
            (byte, _) => {
                out.push(byte);
                at += 1;
            }
        }
    }
    out
}

fn percent(text: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len());
    let mut at = 0;
    while at < text.len() {
        match text.get(at + 1..at + 3).and_then(hex) {
            Some(byte) if text[at] == b'%' => {
                out.push(byte);
                at += 3;
            }
            _ => {
                out.push(text[at]);
                at += 1;
            }
        }
    }
    out
}

/// A header with its `=?charset?B?...?=` words decoded. Space between two such words goes.
fn words(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    let mut after_word = false;
    while let Some(start) = rest.find("=?") {
        let (before, after) = rest.split_at(start);
        match word(&after[2..]) {
            Some((decoded, used)) => {
                if !(after_word && before.trim().is_empty()) {
                    out.push_str(before);
                }
                out.push_str(&decoded);
                rest = &after[2 + used..];
                after_word = true;
            }
            None => {
                out.push_str(before);
                out.push_str("=?");
                rest = &after[2..];
                after_word = false;
            }
        }
    }
    out.push_str(rest);
    out
}

/// One encoded word after its `=?`, and how many bytes of the text it took.
fn word(text: &str) -> Option<(String, usize)> {
    let mut pieces = text.splitn(3, '?');
    let (charset, kind, tail) = (pieces.next()?, pieces.next()?, pieces.next()?);
    let end = tail.find("?=")?;
    let data = &tail.as_bytes()[..end];
    let bytes = match kind {
        "B" | "b" => base64(data),
        "Q" | "q" => quoted(data, true),
        _ => return None,
    };
    Some((decode(&bytes, charset), charset.len() + kind.len() + end + 4))
}

/// Text in a named character set, through Windows' code pages. Unknown sets are taken as UTF-8.
pub fn decode(bytes: &[u8], charset: &str) -> String {
    let name = charset.split('*').next().unwrap_or_default().trim().trim_matches('"').to_ascii_lowercase();
    let page: u32 = match name.as_str() {
        "iso-8859-1" | "latin1" | "us-ascii" | "ascii" if bytes.is_ascii() => return String::from_utf8_lossy(bytes).into_owned(),
        // Mail apps read Latin-1 as Windows-1252, which only adds letters to it.
        "iso-8859-1" | "latin1" => 1252,
        "iso-8859-15" => 28605,
        "shift_jis" | "shift-jis" | "sjis" | "x-sjis" | "cp932" | "windows-31j" => 932,
        "euc-jp" => 20932,
        "iso-2022-jp" => 50220,
        "gb2312" | "gbk" | "cp936" | "x-gbk" => 936,
        "gb18030" => 54936,
        "big5" => 950,
        "euc-kr" | "ks_c_5601-1987" | "cp949" => 949,
        "koi8-r" => 20866,
        "koi8-u" => 21866,
        other => {
            let numbered = other.strip_prefix("iso-8859-").and_then(|n| n.parse::<u32>().ok()).map(|n| 28590 + n);
            let windows = other.strip_prefix("windows-").or_else(|| other.strip_prefix("cp")).and_then(|n| n.parse::<u32>().ok());
            match numbered.or(windows) {
                Some(page) => page,
                None => return String::from_utf8_lossy(bytes).into_owned(),
            }
        }
    };
    paged(bytes, page).unwrap_or_else(|| String::from_utf8_lossy(bytes).into_owned())
}

fn paged(bytes: &[u8], page: u32) -> Option<String> {
    if bytes.is_empty() {
        return Some(String::new());
    }
    let flags = MULTI_BYTE_TO_WIDE_CHAR_FLAGS(0);
    let length = unsafe { MultiByteToWideChar(page, flags, bytes, None) };
    let mut wide = vec![0; usize::try_from(length).ok().filter(|&length| length > 0)?];
    unsafe { MultiByteToWideChar(page, flags, bytes, Some(&mut wide)) };
    Some(String::from_utf16_lossy(&wide))
}

/// The words of an HTML body, with a line break for each block and no styles or scripts. A mail
/// in HTML alone also shows as it was laid out; these are its words for "Just the words".
fn html_text(html: &str) -> String {
    let mut out = String::new();
    let mut rest = html;
    while let Some(open) = rest.find('<') {
        out.push_str(&entities(&rest[..open]));
        let tag = &rest[open + 1..];
        let lower = tag.get(..7).unwrap_or(tag).to_ascii_lowercase();
        let skip = ["style", "script", "head"].into_iter().find(|name| lower.starts_with(name));
        let close = match skip {
            Some(name) => tag.to_ascii_lowercase().find(&format!("</{name}")).and_then(|at| tag[at..].find('>').map(|end| at + end)),
            None => tag.find('>'),
        };
        let Some(close) = close else {
            rest = "";
            break;
        };
        let name = lower.trim_start_matches('/').split(|c: char| !c.is_ascii_alphanumeric()).next().unwrap_or_default();
        if matches!(name, "br" | "p" | "div" | "tr" | "li" | "h1" | "h2" | "h3" | "h4" | "table" | "blockquote") {
            out.push('\n');
        }
        rest = &tag[close + 1..];
    }
    out.push_str(&entities(rest));
    let mut text = String::new();
    let mut blank = 0;
    for line in out.lines().map(str::trim_end) {
        blank = if line.trim().is_empty() { blank + 1 } else { 0 };
        if blank < 2 {
            text.push_str(line.trim_start_matches(['\u{a0}']));
            text.push('\n');
        }
    }
    text.trim().to_string()
}

fn entities(text: &str) -> String {
    if !text.contains('&') {
        return text.replace(['\r', '\n'], " ");
    }
    let mut out = String::new();
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        let tail = &rest[at + 1..];
        let end = tail.find(';').filter(|&end| end <= 8);
        let named = end.and_then(|end| match &tail[..end] {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some(' '),
            code if code.starts_with("#x") => u32::from_str_radix(&code[2..], 16).ok().and_then(char::from_u32),
            code if code.starts_with('#') => code[1..].parse().ok().and_then(char::from_u32),
            _ => None,
        });
        match (named, end) {
            (Some(letter), Some(end)) => {
                out.push(letter);
                rest = &tail[end + 1..];
            }
            _ => {
                out.push('&');
                rest = tail;
            }
        }
    }
    out.push_str(rest);
    out.replace(['\r', '\n'], " ")
}

/// An RFC 5322 date such as `Tue, 15 Nov 2026 10:00:00 +0100`, as FILETIME ticks.
fn date(text: &str) -> Option<u64> {
    const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    let text = text.split_once(',').map_or(text, |(_, rest)| rest);
    let mut words = text.split_whitespace();
    let day: i64 = words.next()?.parse().ok()?;
    let month = words.next()?.to_ascii_lowercase();
    let month = MONTHS.iter().position(|name| month.starts_with(name))? as i64 + 1;
    let year: i64 = match words.next()?.parse().ok()? {
        year @ 0..50 => year + 2000,
        year @ 50..100 => year + 1900,
        year => year,
    };
    let mut clock = words.next()?.split(':').map(|part| part.parse::<i64>().ok());
    let (hour, minute, second) = (clock.next()??, clock.next()??, clock.next().flatten().unwrap_or(0));
    let zone = words.next().unwrap_or("+0000");
    let offset = match zone.to_ascii_uppercase().as_str() {
        "EDT" => -4 * 60,
        "EST" | "CDT" => -5 * 60,
        "CST" | "MDT" => -6 * 60,
        "MST" | "PDT" => -7 * 60,
        "PST" => -8 * 60,
        zone if zone.len() == 5 && zone.starts_with(['+', '-']) => {
            let minutes = zone[1..3].parse::<i64>().ok()? * 60 + zone[3..5].parse::<i64>().ok()?;
            if zone.starts_with('-') { -minutes } else { minutes }
        }
        _ => 0,
    };
    // Days since 1970 from the civil date, as Howard Hinnant's days_from_civil counts them.
    let shifted = if month <= 2 { year - 1 } else { year };
    let era = shifted.div_euclid(400);
    let of_era = shifted - era * 400;
    let of_year = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let days = era * 146_097 + of_era * 365 + of_era / 4 - of_era / 100 + of_year - 719_468;
    let seconds = days * 86_400 + hour * 3600 + minute * 60 + second - offset * 60;
    u64::try_from((seconds + 11_644_473_600) * 10_000_000).ok()
}

// .msg

/// The streams of an Outlook message, by MS-OXMSG: `__substg1.0_` then the property's id and type.
fn outlook(path: &Path, with_data: bool) -> std::io::Result<(Mail, Vec<Bytes>)> {
    let mut file = cfb::open(path)?;
    let name = text(&mut file, "", "0042").or_else(|| text(&mut file, "", "0C1A")).unwrap_or_default();
    let address = text(&mut file, "", "0C1F").or_else(|| text(&mut file, "", "0065")).unwrap_or_default();
    let from = match (name.is_empty(), address.is_empty() || address.starts_with("/O=")) {
        (false, false) if name != address => format!("{name} <{address}>"),
        (false, _) => name,
        _ => address,
    };
    let mut body = text(&mut file, "", "1000").unwrap_or_default();
    let mut html = String::new();
    if body.trim().is_empty() {
        let found = binary(&mut file, "/__substg1.0_10130102").or_else(|| text(&mut file, "", "1013").map(String::into_bytes));
        html = found.map(|found| String::from_utf8_lossy(&found).into_owned()).unwrap_or_default();
        body = html_text(&html);
    }
    let date = properties(&mut file, "/__properties_version1.0", 32, &[0x0039_0040, 0x0E06_0040]);
    let folders: Vec<String> = file
        .read_storage("/")?
        .filter(|entry| entry.is_storage() && entry.name().starts_with("__attach_version1.0_"))
        .map(|entry| entry.path().to_string_lossy().replace('\\', "/"))
        .collect();
    let mut attachments = Vec::new();
    let mut data = Vec::new();
    for folder in folders {
        let name = ["3707", "3704", "3001"].iter().find_map(|id| text(&mut file, &folder, id).filter(|name| !name.trim().is_empty()));
        let item = format!("{folder}/__substg1.0_3701000D");
        if file.is_storage(&item) && is_message(&mut file, &folder, &item) {
            // Its name is mostly its subject, which may hold letters a file name can't.
            let name = file_name(&name.unwrap_or_else(|| "Message".into()));
            let name = if name.to_ascii_lowercase().ends_with(".msg") { name } else { format!("{name}.msg") };
            let size = file.walk_storage(&item)?.filter(|entry| entry.is_stream()).map(|entry| entry.len()).sum();
            attachments.push(Attachment { name, size });
            if with_data {
                data.push(Some(item_msg(&mut file, &item)?));
            }
            continue;
        }
        if let Some((name, bytes)) = file.is_storage(&item).then(|| object(&mut file, &item, name.as_deref())).flatten() {
            attachments.push(Attachment { name, size: bytes.len() as u64 });
            if with_data {
                data.push(Some(bytes));
            }
            continue;
        }
        let stream = format!("{folder}/__substg1.0_37010102");
        let size = file.entry(&stream).map_or(0, |entry| entry.len());
        attachments.push(Attachment { name: name.unwrap_or_else(|| "Attachment".into()), size });
        if with_data {
            data.push(binary(&mut file, &stream));
        }
    }
    let mail = Mail {
        subject: text(&mut file, "", "0037").unwrap_or_default(),
        from,
        to: text(&mut file, "", "0E04").unwrap_or_default(),
        cc: text(&mut file, "", "0E03").unwrap_or_default(),
        date: date.unwrap_or(0),
        body: body.replace("\r\n", "\n").trim_end().to_string(),
        html,
        attachments,
    };
    Ok((mail, data))
}

/// Whether an attachment's storage holds an Outlook item, not an embedded object. Its attach
/// method says so, or, where a writer left that out, the item's message class.
fn is_message(file: &mut cfb::CompoundFile<std::fs::File>, folder: &str, item: &str) -> bool {
    // A 32-bit value sits in the low half of the 8 bytes `properties` reads.
    match properties(file, &format!("{folder}/__properties_version1.0"), 8, &[0x3705_0003]) {
        Some(method) => method as u32 == 5,
        None => ["001F", "001E"].iter().any(|kind| file.is_stream(format!("{item}/__substg1.0_001A{kind}"))),
    }
}

/// An embedded object as a file of its own, where Perli can tell what it is: an Office document,
/// a file packed into the mail, or a Paint picture. Its name and bytes.
fn object(file: &mut cfb::CompoundFile<std::fs::File>, item: &str, name: Option<&str>) -> Option<(String, Vec<u8>)> {
    let class = *file.entry(item).ok()?.clsid();
    let named = |extension: &str| {
        let name = file_name(name.unwrap_or("Object"));
        if name.to_ascii_lowercase().ends_with(&format!(".{extension}")) { name } else { format!("{name}.{extension}") }
    };
    if let Some(native) = binary(file, format!("{item}/\u{1}Ole10Native")) {
        // Its size comes first.
        let data = native.get(4..)?;
        return match class.as_u128() {
            PACKAGE => packed(data),
            PAINT => Some((named("bmp"), data.to_vec())),
            _ => None,
        };
    }
    let &(_, extension) = OBJECTS.iter().find(|(id, _)| *id == class.as_u128())?;
    let bytes = if extension.len() == 4 {
        binary(file, format!("{item}/Package"))?
    } else {
        let mut out = cfb::CompoundFile::create(std::io::Cursor::new(Vec::new())).ok()?;
        out.set_storage_clsid("/", class).ok()?;
        copy_tree(file, &mut out, item, Path::new("/")).ok()?;
        out.flush().ok()?;
        out.into_inner().into_inner()
    };
    Some((named(extension), bytes))
}

/// The file in a packed object: its name and bytes. After a kind come its name, where it was
/// packed from, four bytes, a temp path with its length first, then the file with its size first.
fn packed(data: &[u8]) -> Option<(String, Vec<u8>)> {
    let text = |at: usize| -> Option<(&[u8], usize)> {
        let end = at + data.get(at..)?.iter().position(|&byte| byte == 0)?;
        Some((&data[at..end], end + 1))
    };
    let number = |at: usize| Some(u32::from_le_bytes(data.get(at..at + 4)?.try_into().ok()?) as usize);
    let (label, at) = text(2)?;
    let (_, at) = text(at)?;
    let at = at + 4;
    let at = at + 4 + number(at)?;
    let size = number(at)?;
    let bytes = data.get(at + 4..at.checked_add(4 + size)?)?;
    Some((file_name(&decode(label, "windows-1252")), bytes.to_vec()))
}

/// An Outlook item kept in a mail, as a .msg of its own, laid out as MS-OXMSG says: the item's
/// storage becomes the root, the mail's named-property map comes along, and the root's property
/// stream gets the longer header a top-level message has.
fn item_msg(file: &mut cfb::CompoundFile<std::fs::File>, item: &str) -> std::io::Result<Vec<u8>> {
    let mut out = cfb::CompoundFile::create(std::io::Cursor::new(Vec::new()))?;
    out.set_storage_clsid("/", MESSAGE)?;
    copy_tree(file, &mut out, item, Path::new("/"))?;
    let names = "/__nameid_version1.0";
    if file.is_storage(names) {
        copy_tree(file, &mut out, names, Path::new(names))?;
    }
    out.flush()?;
    Ok(out.into_inner().into_inner())
}

/// Every storage and stream under `from`, made again under `to`.
fn copy_tree(
    file: &mut cfb::CompoundFile<std::fs::File>,
    out: &mut cfb::CompoundFile<std::io::Cursor<Vec<u8>>>,
    from: &str,
    to: &Path,
) -> std::io::Result<()> {
    let entries: Vec<(std::path::PathBuf, bool)> =
        file.walk_storage(from)?.map(|entry| (entry.path().to_path_buf(), entry.is_stream())).collect();
    for (path, stream) in entries {
        let Ok(relative) = path.strip_prefix(from) else { continue };
        let target = if relative.as_os_str().is_empty() { to.to_path_buf() } else { to.join(relative) };
        if !stream {
            if !out.exists(&target) {
                out.create_storage(&target)?;
            }
            continue;
        }
        let mut bytes = binary(file, &path).unwrap_or_default();
        // An embedded message's header is 24 bytes; a top-level one's has 8 more, all zero.
        if target == Path::new("/__properties_version1.0") && bytes.len() >= 24 {
            bytes.splice(24..24, [0; 8]);
        }
        out.create_stream(&target)?.write_all(&bytes)?;
    }
    Ok(())
}

/// A string property under `folder`: UTF-16, or in this PC's ANSI code page for older mails.
fn text(file: &mut cfb::CompoundFile<std::fs::File>, folder: &str, id: &str) -> Option<String> {
    if let Some(bytes) = binary(file, format!("{folder}/__substg1.0_{id}001F")) {
        let units: Vec<u16> = bytes.as_chunks::<2>().0.iter().map(|&pair| u16::from_le_bytes(pair)).collect();
        return Some(String::from_utf16_lossy(&units).trim_end_matches('\0').to_string());
    }
    let bytes = binary(file, format!("{folder}/__substg1.0_{id}001E"))?;
    Some(paged(bytes.strip_suffix(&[0]).unwrap_or(&bytes), 0).unwrap_or_default())
}

fn binary(file: &mut cfb::CompoundFile<std::fs::File>, path: impl AsRef<Path>) -> Option<Vec<u8>> {
    let mut stream = file.open_stream(path).ok()?;
    let mut bytes = Vec::new();
    stream.read_to_end(&mut bytes).ok()?;
    Some(bytes)
}

/// The first of `tags` set in a property stream, read as 8 bytes. `skip` is its header's length.
fn properties(file: &mut cfb::CompoundFile<std::fs::File>, path: &str, skip: usize, tags: &[u32]) -> Option<u64> {
    let bytes = binary(file, path)?;
    let entries: Vec<(u32, u64)> = bytes
        .get(skip..)?
        .as_chunks::<16>()
        .0
        .iter()
        .map(|entry| {
            let tag = u32::from_le_bytes(entry[..4].try_into().unwrap_or_default());
            (tag, u64::from_le_bytes(entry[8..16].try_into().unwrap_or_default()))
        })
        .collect();
    tags.iter().find_map(|wanted| entries.iter().find(|(tag, _)| tag == wanted).map(|&(_, value)| value))
}

#[cfg(test)]
mod tests {
    use super::*;

    const EML: &[u8] = b"From: =?UTF-8?B?Sm9zw6k=?= <jose@example.com>\r\n\
To: Ana <ana@example.com>\r\n\
Subject: =?ISO-8859-1?Q?Caf=E9?= =?ISO-8859-1?Q?_tomorrow?=\r\n\
Date: Tue, 15 Nov 2026 10:00:00 +0100\r\n\
Content-Type: multipart/mixed; boundary=\"outer\"\r\n\
\r\n\
--outer\r\n\
Content-Type: multipart/alternative; boundary=inner\r\n\
\r\n\
--inner\r\n\
Content-Type: text/plain; charset=utf-8\r\n\
Content-Transfer-Encoding: quoted-printable\r\n\
\r\n\
See you at the caf=C3=A9 at ten. =\r\n\
Bring the plan.\r\n\
--inner\r\n\
Content-Type: text/html\r\n\
\r\n\
<p>Not this</p>\r\n\
--inner--\r\n\
--outer\r\n\
Content-Type: application/pdf; name=\"plan.pdf\"\r\n\
Content-Disposition: attachment; filename*=utf-8''pl%C3%A1n.pdf\r\n\
Content-Transfer-Encoding: base64\r\n\
\r\n\
JVBERi0x\r\n\
LjQK\r\n\
--outer--\r\n";

    #[test]
    fn an_eml_shows_who_when_what_and_its_attachments() {
        let (mail, data) = eml(EML, true);
        assert_eq!(mail.from, "Jos\u{e9} <jose@example.com>");
        assert_eq!(mail.to, "Ana <ana@example.com>");
        assert_eq!(mail.subject, "Caf\u{e9} tomorrow");
        assert_eq!(mail.body, "See you at the caf\u{e9} at ten. Bring the plan.");
        assert_eq!(mail.attachments, [Attachment { name: "pl\u{e1}n.pdf".into(), size: 9 }]);
        assert_eq!(data, [Some(b"%PDF-1.4\n".to_vec())]);
        // 2026-11-15 09:00 UTC.
        assert_eq!(mail.date, (1_794_733_200 + 11_644_473_600) * 10_000_000);
    }

    #[test]
    fn an_html_only_mail_reads_as_its_words() {
        let mail = b"Content-Type: text/html; charset=windows-1252\n\n<html><head><style>p{}</style></head><body><p>Hi &amp; bye</p><p>Na\xefve<br>end</p></body></html>";
        let (mail, _) = eml(mail, false);
        assert_eq!(mail.body, "Hi & bye\n\nNa\u{ef}ve\nend");
        assert!(mail.html.contains("<p>Hi &amp; bye</p>"), "and shows as it was laid out");
    }

    #[test]
    fn a_long_attachment_name_comes_together_from_its_pieces() {
        let disposition = "attachment; filename*1=\"de \"; filename*0*=utf-8''Relat%C3%B3rio%20; filename*2*=2026%2Epdf";
        assert_eq!(param(disposition, "filename").as_deref(), Some("Relatório de 2026.pdf"));
        assert_eq!(param("attachment; filename*0=\"a\"; filename*1=\"b.txt\"", "filename").as_deref(), Some("ab.txt"));
        assert_eq!(param("attachment; filename*1=late.txt", "filename"), None, "no first piece, no name");
        assert_eq!(param("inline; name=plain.txt", "name").as_deref(), Some("plain.txt"));
    }

    #[test]
    fn a_msg_shows_its_streams_and_attachments() {
        let path = std::env::temp_dir().join(format!("perli-mail-{}.msg", std::process::id()));
        {
            let mut file = cfb::create(&path).unwrap();
            let mut put = |path: &str, bytes: &[u8]| {
                std::io::Write::write_all(&mut file.create_stream(path).unwrap(), bytes).unwrap();
            };
            let utf16 = |text: &str| text.encode_utf16().flat_map(u16::to_le_bytes).collect::<Vec<u8>>();
            put("/__substg1.0_0037001F", &utf16("Lunch"));
            put("/__substg1.0_0042001F", &utf16("Ana"));
            put("/__substg1.0_0C1F001F", &utf16("ana@example.com"));
            put("/__substg1.0_0E04001F", &utf16("Jos\u{e9}"));
            put("/__substg1.0_1000001F", &utf16("Friday at one?\r\n"));
            let mut props = vec![0u8; 32];
            props.extend(0x0039_0040u32.to_le_bytes());
            props.extend([0; 4]);
            props.extend(133_000_000_000_000_000u64.to_le_bytes());
            put("/__properties_version1.0", &props);
            drop(put);
            file.create_storage("/__attach_version1.0_#00000000").unwrap();
            let mut put = |path: &str, bytes: &[u8]| {
                std::io::Write::write_all(&mut file.create_stream(path).unwrap(), bytes).unwrap();
            };
            put("/__attach_version1.0_#00000000/__substg1.0_3707001F", &utf16("menu.txt"));
            put("/__attach_version1.0_#00000000/__substg1.0_37010102", b"soup");
            drop(put);
            file.create_storage("/__attach_version1.0_#00000001").unwrap();
            file.create_storage("/__attach_version1.0_#00000001/__substg1.0_3701000D").unwrap();
            file.create_storage("/__attach_version1.0_#00000002").unwrap();
            file.create_storage("/__attach_version1.0_#00000002/__substg1.0_3701000D").unwrap();
            for (at, class) in [(3, 0x0002_0821_0000_0000_C000_0000_0000_0046), (4, PACKAGE)] {
                let item = format!("/__attach_version1.0_#0000000{at}/__substg1.0_3701000D");
                file.create_storage(format!("/__attach_version1.0_#0000000{at}")).unwrap();
                file.create_storage(&item).unwrap();
                file.set_storage_clsid(&item, uuid::Uuid::from_u128(class)).unwrap();
            }
            file.create_storage("/__nameid_version1.0").unwrap();
            let mut put = |path: &str, bytes: &[u8]| {
                std::io::Write::write_all(&mut file.create_stream(path).unwrap(), bytes).unwrap();
            };
            // Attach method 5, an Outlook item, and 6, an embedded object.
            let method = |method: u32| [&[0u8; 8][..], &0x3705_0003u32.to_le_bytes()[..], &[0; 4][..], &u64::from(method).to_le_bytes()[..]].concat();
            put("/__attach_version1.0_#00000001/__properties_version1.0", &method(5));
            put("/__attach_version1.0_#00000001/__substg1.0_3001001F", &utf16("Re: Lunch"));
            put("/__attach_version1.0_#00000001/__substg1.0_3701000D/__substg1.0_0037001F", &utf16("Re: Lunch"));
            let mut inner = vec![0u8; 24];
            inner.extend(0x0039_0040u32.to_le_bytes());
            inner.extend([0; 4]);
            inner.extend(132_000_000_000_000_000u64.to_le_bytes());
            put("/__attach_version1.0_#00000001/__substg1.0_3701000D/__properties_version1.0", &inner);
            put("/__attach_version1.0_#00000002/__properties_version1.0", &method(6));
            put("/__attach_version1.0_#00000002/__substg1.0_3001001F", &utf16("Chart"));
            put("/__attach_version1.0_#00000002/__substg1.0_3701000D/\u{1}Ole", b"ole");
            put("/__attach_version1.0_#00000003/__properties_version1.0", &method(6));
            put("/__attach_version1.0_#00000003/__substg1.0_3001001F", &utf16("Sales"));
            put("/__attach_version1.0_#00000003/__substg1.0_3701000D/Workbook", b"cells");
            put("/__attach_version1.0_#00000004/__properties_version1.0", &method(6));
            let temp = b"C:\\Temp\\notes.txt\0";
            let native = [
                &[0u8; 4][..],
                &[2, 0],
                b"notes.txt\0",
                b"C:\\Docs\\notes.txt\0",
                &[0, 0, 3, 0],
                &(temp.len() as u32).to_le_bytes(),
                temp,
                &5u32.to_le_bytes(),
                b"hello",
            ]
            .concat();
            put("/__attach_version1.0_#00000004/__substg1.0_3701000D/\u{1}Ole10Native", &native);
            put("/__nameid_version1.0/__substg1.0_00020102", &[1; 16]);
        }

        let mail = read(&path).unwrap();
        let attached = attachments(&path).unwrap();
        let folder = path.with_extension("out");
        std::fs::create_dir_all(&folder).unwrap();
        let taken = take_out(&path, 0, &folder);
        let object = take_out(&path, 2, &folder);
        let zone = std::fs::read(folder.join("menu.txt:Zone.Identifier"));
        let _ = std::fs::remove_dir_all(&folder);
        let _ = std::fs::remove_file(&path);
        let item = path.with_extension("item.msg");
        std::fs::write(&item, attached[1].1.as_deref().unwrap()).unwrap();
        let inner = read(&item).unwrap();
        let mut file = cfb::open(&item).unwrap();
        let header = binary(&mut file, "/__properties_version1.0").unwrap();
        let names = file.is_stream("/__nameid_version1.0/__substg1.0_00020102");
        let class = *file.root_entry().clsid();
        drop(file);
        let _ = std::fs::remove_file(&item);

        assert_eq!(mail.subject, "Lunch");
        assert_eq!(mail.from, "Ana <ana@example.com>");
        assert_eq!(mail.to, "Jos\u{e9}");
        assert_eq!(mail.body, "Friday at one?");
        assert_eq!(mail.date, 133_000_000_000_000_000);
        assert_eq!(
            mail.attachments,
            [
                Attachment { name: "menu.txt".into(), size: 4 },
                Attachment { name: "Re_ Lunch.msg".into(), size: 18 + 40 },
                Attachment { name: "Chart".into(), size: 0 },
                Attachment { name: "Sales.xls".into(), size: attached[3].1.as_ref().unwrap().len() as u64 },
                Attachment { name: "notes.txt".into(), size: 5 },
            ]
        );
        let sales = cfb::CompoundFile::open(std::io::Cursor::new(attached[3].1.clone().unwrap())).unwrap();
        assert_eq!(sales.root_entry().clsid().as_u128(), 0x0002_0821_0000_0000_C000_0000_0000_0046, "an Excel chart comes out as its own workbook");
        assert!(sales.is_stream("/Workbook"));
        assert_eq!(attached[4], ("notes.txt".to_string(), Some(b"hello".to_vec())), "a packed file comes out as itself");
        assert_eq!(attached[0], ("menu.txt".to_string(), Some(b"soup".to_vec())));
        assert_eq!(attached[2], ("Chart".to_string(), None), "an embedded object has no bytes to pass off as a file");
        assert_eq!(inner.subject, "Re: Lunch", "the Outlook item inside comes out as a .msg of its own");
        assert_eq!(inner.date, 132_000_000_000_000_000, "its properties are read past a top-level header");
        assert_eq!(header.len(), 32 + 16);
        assert!(names, "the mail's named-property map comes along");
        assert_eq!(class, MESSAGE);
        assert_eq!(taken, Ok(folder.join("menu.txt")));
        assert_eq!(zone.unwrap(), FROM_ELSEWHERE, "an attachment taken out to open is marked as from the internet");
        assert!(object.is_err());
    }

    #[test]
    fn a_mail_inside_a_mail_is_named_as_one() {
        let mail = b"Content-Type: multipart/mixed; boundary=b\n\n--b\nContent-Type: message/rfc822; name=\"Re: plan\"\n\nSubject: plan\n\nhi\n--b--\n";
        let (mail, _) = eml(mail, false);
        assert_eq!(mail.attachments[0].name, "Re: plan.eml");
        assert_eq!(file_name("Re: a/b?. "), "Re_ a_b_");
        assert_eq!(file_name(" .. "), "Attachment");
    }
}
