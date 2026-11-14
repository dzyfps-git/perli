//! Sound files the webview cannot take as they are: AIFF, which it does not play, and the cover
//! inside a FLAC, which Windows does not show.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use windows::core::HSTRING;
use windows::Win32::Media::MediaFoundation::{
    MFAudioFormat_Float, MFCreateMediaType, MFCreateSourceReaderFromURL, MFMediaType_Audio, MFShutdown, MFStartup,
    MFSTARTUP_LITE, MF_MT_AUDIO_NUM_CHANNELS, MF_MT_AUDIO_SAMPLES_PER_SECOND, MF_MT_MAJOR_TYPE, MF_MT_SUBTYPE,
    MF_PD_DURATION, MF_SOURCE_READERF_ENDOFSTREAM, MF_SOURCE_READER_ALL_STREAMS, MF_SOURCE_READER_FIRST_AUDIO_STREAM,
    MF_SOURCE_READER_MEDIASOURCE, MF_VERSION,
};
use windows::Win32::System::Com::StructuredStorage::PropVariantToUInt64;

/// The player holds the whole sound in memory, so a file past this is left to its own app.
const MOST_AIFF_BYTES: u64 = 512 << 20;
const MOST_COVER_BYTES: u32 = 32 << 20;
const FLAC_PICTURE: u8 = 6;
const NOT_AIFF: &str = "This AIFF file can't be read";

fn be32(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

fn be16(bytes: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes(bytes.get(at..at + 2)?.try_into().ok()?))
}

/// The sample rate, which AIFF keeps as an 80-bit float.
fn rate_of(bytes: &[u8]) -> Option<u32> {
    let exponent = i32::from(be16(bytes, 0)? & 0x7fff) - 16383 - 63;
    let mantissa = u64::from_be_bytes(bytes.get(2..10)?.try_into().ok()?);
    let rate = mantissa as f64 * 2f64.powi(exponent);
    (1.0..=768_000.0).contains(&rate).then(|| rate.round() as u32)
}

/// An AIFF file read whole, for `aiff_to_wav`.
pub fn read_aiff(path: &Path) -> Result<Vec<u8>, String> {
    let size = std::fs::metadata(path).map_err(|error| error.to_string())?.len();
    if size > MOST_AIFF_BYTES {
        return Err("This AIFF file is too big to play here".into());
    }
    std::fs::read(path).map_err(|error| error.to_string())
}

/// The same sound as a WAV. Only plain samples are taken: AIFF, and AIFF-C marked `NONE` or
/// `sowt`. A packed AIFF-C is refused.
pub fn aiff_to_wav(aiff: &[u8]) -> Result<Vec<u8>, String> {
    let bad = || NOT_AIFF.to_string();
    let compressed = match (aiff.get(..4), aiff.get(8..12)) {
        (Some(b"FORM"), Some(b"AIFF")) => false,
        (Some(b"FORM"), Some(b"AIFC")) => true,
        _ => return Err(bad()),
    };
    let (mut format, mut samples) = (None, None);
    let mut at = 12;
    while let (Some(id), Some(size)) = (aiff.get(at..at + 4), be32(aiff, at + 4)) {
        let body = at + 8;
        // A file cut short still plays what it has.
        let end = body.saturating_add(size as usize).min(aiff.len());
        match id {
            b"COMM" => {
                let channels = be16(aiff, body).ok_or_else(bad)?;
                let bits = be16(aiff, body + 6).ok_or_else(bad)?;
                let rate = aiff.get(body + 8..body + 18).and_then(rate_of).ok_or_else(bad)?;
                let little = match aiff.get(body + 18..body + 22) {
                    _ if !compressed => false,
                    Some(b"NONE") => false,
                    Some(b"sowt") => true,
                    _ => return Err("This AIFF file is packed in a way Perli can't play".into()),
                };
                format = Some((channels, bits, rate, little));
            }
            b"SSND" => {
                let offset = be32(aiff, body).ok_or_else(bad)? as usize;
                samples = aiff.get((body + 8).saturating_add(offset).min(end)..end);
            }
            _ => {}
        }
        // Chunks start on even bytes.
        at = body.saturating_add(size as usize + (size as usize & 1));
    }
    let ((channels, bits, rate, little), samples) = format.zip(samples).ok_or_else(bad)?;
    let width = usize::from(bits.div_ceil(8));
    if channels == 0 || !(1..=4).contains(&width) {
        return Err(bad());
    }
    let frame = width * usize::from(channels);
    let samples = &samples[..samples.len() - samples.len() % frame];

    let mut wav = Vec::with_capacity(44 + samples.len());
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + samples.len() as u32).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
    wav.extend_from_slice(&channels.to_le_bytes());
    wav.extend_from_slice(&rate.to_le_bytes());
    wav.extend_from_slice(&(rate * frame as u32).to_le_bytes());
    wav.extend_from_slice(&(frame as u16).to_le_bytes());
    wav.extend_from_slice(&(width as u16 * 8).to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&(samples.len() as u32).to_le_bytes());
    match width {
        // A WAV's single bytes count up from zero, an AIFF's around it.
        1 => wav.extend(samples.iter().map(|byte| byte ^ 0x80)),
        _ if little => wav.extend_from_slice(samples),
        _ => samples.chunks_exact(width).for_each(|sample| wav.extend(sample.iter().rev())),
    }
    Ok(wav)
}

/// The picture a FLAC file carries, as the JPEG or PNG it is, or nothing if it has none.
pub fn flac_cover(path: &Path) -> Option<Vec<u8>> {
    let mut file = File::open(path).ok()?;
    let mut mark = [0; 4];
    file.read_exact(&mut mark).ok()?;
    if &mark != b"fLaC" {
        return None;
    }
    loop {
        let mut header = [0; 4];
        file.read_exact(&mut header).ok()?;
        let size = u32::from_be_bytes([0, header[1], header[2], header[3]]);
        if header[0] & 0x7f == FLAC_PICTURE && size <= MOST_COVER_BYTES {
            let mut block = vec![0; size as usize];
            file.read_exact(&mut block).ok()?;
            // Kind, then the type and the description, each with its length, then four numbers.
            let mut at = 4;
            at += 4 + be32(&block, at)? as usize;
            at += 4 + be32(&block, at)? as usize;
            at += 16;
            let length = be32(&block, at)? as usize;
            return block.get(at + 4..at + 4 + length).map(<[u8]>::to_vec);
        }
        if header[0] & 0x80 != 0 {
            return None;
        }
        file.seek(SeekFrom::Current(i64::from(size))).ok()?;
    }
}

/// The loudest point of each of `bars` even slices of a sound, from 0 to 1. Windows' own
/// decoders read it a little at a time, so a song of any length takes little memory.
pub fn peaks(path: &Path, bars: usize) -> Result<Vec<f32>, String> {
    let bars = bars.clamp(1, 4096);
    let _com = crate::ops::Com::enter();
    unsafe { MFStartup(MF_VERSION, MFSTARTUP_LITE) }.map_err(|error| error.message())?;
    let peaks = unsafe { read_peaks(path, bars) }.map_err(|error| error.message());
    unsafe {
        let _ = MFShutdown();
    }
    peaks
}

unsafe fn read_peaks(path: &Path, bars: usize) -> windows::core::Result<Vec<f32>> {
    const AUDIO: u32 = MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32;
    unsafe {
        let reader = MFCreateSourceReaderFromURL(&HSTRING::from(path.as_os_str()), None)?;
        reader.SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false)?;
        reader.SetStreamSelection(AUDIO, true)?;
        let wanted = MFCreateMediaType()?;
        wanted.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
        wanted.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_Float)?;
        reader.SetCurrentMediaType(AUDIO, None, &wanted)?;
        let format = reader.GetCurrentMediaType(AUDIO)?;
        let channels = format.GetUINT32(&MF_MT_AUDIO_NUM_CHANNELS)?.max(1) as usize;
        let rate = u64::from(format.GetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND)?);
        // In steps of 100 nanoseconds.
        let length = PropVariantToUInt64(&reader.GetPresentationAttribute(MF_SOURCE_READER_MEDIASOURCE.0 as u32, &MF_PD_DURATION)?)?;
        let frames = (u128::from(length) * u128::from(rate) / 10_000_000).max(1);
        let mut peaks = vec![0f32; bars];
        let mut frame = 0u128;
        loop {
            let (mut flags, mut sample) = (0u32, None);
            reader.ReadSample(AUDIO, 0, None, Some(&mut flags), None, Some(&mut sample))?;
            if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
                break;
            }
            let Some(sample) = sample else { continue };
            let buffer = sample.ConvertToContiguousBuffer()?;
            let (mut data, mut size) = (std::ptr::null_mut(), 0u32);
            buffer.Lock(&mut data, None, Some(&mut size))?;
            let values = std::slice::from_raw_parts(data.cast::<f32>(), size as usize / 4);
            for one in values.chunks(channels) {
                let bar = ((frame * bars as u128 / frames) as usize).min(bars - 1);
                peaks[bar] = one.iter().fold(peaks[bar], |loudest, value| loudest.max(value.abs()));
                frame += 1;
            }
            buffer.Unlock()?;
        }
        let top = peaks.iter().copied().fold(0.01, f32::max);
        Ok(peaks.into_iter().map(|peak| peak / top).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_long_sound_gives_its_peaks_without_being_read_whole() {
        // One second of quiet, then one of a loud square wave, as 16-bit samples.
        let quiet = vec![0u8; 44100 * 2];
        let loud: Vec<u8> = (0..44100).flat_map(|at: i32| if at % 100 < 50 { 0x6000i16 } else { -0x6000 }.to_be_bytes()).collect();
        let wav = aiff_to_wav(&aiff(b"AIFF", &[], 16, &[quiet, loud].concat())).unwrap();
        let file = std::env::temp_dir().join(format!("perli-peaks-{}.wav", std::process::id()));
        std::fs::write(&file, wav).unwrap();
        let peaks = peaks(&file, 4).unwrap();
        std::fs::remove_file(file).unwrap();
        assert_eq!(peaks.len(), 4);
        assert!(peaks[0] < 0.01 && peaks[1] < 0.01, "{peaks:?}");
        assert!(peaks[2] > 0.99 && peaks[3] > 0.99, "{peaks:?}");
    }

    fn chunk(id: &[u8], body: &[u8]) -> Vec<u8> {
        let mut chunk = [id, &(body.len() as u32).to_be_bytes(), body].concat();
        chunk.resize(chunk.len() + body.len() % 2, 0);
        chunk
    }

    /// 44100 as AIFF writes it.
    const RATE: [u8; 10] = [0x40, 0x0e, 0xac, 0x44, 0, 0, 0, 0, 0, 0];

    fn aiff(kind: &[u8], comm_tail: &[u8], bits: u16, samples: &[u8]) -> Vec<u8> {
        let comm = [&1u16.to_be_bytes()[..], &2u32.to_be_bytes(), &bits.to_be_bytes(), &RATE, comm_tail].concat();
        let body = [kind, &chunk(b"NAME", b"odd"), &chunk(b"COMM", &comm), &chunk(b"SSND", &[&[0; 8], samples].concat())].concat();
        [b"FORM", &(body.len() as u32).to_be_bytes()[..], &body].concat()
    }

    #[test]
    fn aiff_samples_turn_around_into_a_wav() {
        let wav = aiff_to_wav(&aiff(b"AIFF", &[], 16, &[0x12, 0x34, 0xab, 0xcd])).unwrap();
        assert_eq!(&wav[..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(wav[4..8].try_into().unwrap()) as usize, wav.len() - 8);
        assert_eq!(u16::from_le_bytes(wav[22..24].try_into().unwrap()), 1, "channels");
        assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 44100);
        assert_eq!(&wav[44..], [0x34, 0x12, 0xcd, 0xab]);

        let little = aiff_to_wav(&aiff(b"AIFC", b"sowt", 16, &[0x12, 0x34, 0xab, 0xcd])).unwrap();
        assert_eq!(&little[44..], [0x12, 0x34, 0xab, 0xcd], "already the way a WAV wants it");
        let bytes = aiff_to_wav(&aiff(b"AIFF", &[], 8, &[0x00, 0x7f])).unwrap();
        assert_eq!(&bytes[44..], [0x80, 0xff], "single bytes move up");
    }

    #[test]
    fn what_is_no_plain_aiff_is_refused() {
        assert_eq!(aiff_to_wav(b"RIFF\0\0\0\0WAVE").unwrap_err(), NOT_AIFF);
        assert_eq!(aiff_to_wav(b"FORM").unwrap_err(), NOT_AIFF);
        assert!(aiff_to_wav(&aiff(b"AIFC", b"ima4", 16, &[0; 4])).unwrap_err().contains("packed"));
        assert_eq!(aiff_to_wav(&aiff(b"AIFF", &[], 64, &[0; 8])).unwrap_err(), NOT_AIFF);
    }

    #[test]
    fn a_flac_gives_its_picture_and_nothing_else() {
        let folder = std::env::temp_dir().join(format!("perli-sound-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        let block = |kind: u8, body: &[u8]| [&[kind], &(body.len() as u32).to_be_bytes()[1..], body].concat();
        let picture = [
            &3u32.to_be_bytes()[..],
            &9u32.to_be_bytes(),
            b"image/png",
            &5u32.to_be_bytes(),
            b"front",
            &[0; 16],
            &4u32.to_be_bytes(),
            b"\x89PNG",
        ]
        .concat();

        let with = folder.join("with.flac");
        std::fs::write(&with, [&b"fLaC"[..], &block(0, &[0; 34]), &block(0x80 | FLAC_PICTURE, &picture), b"sound"].concat()).unwrap();
        assert_eq!(flac_cover(&with).unwrap(), b"\x89PNG");

        let without = folder.join("without.flac");
        std::fs::write(&without, [&b"fLaC"[..], &block(0x80, &[0; 34]), b"sound"].concat()).unwrap();
        assert_eq!(flac_cover(&without), None);
        std::fs::write(&without, b"fLaC\x06\0\0\x40cut").unwrap();
        assert_eq!(flac_cover(&without), None, "a cut-off file");
        std::fs::write(&without, b"ID3 not flac").unwrap();
        assert_eq!(flac_cover(&without), None);
        std::fs::remove_dir_all(&folder).unwrap();
    }
}
