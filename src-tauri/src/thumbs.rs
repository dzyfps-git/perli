//! Pictures of files for the grid. Each file type has its own handler, which can be slow or get
//! stuck, so they run on threads of their own and the list never waits for one.

use std::fs;
use std::mem::size_of;
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::thread;

use tauri::async_runtime;
use windows::core::{Error, Interface, Result};
use windows::Win32::Foundation::{E_FAIL, SIZE};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO,
    BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP,
};
use windows::Win32::UI::Shell::{
    IShellItemImageFactory, SIIGBF_ICONONLY, SIIGBF_INCACHEONLY, SIIGBF_RESIZETOFIT, SIIGBF_THUMBNAILONLY,
};

use crate::folder::ONLINE_ONLY;
use crate::ops::{shell_item, Com};

/// The longest edge in the grid. Windows caches pictures at this size, so most cost no decoding.
pub const EDGE: u32 = 256;
/// The quick preview asks for no more than this.
const MAX_EDGE: u32 = 4096;
// ponytail: no timeout, so a stuck handler keeps its thread and four of them end the pictures
// until a restart. The list itself is never affected. A process of its own could be killed.
const WORKERS: usize = 4;
/// Where the pixels start in what `read` gives.
const HEADER_BYTES: usize = 8;
/// Enough for the lines a hover card shows.
const PEEK_BYTES: usize = 2048;
const PEEK_LINES: usize = 12;

type Work = Box<dyn FnOnce() + Send>;

/// Started by the first picture, so that a list view costs nothing.
fn queue() -> &'static Mutex<Sender<Work>> {
    static QUEUE: OnceLock<Mutex<Sender<Work>>> = OnceLock::new();
    QUEUE.get_or_init(|| {
        let (sender, receiver) = mpsc::channel::<Work>();
        let receiver = Arc::new(Mutex::new(receiver));
        for _ in 0..WORKERS {
            let receiver = receiver.clone();
            thread::spawn(move || {
                let _com = Com::enter();
                loop {
                    let work = receiver.lock().unwrap_or_else(PoisonError::into_inner).recv();
                    let Ok(work) = work else { return };
                    work();
                }
            });
        }
        Mutex::new(sender)
    })
}

/// Width and height (u32, little-endian), then RGBA pixels with plain alpha, or nothing if there
/// is no picture. `src/api/index.ts` decodes this.
pub async fn read(path: PathBuf, edge: u32) -> Vec<u8> {
    load(path, edge, false).await
}

/// Like `read`, but only the file's own picture, such as a song's album cover, never an icon.
pub async fn cover(path: PathBuf, edge: u32) -> Vec<u8> {
    load(path, edge, true).await
}

async fn load(path: PathBuf, edge: u32, own: bool) -> Vec<u8> {
    let (sender, mut result) = async_runtime::channel(1);
    let edge = edge.clamp(1, MAX_EDGE) as i32;
    let work = Box::new(move || {
        let _ = sender.blocking_send(picture(&path, edge, own).unwrap_or_default());
    });
    let _ = queue().lock().unwrap_or_else(PoisonError::into_inner).send(work);
    result.recv().await.unwrap_or_default()
}

const PEEK_NAMES: usize = 6;
const PEEK_COUNT: usize = 1000;

/// The first lines of a file that reads as UTF-8 text, for a preview. Bytes that are not UTF-8,
/// or control characters, mean it is not text. A file in the cloud stays there. Blocks, so call
/// it off the main thread.
pub fn text_start(path: &Path) -> Option<String> {
    use std::io::Read;
    if is_online_only(path) {
        return None;
    }
    let mut bytes = Vec::with_capacity(PEEK_BYTES);
    fs::File::open(path).ok()?.take(PEEK_BYTES as u64).read_to_end(&mut bytes).ok()?;
    let body = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
    // The cut can land inside a character, which is fine.
    let text = crate::preview::as_text(body, true)?;
    (!text.is_empty()).then(|| text.lines().take(PEEK_LINES).collect::<Vec<_>>().join("\n"))
}

/// What a folder's hover card says is inside it.
#[derive(Debug, PartialEq, serde::Serialize)]
pub struct FolderStart {
    /// The first few names, folders marked with `true`.
    pub names: Vec<(String, bool)>,
    pub count: usize,
    /// The folder holds more than were counted.
    pub more: bool,
}

/// The first few things in a folder and how many it holds, without hidden ones. Counting stops
/// at `PEEK_COUNT`, so a huge folder answers as fast as a small one. Blocks.
pub fn folder_start(path: &Path) -> Option<FolderStart> {
    const HIDDEN: u32 = 0x2;
    let mut found = FolderStart { names: Vec::new(), count: 0, more: false };
    for entry in fs::read_dir(path).ok()?.flatten() {
        let Ok(data) = entry.metadata() else { continue };
        if data.file_attributes() & HIDDEN != 0 {
            continue;
        }
        if found.count == PEEK_COUNT {
            found.more = true;
            break;
        }
        found.count += 1;
        if found.names.len() < PEEK_NAMES {
            found.names.push((entry.file_name().to_string_lossy().into_owned(), data.is_dir()));
        }
    }
    Some(found)
}

/// True if opening the file would fetch it from the cloud.
pub fn is_online_only(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|data| data.file_attributes() & ONLINE_ONLY != 0)
}

/// Its own picture if it has one, or else the icon of its type, unless `own` asks for its own
/// picture only. A file in the cloud stays there, so it only gets a picture Windows already has.
fn picture(path: &Path, edge: i32, own: bool) -> Result<Vec<u8>> {
    // Windows draws no cover for a book or a comic, so theirs are read from the file. One with
    // no cover keeps Perli's own icon.
    if crate::inside::has_cover(path) && !is_online_only(path) {
        return crate::inside::cover(path, edge as u32).ok_or_else(|| windows::Win32::Foundation::E_FAIL.into());
    }
    let factory: IShellItemImageFactory = shell_item(path)?.cast()?;
    let size = SIZE { cx: edge, cy: edge };
    let first = match (is_online_only(path), own) {
        (true, _) => SIIGBF_INCACHEONLY,
        (false, true) => SIIGBF_THUMBNAILONLY,
        (false, false) => SIIGBF_RESIZETOFIT,
    };
    let bitmap = unsafe {
        factory.GetImage(size, first).or_else(|error| if own { Err(error) } else { factory.GetImage(size, SIIGBF_ICONONLY) })
    }?;
    let bytes = encode(bitmap);
    let _ = unsafe { DeleteObject(bitmap.into()) };
    bytes
}

/// The picture as the UI reads it: width, height, then RGBA.
pub fn encode(bitmap: HBITMAP) -> Result<Vec<u8>> {
    let mut shape = BITMAP::default();
    let wrote = unsafe { GetObjectW(bitmap.into(), size_of::<BITMAP>() as i32, Some((&raw mut shape).cast())) };
    if wrote == 0 {
        return Err(Error::from(E_FAIL));
    }
    let (width, height) = (shape.bmWidth, shape.bmHeight.abs());

    // A negative height asks for the top row first.
    let mut format = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut bytes = vec![0; HEADER_BYTES + width as usize * height as usize * 4];
    bytes[..4].copy_from_slice(&(width as u32).to_le_bytes());
    bytes[4..8].copy_from_slice(&(height as u32).to_le_bytes());
    let pixels = bytes[HEADER_BYTES..].as_mut_ptr().cast();
    let lines = unsafe {
        let context = CreateCompatibleDC(None);
        let lines = GetDIBits(context, bitmap, 0, height as u32, Some(pixels), &raw mut format, DIB_RGB_COLORS);
        let _ = DeleteDC(context);
        lines
    };
    if lines != height {
        return Err(Error::from(E_FAIL));
    }
    to_rgba(&mut bytes[HEADER_BYTES..]);
    Ok(bytes)
}

/// Windows gives BGRA with alpha already applied, and a canvas wants neither. A picture with no
/// transparency at all can come with alpha zero throughout.
fn to_rgba(pixels: &mut [u8]) {
    let no_alpha = pixels.chunks_exact(4).all(|pixel| pixel[3] == 0);
    for pixel in pixels.chunks_exact_mut(4) {
        pixel.swap(0, 2);
        match pixel[3] {
            0 if no_alpha => pixel[3] = 255,
            0 | 255 => {}
            alpha => {
                for channel in &mut pixel[..3] {
                    *channel = (u32::from(*channel) * 255 / u32::from(alpha)).min(255) as u8;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("perli-thumbs-{name}-{}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    /// A small picture in the plainest format there is.
    fn write_bmp(path: &Path) {
        const SIDE: u32 = 32;
        let pixels = SIDE * SIDE * 4;
        let mut bytes = vec![0u8; 54];
        bytes[..2].copy_from_slice(b"BM");
        bytes[2..6].copy_from_slice(&(54 + pixels).to_le_bytes());
        bytes[10] = 54;
        bytes[14] = 40;
        bytes[18..22].copy_from_slice(&SIDE.to_le_bytes());
        bytes[22..26].copy_from_slice(&SIDE.to_le_bytes());
        bytes[26] = 1;
        bytes[28] = 32;
        bytes.extend([0, 0, 255, 255].repeat(pixels as usize / 4));
        fs::write(path, bytes).unwrap();
    }

    fn shape(bytes: &[u8]) -> (usize, usize) {
        let word = |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap()) as usize;
        (word(0), word(4))
    }

    #[test]
    fn colours_swap_and_alpha_comes_off() {
        let mut pixels = [10, 20, 30, 255, 40, 50, 60, 128, 1, 2, 3, 0];
        to_rgba(&mut pixels);
        assert_eq!(pixels, [30, 20, 10, 255, 119, 99, 79, 128, 3, 2, 1, 0]);
    }

    #[test]
    fn a_bitmap_with_no_alpha_at_all_turns_solid() {
        let mut pixels = [10, 20, 30, 0, 40, 50, 60, 0];
        to_rgba(&mut pixels);
        assert_eq!(pixels, [30, 20, 10, 255, 60, 50, 40, 255]);
    }

    #[test]
    fn a_file_gets_a_picture_or_an_icon() {
        let _com = Com::enter();
        let folder = folder("picture");
        let (image, text) = (folder.join("a.bmp"), folder.join("a.unknown-type"));
        write_bmp(&image);
        fs::write(&text, "words").unwrap();

        for path in [image, text] {
            let bytes = picture(&path, EDGE as i32, false).unwrap();
            let (width, height) = shape(&bytes);
            assert!((1..=EDGE as usize).contains(&width), "{path:?} is {width} wide");
            assert_eq!(bytes.len(), HEADER_BYTES + width * height * 4);
            assert!(bytes[HEADER_BYTES..].iter().any(|&byte| byte != 0), "{path:?} is blank");
        }
        fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn only_text_has_a_text_start() {
        let folder = folder("peek");
        let lines: String = (1..=20).map(|line| format!("line {line}\n")).collect();
        let cut = format!("{}é", "a".repeat(PEEK_BYTES - 1));
        let files = [
            ("a.txt", format!("\u{FEFF}{lines}").into_bytes()),
            ("cut.txt", cut.into_bytes()),
            ("a.bin", b"MZ\0\0".to_vec()),
            ("a.pdf", b"%PDF-1.7\n%\xE2\xE3\xCF\xD3\n".to_vec()),
            ("empty.txt", Vec::new()),
        ];
        for (name, bytes) in &files {
            fs::write(folder.join(name), bytes).unwrap();
        }

        let start = text_start(&folder.join("a.txt")).unwrap();
        assert_eq!(start.lines().count(), PEEK_LINES);
        assert!(start.starts_with("line 1\nline 2"), "{start:?}");
        assert_eq!(text_start(&folder.join("cut.txt")).unwrap(), "a".repeat(PEEK_BYTES - 1));
        assert_eq!(text_start(&folder.join("a.bin")), None);
        assert_eq!(text_start(&folder.join("a.pdf")), None);
        assert_eq!(text_start(&folder.join("empty.txt")), None);
        assert_eq!(text_start(&folder.join("missing.txt")), None);
        fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn a_file_only_in_the_cloud_is_never_read() {
        use windows::core::HSTRING;
        use windows::Win32::Storage::FileSystem::{SetFileAttributesW, FILE_ATTRIBUTE_OFFLINE};

        let folder = folder("cloud");
        let file = folder.join("note.txt");
        fs::write(&file, "plain text").unwrap();
        unsafe { SetFileAttributesW(&HSTRING::from(file.as_os_str()), FILE_ATTRIBUTE_OFFLINE) }.unwrap();
        assert!(is_online_only(&file));
        assert_eq!(text_start(&file), None, "no text start");
        assert_eq!(crate::preview::read(&file, 0), crate::preview::Preview::Cloud, "no preview read");
        fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn a_missing_file_has_no_picture() {
        let _com = Com::enter();
        assert!(picture(&std::env::temp_dir().join("perli-no-such-file"), EDGE as i32, false).is_err());
    }

    #[test]
    fn workers_answer_through_the_queue() {
        let folder = folder("queue");
        let image = folder.join("a.bmp");
        write_bmp(&image);

        let bytes = async_runtime::block_on(read(image, EDGE));

        assert!(bytes.len() > HEADER_BYTES);
        fs::remove_dir_all(folder).unwrap();
    }
}

#[cfg(test)]
mod folder_start_tests {
    use super::*;

    #[test]
    fn a_folder_card_lists_the_first_names_and_counts_the_rest() {
        let folder = std::env::temp_dir().join(format!("perli-folder-start-{}", std::process::id()));
        let _ = fs::remove_dir_all(&folder);
        fs::create_dir_all(folder.join("inner")).unwrap();
        for at in 0..8 {
            fs::write(folder.join(format!("file{at}.txt")), "x").unwrap();
        }
        let found = folder_start(&folder).unwrap();
        assert_eq!((found.count, found.more, found.names.len()), (9, false, PEEK_NAMES));
        assert!(found.names.contains(&("file0.txt".to_string(), false)));
        assert_eq!(folder_start(&folder.join("inner")), Some(FolderStart { names: Vec::new(), count: 0, more: false }));
        assert_eq!(folder_start(&folder.join("missing")), None);
        fs::remove_dir_all(&folder).unwrap();
    }
}
