//! The archives Windows Explorer opens besides ZIP: 7z, RAR, TAR (plain, or squeezed with gzip,
//! bzip2, xz or zstd) and CAB, and the comic books CB7 and CBR, which are 7z and RAR files.
//! Nothing here writes to an archive. RAR is read through RARLAB's UnRAR code, which may be used
//! to read RAR files in any app but not to make them.
//!
//! Each kind reads from its start in one pass, as solid archives and TARs must, so one walk serves
//! every file a caller wants. All of it blocks, so call it off the main thread.

use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::{self, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, PoisonError};
use std::time::SystemTime;

use crate::inside::WRONG_PASSWORD;

/// What the UI looks for to ask for a password.
pub const NEEDS_PASSWORD: &str = "This file is locked. Enter the archive's password first.";
const DAMAGED: &str = "This archive is damaged or isn't one Perli can read";
const TOO_BIG: &str = "is too big to show";

/// FILETIME ticks at 1970-01-01, the start of the times TAR and 7z count from.
const UNIX_START: u64 = 116_444_736_000_000_000;
/// How many archives' lists stay at hand, so going in and out of folders reads none again.
const LISTS_KEPT: usize = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    SevenZ,
    Rar,
    Tar(Squeeze),
    Cab,
}

/// How a TAR is squeezed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Squeeze {
    Plain,
    Gzip,
    Bzip2,
    Xz,
    Zstd,
}

/// The kind of archive a file's name says it is, for the kinds this module reads.
pub fn kind_of(name: &OsStr) -> Option<Kind> {
    let lower = name.to_string_lossy().to_lowercase();
    let ends = |tails: &[&str]| tails.iter().any(|tail| lower.ends_with(tail));
    Some(if ends(&[".7z", ".cb7"]) || seven_part(&lower).is_some() {
        Kind::SevenZ
    } else if ends(&[".rar", ".cbr"]) {
        Kind::Rar
    } else if ends(&[".tar"]) {
        Kind::Tar(Squeeze::Plain)
    } else if ends(&[".tar.gz", ".tgz"]) {
        Kind::Tar(Squeeze::Gzip)
    } else if ends(&[".tar.bz2", ".tbz2", ".tbz"]) {
        Kind::Tar(Squeeze::Bzip2)
    } else if ends(&[".tar.xz", ".txz"]) {
        Kind::Tar(Squeeze::Xz)
    } else if ends(&[".tar.zst", ".tzst"]) {
        Kind::Tar(Squeeze::Zstd)
    } else if ends(&[".cab"]) {
        Kind::Cab
    } else {
        return None;
    })
}

/// The number of a split 7z's part, from a name such as `x.7z.003`.
fn seven_part(lower: &str) -> Option<u32> {
    let (stem, number) = lower.rsplit_once('.')?;
    (stem.ends_with(".7z") && number.len() == 3 && number.bytes().all(|byte| byte.is_ascii_digit())).then(|| number.parse().ok()).flatten()
}

/// The number of a RAR set's part, from a name such as `x.part03.rar`, and where its digits sit.
fn rar_part(lower: &str) -> Option<(u32, std::ops::Range<usize>)> {
    let stem = lower.strip_suffix(".rar")?;
    let digits = stem.len() - stem.bytes().rev().take_while(u8::is_ascii_digit).count();
    stem[..digits].strip_suffix(".part")?;
    (digits < stem.len()).then(|| Some((stem[digits..].parse().ok()?, digits..stem.len()))).flatten()
}

/// What marks a name as an archive, longest first.
const TAILS: [&str; 15] = [".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst", ".tgz", ".tbz2", ".tbz", ".txz", ".tzst", ".tar", ".7z", ".rar", ".cab", ".cbr", ".cb7"];

/// A name without what marks it as an archive or a part of a set: `x` for `x.tar.gz`,
/// `x.part2.rar` and `x.7z.001`.
pub fn stem(name: &str) -> &str {
    // ASCII lowercase keeps every letter where it was, so its places hold in `name` too.
    let lower = name.to_ascii_lowercase();
    let mut end = name.len();
    if seven_part(&lower).is_some() {
        end -= ".001".len();
    } else if let Some((_, digits)) = rar_part(&lower) {
        return &name[..digits.start - ".part".len()];
    }
    let tail = TAILS.iter().find(|tail| lower[..end].ends_with(*tail)).map_or(0, |tail| tail.len());
    &name[..end - tail]
}

/// The file a set of parts is read from: `x.part1.rar` for `x.part3.rar`, `x.7z.001` for
/// `x.7z.004`. Any other archive, and a part whose first is missing, reads from itself.
pub fn first_part(path: &Path) -> PathBuf {
    let Some(name) = path.file_name().map(|name| name.to_string_lossy().into_owned()) else {
        return path.to_path_buf();
    };
    let lower = name.to_lowercase();
    let first = if seven_part(&lower).is_some_and(|number| number > 1) {
        Some(format!("{}001", &name[..name.len() - 3]))
    } else if let Some((_, digits)) = rar_part(&lower).filter(|(number, _)| *number > 1) {
        Some(format!("{}{:0width$}{}", &name[..digits.start], 1, &name[digits.end..], width = digits.len()))
    } else {
        None
    };
    first.map(|first| path.with_file_name(first)).filter(|first| first.is_file()).unwrap_or_else(|| path.to_path_buf())
}

/// One file or folder in an archive.
#[derive(Clone, Debug, PartialEq)]
pub struct Item {
    /// Its path in the archive, with `/` between parts and none at the end.
    pub name: String,
    pub size: u64,
    /// What it takes up in the archive. Shared out by size where the archive packs files together.
    pub packed: u64,
    /// FILETIME ticks, 0 if the archive has no time for it.
    pub ticks: u64,
    pub folder: bool,
    /// Protected by a password.
    pub locked: bool,
}

#[derive(Debug, Default, PartialEq)]
pub struct Listed {
    pub items: Vec<Item>,
    /// Files are packed together, so reading a late one reads all before it.
    pub solid: bool,
    /// Even the names are locked: nothing shows without the password.
    pub hidden: bool,
}

impl Listed {
    pub fn locked(&self) -> bool {
        self.hidden || self.items.iter().any(|item| item.locked)
    }
}

/// A file's data while a walk stands on it. Pouring it reads it, once.
pub trait Body {
    fn pour(&mut self, to: &mut dyn Write) -> io::Result<u64>;
}

/// A body read through `Read`, as all kinds but RAR give it.
struct ReadBody<'r> {
    from: &'r mut dyn Read,
    poured: bool,
}

impl Body for ReadBody<'_> {
    fn pour(&mut self, to: &mut dyn Write) -> io::Result<u64> {
        if std::mem::replace(&mut self.poured, true) {
            return Err(io::Error::other("This file was read already"));
        }
        io::copy(self.from, to)
    }
}

type Stamp = (String, u64, Option<SystemTime>, bool);
type Lists = Mutex<Vec<(Stamp, Arc<Listed>)>>;
static LISTS: LazyLock<Lists> = LazyLock::new(Mutex::default);

/// What an archive holds. The list of a version of the archive is read once.
pub fn list(path: &Path, password: Option<&str>) -> Result<Arc<Listed>, String> {
    let path = first_part(path);
    let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
    let stamp = (path.to_string_lossy().to_lowercase(), metadata.len(), metadata.modified().ok(), password.is_some());
    if let Some((_, listed)) = LISTS.lock().unwrap_or_else(PoisonError::into_inner).iter().find(|(kept, _)| *kept == stamp) {
        return Ok(listed.clone());
    }
    let kind = kind_of(path.as_os_str()).ok_or(DAMAGED)?;
    let mut listed = match kind {
        Kind::SevenZ => seven::list(&path, password)?,
        Kind::Rar => rar::list(&path, password)?,
        Kind::Tar(squeeze) => tar_list(&path, squeeze)?,
        Kind::Cab => cab_list(&path)?,
    };
    // Kinds that know only what the whole archive takes up share it out by size.
    let total: u64 = listed.items.iter().map(|item| item.size).sum();
    if total > 0 && listed.items.iter().all(|item| item.packed == 0) {
        let whole = parts_size(&path, kind) as f64;
        for item in &mut listed.items {
            item.packed = (item.size as f64 * whole / total as f64) as u64;
        }
    }
    let listed = Arc::new(listed);
    let mut lists = LISTS.lock().unwrap_or_else(PoisonError::into_inner);
    lists.retain(|(kept, _)| kept.0 != stamp.0 || kept.3 != stamp.3);
    lists.push((stamp, listed.clone()));
    if lists.len() > LISTS_KEPT {
        lists.remove(0);
    }
    Ok(listed)
}

/// The bytes all parts of the archive take up.
fn parts_size(path: &Path, kind: Kind) -> u64 {
    let size = |path: &Path| fs::metadata(path).map_or(0, |metadata| metadata.len());
    match kind {
        Kind::SevenZ => seven::parts(path).iter().map(|part| size(part)).sum(),
        _ => size(path),
    }
}

/// Visits each file `want` picks, in archive order, until `each` says to stop. A file `each`
/// leaves unpoured is passed over.
pub fn walk<E: From<String>>(
    path: &Path,
    password: Option<&str>,
    want: impl Fn(&Item) -> bool,
    mut each: impl FnMut(&Item, &mut dyn Body) -> Result<bool, E>,
) -> Result<(), E> {
    let path = first_part(path);
    match kind_of(path.as_os_str()).ok_or_else(|| E::from(DAMAGED.into()))? {
        Kind::SevenZ => seven::walk(&path, password, &want, &mut each),
        Kind::Rar => rar::walk(&path, password, &want, &mut each),
        Kind::Tar(squeeze) => tar_walk(&path, squeeze, &want, &mut each),
        Kind::Cab => cab_walk(&path, &want, &mut each),
    }
}

/// Takes what a walk's caller gives back, and an error of the archive's as a string.
pub(crate) fn read_error(error: io::Error, item: &Item, password: Option<&str>) -> String {
    match error.kind() {
        // A wrong key reads as garbage that fails to unpack, ends too soon, or fails its checksum.
        io::ErrorKind::InvalidData | io::ErrorKind::InvalidInput | io::ErrorKind::UnexpectedEof if item.locked && password.is_some() => WRONG_PASSWORD.into(),
        _ => error.to_string(),
    }
}

/// A writer that takes `most` bytes and then says it has enough.
struct Capped<'v> {
    into: &'v mut Vec<u8>,
    most: u64,
}

const ENOUGH: &str = "enough";

impl Write for Capped<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let room = (self.most - self.into.len() as u64) as usize;
        if room == 0 {
            return Err(io::Error::other(ENOUGH));
        }
        let taken = bytes.len().min(room);
        self.into.extend_from_slice(&bytes[..taken]);
        Ok(taken)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// The start of one file, `most` bytes at most. With `whole`, a bigger file is refused.
pub fn read(path: &Path, name: &str, most: u64, whole: bool, password: Option<&str>) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let mut found = false;
    walk(path, password, |item| !item.folder && item.name == name, |item, body| {
        found = true;
        if whole && item.size > most {
            return Err(format!("{name} {TOO_BIG}"));
        }
        let poured = body.pour(&mut Capped { into: &mut bytes, most });
        match poured {
            Err(error) if error.to_string() != ENOUGH => Err(read_error(error, item, password)),
            _ => Ok(false),
        }
    })?;
    if found {
        Ok(bytes)
    } else {
        Err("That isn't in the archive anymore".into())
    }
}

/// Whether `password` opens the archive: its names when they are locked, and else its smallest
/// locked file, read through so a wrong one can't pass.
pub fn check_password(path: &Path, password: &str) -> Result<(), String> {
    let listed = list(path, Some(password))?;
    let smallest = listed.items.iter().filter(|item| item.locked && !item.folder).min_by_key(|item| item.size);
    let Some(smallest) = smallest else { return Ok(()) };
    let name = smallest.name.clone();
    walk(path, Some(password), |item| item.name == name, |item, body| {
        body.pour(&mut io::sink()).map_err(|error| read_error(error, item, Some(password)))?;
        Ok::<_, String>(false)
    })
}

/// How many files read back whole, which did not, and how many stayed locked.
pub fn test(path: &Path, password: Option<&str>) -> Result<crate::inside::Tested, String> {
    let mut found = crate::inside::Tested { sound: 0, damaged: Vec::new(), locked: 0 };
    let listed = list(path, password)?;
    if listed.hidden {
        return Err(NEEDS_PASSWORD.into());
    }
    found.locked = listed.items.iter().filter(|item| item.locked && !item.folder && password.is_none()).count() as u32;
    walk(path, password, |item| !item.folder && (!item.locked || password.is_some()), |item, body| {
        match body.pour(&mut io::sink()) {
            Ok(_) => found.sound += 1,
            Err(error) => match read_error(error, item, password) {
                wrong if wrong == WRONG_PASSWORD => return Err(wrong),
                _ => found.damaged.push(item.name.clone()),
            },
        }
        Ok(true)
    })?;
    Ok(found)
}

/// FILETIME ticks for seconds since 1970.
fn unix_ticks(seconds: u64) -> u64 {
    seconds.saturating_mul(10_000_000).saturating_add(UNIX_START)
}

/// An archive's own name with `/` between parts and none at the end, or `None` for one that
/// names nothing.
fn clean_name(name: &str) -> Option<String> {
    let parts: Vec<&str> = name.split(['/', '\\']).filter(|part| !part.is_empty() && *part != ".").collect();
    (!parts.is_empty()).then(|| parts.join("/"))
}

fn tar_reader(path: &Path, squeeze: Squeeze) -> Result<Box<dyn Read>, String> {
    let file = BufReader::new(File::open(path).map_err(|error| error.to_string())?);
    Ok(match squeeze {
        Squeeze::Plain => Box::new(file),
        Squeeze::Gzip => Box::new(flate2::read::MultiGzDecoder::new(file)),
        Squeeze::Bzip2 => Box::new(bzip2::read::MultiBzDecoder::new(file)),
        Squeeze::Xz => Box::new(lzma_rust2::XzReader::new(file, true)),
        Squeeze::Zstd => Box::new(Zstd::new(file)),
    })
}

/// A zstd stream read through all its frames. Tools that write in parts, and files joined end to
/// end, hold more than one. Skippable frames are passed over.
pub(crate) struct Zstd<R> {
    source: R,
    frame: ruzstd::decoding::FrameDecoder,
    frames: u32,
}

impl<R: io::BufRead> Zstd<R> {
    pub(crate) fn new(source: R) -> Self {
        Self { source, frame: ruzstd::decoding::FrameDecoder::new(), frames: 0 }
    }

    /// What it reads from, for what is left after the last frame.
    pub(crate) fn source_mut(&mut self) -> &mut R {
        &mut self.source
    }

    /// Starts the next frame. False at the end of the stream, and at bytes after the first frame
    /// that are no frame at all, which zstd's own tools leave be too.
    fn next_frame(&mut self) -> io::Result<bool> {
        use ruzstd::decoding::errors::{FrameDecoderError, ReadFrameHeaderError};
        loop {
            if self.frames > 0 && self.source.fill_buf()?.is_empty() {
                return Ok(false);
            }
            match self.frame.reset(&mut self.source) {
                Ok(()) => {
                    self.frames += 1;
                    return Ok(true);
                }
                Err(FrameDecoderError::ReadFrameHeaderError(ReadFrameHeaderError::SkipFrame { length, .. })) => {
                    io::copy(&mut (&mut self.source).take(u64::from(length)), &mut io::sink())?;
                }
                Err(FrameDecoderError::ReadFrameHeaderError(ReadFrameHeaderError::BadMagicNumber(_))) if self.frames > 0 => return Ok(false),
                Err(error) => return Err(io::Error::new(io::ErrorKind::InvalidData, error)),
            }
        }
    }
}

impl<R: io::BufRead> Read for Zstd<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        loop {
            if self.frames > 0 && self.frame.can_collect() > 0 {
                return self.frame.read(buffer);
            }
            if self.frames == 0 || self.frame.is_finished() {
                if !self.next_frame()? {
                    return Ok(0);
                }
                continue;
            }
            self.frame
                .decode_blocks(&mut self.source, ruzstd::decoding::BlockDecodingStrategy::UptoBlocks(1))
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        }
    }
}

/// A TAR entry as an item. Links and devices are left out: they lead outside what was packed.
fn tar_item<R: Read>(entry: &tar::Entry<'_, R>) -> Option<Item> {
    let kind = entry.header().entry_type();
    let folder = kind.is_dir();
    if !folder && !kind.is_file() && kind != tar::EntryType::Continuous && kind != tar::EntryType::GNUSparse {
        return None;
    }
    let name = clean_name(&String::from_utf8_lossy(&entry.path_bytes()))?;
    let ticks = entry.header().mtime().map_or(0, unix_ticks);
    Some(Item { name, size: if folder { 0 } else { entry.size() }, packed: 0, ticks, folder, locked: false })
}

fn tar_list(path: &Path, squeeze: Squeeze) -> Result<Listed, String> {
    let mut items = Vec::new();
    let mut each = |item: &Item, _: &mut dyn Body| {
        items.push(item.clone());
        Ok::<_, String>(true)
    };
    tar_walk(path, squeeze, &|_| true, &mut each)?;
    Ok(Listed { items, solid: true, hidden: false })
}

fn tar_walk<E: From<String>>(
    path: &Path,
    squeeze: Squeeze,
    want: &dyn Fn(&Item) -> bool,
    each: &mut dyn FnMut(&Item, &mut dyn Body) -> Result<bool, E>,
) -> Result<(), E> {
    let text = |error: io::Error| E::from(format!("{DAMAGED}: {error}"));
    let mut archive = tar::Archive::new(tar_reader(path, squeeze).map_err(E::from)?);
    for entry in archive.entries().map_err(text)? {
        let mut entry = entry.map_err(text)?;
        let Some(item) = tar_item(&entry).filter(|item| want(item)) else { continue };
        if !each(&item, &mut ReadBody { from: &mut entry, poured: false })? {
            break;
        }
    }
    Ok(())
}

fn cab_open(path: &Path) -> Result<cab::Cabinet<BufReader<File>>, String> {
    let file = BufReader::new(File::open(path).map_err(|error| error.to_string())?);
    cab::Cabinet::new(file).map_err(|error| format!("{DAMAGED}: {error}"))
}

fn cab_items(cabinet: &cab::Cabinet<BufReader<File>>) -> Vec<Item> {
    let mut items = Vec::new();
    for folder in cabinet.folder_entries() {
        for file in folder.file_entries() {
            let Some(name) = clean_name(file.name()) else { continue };
            // CAB keeps local times, as ZIP does.
            let ticks = file.datetime().and_then(|time| {
                let seconds = time.assume_utc().unix_timestamp();
                u64::try_from(seconds).ok().map(unix_ticks)
            });
            items.push(Item { name, size: file.uncompressed_size().into(), packed: 0, ticks: ticks.unwrap_or(0), folder: false, locked: false });
        }
    }
    items
}

fn cab_list(path: &Path) -> Result<Listed, String> {
    Ok(Listed { items: cab_items(&cab_open(path)?), solid: true, hidden: false })
}

fn cab_walk<E: From<String>>(path: &Path, want: &dyn Fn(&Item) -> bool, each: &mut dyn FnMut(&Item, &mut dyn Body) -> Result<bool, E>) -> Result<(), E> {
    let mut cabinet = cab_open(path).map_err(E::from)?;
    let names: Vec<(Item, String)> = {
        let mut raw = Vec::new();
        for folder in cabinet.folder_entries() {
            for file in folder.file_entries() {
                raw.push(file.name().to_string());
            }
        }
        cab_items(&cabinet).into_iter().zip(raw).collect()
    };
    for (item, raw) in names {
        if !want(&item) {
            continue;
        }
        let mut reader = cabinet.read_file(&raw).map_err(|error| E::from(error.to_string()))?;
        if !each(&item, &mut ReadBody { from: &mut reader, poured: false })? {
            break;
        }
    }
    Ok(())
}

mod seven {
    use super::*;
    use sevenz_rust2::{Archive, BlockDecoder, EncoderMethod, Error, Password};

    /// The parts of a split 7z, in order, or the archive alone.
    pub fn parts(path: &Path) -> Vec<PathBuf> {
        let name = path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
        if seven_part(&name.to_lowercase()).is_none() {
            return vec![path.to_path_buf()];
        }
        let stem = &name[..name.len() - 3];
        (1..1000).map(|number| path.with_file_name(format!("{stem}{number:03}"))).take_while(|part| part.is_file()).collect()
    }

    /// The parts of a split 7z read as one file.
    pub struct Volumes {
        parts: Vec<(File, u64)>,
        at: u64,
        total: u64,
    }

    impl Volumes {
        fn open(path: &Path) -> io::Result<Self> {
            let mut parts = Vec::new();
            for part in super::seven::parts(path) {
                let file = File::open(&part)?;
                let length = file.metadata()?.len();
                parts.push((file, length));
            }
            let total = parts.iter().map(|(_, length)| length).sum();
            Ok(Self { parts, at: 0, total })
        }
    }

    impl Read for Volumes {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            let mut start = 0;
            for (file, length) in &mut self.parts {
                if self.at < start + *length {
                    file.seek(SeekFrom::Start(self.at - start))?;
                    let room = (start + *length - self.at).min(buffer.len() as u64) as usize;
                    let count = file.read(&mut buffer[..room])?;
                    self.at += count as u64;
                    return Ok(count);
                }
                start += *length;
            }
            Ok(0)
        }
    }

    impl Seek for Volumes {
        fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
            let at = match to {
                SeekFrom::Start(at) => Some(at),
                SeekFrom::End(offset) => self.total.checked_add_signed(offset),
                SeekFrom::Current(offset) => self.at.checked_add_signed(offset),
            };
            self.at = at.ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
            Ok(self.at)
        }
    }

    fn reason(error: Error, password: Option<&str>) -> String {
        match error {
            Error::PasswordRequired => NEEDS_PASSWORD.into(),
            Error::MaybeBadPassword(_) => WRONG_PASSWORD.into(),
            Error::ChecksumVerificationFailed if password.is_some() => WRONG_PASSWORD.into(),
            other => format!("{DAMAGED}: {other}"),
        }
    }

    fn open(path: &Path, password: Option<&str>) -> Result<(Archive, Volumes, Password), String> {
        let mut volumes = Volumes::open(path).map_err(|error| error.to_string())?;
        let key = password.map_or_else(Password::empty, Password::new);
        let archive = Archive::read(&mut volumes, &key).map_err(|error| reason(error, password))?;
        Ok((archive, volumes, key))
    }

    /// For each file, whether its block is locked with AES.
    fn locks(archive: &Archive) -> Vec<bool> {
        let locked: Vec<bool> = archive
            .blocks
            .iter()
            .map(|block| block.coders.iter().any(|coder| coder.encoder_method_id() == EncoderMethod::ID_AES256_SHA256))
            .collect();
        archive.stream_map.file_block_index.iter().map(|block| block.is_some_and(|block| locked[block])).collect()
    }

    fn items(archive: &Archive) -> Vec<Option<Item>> {
        let locks = locks(archive);
        archive
            .files
            .iter()
            .enumerate()
            .map(|(index, entry)| {
                if entry.is_anti_item {
                    return None;
                }
                let name = clean_name(entry.name())?;
                let ticks = if entry.has_last_modified_date { u64::from(entry.last_modified_date) } else { 0 };
                let folder = entry.is_directory;
                Some(Item { name, size: entry.size, packed: 0, ticks, folder, locked: locks.get(index).copied().unwrap_or(false) })
            })
            .collect()
    }

    pub fn list(path: &Path, password: Option<&str>) -> Result<Listed, String> {
        match open(path, password) {
            Ok((archive, ..)) => Ok(Listed { items: items(&archive).into_iter().flatten().collect(), solid: archive.is_solid, hidden: false }),
            Err(error) if error == NEEDS_PASSWORD && password.is_none() => Ok(Listed { items: Vec::new(), solid: true, hidden: true }),
            Err(error) => Err(error),
        }
    }

    /// Decodes only the blocks that hold a wanted file, so a locked block nobody asked for needs
    /// no password, and stops each block after its last wanted file.
    pub fn walk<E: From<String>>(
        path: &Path,
        password: Option<&str>,
        want: &dyn Fn(&Item) -> bool,
        each: &mut dyn FnMut(&Item, &mut dyn Body) -> Result<bool, E>,
    ) -> Result<(), E> {
        let (archive, mut volumes, key) = open(path, password).map_err(E::from)?;
        let items = items(&archive);
        let wanted: Vec<bool> = items.iter().map(|item| item.as_ref().is_some_and(want)).collect();
        let first = &archive.stream_map.block_first_file_index;
        let mut failed: Option<E> = None;
        let mut go_on = true;
        for (block, &start) in first.iter().enumerate().take(archive.blocks.len()) {
            let decoder = BlockDecoder::new(1, block, &archive, &key, &mut volumes);
            let range = start..start + decoder.entry_count();
            let mut left = range.clone().filter(|&index| wanted[index]).count();
            if left == 0 || !go_on {
                continue;
            }
            let mut index = range.start;
            let decoded = decoder.for_each_entries(&mut |_, data| {
                let at = index;
                index += 1;
                if !wanted[at] {
                    return Ok(true);
                }
                left -= 1;
                let item = items[at].as_ref().expect("wanted items exist");
                match each(item, &mut ReadBody { from: data, poured: false }) {
                    Ok(more) => {
                        go_on = more;
                        Ok(more && left > 0)
                    }
                    Err(error) => {
                        failed = Some(error);
                        go_on = false;
                        Ok(false)
                    }
                }
            });
            if let Some(error) = failed.take() {
                return Err(error);
            }
            decoded.map_err(|error| E::from(reason(error, password)))?;
        }
        // Files with no data belong to no block.
        for (index, item) in items.iter().enumerate() {
            if !go_on {
                break;
            }
            let Some(item) = item.as_ref().filter(|_| wanted[index] && archive.stream_map.file_block_index[index].is_none()) else { continue };
            go_on = each(item, &mut ReadBody { from: &mut io::empty(), poured: false })?;
        }
        Ok(())
    }
}

mod rar {
    use std::os::raw::c_int;
    use std::os::windows::ffi::OsStrExt;

    use unrar_ng_sys as native;

    use super::*;

    /// Open flags and header flags from UnRAR's `dll.hpp`.
    const SOLID: u32 = 0x0008;
    const HEADERS_LOCKED: u32 = 0x0080;
    const FILE_LOCKED: u32 = 0x0004;
    const FILE_FOLDER: u32 = 0x0020;

    /// What the callback reaches while UnRAR works.
    struct State {
        password: Option<Vec<u16>>,
        sink: Option<*mut dyn Write>,
        failed: Option<io::Error>,
    }

    struct Handle {
        raw: *const native::Handle,
        state: Box<State>,
        flags: u32,
    }

    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe { native::RARCloseArchive(self.raw) };
        }
    }

    extern "C" fn callback(message: native::UINT, user: native::LPARAM, first: native::LPARAM, second: native::LPARAM) -> c_int {
        let state = unsafe { &mut *(user as *mut State) };
        match message {
            // A part that isn't there ends the read rather than waiting for a disk.
            native::UCM_CHANGEVOLUMEW => {
                if second == native::RAR_VOL_ASK {
                    -1
                } else {
                    1
                }
            }
            native::UCM_NEEDPASSWORDW => {
                let Some(password) = &state.password else { return -1 };
                let room = usize::try_from(second).unwrap_or(0);
                if password.len() + 1 > room {
                    return -1;
                }
                let buffer = unsafe { std::slice::from_raw_parts_mut(first as *mut u16, room) };
                buffer[..password.len()].copy_from_slice(password);
                buffer[password.len()] = 0;
                1
            }
            native::UCM_PROCESSDATA => {
                let Some(sink) = state.sink else { return 1 };
                let bytes = unsafe { std::slice::from_raw_parts(first as *const u8, usize::try_from(second).unwrap_or(0)) };
                match unsafe { &mut *sink }.write_all(bytes) {
                    Ok(()) => 1,
                    Err(error) => {
                        state.failed = Some(error);
                        -1
                    }
                }
            }
            // A dictionary past what this build allows could take gigabytes of memory.
            native::UCM_LARGEDICT => -1,
            _ => 1,
        }
    }

    fn wide(text: &OsStr) -> Vec<u16> {
        text.encode_wide().chain([0]).collect()
    }

    fn reason(code: c_int, password: Option<&str>) -> String {
        match code {
            native::ERAR_MISSING_PASSWORD => NEEDS_PASSWORD.into(),
            native::ERAR_BAD_PASSWORD => WRONG_PASSWORD.into(),
            native::ERAR_BAD_DATA if password.is_some() => WRONG_PASSWORD.into(),
            native::ERAR_EOPEN => "A part of this archive is missing or can't be opened".into(),
            native::ERAR_LARGE_DICT => "This archive needs more memory to unpack than Perli allows".into(),
            _ => DAMAGED.into(),
        }
    }

    fn open(path: &Path, password: Option<&str>, mode: u32) -> Result<Handle, String> {
        let name = wide(path.as_os_str());
        let mut state = Box::new(State { password: password.map(|password| password.encode_utf16().collect()), sink: None, failed: None });
        let mut data: native::OpenArchiveDataEx = unsafe { std::mem::zeroed() };
        data.archive_name_w = name.as_ptr() as *const _;
        data.open_mode = mode;
        data.callback = Some(callback);
        data.user_data = (&mut *state as *mut State) as native::LPARAM;
        let raw = unsafe { native::RAROpenArchiveEx(&data) };
        let code = data.open_result as c_int;
        if raw.is_null() || code != native::ERAR_SUCCESS {
            if !raw.is_null() {
                unsafe { native::RARCloseArchive(raw) };
            }
            return Err(reason(code, password));
        }
        Ok(Handle { raw, state, flags: data.flags })
    }

    fn text_of(wide: &[u16]) -> String {
        let end = wide.iter().position(|&unit| unit == 0).unwrap_or(wide.len());
        String::from_utf16_lossy(&wide[..end])
    }

    fn item_of(header: &native::HeaderDataEx) -> Option<Item> {
        // Links lead outside what was packed.
        if header.redir_type != 0 {
            return None;
        }
        // The header is packed, so its name is copied out before it is read.
        let wide = header.filename_w;
        let name = clean_name(&text_of(&wide))?;
        let folder = header.flags & FILE_FOLDER != 0;
        let high = |low: u32, high: u32| (u64::from(high) << 32) | u64::from(low);
        let ticks = match high(header.mtime_low, header.mtime_high) {
            0 => dos_ticks(header.file_time),
            ticks => ticks,
        };
        Some(Item {
            name,
            size: if folder { 0 } else { high(header.unp_size, header.unp_size_high) },
            packed: high(header.pack_size, header.pack_size_high),
            ticks,
            folder,
            locked: header.flags & FILE_LOCKED != 0,
        })
    }

    /// A DOS date and time, local as RAR 4 kept it, as FILETIME ticks.
    fn dos_ticks(time: u32) -> u64 {
        use windows::Win32::Foundation::SYSTEMTIME;
        let field = |shift: u32, bits: u32| ((time >> shift) & ((1 << bits) - 1)) as u16;
        let local = SYSTEMTIME {
            wYear: 1980 + field(25, 7),
            wMonth: field(21, 4),
            wDay: field(16, 5),
            wHour: field(11, 5),
            wMinute: field(5, 6),
            wSecond: field(0, 5) * 2,
            ..Default::default()
        };
        crate::ops::sys::local_ticks(&local).unwrap_or(0)
    }

    /// The next file's header, or `None` at the end.
    fn next(handle: &Handle, password: Option<&str>) -> Result<Option<native::HeaderDataEx>, String> {
        let mut header = native::HeaderDataEx::default();
        match unsafe { native::RARReadHeaderEx(handle.raw, &raw mut header) } {
            native::ERAR_SUCCESS => Ok(Some(header)),
            native::ERAR_END_ARCHIVE => Ok(None),
            code => Err(reason(code, password)),
        }
    }

    pub fn list(path: &Path, password: Option<&str>) -> Result<Listed, String> {
        let handle = open(path, password, native::RAR_OM_LIST)?;
        if handle.flags & HEADERS_LOCKED != 0 && password.is_none() {
            return Ok(Listed { items: Vec::new(), solid: true, hidden: true });
        }
        let mut items = Vec::new();
        while let Some(header) = next(&handle, password)? {
            items.extend(item_of(&header));
            let code = unsafe { native::RARProcessFileW(handle.raw, native::RAR_SKIP, std::ptr::null(), std::ptr::null()) };
            if code != native::ERAR_SUCCESS {
                return Err(reason(code, password));
            }
        }
        Ok(Listed { items, solid: handle.flags & SOLID != 0, hidden: false })
    }

    /// The file UnRAR stands on, read once into whatever the caller pours it.
    struct RarBody<'h> {
        handle: &'h mut Handle,
        password: Option<&'h str>,
        poured: bool,
    }

    impl Body for RarBody<'_> {
        fn pour(&mut self, to: &mut dyn Write) -> io::Result<u64> {
            if std::mem::replace(&mut self.poured, true) {
                return Err(io::Error::other("This file was read already"));
            }
            struct Counted<'w>(&'w mut dyn Write, u64);
            impl Write for Counted<'_> {
                fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                    let count = self.0.write(bytes)?;
                    self.1 += count as u64;
                    Ok(count)
                }
                fn flush(&mut self) -> io::Result<()> {
                    self.0.flush()
                }
            }
            let mut counted = Counted(to, 0);
            let sink: *mut (dyn Write + '_) = &mut counted;
            // The sink lives only while UnRAR runs here, and the callback drops it before this ends.
            self.handle.state.sink = Some(unsafe { std::mem::transmute::<*mut (dyn Write + '_), *mut dyn Write>(sink) });
            let code = unsafe { native::RARProcessFileW(self.handle.raw, native::RAR_TEST, std::ptr::null(), std::ptr::null()) };
            self.handle.state.sink = None;
            if let Some(error) = self.handle.state.failed.take() {
                return Err(error);
            }
            match code {
                native::ERAR_SUCCESS => Ok(counted.1),
                native::ERAR_BAD_PASSWORD | native::ERAR_MISSING_PASSWORD => Err(io::Error::new(io::ErrorKind::InvalidData, reason(code, self.password))),
                native::ERAR_BAD_DATA => Err(io::Error::new(io::ErrorKind::InvalidData, "This file is damaged in the archive")),
                _ => Err(io::Error::other(reason(code, self.password))),
            }
        }
    }

    pub fn walk<E: From<String>>(
        path: &Path,
        password: Option<&str>,
        want: &dyn Fn(&Item) -> bool,
        each: &mut dyn FnMut(&Item, &mut dyn Body) -> Result<bool, E>,
    ) -> Result<(), E> {
        let mut handle = open(path, password, native::RAR_OM_EXTRACT).map_err(E::from)?;
        if handle.flags & HEADERS_LOCKED != 0 && password.is_none() {
            return Err(E::from(NEEDS_PASSWORD.into()));
        }
        while let Some(header) = next(&handle, password).map_err(E::from)? {
            let mut go_on = true;
            let mut poured = false;
            if let Some(item) = item_of(&header).filter(|item| want(item)) {
                let mut body = RarBody { handle: &mut handle, password, poured: false };
                go_on = each(&item, &mut body)?;
                poured = body.poured;
            }
            if !go_on {
                break;
            }
            if !poured {
                let code = unsafe { native::RARProcessFileW(handle.raw, native::RAR_SKIP, std::ptr::null(), std::ptr::null()) };
                if code != native::ERAR_SUCCESS {
                    return Err(E::from(reason(code, password)));
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    struct Fixture(PathBuf);

    impl Fixture {
        fn new(name: &str) -> Self {
            let folder = std::env::temp_dir().join(format!("perli-packs-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&folder);
            fs::create_dir_all(&folder).unwrap();
            Self(folder)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    const FILES: [(&str, &str); 3] = [("top.txt", "top"), ("docs/a.txt", "alpha"), ("docs/deeper/b.txt", "beta!")];

    pub(crate) fn tar_bytes() -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        for (name, text) in FILES {
            let mut header = tar::Header::new_gnu();
            header.set_size(text.len() as u64);
            header.set_mode(0o644);
            header.set_mtime(1_700_000_000);
            header.set_cksum();
            builder.append_data(&mut header, name, text.as_bytes()).unwrap();
        }
        builder.into_inner().unwrap()
    }

    /// A 7z of `FILES`. A password locks the files, and with `hide` their names too.
    pub(crate) fn seven(path: &Path, password: Option<&str>, solid: bool, hide: bool) {
        use sevenz_rust2::{encoder_options, ArchiveEntry, ArchiveWriter};
        let mut writer = ArchiveWriter::create(path).unwrap();
        if let Some(password) = password {
            writer.set_content_methods(vec![encoder_options::AesEncoderOptions::new(password.into()).into(), encoder_options::Lzma2Options::from_level(1).into()]);
            writer.set_encrypt_header(hide);
        }
        if solid {
            let entries = FILES.iter().map(|(name, _)| ArchiveEntry::new_file(name)).collect();
            let readers = FILES.iter().map(|(_, text)| sevenz_rust2::SourceReader::new(text.as_bytes())).collect();
            writer.push_archive_entries(entries, readers).unwrap();
        } else {
            for (name, text) in FILES {
                writer.push_archive_entry(ArchiveEntry::new_file(name), Some(text.as_bytes())).unwrap();
            }
        }
        writer.finish().unwrap();
    }

    fn sorted_names(listed: &Listed) -> Vec<String> {
        let mut names: Vec<String> = listed.items.iter().filter(|item| !item.folder).map(|item| item.name.clone()).collect();
        names.sort();
        names
    }

    #[test]
    fn names_say_the_kind_and_parts_lead_to_the_first() {
        let kind = |name: &str| kind_of(OsStr::new(name));
        assert_eq!(kind("a.7z"), Some(Kind::SevenZ));
        assert_eq!(kind("a.CB7"), Some(Kind::SevenZ));
        assert_eq!(kind("a.7z.002"), Some(Kind::SevenZ));
        assert_eq!(kind("a.part2.rar"), Some(Kind::Rar));
        assert_eq!(kind("a.cbr"), Some(Kind::Rar));
        assert_eq!(kind("a.tgz"), Some(Kind::Tar(Squeeze::Gzip)));
        assert_eq!(kind("a.tar.zst"), Some(Kind::Tar(Squeeze::Zstd)));
        assert_eq!(kind("a.cab"), Some(Kind::Cab));
        assert_eq!(kind("a.zip"), None);
        assert_eq!(kind("a.gz"), None);

        let fixture = Fixture::new("parts");
        for name in ["set.part01.rar", "set.part02.rar", "split.7z.001", "split.7z.002"] {
            fs::write(fixture.0.join(name), b"").unwrap();
        }
        assert_eq!(first_part(&fixture.0.join("set.part02.rar")), fixture.0.join("set.part01.rar"));
        assert_eq!(first_part(&fixture.0.join("split.7z.002")), fixture.0.join("split.7z.001"));
        // A part whose first is missing reads from itself.
        assert_eq!(first_part(&fixture.0.join("lone.part3.rar")), fixture.0.join("lone.part3.rar"));
        assert_eq!(["Pics.TAR.GZ", "set.part02.rar", "split.7z.001", "a.b.cab", "odd.ünï.7z"].map(stem), ["Pics", "set", "split", "a.b", "odd.ünï"]);
    }

    #[test]
    fn tars_list_and_read_in_every_squeeze() {
        let fixture = Fixture::new("tars");
        let plain = tar_bytes();
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        gz.write_all(&plain).unwrap();
        let mut bz = bzip2::write::BzEncoder::new(Vec::new(), bzip2::Compression::fast());
        bz.write_all(&plain).unwrap();
        let mut xz = lzma_rust2::XzWriter::new(Vec::new(), lzma_rust2::XzOptions::with_preset(1)).unwrap();
        xz.write_all(&plain).unwrap();
        // Two frames, as a writer that squeezes in parts makes.
        let half = plain.len() / 2;
        let mut zst = ruzstd::encoding::compress_to_vec(&plain[..half], ruzstd::encoding::CompressionLevel::Fastest);
        zst.extend(ruzstd::encoding::compress_to_vec(&plain[half..], ruzstd::encoding::CompressionLevel::Fastest));
        let files = [("a.tar", plain.clone()), ("a.tar.gz", gz.finish().unwrap()), ("a.tbz2", bz.finish().unwrap()), ("a.txz", xz.finish().unwrap()), ("a.tar.zst", zst)];
        for (name, bytes) in files {
            let path = fixture.0.join(name);
            fs::write(&path, bytes).unwrap();
            let listed = list(&path, None).unwrap();
            assert_eq!(sorted_names(&listed), ["docs/a.txt", "docs/deeper/b.txt", "top.txt"], "{name}");
            assert!(listed.items.iter().all(|item| item.ticks == unix_ticks(1_700_000_000) && item.packed > 0));
            assert_eq!(read(&path, "docs/deeper/b.txt", 1024, true, None).unwrap(), b"beta!", "{name}");
        }
    }

    #[test]
    fn sevens_read_plain_split_solid_and_locked() {
        let fixture = Fixture::new("sevens");
        let plain = fixture.0.join("plain.7z");
        seven(&plain, None, false, false);
        assert_eq!(sorted_names(&list(&plain, None).unwrap()), ["docs/a.txt", "docs/deeper/b.txt", "top.txt"]);
        assert_eq!(read(&plain, "docs/a.txt", 1024, true, None).unwrap(), b"alpha");
        // A file too big to show is refused, and the start of one is kept.
        assert!(read(&plain, "docs/deeper/b.txt", 2, true, None).unwrap_err().ends_with(TOO_BIG));
        assert_eq!(read(&plain, "docs/deeper/b.txt", 2, false, None).unwrap(), b"be");

        let solid = fixture.0.join("solid.7z");
        seven(&solid, None, true, false);
        assert!(list(&solid, None).unwrap().solid);
        let mut seen = Vec::new();
        walk(&solid, None, |item| item.name != "top.txt", |item, body| {
            let mut bytes = Vec::new();
            body.pour(&mut bytes).unwrap();
            seen.push((item.name.clone(), String::from_utf8(bytes).unwrap()));
            Ok::<_, String>(true)
        })
        .unwrap();
        seen.sort();
        assert_eq!(seen, [("docs/a.txt".into(), "alpha".into()), ("docs/deeper/b.txt".into(), "beta!".into())]);

        // The same archive split in two parts reads from either part.
        let bytes = fs::read(&plain).unwrap();
        let (first, second) = bytes.split_at(bytes.len() / 2);
        fs::write(fixture.0.join("split.7z.001"), first).unwrap();
        fs::write(fixture.0.join("split.7z.002"), second).unwrap();
        assert_eq!(read(&fixture.0.join("split.7z.002"), "top.txt", 1024, true, None).unwrap(), b"top");

        let locked = fixture.0.join("locked.7z");
        seven(&locked, Some("sesame"), false, false);
        let listed = list(&locked, None).unwrap();
        assert_eq!(listed.items.len(), 3);
        assert!(listed.items.iter().all(|item| item.locked) && !listed.hidden);
        assert_eq!(check_password(&locked, "wrong"), Err(WRONG_PASSWORD.into()));
        assert_eq!(check_password(&locked, "sesame"), Ok(()));
        assert_eq!(read(&locked, "top.txt", 1024, true, Some("sesame")).unwrap(), b"top");
        let tested = test(&locked, None).unwrap();
        assert_eq!((tested.sound, tested.locked), (0, 3));
        assert_eq!(test(&locked, Some("sesame")).unwrap().sound, 3);

        // Locked names show nothing until the password comes.
        let hidden = fixture.0.join("hidden.7z");
        seven(&hidden, Some("sesame"), false, true);
        let listed = list(&hidden, None).unwrap();
        assert!(listed.hidden && listed.items.is_empty() && listed.locked());
        assert_eq!(check_password(&hidden, "wrong"), Err(WRONG_PASSWORD.into()));
        assert_eq!(check_password(&hidden, "sesame"), Ok(()));
        assert_eq!(sorted_names(&list(&hidden, Some("sesame")).unwrap()).len(), 3);
        assert_eq!(test(&hidden, None), Err(NEEDS_PASSWORD.into()));
    }

    #[test]
    fn cabs_list_and_read() {
        let fixture = Fixture::new("cabs");
        let path = fixture.0.join("a.cab");
        let mut builder = cab::CabinetBuilder::new();
        {
            let folder = builder.add_folder(cab::CompressionType::MsZip);
            for (name, _) in FILES {
                folder.add_file(name.replace('/', "\\"));
            }
        }
        let mut writer = builder.build(File::create(&path).unwrap()).unwrap();
        let mut texts = FILES.iter();
        while let Some(mut file) = writer.next_file().unwrap() {
            file.write_all(texts.next().unwrap().1.as_bytes()).unwrap();
        }
        writer.finish().unwrap();

        assert_eq!(sorted_names(&list(&path, None).unwrap()), ["docs/a.txt", "docs/deeper/b.txt", "top.txt"]);
        assert_eq!(read(&path, "docs/a.txt", 1024, true, None).unwrap(), b"alpha");
    }

    /// A RAR 5 archive of stored files, built by the format's public description, as RAR files
    /// can only be made with WinRAR. A name ending in `/` is a folder.
    fn rar5(files: &[(&str, &[u8])]) -> Vec<u8> {
        fn vint(mut value: u64, into: &mut Vec<u8>) {
            loop {
                let low = (value & 0x7f) as u8;
                value >>= 7;
                into.push(if value == 0 { low } else { low | 0x80 });
                if value == 0 {
                    return;
                }
            }
        }
        fn block(fields: &[u8], into: &mut Vec<u8>) {
            let mut sized = Vec::new();
            vint(fields.len() as u64, &mut sized);
            sized.extend_from_slice(fields);
            let mut crc = flate2::Crc::new();
            crc.update(&sized);
            into.extend_from_slice(&crc.sum().to_le_bytes());
            into.extend_from_slice(&sized);
        }
        let mut out = b"Rar!\x1a\x07\x01\x00".to_vec();
        // Main header: type 1, no flags, no archive flags.
        block(&[1, 0, 0], &mut out);
        for (name, data) in files {
            let folder = name.ends_with('/');
            let mut fields = Vec::new();
            vint(2, &mut fields);
            vint(if folder { 0 } else { 0x0002 }, &mut fields);
            if !folder {
                vint(data.len() as u64, &mut fields);
            }
            // Time and CRC32 present, or a folder.
            vint(if folder { 0x0003 } else { 0x0006 }, &mut fields);
            vint(data.len() as u64, &mut fields);
            vint(0x20, &mut fields);
            fields.extend_from_slice(&1_700_000_000u32.to_le_bytes());
            if !folder {
                let mut crc = flate2::Crc::new();
                crc.update(data);
                fields.extend_from_slice(&crc.sum().to_le_bytes());
            }
            // Stored, by Windows.
            vint(0, &mut fields);
            vint(0, &mut fields);
            let name = name.trim_end_matches('/');
            vint(name.len() as u64, &mut fields);
            fields.extend_from_slice(name.as_bytes());
            block(&fields, &mut out);
            out.extend_from_slice(data);
        }
        // End of archive.
        block(&[5, 0, 0], &mut out);
        out
    }

    #[test]
    fn rars_list_read_and_walk() {
        let fixture = Fixture::new("rars");
        let path = fixture.0.join("a.rar");
        let mut files: Vec<(&str, &[u8])> = FILES.iter().map(|(name, text)| (*name, text.as_bytes())).collect();
        files.insert(1, ("docs/", b""));
        fs::write(&path, rar5(&files)).unwrap();

        let listed = list(&path, None).unwrap();
        assert_eq!(sorted_names(&listed), ["docs/a.txt", "docs/deeper/b.txt", "top.txt"]);
        assert!(listed.items.iter().any(|item| item.folder && item.name == "docs"));
        assert!(!listed.solid && !listed.locked());
        let top = listed.items.iter().find(|item| item.name == "top.txt").unwrap();
        assert_eq!((top.size, top.packed, top.ticks), (3, 3, unix_ticks(1_700_000_000)));
        assert_eq!(read(&path, "docs/deeper/b.txt", 1024, true, None).unwrap(), b"beta!");
        assert_eq!(test(&path, None).unwrap().sound, 3);

        // A walk that stops leaves the rest unread, and one that skips a file reads the next.
        let mut seen = Vec::new();
        walk(&path, None, |item| !item.folder && item.name != "docs/a.txt", |item, body| {
            let mut bytes = Vec::new();
            body.pour(&mut bytes).unwrap();
            seen.push(String::from_utf8(bytes).unwrap());
            Ok::<_, String>(item.name != "top.txt")
        })
        .unwrap();
        assert_eq!(seen, ["top"]);
    }
}
