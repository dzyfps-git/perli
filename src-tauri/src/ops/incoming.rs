//! Files dragged in from somewhere with no paths to give, such as the inside of a zip or a mail.
//! Only their names and contents can be asked for, one at a time, through the drag's data object.

use std::io::{self, Read};
use std::mem::{size_of, ManuallyDrop};
use std::path::{Path, PathBuf};
use std::ptr;

use windows::core::{Error, Interface, Result, HRESULT, PCWSTR};
use windows::Win32::Foundation::{E_ABORT, E_FAIL, S_OK};
use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_DIRECTORY;
use windows::Win32::System::Com::Marshal::CoMarshalInterThreadInterfaceInStream;
use windows::Win32::System::Com::StructuredStorage::CoGetInterfaceAndReleaseStream;
use windows::Win32::System::Com::{
    IBindCtx, IDataObject, IStream, DVASPECT_CONTENT, FORMATETC, STREAM_SEEK_SET, TYMED, TYMED_HGLOBAL,
    TYMED_ISTREAM,
};
use windows::Win32::System::DataExchange::RegisterClipboardFormatW;
use windows::Win32::System::Ole::{ReleaseStgMedium, DROPEFFECT_COPY};
use windows::Win32::UI::Shell::{
    IDataObjectAsyncCapability, CFSTR_FILECONTENTS, CFSTR_FILEDESCRIPTORW, FD_ATTRIBUTES, FD_FILESIZE,
    FD_WRITESTIME, FILEDESCRIPTORW,
};

use super::archive::{safe, Landing};
use super::sys::Stat;
use super::{Flow, Run};
use crate::clipboard;

/// Where the files came from is anyone's guess, so Windows treats them as downloads.
const FROM_ELSEWHERE: &[u8] = b"[ZoneTransfer]\r\nZoneId=3\r\n";
const UNSAFE_NAME: &str = "This name isn't safe to use, so Perli left it out.";
const UNREADABLE: &str = "This item can't be read from where it was dragged from.";

fn format(name: PCWSTR, index: i32, tymed: TYMED) -> FORMATETC {
    FORMATETC {
        cfFormat: unsafe { RegisterClipboardFormatW(name) } as u16,
        ptd: ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: index,
        tymed: tymed.0 as u32,
    }
}

fn descriptors() -> FORMATETC {
    format(CFSTR_FILEDESCRIPTORW, -1, TYMED_HGLOBAL)
}

/// True if a drag holds files with no paths.
pub fn offers_files(data: &IDataObject) -> bool {
    (unsafe { data.QueryGetData(&descriptors()) }) == S_OK
}

/// A dragged data object on its way to the job's thread.
pub struct Incoming {
    /// Spent once the data object is unpacked from it.
    stream: Option<IStream>,
    /// The source went on with its life and waits to hear that the job ended.
    waits: bool,
}

// The stream exists to carry an interface between threads, and it is read once, on arrival.
unsafe impl Send for Incoming {}

impl Incoming {
    /// Call this on the thread the drop came to, before the drop returns. A source that can work
    /// in the background then keeps its data until the job says it is done, so a drop stays quick.
    pub fn take_over(data: &IDataObject) -> Result<Self> {
        let stream = unsafe { CoMarshalInterThreadInterfaceInStream(&IDataObject::IID, data) }?;
        let waits = data.cast::<IDataObjectAsyncCapability>().is_ok_and(|source| unsafe {
            source.GetAsyncMode().is_ok_and(|on| on.as_bool()) && source.StartOperation(None::<&IBindCtx>).is_ok()
        });
        Ok(Self { stream: Some(stream), waits })
    }

    /// Unpacks the data object on this thread. Works once.
    fn open(&mut self) -> Result<IDataObject> {
        // The call lets go of the stream itself, so it must not be released again here.
        let stream = ManuallyDrop::new(self.stream.take().ok_or_else(|| Error::new(E_FAIL, UNREADABLE))?);
        unsafe { CoGetInterfaceAndReleaseStream(&*stream) }
    }

    /// Tells a waiting source the job ended, so it can let go of its data.
    fn finish(&mut self, data: &IDataObject, outcome: HRESULT) {
        if std::mem::take(&mut self.waits) {
            if let Ok(source) = data.cast::<IDataObjectAsyncCapability>() {
                let _ = unsafe { source.EndOperation(outcome, None::<&IBindCtx>, DROPEFFECT_COPY.0) };
            }
        }
    }
}

/// A drop that never became a job, such as a dismissed choice menu, still frees the source.
impl Drop for Incoming {
    fn drop(&mut self) {
        if let Ok(data) = self.open() {
            self.finish(&data, E_ABORT);
        }
    }
}

/// One entry of the list a source gives out.
struct Item {
    name: String,
    folder: bool,
    stat: Stat,
}

/// Each entry starts on the byte after the one before it, so none can be read in place.
fn parse(bytes: &[u8]) -> Vec<Item> {
    let count = bytes.get(..4).map_or(0, |word| u32::from_le_bytes([word[0], word[1], word[2], word[3]]));
    let item = |raw: &[u8]| {
        let entry = unsafe { ptr::read_unaligned(raw.as_ptr().cast::<FILEDESCRIPTORW>()) };
        let flags = entry.dwFlags;
        let name = entry.cFileName;
        let length = name.iter().position(|&unit| unit == 0).unwrap_or(name.len());
        let has = |flag: i32| flags & flag as u32 != 0;
        let written = entry.ftLastWriteTime;
        let ticks = (u64::from(written.dwHighDateTime) << 32) | u64::from(written.dwLowDateTime);
        let size = (u64::from(entry.nFileSizeHigh) << 32) | u64::from(entry.nFileSizeLow);
        Item {
            name: String::from_utf16_lossy(&name[..length]),
            folder: has(FD_ATTRIBUTES.0) && entry.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 != 0,
            stat: Stat::of_file(if has(FD_FILESIZE.0) { size } else { 0 }, if has(FD_WRITESTIME.0) { ticks } else { 0 }),
        }
    };
    let entries = bytes.get(4..).unwrap_or_default().chunks_exact(size_of::<FILEDESCRIPTORW>());
    entries.take(count as usize).map(item).collect()
}

fn read_items(data: &IDataObject) -> Result<Vec<Item>> {
    let mut medium = unsafe { data.GetData(&descriptors()) }?;
    let bytes = unsafe { clipboard::copy_memory(medium.u.hGlobal) };
    unsafe { ReleaseStgMedium(&raw mut medium) };
    bytes.map(|bytes| parse(&bytes)).ok_or_else(|| Error::new(E_FAIL, UNREADABLE))
}

struct Stream(IStream);

impl Read for Stream {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let mut count = 0;
        let size = buffer.len().min(u32::MAX as usize) as u32;
        let read = unsafe { self.0.Read(buffer.as_mut_ptr().cast(), size, Some(&raw mut count)) };
        read.ok().map_err(|error| io::Error::other(error.message()))?;
        Ok(count as usize)
    }
}

/// What a source hands over for one file. A mail stored as a whole storage comes as neither.
enum Contents {
    Bytes(Vec<u8>),
    Stream(Stream),
}

fn contents(data: &IDataObject, index: usize) -> Result<Contents> {
    let wanted = format(CFSTR_FILECONTENTS, index as i32, TYMED(TYMED_ISTREAM.0 | TYMED_HGLOBAL.0));
    let mut medium = unsafe { data.GetData(&raw const wanted) }?;
    let found = unsafe {
        match TYMED(medium.tymed as i32) {
            TYMED_HGLOBAL => clipboard::copy_memory(medium.u.hGlobal).map(Contents::Bytes),
            TYMED_ISTREAM => (*medium.u.pstm).clone().map(|stream| {
                // A retry reads the same stream, and some sources start it anywhere.
                let _ = stream.Seek(0, STREAM_SEEK_SET, None);
                Contents::Stream(Stream(stream))
            }),
            _ => None,
        }
    };
    unsafe { ReleaseStgMedium(&raw mut medium) };
    found.ok_or_else(|| Error::new(E_FAIL, UNREADABLE))
}

impl Run<'_> {
    pub(super) fn receive(&mut self, mut incoming: Incoming, folder: &Path) -> Flow {
        let data = match incoming.open() {
            Ok(data) => data,
            Err(error) => return self.refuse(folder, &error.message()),
        };
        let received = self.receive_items(&data, folder);
        incoming.finish(&data, if received.is_ok() { S_OK } else { E_ABORT });
        received
    }

    fn receive_items(&mut self, data: &IDataObject, folder: &Path) -> Flow {
        let Some(items) = self.attempt(folder, None, |_| read_items(data))? else {
            return Ok(());
        };
        self.add_total(items.len() as u64, items.iter().map(|item| item.stat.size).sum());
        let mut landing = Landing::new(folder.to_path_buf(), None, Some(FROM_ELSEWHERE.to_vec()));
        for (index, item) in items.iter().enumerate() {
            self.check()?;
            let Some(relative) = safe(PathBuf::from(&item.name)) else {
                self.refuse(&folder.join(item.name.replace(['/', '\\'], " ")), UNSAFE_NAME)?;
                continue;
            };
            if item.folder {
                self.land_folder(&mut landing, &relative)?;
                self.step(1, 0);
                continue;
            }
            self.land_file(&mut landing, &relative, item.stat, |run, file, base| {
                match contents(data, index).map_err(|error| io::Error::other(error.message()))? {
                    Contents::Bytes(bytes) => run.pour(&mut bytes.as_slice(), file, base),
                    Contents::Stream(mut stream) => run.pour(&mut stream, file, base),
                }
            })?;
        }
        Ok(())
    }
}
