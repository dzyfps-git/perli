//! ZIP archives, and landing files that come from inside something rather than from a path.
//! A landed file is written beside its target and renamed when whole, like a copy, so the same
//! conflict answers apply and a damaged entry leaves nothing behind.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{self, BufReader, BufWriter, Read, Seek, Write};
use std::path::{Component, Path, PathBuf};

use windows::core::{Error, Result};
use windows::Win32::Foundation::{E_FAIL, SYSTEMTIME};
use zip::result::ZipError;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, DateTime, ZipArchive, ZipWriter};

use super::sys::{self, Stat};
use super::transfer::{file_name, Plan};
use super::tree::Node;
use super::{names, Done, Flow, Run, Stopped};

const CHUNK: usize = 256 * 1024;
const NO_PASSWORDS: &str = "This file is protected by a password, which Perli can't open yet.";
const UNSAFE_NAME: &str = "This name in the archive isn't safe to use, so Perli left it out.";

type Writer<'a> = ZipWriter<BufWriter<&'a mut File>>;

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

fn ticks_of(time: DateTime) -> u64 {
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
pub(super) fn safe(relative: PathBuf) -> Option<PathBuf> {
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

impl Run<'_> {
    pub(super) fn zip(&mut self, sources: Vec<PathBuf>) -> Flow {
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
            sys::fill_new(&temp, |file| run.write_archive(file, &nodes))
        })?;
        if written.is_none() {
            return Ok(());
        }
        // Only now, as a long job gives another one time to take the name.
        let target = names::free(&folder, &stem, ".zip");
        let swapped = self.swap_in(&temp, &target, false);
        if !matches!(swapped, Ok(true)) {
            let _ = sys::delete_file(&temp);
        }
        if swapped? {
            self.done.push(Done::Created { path: target });
        }
        Ok(())
    }

    fn write_archive(&mut self, file: &mut File, nodes: &[Node]) -> io::Result<()> {
        let mut zip = ZipWriter::new(BufWriter::new(&mut *file));
        let mut used = HashSet::new();
        let stopped = |Stopped| io::Error::from(io::ErrorKind::Interrupted);
        for node in nodes {
            let name = name_of(node);
            if used.insert(name.to_lowercase()) {
                self.add_node(&mut zip, node, &name).map_err(stopped)?;
            } else {
                // Search rows come from many folders, and an archive's top level is one.
                self.refuse(&node.path, "Another item in this archive has the same name.").map_err(stopped)?;
                self.step(node.items - 1, node.bytes);
            }
        }
        let file = zip.finish().map_err(io::Error::other)?.into_inner().map_err(io::IntoInnerError::into_error)?;
        // A file given up on rewinds the archive, which can leave old bytes past its new end.
        let end = file.stream_position()?;
        file.set_len(end)
    }

    fn add_node(&mut self, zip: &mut Writer<'_>, node: &Node, name: &str) -> Flow {
        let time = zip_time(node.stat.modified).unwrap_or_default();
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .last_modified_time(time);
        if node.stat.is_link() {
            // ponytail: links stay out, as what they lead to is not part of what was picked.
            self.step(1, 0);
            return Ok(());
        }
        let Some(children) = &node.children else {
            let options = options.large_file(node.stat.size >= u64::from(u32::MAX));
            return self.add_file(zip, node, name, options);
        };
        self.attempt(&node.path, None, |_| zip.add_directory(name, options).map_err(from_zip))?;
        self.step(1, 0);
        for child in children {
            self.add_node(zip, child, &format!("{name}/{}", name_of(child)))?;
        }
        Ok(())
    }

    fn add_file(&mut self, zip: &mut Writer<'_>, node: &Node, name: &str, options: SimpleFileOptions) -> Flow {
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

    pub(super) fn unzip(&mut self, archives: Vec<PathBuf>, own_folder: bool) -> Flow {
        self.add_total(archives.len() as u64, 0);
        for archive in archives {
            self.unzip_one(&archive, own_folder)?;
            self.step(1, 0);
        }
        Ok(())
    }

    fn unzip_one(&mut self, archive: &Path, own_folder: bool) -> Flow {
        let Some(mut zip) = self.attempt(archive, None, |_| open_archive(archive))? else {
            return Ok(());
        };
        let folder = sys::parent(archive);
        let zone = sys::read_zone(archive);
        let mut landing = Landing::new(folder.clone(), Some(archive.to_path_buf()), zone);
        if own_folder {
            let stem = archive.file_stem().unwrap_or(archive.as_os_str());
            let root = names::keep_both(&folder, stem, true);
            if self.attempt(archive, None, |_| sys::create_dir(&root))?.is_none() {
                return Ok(());
            }
            self.done.push(Done::Created { path: root.clone() });
            landing.root = root;
            landing = landing.in_new_root();
        }

        let sizes = (0..zip.len()).filter_map(|index| zip.by_index_data(index).ok().map(|entry| entry.size()));
        let bytes = sizes.sum();
        self.add_total(zip.len() as u64, bytes);
        for index in 0..zip.len() {
            self.check()?;
            let facts = zip.by_index_data(index).map(|entry| {
                let relative = entry.enclosed_name().and_then(safe);
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
            if encrypted {
                self.refuse(&landing.root.join(&relative), NO_PASSWORDS)?;
                self.progress.bytes += stat.size;
            } else if is_dir {
                self.land_folder(&mut landing, &relative)?;
                self.step(1, 0);
            } else {
                self.land_file(&mut landing, &relative, stat, |run, file, base| {
                    let mut entry = zip.by_index(index).map_err(io::Error::other)?;
                    run.pour(&mut entry, file, base)
                })?;
            }
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
                Some(stat) if stat.is_dir() => fresh = false,
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
                    if stat.modified != 0 {
                        let _ = sys::set_modified(&temp, stat.modified);
                    }
                    if let Some(zone) = &landing.zone {
                        let _ = sys::write_zone(&temp, zone);
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
fn entry_name(zip: &ZipArchive<BufReader<File>>, index: usize) -> String {
    let entry = zip.by_index_data(index);
    entry.ok().and_then(|entry| entry.name().ok().map(|name| name.replace(['/', '\\'], " "))).unwrap_or_default()
}
