//! Archives, made as ZIPs and taken apart in every kind `packs` reads, and landing files that
//! come from inside something rather than from a path. A landed file is written beside its target and renamed when whole, like a copy, so the same
//! conflict answers apply and a damaged entry leaves nothing behind.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{self, BufReader, BufWriter, Read, Seek, Write};
use std::path::{Component, Path, PathBuf};

use windows::core::{Error, Result};
use windows::Win32::Foundation::{E_FAIL, SYSTEMTIME};
use zip::result::ZipError;
use zip::unstable::write::FileOptionsExt;
use zip::write::{FileOptions, SimpleFileOptions};
use zip::{CompressionMethod, DateTime, ZipArchive, ZipWriter};

use crate::packs;

use super::sys::{self, Stat};
use super::transfer::{file_name, Plan};
use super::tree::Node;
use super::{names, ArchiveFormat, Done, Flow, Run, Stopped, ZipLevel};

const CHUNK: usize = 256 * 1024;
const NO_PASSWORDS: &str = "This file is protected by a password. Preview the archive to unlock it and take it out.";
const UNSAFE_NAME: &str = "This name in the archive isn't safe to use, so Perli left it out.";

type Writer<'a> = ZipWriter<BufWriter<&'a mut File>>;
/// What each file is written with. `'k` is the password's.
type Options<'k> = FileOptions<'k, 'static, ()>;

impl ZipLevel {
    fn options<'k>(self) -> Options<'k> {
        let deflated = Options::default().compression_method(CompressionMethod::Deflated);
        match self {
            Self::Store => Options::default().compression_method(CompressionMethod::Stored),
            Self::Fast => deflated.compression_level(Some(1)),
            Self::Normal => deflated,
            Self::Best => deflated.compression_level(Some(9)),
        }
    }
}

fn failed(error: impl ToString) -> Error {
    Error::new(E_FAIL, error.to_string())
}

/// An error of Windows' own keeps its code, as code that asks who holds a file looks at that.
fn from_io(error: io::Error) -> Error {
    if error.raw_os_error().is_some() {
        error.into()
    } else {
        failed(error)
    }
}

fn from_zip(error: ZipError) -> Error {
    match error {
        ZipError::Io(error) => from_io(error),
        other => failed(other),
    }
}

fn reading(path: &Path) -> io::Result<File> {
    File::open(PathBuf::from(sys::extended(path).to_os_string()))
}

fn open_archive(path: &Path) -> Result<ZipArchive<BufReader<File>>> {
    let file = reading(path).map_err(from_io)?;
    ZipArchive::new(BufReader::new(file)).map_err(from_zip)
}

/// The name for an archive of `nodes`, without its extension.
fn archive_stem(nodes: &[Node], folder: &Path) -> String {
    let name = match nodes {
        [one] if one.stat.is_dir() => one.path.file_name(),
        [one] => one.path.file_stem(),
        _ => folder.file_name(),
    };
    name.map_or_else(|| "Archive".to_string(), |name| name.to_string_lossy().into_owned())
}

fn name_of(node: &Node) -> String {
    file_name(&node.path).to_string_lossy().into_owned()
}

/// A file's time as ZIP stores it, in the local clock. ZIP has no dates before 1980.
fn zip_time(ticks: u64) -> Option<DateTime> {
    let time = sys::local_time(ticks)?;
    let part = |value: u16| value as u8;
    DateTime::from_date_and_time(
        time.wYear,
        part(time.wMonth),
        part(time.wDay),
        part(time.wHour),
        part(time.wMinute),
        part(time.wSecond),
    )
    .ok()
}

pub fn ticks_of(time: DateTime) -> u64 {
    sys::local_ticks(&SYSTEMTIME {
        wYear: time.year(),
        wMonth: time.month().into(),
        wDay: time.day().into(),
        wHour: time.hour().into(),
        wMinute: time.minute().into(),
        wSecond: time.second().into(),
        ..Default::default()
    })
    .unwrap_or(0)
}

/// `relative` if every part of it is a plain name Windows would accept.
pub fn safe(relative: PathBuf) -> Option<PathBuf> {
    let plain = |part: Component<'_>| match part {
        Component::Normal(name) => name.to_str().is_some_and(|name| names::check(name).is_ok()),
        _ => false,
    };
    relative.components().all(plain).then_some(relative)
}

/// Where incoming items land, and what is known about the folders on the way there.
pub(super) struct Landing {
    pub root: PathBuf,
    /// The file a landing comes out of, which it must not overwrite.
    pub source: Option<PathBuf>,
    /// Goes on every landed file, so that a warning about downloads travels with them.
    pub zone: Option<Vec<u8>>,
    /// Folders seen so far, true for those this job made. Those make their contents new.
    folders: HashMap<String, bool>,
}

impl Landing {
    pub fn new(root: PathBuf, source: Option<PathBuf>, zone: Option<Vec<u8>>) -> Self {
        Self {
            root,
            source,
            zone,
            folders: HashMap::new(),
        }
    }

    /// `root` itself is new, and undoing its making takes everything in it along.
    fn in_new_root(mut self) -> Self {
        self.folders.insert(key(&self.root), true);
        self
    }
}

fn key(path: &Path) -> String {
    path.to_string_lossy().to_lowercase()
}

impl ArchiveFormat {
    fn extension(self) -> &'static str {
        match self {
            Self::Zip => ".zip",
            Self::SevenZ => ".7z",
            Self::Tar => ".tar",
            Self::TarGz => ".tar.gz",
        }
    }
}

/// A file being read that counts what comes out, for the job's progress. A cancel fails it.
struct Counting<'r, 'a, R> {
    run: &'r mut Run<'a>,
    from: R,
    base: u64,
    read: u64,
}

impl<R: Read> Read for Counting<'_, '_, R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let count = self.from.read(buffer)?;
        self.read += count as u64;
        if !self.run.copied(self.base + self.read) {
            return Err(io::ErrorKind::Interrupted.into());
        }
        Ok(count)
    }
}

fn interrupted(_: Stopped) -> io::Error {
    io::ErrorKind::Interrupted.into()
}

/// FILETIME ticks as the seconds since 1970 a TAR keeps.
fn unix_seconds(ticks: u64) -> u64 {
    ticks.saturating_sub(116_444_736_000_000_000) / 10_000_000
}

impl Run<'_> {
    /// A ZIP's password locks each file with ZipCrypto, which every unzip tool and Windows itself
    /// opens, or with `aes` AES-256, which Windows can't. A 7z's locks its files and their names
    /// with AES-256. A TAR has no lock.
    pub(super) fn zip(&mut self, sources: Vec<PathBuf>, level: ZipLevel, password: Option<&str>, format: ArchiveFormat, aes: bool) -> Flow {
        let password = password.filter(|password| !password.is_empty());
        let plain = level.options();
        let files = match password {
            Some(password) if aes => plain.with_aes_encryption(zip::AesMode::Aes256, password),
            Some(password) => plain.with_deprecated_encryption(password.as_bytes()).unwrap_or(plain),
            None => plain,
        };
        let nodes = self.scan_all(&sources)?;
        let Some(first) = nodes.first() else {
            return Ok(());
        };
        let folder = sys::parent(&first.path);
        let stem = archive_stem(&nodes, &folder);
        let spot = folder.join(&stem);
        let temp = self.temp_beside(&spot);
        let (items, bytes) = (self.progress.items, self.progress.bytes);
        let written = self.attempt(&spot, None, |run| {
            (run.progress.items, run.progress.bytes) = (items, bytes);
            sys::fill_new(&temp, |file| match format {
                ArchiveFormat::Zip => run.write_archive(file, &nodes, files),
                ArchiveFormat::SevenZ => run.write_seven(file, &nodes, level, password),
                ArchiveFormat::Tar => run.write_tar(BufWriter::with_capacity(CHUNK, file), &nodes)?.flush(),
                ArchiveFormat::TarGz => {
                    let squeeze = match level {
                        ZipLevel::Store => flate2::Compression::none(),
                        ZipLevel::Fast => flate2::Compression::fast(),
                        ZipLevel::Normal => flate2::Compression::default(),
                        ZipLevel::Best => flate2::Compression::best(),
                    };
                    let gzip = flate2::write::GzEncoder::new(BufWriter::with_capacity(CHUNK, file), squeeze);
                    run.write_tar(gzip, &nodes)?.finish()?.flush()
                }
            })
        })?;
        if written.is_none() {
            return Ok(());
        }
        // Only now, as a long job gives another one time to take the name.
        let target = names::free(&folder, &stem, format.extension());
        let swapped = self.swap_in(&temp, &target, false);
        if !matches!(swapped, Ok(true)) {
            let _ = sys::delete_file(&temp);
        }
        if swapped? {
            self.done.push(Done::Created { path: target });
        }
        Ok(())
    }

    /// The items of a new archive's top with their names. One whose name another already has is
    /// left out, as search rows come from many folders and an archive's top level is one.
    fn tops_of<'n>(&mut self, nodes: &'n [Node]) -> Flow<Vec<(&'n Node, String)>> {
        let mut used = HashSet::new();
        let mut tops = Vec::new();
        for node in nodes {
            let name = name_of(node);
            if used.insert(name.to_lowercase()) {
                tops.push((node, name));
            } else {
                self.refuse(&node.path, "Another item in this archive has the same name.")?;
                self.step(node.items - 1, node.bytes);
            }
        }
        Ok(tops)
    }

    /// Opens a file to go in a new archive. `None` if the user gives up on it, which is counted
    /// as done.
    fn source(&mut self, node: &Node) -> io::Result<Option<File>> {
        let opened = self.attempt(&node.path, None, |_| reading(&node.path).map_err(from_io)).map_err(interrupted)?;
        if opened.is_none() {
            self.progress.bytes += node.bytes;
            self.step(1, 0);
        }
        Ok(opened)
    }

    /// A 7z of `nodes`, each file packed on its own, so one can be read without the others.
    // ponytail: a file that fails partway gives up the whole archive, where a ZIP leaves that
    // file out; 7z's writer can't take back what it wrote.
    fn write_seven(&mut self, file: &mut File, nodes: &[Node], level: ZipLevel, password: Option<&str>) -> io::Result<()> {
        use sevenz_rust2::encoder_options::{AesEncoderOptions, Lzma2Options};
        use sevenz_rust2::{ArchiveWriter, EncoderMethod};
        let mut seven = ArchiveWriter::new(BufWriter::with_capacity(CHUNK, &mut *file)).map_err(io::Error::other)?;
        let squeeze = match level {
            ZipLevel::Store => EncoderMethod::COPY.into(),
            ZipLevel::Fast => Lzma2Options::from_level(1).into(),
            ZipLevel::Normal => Lzma2Options::from_level(6).into(),
            ZipLevel::Best => Lzma2Options::from_level(9).into(),
        };
        let mut methods = vec![squeeze];
        if let Some(password) = password {
            methods.insert(0, AesEncoderOptions::new(password.into()).into());
        }
        seven.set_content_methods(methods);
        seven.set_encrypt_header(password.is_some());
        for (node, name) in self.tops_of(nodes).map_err(interrupted)? {
            self.add_seven(&mut seven, node, name)?;
        }
        seven.finish()?.flush()
    }

    fn add_seven(&mut self, seven: &mut sevenz_rust2::ArchiveWriter<BufWriter<&mut File>>, node: &Node, name: String) -> io::Result<()> {
        use sevenz_rust2::ArchiveEntry;
        self.check().map_err(interrupted)?;
        if node.stat.is_link() {
            self.step(1, 0);
            return Ok(());
        }
        let mut entry = if node.children.is_some() { ArchiveEntry::new_directory(&name) } else { ArchiveEntry::new_file(&name) };
        entry.last_modified_date = node.stat.modified.into();
        entry.has_last_modified_date = node.stat.modified > 0;
        self.progress.current = node.path.to_string_lossy().into_owned();
        let Some(children) = &node.children else {
            let Some(source) = self.source(node)? else { return Ok(()) };
            let base = self.progress.bytes;
            let counted = BufReader::with_capacity(CHUNK, Counting { run: self, from: source, base, read: 0 });
            seven.push_archive_entry(entry, Some(counted)).map_err(io::Error::other)?;
            self.progress.bytes = base + node.bytes;
            self.step(1, 0);
            return Ok(());
        };
        seven.push_archive_entry::<File>(entry, None).map_err(io::Error::other)?;
        self.step(1, 0);
        for child in children {
            self.add_seven(seven, child, format!("{name}/{}", name_of(child)))?;
        }
        Ok(())
    }

    /// A TAR of `nodes` written to `to`, which comes back to be finished.
    fn write_tar<W: Write>(&mut self, to: W, nodes: &[Node]) -> io::Result<W> {
        let mut tar = tar::Builder::new(to);
        for (node, name) in self.tops_of(nodes).map_err(interrupted)? {
            self.add_tar(&mut tar, node, name)?;
        }
        tar.into_inner()
    }

    fn add_tar<W: Write>(&mut self, tar: &mut tar::Builder<W>, node: &Node, name: String) -> io::Result<()> {
        self.check().map_err(interrupted)?;
        if node.stat.is_link() {
            self.step(1, 0);
            return Ok(());
        }
        let mut header = tar::Header::new_gnu();
        header.set_mtime(unix_seconds(node.stat.modified));
        self.progress.current = node.path.to_string_lossy().into_owned();
        let Some(children) = &node.children else {
            let Some(source) = self.source(node)? else { return Ok(()) };
            header.set_size(node.stat.size);
            header.set_mode(0o644);
            let base = self.progress.bytes;
            // A file that grew since it was measured goes in at the size its header says.
            let counted = BufReader::with_capacity(CHUNK, Counting { run: self, from: source, base, read: 0 }).take(node.stat.size);
            tar.append_data(&mut header, &name, counted)?;
            self.progress.bytes = base + node.bytes;
            self.step(1, 0);
            return Ok(());
        };
        header.set_entry_type(tar::EntryType::Directory);
        header.set_size(0);
        header.set_mode(0o755);
        tar.append_data(&mut header, format!("{name}/"), io::empty())?;
        self.step(1, 0);
        for child in children {
            self.add_tar(tar, child, format!("{name}/{}", name_of(child)))?;
        }
        Ok(())
    }

    fn write_archive(&mut self, file: &mut File, nodes: &[Node], files: Options<'_>) -> io::Result<()> {
        let mut zip = ZipWriter::new(BufWriter::new(&mut *file));
        for (node, name) in self.tops_of(nodes).map_err(interrupted)? {
            self.add_node(&mut zip, node, &name, files).map_err(interrupted)?;
        }
        let file = zip.finish().map_err(io::Error::other)?.into_inner().map_err(io::IntoInnerError::into_error)?;
        // A file given up on rewinds the archive, which can leave old bytes past its new end.
        let end = file.stream_position()?;
        file.set_len(end)
    }

    fn add_node(&mut self, zip: &mut Writer<'_>, node: &Node, name: &str, files: Options<'_>) -> Flow {
        let time = zip_time(node.stat.modified).unwrap_or_default();
        // A folder holds no data, so it needs no squeezing and no lock.
        let options = SimpleFileOptions::default().last_modified_time(time);
        if node.stat.is_link() {
            // ponytail: links stay out, as what they lead to is not part of what was picked.
            self.step(1, 0);
            return Ok(());
        }
        let Some(children) = &node.children else {
            let options = files.last_modified_time(time).large_file(node.stat.size >= u64::from(u32::MAX));
            return self.add_file(zip, node, name, options);
        };
        self.attempt(&node.path, None, |_| zip.add_directory(name, options).map_err(from_zip))?;
        self.step(1, 0);
        for child in children {
            self.add_node(zip, child, &format!("{name}/{}", name_of(child)), files)?;
        }
        Ok(())
    }

    fn add_file(&mut self, zip: &mut Writer<'_>, node: &Node, name: &str, options: Options<'_>) -> Flow {
        let base = self.progress.bytes;
        self.attempt(&node.path, None, |run| {
            let mut source = reading(&node.path).map_err(from_io)?;
            zip.start_file(name, options).map_err(from_zip)?;
            let poured = run.pour(&mut source, zip, base);
            if poured.is_err() {
                let _ = zip.abort_file();
            }
            poured.map_err(from_io)
        })?;
        self.progress.bytes = base + node.bytes;
        self.step(1, 0);
        Ok(())
    }

    /// Copies everything from `from` to `to`. A cancel fails it.
    pub(super) fn pour(&mut self, from: &mut impl Read, to: &mut impl Write, base: u64) -> io::Result<()> {
        let mut buffer = vec![0; CHUNK];
        let mut poured = 0;
        loop {
            let count = from.read(&mut buffer)?;
            if count == 0 {
                return Ok(());
            }
            to.write_all(&buffer[..count])?;
            poured += count as u64;
            if !self.copied(base + poured) {
                return Err(io::ErrorKind::Interrupted.into());
            }
        }
    }

    /// With `only`, just those entries come out, each as if its own folder were the top.
    /// One inside a folder also picked comes out with that folder, not again on its own.
    pub(super) fn unzip(&mut self, archives: Vec<PathBuf>, own_folder: bool, smart: bool, only: &[String], password: Option<&str>, into: Option<&Path>) -> Flow {
        self.add_total(archives.len() as u64, 0);
        for archive in archives {
            if only.is_empty() {
                self.unzip_one(&archive, own_folder, smart, None, password, into)?;
            }
            for name in outermost(only) {
                self.unzip_one(&archive, own_folder, false, Some(name), password, into)?;
            }
            self.step(1, 0);
        }
        Ok(())
    }

    /// Where an archive's files land: beside it or in `into`, and with `own_folder` in a new
    /// folder named for it. `None` if that folder can't be made.
    fn landing_for(&mut self, archive: &Path, own_folder: bool, into: Option<&Path>) -> Flow<Option<Landing>> {
        let folder = into.map_or_else(|| sys::parent(archive), Path::to_path_buf);
        let landing = Landing::new(folder.clone(), Some(archive.to_path_buf()), sys::read_zone(archive));
        if !own_folder {
            return Ok(Some(landing));
        }
        let name = file_name(archive).to_string_lossy().into_owned();
        let stem = match packs::kind_of(archive.as_os_str()) {
            Some(_) => packs::stem(&name).into(),
            None => archive.file_stem().unwrap_or(archive.as_os_str()).to_os_string(),
        };
        let root = names::keep_both(&folder, &stem, true);
        if self.attempt(archive, None, |_| sys::create_dir(&root))?.is_none() {
            return Ok(None);
        }
        self.done.push(Done::Created { path: root.clone() });
        Ok(Some(Landing { root, ..landing }.in_new_root()))
    }

    fn unzip_one(&mut self, archive: &Path, own_folder: bool, smart: bool, only: Option<&str>, password: Option<&str>, into: Option<&Path>) -> Flow {
        if packs::kind_of(archive.as_os_str()).is_some() {
            return self.unpack_one(archive, own_folder, smart, only, password, into);
        }
        let Some(mut zip) = self.attempt(archive, None, |_| open_archive(archive))? else {
            return Ok(());
        };
        let own_folder = own_folder || (smart && tops(zip.file_names().flatten()) > 1);
        let Some(mut landing) = self.landing_for(archive, own_folder, into)? else {
            return Ok(());
        };

        // One entry lands as if its own folder were the top of the archive.
        let only = only.map(|name| name.trim_end_matches(['/', '\\']));
        // How many folders sit above the entry, whatever their case.
        let above = only.map_or(0, |name| parts(name).count().saturating_sub(1));
        let wanted: Vec<usize> = (0..zip.len()).filter(|&index| only.is_none_or(|name| is_under(&zip, index, name))).collect();
        let sizes = wanted.iter().filter_map(|&index| zip.by_index_data(index).ok().map(|entry| entry.size()));
        let bytes = sizes.sum();
        self.add_total(wanted.len() as u64, bytes);
        for index in wanted {
            self.check()?;
            let facts = zip.by_index_data(index).map(|entry| {
                let relative = entry.enclosed_name().and_then(safe).map(|path| path.components().skip(above).collect::<PathBuf>());
                let time = entry.last_modified().map_or(0, ticks_of);
                (relative, entry.is_dir(), entry.encrypted(), Stat::of_file(entry.size(), time))
            });
            let (relative, is_dir, encrypted, stat) = match facts {
                Ok(facts) => facts,
                Err(error) => {
                    self.refuse(archive, &error.to_string())?;
                    continue;
                }
            };
            let Some(relative) = relative else {
                self.refuse(&archive.join(entry_name(&zip, index)), UNSAFE_NAME)?;
                self.progress.bytes += stat.size;
                continue;
            };
            if encrypted && password.is_none() {
                self.refuse(&landing.root.join(&relative), NO_PASSWORDS)?;
                self.progress.bytes += stat.size;
            } else if is_dir {
                self.land_folder(&mut landing, &relative)?;
                self.step(1, 0);
            } else {
                self.land_file(&mut landing, &relative, stat, |run, file, base| {
                    let mut entry = crate::inside::data(&mut zip, index, password.filter(|_| encrypted)).map_err(io::Error::other)?;
                    run.pour(&mut entry, file, base)
                })?;
            }
        }
        Ok(())
    }

    /// `unzip_one` for the kinds `packs` reads. Folders, locked files and names that can't land
    /// are settled first, and then one walk reads all the files, as solid archives need.
    fn unpack_one(&mut self, archive: &Path, own_folder: bool, smart: bool, only: Option<&str>, password: Option<&str>, into: Option<&Path>) -> Flow {
        let Some(listed) = self.attempt(archive, None, |_| packs::list(archive, password).map_err(failed))? else {
            return Ok(());
        };
        if listed.hidden {
            return self.refuse(archive, NO_PASSWORDS);
        }
        let own_folder = own_folder || (smart && tops(listed.items.iter().map(|item| item.name.as_str())) > 1);
        let Some(mut landing) = self.landing_for(archive, own_folder, into)? else {
            return Ok(());
        };
        let only = only.map(|name| name.trim_end_matches(['/', '\\']));
        let above = only.map_or(0, |name| parts(name).count().saturating_sub(1));
        let wanted: Vec<&packs::Item> = listed.items.iter().filter(|item| only.is_none_or(|name| name_under(&item.name, name))).collect();
        self.add_total(wanted.len() as u64, wanted.iter().map(|item| item.size).sum());
        let mut files = HashMap::new();
        for item in wanted {
            self.check()?;
            let relative = safe(parts(&item.name).collect()).map(|path| path.components().skip(above).collect::<PathBuf>());
            match relative {
                None => {
                    self.refuse(&archive.join(item.name.replace('/', " ")), UNSAFE_NAME)?;
                    self.progress.bytes += item.size;
                }
                Some(relative) if item.locked && !item.folder && password.is_none() => {
                    self.refuse(&landing.root.join(relative), NO_PASSWORDS)?;
                    self.progress.bytes += item.size;
                }
                Some(relative) if item.folder => {
                    self.land_folder(&mut landing, &relative)?;
                    self.step(1, 0);
                }
                Some(relative) => {
                    files.insert(item.name.as_str(), relative);
                }
            }
        }
        let mut stopped = None;
        let walked = packs::walk(archive, password, |item| !item.folder && files.contains_key(item.name.as_str()), |item, body| {
            let stat = Stat::of_file(item.size, item.ticks);
            let mut body = Some(body);
            let landed = self.land_file(&mut landing, &files[item.name.as_str()], stat, |run, file, base| {
                let mut counted = Counted { run, to: file, base, poured: 0 };
                let mut buffered = BufWriter::with_capacity(CHUNK, &mut counted);
                let poured = match body.take() {
                    Some(body) => body.pour(&mut buffered).map(drop),
                    // A try after a failure reads the file again from the archive.
                    None => packs::walk(archive, password, |again| again.name == item.name, |_, again| {
                        again.pour(&mut buffered).map(|_| false).map_err(|error| error.to_string())
                    })
                    .map_err(io::Error::other),
                };
                poured.and_then(|()| buffered.flush()).map_err(|error| io::Error::other(packs::read_error(error, item, password)))
            });
            match landed {
                Ok(()) => Ok(true),
                Err(stop) => {
                    stopped = Some(stop);
                    Ok::<_, String>(false)
                }
            }
        });
        if let Some(stop) = stopped {
            return Err(stop);
        }
        if let Err(error) = walked {
            self.refuse(archive, &error)?;
        }
        Ok(())
    }

    /// Makes the folders down to `relative`, and says whether the last of them is new. `None`
    /// means a folder can't be there.
    pub(super) fn land_folder(&mut self, landing: &mut Landing, relative: &Path) -> Flow<Option<bool>> {
        let mut folder = landing.root.clone();
        let mut fresh = landing.folders.get(&key(&folder)).copied().unwrap_or(false);
        for part in relative.components() {
            folder.push(part);
            let known = key(&folder);
            if let Some(&seen) = landing.folders.get(&known) {
                fresh = seen;
                continue;
            }
            let Some(found) = self.attempt(&folder, None, |_| sys::stat(&folder))? else {
                return Ok(None);
            };
            match found {
                Some(stat) if stat.is_folder() => fresh = false,
                // A link could carry the rest of the path somewhere outside the landing.
                Some(stat) if stat.is_link() => {
                    self.tell(&folder, "A link has the name this folder needs, so nothing goes through it.")?;
                    return Ok(None);
                }
                Some(_) => {
                    self.tell(&folder, "A file already has the name this folder needs.")?;
                    return Ok(None);
                }
                None => {
                    if self.attempt(&folder, None, |_| sys::create_dir(&folder))?.is_none() {
                        return Ok(None);
                    }
                    // The top new folder stands for all that land inside it.
                    if !fresh {
                        self.done.push(Done::Created { path: folder.clone() });
                    }
                    fresh = true;
                }
            }
            landing.folders.insert(known, fresh);
        }
        Ok(Some(fresh))
    }

    /// Writes one file under `landing`. `fill` gets a new try after each failure, along with
    /// the bytes counted so far.
    pub(super) fn land_file(
        &mut self,
        landing: &mut Landing,
        relative: &Path,
        stat: Stat,
        mut fill: impl FnMut(&mut Self, &mut File, u64) -> io::Result<()>,
    ) -> Flow {
        let base = self.progress.bytes;
        let folder = relative.parent().unwrap_or(Path::new(""));
        if let Some(fresh) = self.land_folder(landing, folder)? {
            let target = landing.root.join(relative);
            let source = landing.source.clone();
            let plan = self.resolve(source.as_deref(), stat, &target)?;
            if let Plan::Write(target) | Plan::Replace(target) = &plan {
                let replace = matches!(plan, Plan::Replace(_));
                let temp = self.temp_beside(target);
                let written = self.attempt(target, None, |run| {
                    sys::fill_new(&temp, |file| fill(run, file, base))
                })?;
                if written.is_some() {
                    // Writing the mark changes the file's time, so the mark goes first.
                    if let Some(zone) = &landing.zone {
                        let _ = sys::write_zone(&temp, zone);
                    }
                    if stat.modified != 0 {
                        let _ = sys::set_modified(&temp, stat.modified);
                    }
                    let swapped = self.swap_in(&temp, target, replace);
                    if !matches!(swapped, Ok(true)) {
                        let _ = sys::delete_file(&temp);
                    }
                    if swapped? && !fresh {
                        self.done.push(Done::Created { path: target.clone() });
                    }
                }
            }
        }
        self.progress.bytes = base + stat.size;
        self.step(1, 0);
        Ok(())
    }
}

/// What an entry calls itself, for telling the user about it. Only ever shown.
/// True if entry `index` is `name` itself or lies inside the folder `name`.
/// How many items sit at the archive's top, counting a folder once however much it holds.
fn tops<N: AsRef<str>>(names: impl Iterator<Item = N>) -> usize {
    names.filter_map(|name| parts(name.as_ref()).next().map(str::to_lowercase)).collect::<HashSet<_>>().len()
}

/// Whether the entry named `own` is `name` or inside it, in any case and with either separator.
fn name_under(own: &str, name: &str) -> bool {
    let mut own = parts(own);
    parts(name).all(|wanted| own.next().is_some_and(|part| part.to_lowercase() == wanted.to_lowercase()))
}

/// A file being written that counts what goes in, for the job's progress. A cancel fails it.
struct Counted<'r, 'a, 'f> {
    run: &'r mut Run<'a>,
    to: &'f mut File,
    base: u64,
    poured: u64,
}

impl Write for Counted<'_, '_, '_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let written = self.to.write(bytes)?;
        self.poured += written as u64;
        if !self.run.copied(self.base + self.poured) {
            return Err(io::ErrorKind::Interrupted.into());
        }
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.to.flush()
    }
}

/// Whether entry `index` is `name` or inside it. Names match in any case and with either
/// separator, the way a ZIP opened as a folder shows them.
fn is_under(zip: &ZipArchive<BufReader<File>>, index: usize, name: &str) -> bool {
    let Ok(entry) = zip.by_index_data(index) else { return false };
    entry.name().is_ok_and(|own| name_under(&own, name))
}

/// The parts of a name in an archive, between either separator.
fn parts(name: &str) -> impl Iterator<Item = &str> {
    name.split(['/', '\\']).filter(|part| !part.is_empty())
}

fn entry_name(zip: &ZipArchive<BufReader<File>>, index: usize) -> String {
    let entry = zip.by_index_data(index);
    entry.ok().and_then(|entry| entry.name().ok().map(|name| name.replace(['/', '\\'], " "))).unwrap_or_default()
}

/// The names of `only` that no other picked folder holds. Folder names end in `/`.
fn outermost(only: &[String]) -> impl Iterator<Item = &str> {
    only.iter()
        .filter(|name| !only.iter().any(|folder| folder.ends_with('/') && folder != *name && name.starts_with(folder.as_str())))
        .map(String::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pick_inside_a_picked_folder_comes_out_once() {
        let only = ["docs/", "docs/a.txt", "docs/sub/", "docs/sub/b.txt", "other.txt", "docsy.txt"].map(String::from);
        assert_eq!(outermost(&only).collect::<Vec<_>>(), ["docs/", "other.txt", "docsy.txt"]);
    }
}
