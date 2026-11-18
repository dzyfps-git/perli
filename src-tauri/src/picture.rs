//! Changes to pictures: a turn or a mirror saved into the file, and copies that are smaller, in
//! another format, or fit for sharing. A JPEG turns without being drawn again: only the EXIF
//! note that says how it stands changes, so it loses nothing.

use std::path::Path;

use serde::Deserialize;
use windows::core::{w, Error, Interface, Result, GUID, PCWSTR, PWSTR};
use windows::Win32::Foundation::{E_FAIL, GENERIC_READ, GENERIC_WRITE};
use windows::Win32::Graphics::Imaging::{
    CLSID_WICImagingFactory, GUID_ContainerFormatBmp, GUID_ContainerFormatJpeg, GUID_ContainerFormatPng, GUID_ContainerFormatTiff,
    GUID_WICPixelFormat1bppIndexed, GUID_WICPixelFormat2bppIndexed, GUID_WICPixelFormat32bppBGRA, GUID_WICPixelFormat4bppIndexed,
    GUID_WICPixelFormat8bppIndexed, IWICBitmapFrameDecode, IWICBitmapFrameEncode, IWICBitmapSource, IWICColorContext, IWICImagingFactory,
    IWICMetadataBlockReader, IWICMetadataBlockWriter, WICBitmapDitherTypeNone, WICBitmapEncoderNoCache,
    WICBitmapInterpolationModeHighQualityCubic, WICBitmapPaletteTypeCustom, WICBitmapTransformFlipHorizontal, WICBitmapTransformOptions,
    WICBitmapTransformRotate0, WICBitmapTransformRotate180, WICBitmapTransformRotate270, WICBitmapTransformRotate90,
    WICConvertBitmapSource, WICDecodeMetadataCacheOnDemand, WICRect,
};
use windows::Win32::System::Com::StructuredStorage::{PROPBAG2, PROPVARIANT};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
use windows::Win32::System::Variant::{VARIANT, VT_R4};

use crate::ops::sys::extended;
use crate::ops::Com;

/// A sharing copy is at most this long on its longer side, which every chat and mail app takes.
const SHARE_EDGE: u32 = 2048;
const QUALITY: f32 = 0.92;
const SHARE_QUALITY: f32 = 0.85;

/// What to do to a picture.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Edit {
    /// Saved into the file itself: quarter turns clockwise, after a mirror left to right with `flip`.
    Turn { quarters: u8, flip: bool },
    /// A copy whose longer side is `longest` pixels. A copy is never made bigger.
    Resize { longest: u32 },
    /// A copy in another format.
    Convert { format: Format },
    /// A smaller JPEG copy that holds the picture alone: no place it was taken, no camera.
    Share,
    /// A copy of part of the picture, each side a share of the whole from 0 to 1, of the picture
    /// as it stands. Shares and not pixels, so a photo its EXIF turns crops where it shows.
    Crop { left: f32, top: f32, width: f32, height: f32 },
}

/// What a copy keeps of the facts a photo carries. A turn saved into the file keeps them all.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Keep {
    /// The camera, its settings, when it was taken, and the rest of the picture's notes.
    pub camera: bool,
    /// Where it was taken, which goes only with the camera facts.
    pub place: bool,
}

impl Default for Keep {
    fn default() -> Self {
        Self { camera: true, place: false }
    }
}

impl Keep {
    pub const ALL: Self = Self { camera: true, place: true };
}

/// The facts a copy takes over one by one, by Windows' names for them, when it is in another
/// format or leaves the place out. None of them says where the photo was taken.
const FACTS: [PCWSTR; 17] = [
    w!("System.Photo.DateTaken"),
    w!("System.Photo.CameraManufacturer"),
    w!("System.Photo.CameraModel"),
    w!("System.Photo.FNumber"),
    w!("System.Photo.ExposureTime"),
    w!("System.Photo.ISOSpeed"),
    w!("System.Photo.FocalLength"),
    w!("System.Photo.Flash"),
    w!("System.Photo.ExposureBias"),
    w!("System.Photo.WhiteBalance"),
    w!("System.ApplicationName"),
    w!("System.Author"),
    w!("System.Copyright"),
    w!("System.Title"),
    w!("System.Comment"),
    w!("System.Keywords"),
    w!("System.Rating"),
];

/// Where a photo was taken.
const PLACE: [PCWSTR; 8] = [
    w!("System.GPS.Latitude"),
    w!("System.GPS.LatitudeRef"),
    w!("System.GPS.Longitude"),
    w!("System.GPS.LongitudeRef"),
    w!("System.GPS.Altitude"),
    w!("System.GPS.AltitudeRef"),
    w!("System.GPS.Date"),
    w!("System.GPS.TimeStamp"),
];

const ORIENTATION: PCWSTR = w!("System.Photo.Orientation");

/// How a JPEG or TIFF says it stands, 1 to 8.
unsafe fn standing(frame: &IWICBitmapFrameDecode) -> Option<u16> {
    let mut value = PROPVARIANT::default();
    unsafe { frame.GetMetadataQueryReader().ok()?.GetMetadataByName(ORIENTATION, &raw mut value) }.ok()?;
    u16::try_from(&value).ok()
}

/// Carries `from`'s colour profile into `to`, and what `keep` says of its facts. `same` is when
/// both are one format, so the blocks of facts go whole, but only with the place: a place can
/// hide in many notes (EXIF GPS, XMP, IPTC), so a copy without it takes only the facts known to
/// hold none. The pixels now stand the way the
/// orientation note said, so it says they stand as they are. Each is a best try: a format with no
/// room for a fact goes without it.
unsafe fn carry(factory: &IWICImagingFactory, from: &IWICBitmapFrameDecode, to: &IWICBitmapFrameEncode, same: bool, keep: Keep) {
    unsafe {
        let mut count = 0;
        if from.GetColorContexts(&mut [], &raw mut count).is_ok() && count > 0 {
            let mut contexts: Vec<Option<IWICColorContext>> = (0..count).map(|_| factory.CreateColorContext().ok()).collect();
            if contexts.iter().all(Option::is_some) && from.GetColorContexts(&mut contexts, &raw mut count).is_ok() {
                let _ = to.SetColorContexts(&contexts);
            }
        }
        if !keep.camera {
            return;
        }
        let Ok(reader) = from.GetMetadataQueryReader() else { return };
        let whole = same
            && keep.place
            && from
                .cast::<IWICMetadataBlockReader>()
                .and_then(|blocks| to.cast::<IWICMetadataBlockWriter>()?.InitializeFromBlockReader(&blocks))
                .is_ok();
        let Ok(writer) = to.GetMetadataQueryWriter() else { return };
        // The small picture a camera keeps for a quick look still shows the photo as it was, so a
        // whole copy leaves it out. Windows makes its own from the new pixels.
        if whole {
            let _ = writer.RemoveMetadataByName(w!("/app1/thumb"));
        }
        if !whole {
            let place: &[PCWSTR] = if keep.place { &PLACE } else { &[] };
            for &name in FACTS.iter().chain(place) {
                let mut value = PROPVARIANT::default();
                if reader.GetMetadataByName(name, &raw mut value).is_ok() {
                    let _ = writer.SetMetadataByName(name, &raw const value);
                }
            }
        }
        let mut value = PROPVARIANT::default();
        if reader.GetMetadataByName(ORIENTATION, &raw mut value).is_ok() {
            let upright = PROPVARIANT::from(1u16);
            let _ = writer.SetMetadataByName(ORIENTATION, &raw const upright);
        }
    }
}

/// The formats Windows can write.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Png,
    Jpeg,
    Tiff,
    Bmp,
}

impl Format {
    fn container(self) -> GUID {
        match self {
            Self::Png => GUID_ContainerFormatPng,
            Self::Jpeg => GUID_ContainerFormatJpeg,
            Self::Tiff => GUID_ContainerFormatTiff,
            Self::Bmp => GUID_ContainerFormatBmp,
        }
    }

    fn extension(self) -> &'static str {
        match self {
            Self::Png => ".png",
            Self::Jpeg => ".jpg",
            Self::Tiff => ".tif",
            Self::Bmp => ".bmp",
        }
    }
}

fn extension(path: &Path) -> String {
    path.extension().map(|extension| extension.to_string_lossy().to_lowercase()).unwrap_or_default()
}

/// The format a picture is in, by its name, if Windows can write it.
pub fn format_of(path: &Path) -> Option<Format> {
    Some(match extension(path).as_str() {
        "png" => Format::Png,
        "jpg" | "jpeg" | "jpe" | "jfif" => Format::Jpeg,
        "tif" | "tiff" => Format::Tiff,
        "bmp" | "dib" => Format::Bmp,
        _ => return None,
    })
}

/// Why an edit can't be done to `path`, before anything starts.
pub fn refusal(path: &Path, edit: Edit) -> Option<String> {
    match edit {
        Edit::Turn { .. } if format_of(path).is_none() => {
            Some(format!("Perli can't save .{} pictures. Make a PNG or JPEG copy, and turn that.", extension(path)))
        }
        _ => None,
    }
}

/// The name of a copy, before any number that keeps it apart: its stem and its extension.
pub fn copy_name(path: &Path, edit: Edit, (width, height): (u32, u32)) -> (String, String) {
    let stem = path.file_stem().unwrap_or_default().to_string_lossy();
    let own = || match format_of(path) {
        Some(_) => format!(".{}", extension(path)),
        None => Format::Png.extension().to_string(),
    };
    match edit {
        Edit::Resize { .. } => (format!("{stem} ({width}×{height})"), own()),
        Edit::Convert { format } => (stem.into_owned(), format.extension().to_string()),
        Edit::Share => (format!("{stem} (to share)"), Format::Jpeg.extension().to_string()),
        Edit::Crop { .. } => (format!("{stem} (cropped)"), own()),
        Edit::Turn { .. } => (stem.into_owned(), own()),
    }
}

/// A turn as quarter turns clockwise, after a mirror left to right when the flag is set.
pub type Turn = (u8, bool);

/// `first`, then `then`. A mirror after a turn is the same as the mirror first and the turn the
/// other way round.
fn compose((quarters, flip): Turn, (more, flip_more): Turn) -> Turn {
    let quarters = if flip_more { (4 - quarters % 4) % 4 } else { quarters % 4 };
    ((quarters + more) % 4, flip ^ flip_more)
}

/// What each EXIF orientation, 1 to 8, asks a viewer to do to the stored picture.
const ORIENTATIONS: [Turn; 8] = [(0, false), (0, true), (2, false), (2, true), (3, true), (1, false), (1, true), (3, false)];

fn turn_of(orientation: u16) -> Turn {
    ORIENTATIONS.get(usize::from(orientation).wrapping_sub(1)).copied().unwrap_or((0, false))
}

fn orientation_of(turn: Turn) -> u16 {
    let at = ORIENTATIONS.iter().position(|&known| known == (turn.0 % 4, turn.1)).unwrap_or(0);
    at as u16 + 1
}

/// The same turn as Windows' flip-rotator says it, which mirrors before it turns.
fn wic(turn: Turn) -> WICBitmapTransformOptions {
    let rotate = [WICBitmapTransformRotate0, WICBitmapTransformRotate90, WICBitmapTransformRotate180, WICBitmapTransformRotate270];
    let flip = if turn.1 { WICBitmapTransformFlipHorizontal.0 } else { 0 };
    WICBitmapTransformOptions(rotate[usize::from(turn.0 % 4)].0 | flip)
}

/// A new EXIF block that says only how the picture stands.
fn exif_block(orientation: u16) -> Vec<u8> {
    let mut data = b"Exif\0\0II*\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0".to_vec();
    data.extend(orientation.to_le_bytes());
    data.extend([0; 6]);
    let mut block = vec![0xFF, 0xE1];
    block.extend(((data.len() + 2) as u16).to_be_bytes());
    block.extend(data);
    block
}

/// A JPEG turned by `by` without drawing it again: its EXIF orientation changes, and nothing
/// else. `None` if the file isn't a JPEG this can read.
pub fn turn_jpeg(bytes: &[u8], by: Turn) -> Option<Vec<u8>> {
    if !bytes.starts_with(&[0xFF, 0xD8]) {
        return None;
    }
    let mut at = 2;
    // A JFIF block must stay first, so a new EXIF block goes after it.
    let mut first_free = 2;
    while at + 4 <= bytes.len() {
        if bytes[at] != 0xFF {
            return None;
        }
        let marker = bytes[at + 1];
        if marker == 0xFF {
            at += 1;
            continue;
        }
        // The picture itself starts here, and no block of notes comes after it.
        if marker == 0xDA || marker == 0xD9 {
            break;
        }
        let length = usize::from(u16::from_be_bytes([bytes[at + 2], bytes[at + 3]]));
        let end = at + 2 + length;
        if length < 2 || end > bytes.len() {
            return None;
        }
        if marker == 0xE0 && at == first_free {
            first_free = end;
        }
        if marker == 0xE1 && bytes[at + 4..end].starts_with(b"Exif\0\0") {
            return turn_exif(bytes, at, end, by);
        }
        at = end;
    }
    let mut out = bytes[..first_free].to_vec();
    out.extend(exif_block(orientation_of(by)));
    out.extend(&bytes[first_free..]);
    Some(out)
}

/// Turns the EXIF block from `start` to `end`. Its first list of tags gets a new orientation,
/// or a copy of the list with one added, at the block's end, so nothing else in it moves.
fn turn_exif(bytes: &[u8], start: usize, end: usize, by: Turn) -> Option<Vec<u8>> {
    let tiff = start + 10;
    let little = match bytes.get(tiff..tiff + 2)? {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    let short = |at: usize| -> Option<u16> {
        let pair: [u8; 2] = bytes.get(at..at + 2)?.try_into().ok()?;
        Some(if little { u16::from_le_bytes(pair) } else { u16::from_be_bytes(pair) })
    };
    let long = |at: usize| -> Option<u32> {
        let four: [u8; 4] = bytes.get(at..at + 4)?.try_into().ok()?;
        Some(if little { u32::from_le_bytes(four) } else { u32::from_be_bytes(four) })
    };
    let put_short = |value: u16| if little { value.to_le_bytes() } else { value.to_be_bytes() };
    let list = tiff + long(tiff + 4)? as usize;
    let count = usize::from(short(list)?);
    let entries = list + 2;
    if entries + count * 12 + 4 > end {
        return None;
    }
    for index in 0..count {
        let entry = entries + index * 12;
        if short(entry)? == 0x0112 {
            if short(entry + 2)? != 3 {
                return None;
            }
            let turned = orientation_of(compose(turn_of(short(entry + 8)?), by));
            let mut out = bytes.to_vec();
            out[entry + 8..entry + 10].copy_from_slice(&put_short(turned));
            return Some(out);
        }
    }
    let mut tags: Vec<Vec<u8>> = (0..count).map(|index| bytes[entries + index * 12..entries + index * 12 + 12].to_vec()).collect();
    let mut added = Vec::with_capacity(12);
    added.extend(put_short(0x0112));
    added.extend(put_short(3));
    added.extend(if little { 1u32.to_le_bytes() } else { 1u32.to_be_bytes() });
    added.extend(put_short(orientation_of(by)));
    added.extend([0, 0]);
    tags.push(added);
    tags.sort_by_key(|tag| if little { u16::from_le_bytes([tag[0], tag[1]]) } else { u16::from_be_bytes([tag[0], tag[1]]) });
    // A list of tags starts on an even offset.
    let pad = (end - tiff) % 2;
    let offset = (end - tiff + pad) as u32;
    let mut list_bytes = vec![0; pad];
    list_bytes.extend(put_short(tags.len() as u16));
    list_bytes.extend(tags.concat());
    list_bytes.extend(&bytes[entries + count * 12..entries + count * 12 + 4]);
    let length = end - start - 2 + list_bytes.len();
    let length = u16::try_from(length).ok()?;
    let mut block = bytes[start..end].to_vec();
    block[2..4].copy_from_slice(&length.to_be_bytes());
    block[14..18].copy_from_slice(&if little { offset.to_le_bytes() } else { offset.to_be_bytes() });
    let mut out = bytes[..start].to_vec();
    out.extend(block);
    out.extend(list_bytes);
    out.extend(&bytes[end..]);
    Some(out)
}

fn failure(message: &str) -> Error {
    Error::new(E_FAIL, message)
}

unsafe fn size_of(picture: &IWICBitmapSource) -> Result<(u32, u32)> {
    let (mut width, mut height) = (0, 0);
    unsafe { picture.GetSize(&raw mut width, &raw mut height) }?;
    Ok((width, height))
}

/// Draws `source` into `target` with `edit` done, through Windows' own imaging, and gives the
/// size it came out. The pixels are turned the way the photo's EXIF says it stands, so what comes
/// out stands that way itself. Its colour profile goes with it, and what `keep` says of its facts.
pub fn write(source: &Path, target: &Path, edit: Edit, keep: Keep) -> Result<(u32, u32)> {
    let _com = Com::enter();
    unsafe {
        let factory: IWICImagingFactory = CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)?;
        let decoder = factory.CreateDecoderFromFilename(&extended(source), None, GENERIC_READ, WICDecodeMetadataCacheOnDemand)?;
        if decoder.GetFrameCount()? > 1 {
            return Err(failure("It holds more than one picture, such as frames that move, and Perli changes only single pictures."));
        }
        let frame = decoder.GetFrame(0)?;
        let mut picture: IWICBitmapSource = frame.cast()?;
        let noted = match format_of(source) {
            Some(Format::Jpeg | Format::Tiff) => standing(&frame),
            _ => None,
        };
        let stands = turn_of(noted.or_else(|| crate::inside::orientation(&frame)).unwrap_or(1));
        let turn = match edit {
            Edit::Turn { quarters, flip } => compose(stands, (quarters % 4, flip)),
            _ => stands,
        };
        if turn != (0, false) {
            let rotator = factory.CreateBitmapFlipRotator()?;
            rotator.Initialize(&picture, wic(turn))?;
            picture = rotator.cast()?;
        }
        if let Edit::Crop { left, top, width, height } = edit {
            let (whole_width, whole_height) = size_of(&picture)?;
            let (x, width) = span(left, width, whole_width);
            let (y, height) = span(top, height, whole_height);
            let rect = WICRect { X: x, Y: y, Width: width, Height: height };
            let clipper = factory.CreateBitmapClipper()?;
            clipper.Initialize(&picture, &raw const rect)?;
            picture = clipper.cast()?;
        }
        let (width, height) = size_of(&picture)?;
        let edge = match edit {
            Edit::Resize { longest } => Some(longest),
            Edit::Share => Some(SHARE_EDGE),
            _ => None,
        };
        if let Some(edge) = edge.filter(|&edge| edge > 0 && edge < width.max(height)) {
            let scale = f64::from(edge) / f64::from(width.max(height));
            let scaled = |side: u32| ((f64::from(side) * scale).round() as u32).max(1);
            let scaler = factory.CreateBitmapScaler()?;
            scaler.Initialize(&picture, scaled(width), scaled(height), WICBitmapInterpolationModeHighQualityCubic)?;
            picture = scaler.cast()?;
        }
        let format = match edit {
            Edit::Convert { format } => format,
            Edit::Share => Format::Jpeg,
            _ => format_of(source).unwrap_or(Format::Png),
        };
        let quality = if edit == Edit::Share { SHARE_QUALITY } else { QUALITY };
        let keep = if matches!(edit, Edit::Turn { .. }) { Keep::ALL } else { keep };
        let same = decoder.GetContainerFormat()? == format.container();
        encode(&factory, &picture, target, format, quality, Some((&frame, same, keep)))?;
        size_of(&picture)
    }
}

/// Where a share of a side starts and how long it is in pixels: at least one, never past the edge.
fn span(start: f32, length: f32, whole: u32) -> (i32, i32) {
    let whole = f64::from(whole);
    let from = (f64::from(start).clamp(0.0, 1.0) * whole).round().min(whole - 1.0);
    let to = (f64::from(start + length).clamp(0.0, 1.0) * whole).round().max(from + 1.0);
    (from as i32, (to - from) as i32)
}

/// Writes `picture` to `target`, with the facts `from` carries when one is given.
unsafe fn encode(
    factory: &IWICImagingFactory,
    picture: &IWICBitmapSource,
    target: &Path,
    format: Format,
    quality: f32,
    from: Option<(&IWICBitmapFrameDecode, bool, Keep)>,
) -> Result<()> {
    unsafe {
        let mut picture = picture.clone();
        let indexed = [GUID_WICPixelFormat1bppIndexed, GUID_WICPixelFormat2bppIndexed, GUID_WICPixelFormat4bppIndexed, GUID_WICPixelFormat8bppIndexed];
        // A picture with a palette needs it set on the frame, so it is drawn in full colour instead.
        if indexed.contains(&picture.GetPixelFormat()?) {
            picture = WICConvertBitmapSource(&GUID_WICPixelFormat32bppBGRA, &picture)?;
        }
        let stream = factory.CreateStream()?;
        stream.InitializeFromFilename(&extended(target), GENERIC_WRITE.0)?;
        let encoder = factory.CreateEncoder(&format.container(), std::ptr::null())?;
        encoder.Initialize(&stream, WICBitmapEncoderNoCache)?;
        let (mut frame, mut options) = (None, None);
        encoder.CreateNewFrame(&raw mut frame, &raw mut options)?;
        let frame = frame.ok_or_else(|| failure("Windows made no frame to draw into"))?;
        if let (Format::Jpeg, Some(options)) = (format, &options) {
            let name = PROPBAG2 { pstrName: PWSTR(w!("ImageQuality").as_ptr().cast_mut()), ..Default::default() };
            let mut value = VARIANT::default();
            (*value.Anonymous.Anonymous).vt = VT_R4;
            (*value.Anonymous.Anonymous).Anonymous.fltVal = quality;
            options.Write(1, &raw const name, &raw const value)?;
        }
        frame.Initialize(options.as_ref())?;
        let (width, height) = size_of(&picture)?;
        frame.SetSize(width, height)?;
        let wanted = picture.GetPixelFormat()?;
        let mut pixels = wanted;
        frame.SetPixelFormat(&raw mut pixels)?;
        if pixels != wanted {
            let converter = factory.CreateFormatConverter()?;
            converter.Initialize(&picture, &pixels, WICBitmapDitherTypeNone, None, 0.0, WICBitmapPaletteTypeCustom)?;
            picture = converter.cast()?;
        }
        if let Some((from, same, keep)) = from {
            carry(factory, from, &frame, same, keep);
        }
        frame.WriteSource(&picture, std::ptr::null())?;
        frame.Commit()?;
        encoder.Commit()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn turns_add_up_the_way_a_picture_does() {
        // Four quarter turns, or two mirrors, are no turn at all.
        assert_eq!(compose(compose((1, false), (1, false)), (2, false)), (0, false));
        assert_eq!(compose((0, true), (0, true)), (0, false));
        // A photo that stands a quarter turn right, turned right again, stands upside down.
        assert_eq!(orientation_of(compose(turn_of(6), (1, false))), 3);
        // Mirrored after a turn right is EXIF's "mirror, then turn 270".
        assert_eq!(orientation_of(compose(turn_of(6), (0, true))), 5);
        for orientation in 1..=8 {
            assert_eq!(orientation_of(turn_of(orientation)), orientation);
        }
    }

    /// The smallest JPEG start this needs: SOI, a JFIF block, then the picture.
    fn jpeg(notes: &[u8]) -> Vec<u8> {
        let mut bytes = vec![0xFF, 0xD8, 0xFF, 0xE0, 0, 4, b'J', b'F'];
        bytes.extend(notes);
        bytes.extend([0xFF, 0xDA, 0, 2, 1, 2, 3, 0xFF, 0xD9]);
        bytes
    }

    fn orientation_in(bytes: &[u8]) -> u16 {
        let found = bytes.windows(4).position(|four| four == b"\x12\x01\x03\0" || four == b"\x01\x12\0\x03").unwrap();
        let pair = [bytes[found + 8], bytes[found + 9]];
        if bytes[found] == 0x12 { u16::from_le_bytes(pair) } else { u16::from_be_bytes(pair) }
    }

    #[test]
    fn a_jpeg_turns_by_its_exif_alone() {
        // No EXIF yet: a block goes after the JFIF one, and the picture's bytes stay as they were.
        let plain = jpeg(&[]);
        let turned = turn_jpeg(&plain, (1, false)).unwrap();
        assert_eq!(&turned[..8], &plain[..8]);
        assert_eq!(&turned[8..10], &[0xFF, 0xE1]);
        assert_eq!(orientation_in(&turned), 6);
        assert!(turned.ends_with(&plain[8..]));
        // Its orientation is changed in place after that.
        let again = turn_jpeg(&turned, (1, false)).unwrap();
        assert_eq!(again.len(), turned.len());
        assert_eq!(orientation_in(&again), 3);
        assert!(turn_jpeg(b"not a jpeg", (1, false)).is_none());
    }

    #[test]
    fn exif_without_an_orientation_gets_one_and_keeps_the_rest() {
        // Big-endian EXIF whose only tag is the software that made it, pointing past the list.
        let mut data = b"Exif\0\0MM\0*\0\0\0\x08\0\x01\x01\x31\0\x02\0\0\0\x04\0\0\0\x1A\0\0\0\0".to_vec();
        data.extend(b"Cam\0");
        let mut block = vec![0xFF, 0xE1];
        block.extend(((data.len() + 2) as u16).to_be_bytes());
        block.extend(&data);
        let turned = turn_jpeg(&jpeg(&block), (2, false)).unwrap();
        assert_eq!(orientation_in(&turned), 3);
        // The software's name is still where its tag points.
        let tiff = 8 + 10;
        assert_eq!(&turned[tiff + 0x1A..tiff + 0x1E], b"Cam\0");
        // The header now points to the new list, at the end of the block, with both tags in order.
        let list = tiff + u32::from_be_bytes(turned[tiff + 4..tiff + 8].try_into().unwrap()) as usize;
        assert_eq!(&turned[list..list + 4], &[0, 2, 0x01, 0x12]);
        assert_eq!(&turned[list + 14..list + 16], &[0x01, 0x31]);
        let length = usize::from(u16::from_be_bytes([turned[10], turned[11]]));
        assert_eq!(&turned[8 + 2 + length..8 + 2 + length + 2], &[0xFF, 0xDA]);
    }

    /// A photo that stands a quarter turn right, from a camera, with the side of the world it was
    /// taken in.
    fn camera_photo(path: &Path) {
        let plain = crate::inside::tests::turned_jpeg(1);
        let old = 4 + usize::from(u16::from_be_bytes([plain[4], plain[5]]));
        let mut tiff = b"II*\0\x08\0\0\0\x03\0".to_vec();
        tiff.extend(b"\x10\x01\x02\0\x09\0\0\0\x32\0\0\0");
        tiff.extend(b"\x12\x01\x03\0\x01\0\0\0\x06\0\0\0");
        tiff.extend(b"\x25\x88\x04\0\x01\0\0\0\x3C\0\0\0");
        // The second list, at 78, holds the small picture that cameras keep for a quick look.
        tiff.extend(78u32.to_le_bytes());
        tiff.extend(b"PerliCam\0\0");
        tiff.extend(b"\x01\0\x01\0\x02\0\x02\0\0\0N\0\0\0\0\0\0\0");
        tiff.extend(b"\x02\0\x01\x02\x04\0\x01\0\0\0\x6C\0\0\0\x02\x02\x04\0\x01\0\0\0");
        tiff.extend((plain.len() as u32).to_le_bytes());
        tiff.extend([0; 4]);
        tiff.extend(&plain);
        let mut app1 = b"Exif\0\0".to_vec();
        app1.extend(tiff);
        let mut bytes = plain[..2].to_vec();
        bytes.extend([0xFF, 0xE1]);
        bytes.extend(((app1.len() + 2) as u16).to_be_bytes());
        bytes.extend(app1);
        // The town in XMP too, which no GPS block holds.
        let mut xmp = b"http://ns.adobe.com/xap/1.0/\0".to_vec();
        xmp.extend(br#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">"#);
        xmp.extend(br#"<rdf:Description rdf:about="" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/">"#);
        xmp.extend(br#"<photoshop:City>Lisbon</photoshop:City></rdf:Description></rdf:RDF></x:xmpmeta>"#);
        bytes.extend([0xFF, 0xE1]);
        bytes.extend(((xmp.len() + 2) as u16).to_be_bytes());
        bytes.extend(xmp);
        bytes.extend(&plain[old..]);
        std::fs::write(path, bytes).unwrap();
    }

    fn fact(path: &Path, name: PCWSTR) -> Option<String> {
        let _com = Com::enter();
        unsafe {
            let factory: IWICImagingFactory = CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).ok()?;
            let decoder = factory.CreateDecoderFromFilename(&extended(path), None, GENERIC_READ, WICDecodeMetadataCacheOnDemand).ok()?;
            let mut value = PROPVARIANT::default();
            decoder.GetFrame(0).ok()?.GetMetadataQueryReader().ok()?.GetMetadataByName(name, &raw mut value).ok()?;
            Some(value.to_string())
        }
    }

    #[test]
    fn copies_keep_the_camera_facts_asked_for_and_stand_as_they_show() {
        let folder = std::env::temp_dir().join(format!("perli-picture-facts-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        let photo = folder.join("photo.jpg");
        camera_photo(&photo);
        let (model, side) = (w!("System.Photo.CameraModel"), w!("System.GPS.LatitudeRef"));
        let town = w!("/xmp/photoshop:City");
        assert_eq!(fact(&photo, model).as_deref(), Some("PerliCam"));
        assert_eq!(fact(&photo, side).as_deref(), Some("N"));
        assert_eq!(fact(&photo, town).as_deref(), Some("Lisbon"));

        let small = folder.join("small.jpg");
        assert_eq!(write(&photo, &small, Edit::Resize { longest: 32 }, Keep::default()).unwrap(), (16, 32), "turned the way it shows");
        assert_eq!(fact(&small, model).as_deref(), Some("PerliCam"));
        assert_eq!(fact(&small, side), None, "the place goes by default");
        assert_eq!(fact(&small, town), None, "and so does a place in XMP");
        assert_eq!(fact(&small, ORIENTATION).as_deref(), Some("1"));

        let placed = folder.join("placed.jpg");
        write(&photo, &placed, Edit::Resize { longest: 32 }, Keep::ALL).unwrap();
        assert_eq!(fact(&placed, side).as_deref(), Some("N"));
        assert_eq!(fact(&placed, town).as_deref(), Some("Lisbon"));
        let quick_look = w!("/app1/thumb/{ushort=513}");
        assert!(fact(&photo, quick_look).is_some());
        assert_eq!(fact(&placed, quick_look), None, "the camera's small picture of the old pixels goes");
        assert_eq!(fact(&placed, model).as_deref(), Some("PerliCam"), "and only that");

        let png = folder.join("photo.png");
        write(&photo, &png, Edit::Convert { format: Format::Png }, Keep::default()).unwrap();
        assert_eq!(fact(&png, model).as_deref(), Some("PerliCam"), "a PNG keeps them in XMP");

        let tiff = folder.join("photo.tif");
        write(&photo, &tiff, Edit::Convert { format: Format::Tiff }, Keep::default()).unwrap();
        assert_eq!(fact(&tiff, model).as_deref(), Some("PerliCam"), "facts go over to another format");
        assert_eq!(fact(&tiff, side), None);

        let bare = folder.join("bare.jpg");
        write(&photo, &bare, Edit::Share, Keep { camera: false, place: true }).unwrap();
        assert_eq!(fact(&bare, model), None);
        assert_eq!(fact(&bare, side), None, "no place without the camera facts");
        std::fs::remove_dir_all(folder).unwrap();
    }


    #[test]
    fn copies_are_named_for_what_they_are() {
        let photo = Path::new(r"C:\a\Trip.JPG");
        assert_eq!(copy_name(photo, Edit::Resize { longest: 800 }, (800, 600)), ("Trip (800×600)".into(), ".jpg".into()));
        assert_eq!(copy_name(photo, Edit::Convert { format: Format::Png }, (1, 1)), ("Trip".into(), ".png".into()));
        assert_eq!(copy_name(Path::new("x.webp"), Edit::Share, (1, 1)), ("x (to share)".into(), ".jpg".into()));
        assert_eq!(copy_name(photo, Edit::Crop { left: 0.0, top: 0.0, width: 1.0, height: 1.0 }, (1, 1)), ("Trip (cropped)".into(), ".jpg".into()));
        assert_eq!(span(0.25, 0.5, 64), (16, 32));
        assert_eq!(span(0.9, 0.5, 10), (9, 1), "past the edge it stops there");
        assert_eq!(span(1.0, 0.0, 10), (9, 1), "never nothing");
        assert_eq!(copy_name(Path::new("x.webp"), Edit::Resize { longest: 9 }, (9, 9)).1, ".png");
        assert!(refusal(Path::new("x.webp"), Edit::Turn { quarters: 1, flip: false }).is_some());
        assert!(refusal(Path::new("x.png"), Edit::Turn { quarters: 1, flip: false }).is_none());
    }
}
