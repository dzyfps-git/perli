//! Files on the Windows clipboard, in Explorer's own formats so the two can trade.

use std::ffi::OsString;
use std::mem::size_of;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::PathBuf;
use std::ptr;
use std::thread;
use std::time::Duration;

use windows::core::{w, Error, Result};
use windows::Win32::Foundation::{GlobalFree, E_OUTOFMEMORY, HANDLE, HGLOBAL, HWND};
use windows::Win32::Graphics::Gdi::{HBITMAP, HPALETTE};
use windows::Win32::Graphics::Imaging::{
    CLSID_WICImagingFactory, GUID_ContainerFormatPng, IWICImagingFactory, WICBitmapEncoderNoCache,
    WICBitmapIgnoreAlpha,
};
use windows::Win32::System::Com::{
    CoCreateInstance, IStream, CLSCTX_INPROC_SERVER, STATFLAG_NONAME, STATSTG, STREAM_SEEK_SET,
};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, GetClipboardSequenceNumber,
    IsClipboardFormatAvailable, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
};
use windows::Win32::System::Memory::{
    GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE,
};
use windows::Win32::System::Ole::{DROPEFFECT_COPY, DROPEFFECT_LINK, DROPEFFECT_MOVE};
use windows::Win32::UI::Shell::{SHCreateMemStream, CFSTR_PREFERREDDROPEFFECT, DROPFILES};

use crate::ops::{Com, Content, Template};

/// Windows' standard clipboard format numbers.
const CF_BITMAP: u32 = 2;
const CF_UNICODETEXT: u32 = 13;
const CF_HDROP: u32 = 15;

const PNG_START: &[u8] = b"\x89PNG\r\n\x1a\n";

const OPEN_TRIES: u32 = 5;
const OPEN_WAIT: Duration = Duration::from_millis(20);

/// Where `DROPFILES` says whether its names are UTF-16.
const WIDE_FLAG_OFFSET: usize = 16;

pub struct Files {
    pub paths: Vec<PathBuf>,
    pub cut: bool,
}

/// The open clipboard, closed again when dropped.
struct Open;

impl Open {
    /// Other programs hold the clipboard for a moment at a time, so it is worth a few tries.
    fn new(owner: HWND) -> Result<Self> {
        let owner = (!owner.is_invalid()).then_some(owner);
        for _ in 1..OPEN_TRIES {
            if unsafe { OpenClipboard(owner) }.is_ok() {
                return Ok(Self);
            }
            thread::sleep(OPEN_WAIT);
        }
        unsafe { OpenClipboard(owner) }?;
        Ok(Self)
    }
}

impl Drop for Open {
    fn drop(&mut self) {
        let _ = unsafe { CloseClipboard() };
    }
}

fn effect_format() -> u32 {
    unsafe { RegisterClipboardFormatW(CFSTR_PREFERREDDROPEFFECT) }
}

/// What browsers and image editors put beside a plain bitmap, with its transparency intact.
fn png_format() -> u32 {
    unsafe { RegisterClipboardFormatW(w!("PNG")) }
}

fn encode(paths: &[PathBuf]) -> Vec<u8> {
    let mut bytes = vec![0; size_of::<DROPFILES>()];
    bytes[..4].copy_from_slice(&(size_of::<DROPFILES>() as u32).to_le_bytes());
    bytes[WIDE_FLAG_OFFSET] = 1;
    for path in paths {
        let name = path.as_os_str().encode_wide().chain([0]);
        bytes.extend(name.flat_map(u16::to_le_bytes));
    }
    bytes.extend([0, 0]);
    bytes
}

// ponytail: UTF-16 lists only, which every program since Windows 2000 writes.
pub fn decode(bytes: &[u8]) -> Option<Vec<PathBuf>> {
    let word = |at: usize| Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?));
    if word(WIDE_FLAG_OFFSET)? == 0 {
        return None;
    }
    let units: Vec<u16> = bytes
        .get(word(0)? as usize..)?
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    let names = units.split(|&unit| unit == 0).take_while(|name| !name.is_empty());
    Some(names.map(|name| OsString::from_wide(name).into()).collect())
}

unsafe fn put(format: u32, bytes: &[u8]) -> Result<()> {
    let memory = GlobalAlloc(GMEM_MOVEABLE, bytes.len())?;
    let target = GlobalLock(memory);
    if target.is_null() {
        let error = Error::from_thread();
        let _ = GlobalFree(Some(memory));
        return Err(error);
    }
    ptr::copy_nonoverlapping(bytes.as_ptr(), target.cast(), bytes.len());
    // Reports an error once the lock count reaches zero, which is the normal outcome.
    let _ = GlobalUnlock(memory);
    // The clipboard owns the memory once this works.
    if let Err(error) = SetClipboardData(format, Some(HANDLE(memory.0))) {
        let _ = GlobalFree(Some(memory));
        return Err(error);
    }
    Ok(())
}

unsafe fn take(format: u32) -> Option<Vec<u8>> {
    copy_memory(HGLOBAL(GetClipboardData(format).ok()?.0))
}

/// Copies out a block of global memory that holds a file list or a clipboard value.
pub unsafe fn copy_memory(memory: HGLOBAL) -> Option<Vec<u8>> {
    let source = GlobalLock(memory) as *const u8;
    if source.is_null() {
        return None;
    }
    let bytes = std::slice::from_raw_parts(source, GlobalSize(memory)).to_vec();
    let _ = GlobalUnlock(memory);
    Some(bytes)
}

/// `owner` is a window of this program. With none, `EmptyClipboard` leaves the clipboard
/// without an owner, and Windows documents that `SetClipboardData` then fails.
pub fn write(paths: &[PathBuf], cut: bool, owner: isize) -> Result<()> {
    let effect = if cut {
        DROPEFFECT_MOVE.0
    } else {
        DROPEFFECT_COPY.0 | DROPEFFECT_LINK.0
    };
    let _open = Open::new(HWND(owner as _))?;
    unsafe {
        EmptyClipboard()?;
        put(CF_HDROP, &encode(paths))?;
        put(effect_format(), &effect.to_le_bytes())
    }
}

/// The files on the clipboard, if it holds any.
pub fn read() -> Result<Option<Files>> {
    if !has_files() {
        return Ok(None);
    }
    let _open = Open::new(HWND::default())?;
    let Some(paths) = (unsafe { take(CF_HDROP) }).as_deref().and_then(decode) else {
        return Ok(None);
    };
    let effect = unsafe { take(effect_format()) }.unwrap_or_default();
    let cut = effect.first().is_some_and(|&low| u32::from(low) & DROPEFFECT_MOVE.0 != 0);
    Ok(Some(Files { paths, cut }))
}

pub fn has_files() -> bool {
    unsafe { IsClipboardFormatAvailable(CF_HDROP) }.is_ok()
}

/// True if a paste would make something. This reads nothing, so it never wakes a program that
/// renders its copied data late.
pub fn can_paste() -> bool {
    [CF_HDROP, CF_UNICODETEXT, CF_BITMAP, png_format()]
        .into_iter()
        .any(|format| unsafe { IsClipboardFormatAvailable(format) }.is_ok())
}

fn image_file(png: Vec<u8>) -> Template {
    let stem = "Pasted image".to_string();
    Template { stem, extension: ".png".to_string(), content: Content::Bytes(png) }
}

fn text_file(units: &[u8]) -> Option<Template> {
    let units: Vec<u16> = units.chunks_exact(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect();
    let length = units.iter().position(|&unit| unit == 0).unwrap_or(units.len());
    let text = String::from_utf16_lossy(&units[..length]);
    let stem = "Pasted text".to_string();
    (!text.is_empty()).then(|| Template { stem, extension: ".txt".to_string(), content: Content::Bytes(text.into_bytes()) })
}

/// Writes a bitmap as a PNG through Windows' own imaging. Screenshots have no real transparency,
/// so what their alpha bytes say goes unused.
fn png_of(bitmap: HBITMAP) -> Result<Vec<u8>> {
    let _com = Com::enter();
    unsafe {
        let factory: IWICImagingFactory = CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)?;
        let source = factory.CreateBitmapFromHBITMAP(bitmap, HPALETTE::default(), WICBitmapIgnoreAlpha)?;
        let stream = SHCreateMemStream(None).ok_or(Error::from(E_OUTOFMEMORY))?;
        let encoder = factory.CreateEncoder(&GUID_ContainerFormatPng, ptr::null())?;
        encoder.Initialize(&stream, WICBitmapEncoderNoCache)?;
        let mut frame = None;
        encoder.CreateNewFrame(&raw mut frame, ptr::null_mut())?;
        let frame = frame.ok_or(Error::from(E_OUTOFMEMORY))?;
        frame.Initialize(None)?;
        frame.WriteSource(&source, ptr::null())?;
        frame.Commit()?;
        encoder.Commit()?;
        read_all(&stream)
    }
}

unsafe fn read_all(stream: &IStream) -> Result<Vec<u8>> {
    let mut facts = STATSTG::default();
    stream.Stat(&raw mut facts, STATFLAG_NONAME)?;
    stream.Seek(0, STREAM_SEEK_SET, None)?;
    let mut bytes = vec![0; facts.cbSize as usize];
    let mut read = 0;
    stream.Read(bytes.as_mut_ptr().cast(), bytes.len() as u32, Some(&raw mut read)).ok()?;
    bytes.truncate(read as usize);
    Ok(bytes)
}

/// A new file that holds what the clipboard does. An image wins over text, because anything
/// copied as a picture also carries text only if that text describes it.
pub fn content() -> Result<Option<Template>> {
    let _open = Open::new(HWND::default())?;
    if let Some(png) = unsafe { take(png_format()) }.filter(|bytes| bytes.starts_with(PNG_START)) {
        return Ok(Some(image_file(png)));
    }
    if let Ok(bitmap) = unsafe { GetClipboardData(CF_BITMAP) } {
        return Ok(Some(image_file(png_of(HBITMAP(bitmap.0))?)));
    }
    Ok(unsafe { take(CF_UNICODETEXT) }.as_deref().and_then(text_file))
}

/// Changes every time any program writes the clipboard.
pub fn sequence() -> u32 {
    unsafe { GetClipboardSequenceNumber() }
}

/// A cut is used up once it is pasted, unless something else was copied since `seen`.
pub fn clear_if_unchanged(seen: u32) -> Result<()> {
    if sequence() != seen {
        return Ok(());
    }
    let _open = Open::new(HWND::default())?;
    unsafe { EmptyClipboard() }
}

#[cfg(test)]
mod tests {
    use std::process::Command;

    use windows::core::PCWSTR;
    use windows::Win32::Foundation::GENERIC_ALL;
    use windows::Win32::Graphics::Gdi::CreateBitmap;
    use windows::Win32::System::StationsAndDesktops::{
        CreateDesktopW, CreateWindowStationW, SetProcessWindowStation, SetThreadDesktop,
        DESKTOP_CONTROL_FLAGS,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, HWND_MESSAGE, WINDOW_EX_STYLE, WINDOW_STYLE,
    };

    use super::*;

    #[test]
    fn file_list_survives_encoding() {
        let paths = vec![PathBuf::from(r"C:\a b\ünï.txt"), PathBuf::from(r"D:\c.")];
        assert_eq!(decode(&encode(&paths)), Some(paths));
    }

    #[test]
    fn file_list_needs_wide_names_and_a_whole_header() {
        let mut bytes = encode(&[PathBuf::from(r"C:\a")]);
        assert_eq!(decode(&bytes[..8]), None);
        bytes[WIDE_FLAG_OFFSET] = 0;
        assert_eq!(decode(&bytes), None);
    }

    /// A window station has a clipboard of its own, so the user's is never touched. Joining one
    /// changes the whole process, so the real test gets a process to itself.
    fn in_own_process(test: &str) {
        let output = Command::new(std::env::current_exe().unwrap())
            .args([test, "--exact", "--ignored", "--nocapture", "--test-threads=1"])
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"), "{output:?}");
    }

    #[test]
    fn files_survive_a_real_clipboard() {
        in_own_process("clipboard::tests::private_round_trip");
    }

    #[test]
    fn pastes_make_files_from_a_real_clipboard() {
        in_own_process("clipboard::tests::private_content");
    }

    fn private_window() -> HWND {
        unsafe {
            let station = CreateWindowStationW(PCWSTR::null(), 0, GENERIC_ALL.0, None).unwrap();
            SetProcessWindowStation(station).unwrap();
            let desktop = CreateDesktopW(
                w!("perli-test"),
                PCWSTR::null(),
                None,
                DESKTOP_CONTROL_FLAGS(0),
                GENERIC_ALL.0,
                None,
            )
            .unwrap();
            SetThreadDesktop(desktop).unwrap();
            CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("STATIC"),
                PCWSTR::null(),
                WINDOW_STYLE(0),
                0,
                0,
                0,
                0,
                Some(HWND_MESSAGE),
                None,
                None,
                None,
            )
            .unwrap()
        }
    }

    #[test]
    #[ignore = "pastes_make_files_from_a_real_clipboard runs this in its own process"]
    fn private_content() {
        let window = private_window();
        let fresh = |fill: &dyn Fn()| {
            let _open = Open::new(window).unwrap();
            unsafe { EmptyClipboard() }.unwrap();
            fill();
        };
        let bytes_of = |template: Template| match template.content {
            Content::Bytes(bytes) => bytes,
            other => panic!("{other:?}"),
        };
        assert!(!can_paste());

        let text: Vec<u8> = "héllo\0".encode_utf16().flat_map(u16::to_le_bytes).collect();
        fresh(&|| unsafe { put(CF_UNICODETEXT, &text) }.unwrap());
        assert!(can_paste());
        let template = content().unwrap().unwrap();
        assert_eq!((template.stem.as_str(), template.extension.as_str()), ("Pasted text", ".txt"));
        assert_eq!(bytes_of(template), "héllo".as_bytes());

        let png = [PNG_START, b"rest of a picture"].concat();
        fresh(&|| unsafe {
            put(CF_UNICODETEXT, &text).unwrap();
            put(png_format(), &png).unwrap();
        });
        let template = content().unwrap().unwrap();
        assert_eq!(template.extension, ".png");
        assert!(bytes_of(template).starts_with(&png));

        fresh(&|| unsafe {
            let pixels = [0x11u8; 16];
            let bitmap = CreateBitmap(2, 2, 1, 32, Some(pixels.as_ptr().cast()));
            SetClipboardData(CF_BITMAP, Some(HANDLE(bitmap.0))).unwrap();
        });
        let template = content().unwrap().unwrap();
        assert_eq!(template.stem, "Pasted image");
        let written = bytes_of(template);
        assert!(written.starts_with(PNG_START) && written.len() > 40, "{written:?}");

        fresh(&|| ());
        assert!(content().unwrap().is_none());
    }

    #[test]
    #[ignore = "files_survive_a_real_clipboard runs this in its own process"]
    fn private_round_trip() {
        let window = private_window();
        let paths = vec![PathBuf::from(r"C:\a.txt"), PathBuf::from(r"C:\b.txt")];

        write(&paths, true, window.0 as isize).unwrap();
        let files = read().unwrap().unwrap();
        assert_eq!(files.paths, paths);
        assert!(files.cut);

        clear_if_unchanged(sequence()).unwrap();
        assert!(!has_files());
    }
}
