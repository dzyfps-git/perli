//! MIDI files played through the bundled SoundFont. The song becomes one WAV, made a block at a
//! time into a temp file while the page's own audio player streams it, so it plays at once, and
//! pausing, seeking and volume need nothing here.

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::BufReader;
use std::os::windows::fs::{FileExt, OpenOptionsExt};
use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::time::SystemTime;

use windows::Win32::Storage::FileSystem::{FILE_ATTRIBUTE_TEMPORARY, FILE_FLAG_DELETE_ON_CLOSE};

use serde::{Deserialize, Serialize};
use rustysynth::{MidiFile, MidiFileSequencer, SoundFont, Synthesizer, SynthesizerSettings};
use tauri::http::Response;

/// The SoundFont beside perli.exe. Its license is in TimGM6mb-LICENSE.txt beside it.
pub const SOUND_FONT: &str = "TimGM6mb.sf2";
const RATE: u32 = 44_100;
const CHANNELS: u16 = 2;
const SAMPLE_BYTES: u16 = 2;
/// Long enough for the last notes to fade out.
const TAIL_SECONDS: f64 = 2.0;
/// A WAV counts its bytes in 32 bits, so it holds at most 4 GB, a little over six and a half hours.
const MOST_SECONDS: f64 = 6.0 * 60.0 * 60.0;
/// How far making the song runs ahead of what the window has asked for, so a long song played
/// for a minute fills no gigabytes of disk. About 53 MB.
const AHEAD_BYTES: usize = 5 * 60 * RATE as usize * 4;
const BLOCK_FRAMES: usize = 4096;
const WAV_HEADER_BYTES: usize = 44;

/// How a song is played: which channels stay silent (one bit each), how many keys its notes move
/// up or down, and how fast it goes.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(default)]
pub struct Playing {
    pub muted: u16,
    pub transpose: i8,
    pub speed: f64,
}

impl Default for Playing {
    fn default() -> Self {
        Self { muted: 0, transpose: 0, speed: 1.0 }
    }
}

const SLOWEST: f64 = 0.25;
const FASTEST: f64 = 4.0;

/// The song as a 16-bit stereo WAV, made on another thread while the window plays its start.
pub fn stream(sound_font: &Path, song: &Path, playing: Playing) -> Result<Arc<Stream>, String> {
    let font = SoundFont::new(&mut BufReader::new(File::open(sound_font).map_err(|error| error.to_string())?))
        .map_err(|error| format!("The SoundFont can't be read: {error}"))?;
    let mut bytes = std::fs::read(song).map_err(|error| error.to_string())?;
    patch(&mut bytes, playing.muted, playing.transpose);
    let song = MidiFile::new(&mut &bytes[..]).map_err(|error| format!("This MIDI file can't be read: {error}"))?;
    let speed = if playing.speed.is_finite() { playing.speed.clamp(SLOWEST, FASTEST) } else { 1.0 };
    let seconds = (song.get_length() / speed + TAIL_SECONDS).min(MOST_SECONDS);
    let frames = (seconds * f64::from(RATE)) as usize;
    let synthesizer = Synthesizer::new(&Arc::new(font), &SynthesizerSettings::new(RATE as i32))
        .map_err(|error| error.to_string())?;
    let mut sequencer = MidiFileSequencer::new(synthesizer);
    sequencer.play(&Arc::new(song), false);
    sequencer.set_speed(speed);

    let header = wav_header(frames);
    let total = header.len() + frames * usize::from(CHANNELS * SAMPLE_BYTES);
    let file = temp_wav().map_err(|error| error.to_string())?;
    write_at(&file, &header, 0).map_err(|error| error.to_string())?;
    let made = Made { bytes: header.len(), ended: false, asked: 0 };
    let stream = Arc::new(Stream { file, made: Mutex::new(made), grown: Condvar::new(), total });
    let filling = Arc::clone(&stream);
    std::thread::spawn(move || {
        // A broken file can trip the synthesizer's own checks. The song then ends where it got to.
        let _ = std::panic::catch_unwind(AssertUnwindSafe(|| fill(&mut sequencer, frames, &filling)));
        filling.lock().ended = true;
        filling.grown.notify_all();
    });
    Ok(stream)
}

fn fill(sequencer: &mut MidiFileSequencer, frames: usize, stream: &Arc<Stream>) {
    let (mut left, mut right) = (vec![0.0; BLOCK_FRAMES], vec![0.0; BLOCK_FRAMES]);
    let mut block = Vec::with_capacity(BLOCK_FRAMES * 4);
    let mut done = 0;
    // Once the window lets go of the song, nothing else holds it, and making it stops.
    while done < frames && Arc::strong_count(stream) > 1 {
        let count = BLOCK_FRAMES.min(frames - done);
        sequencer.render(&mut left[..count], &mut right[..count]);
        block.clear();
        for (l, r) in left[..count].iter().zip(&right[..count]) {
            block.extend_from_slice(&sample(*l));
            block.extend_from_slice(&sample(*r));
        }
        // Far enough ahead waits for the window to ask for more, or to let go.
        let made = stream.grown.wait_while(stream.lock(), |made| made.bytes > made.asked + AHEAD_BYTES && !made.ended);
        let at = made.unwrap_or_else(PoisonError::into_inner).bytes;
        if write_at(&stream.file, &block, at).is_err() {
            return;
        }
        let mut made = stream.lock();
        // Let go of, so nothing more is made.
        if made.ended {
            return;
        }
        made.bytes += block.len();
        drop(made);
        stream.grown.notify_all();
        done += count;
    }
}

static TEMP_NUMBER: AtomicU64 = AtomicU64::new(0);

/// A temp file Windows deletes once its last handle closes, even if Perli ends without asking.
fn temp_wav() -> std::io::Result<File> {
    let number = TEMP_NUMBER.fetch_add(1, Ordering::Relaxed);
    let path = std::env::temp_dir().join(format!("perli-song-{}-{number}.wav", std::process::id()));
    OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .attributes(FILE_ATTRIBUTE_TEMPORARY.0)
        .custom_flags(FILE_FLAG_DELETE_ON_CLOSE.0)
        .open(path)
}

fn write_at(file: &File, mut bytes: &[u8], mut at: usize) -> std::io::Result<()> {
    while !bytes.is_empty() {
        let wrote = file.seek_write(bytes, at as u64)?;
        bytes = &bytes[wrote..];
        at += wrote;
    }
    Ok(())
}

fn read_at(file: &File, mut into: &mut [u8], mut at: usize) -> std::io::Result<()> {
    while !into.is_empty() {
        let read = file.seek_read(into, at as u64)?;
        if read == 0 {
            return Err(std::io::ErrorKind::UnexpectedEof.into());
        }
        into = &mut into[read..];
        at += read;
    }
    Ok(())
}

/// How far a song's WAV has got.
struct Made {
    bytes: usize,
    /// Making it has ended, all of it or not.
    ended: bool,
    /// The furthest byte the window has asked for.
    asked: usize,
}

/// A song being made into a WAV a block at a time. The window plays it as it grows.
pub struct Stream {
    file: File,
    made: Mutex<Made>,
    grown: Condvar,
    /// How long the whole WAV is.
    total: usize,
}

/// The most of a song one ask gets. The window asks again for the rest.
const CHUNK_BYTES: usize = 1 << 20;

impl Stream {
    fn lock(&self) -> std::sync::MutexGuard<'_, Made> {
        self.made.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Ends the making, and wakes every ask still waiting with what there is.
    fn stop(&self) {
        self.lock().ended = true;
        self.grown.notify_all();
    }

    /// The bytes from `start` up to `end`, waiting until they are made.
    fn read(&self, start: usize, end: usize) -> Vec<u8> {
        let mut made = self.lock();
        if end > made.asked {
            made.asked = end;
            self.grown.notify_all();
        }
        let made = self.grown.wait_while(made, |made| made.bytes < end && !made.ended);
        let end = end.min(made.unwrap_or_else(PoisonError::into_inner).bytes);
        let mut body = vec![0; end.saturating_sub(start)];
        if read_at(&self.file, &mut body, start).is_err() {
            body.clear();
        }
        body
    }

    /// The answer to the window's ask for a part of the song, by an HTTP `Range` such as `bytes=0-`.
    pub fn answer(&self, range: Option<&str>) -> Response<Vec<u8>> {
        let total = self.total;
        let asked = range.and_then(|range| range.strip_prefix("bytes=")).and_then(|range| range.split_once('-'));
        let (start, end) = match asked {
            Some(("", last)) => (total.saturating_sub(last.parse().unwrap_or(0)), total),
            Some((first, last)) => (first.parse().unwrap_or(usize::MAX), last.parse::<usize>().map_or(total, |last| last.saturating_add(1))),
            None => (0, total),
        };
        let body = if start < total { self.read(start, end.min(total).min(start + CHUNK_BYTES)) } else { Vec::new() };
        if body.is_empty() {
            return Response::builder().status(416).header("Content-Range", format!("bytes */{total}")).body(Vec::new()).unwrap();
        }
        Response::builder()
            .status(206)
            .header("Content-Type", "audio/wav")
            .header("Accept-Ranges", "bytes")
            .header("Content-Range", format!("bytes {start}-{}/{total}", start + body.len() - 1))
            .body(body)
            .unwrap()
    }
}

/// The songs being made, by number, until the window lets go of each.
#[derive(Default)]
pub struct Streams {
    next: AtomicU64,
    songs: Mutex<HashMap<u64, Arc<Stream>>>,
}

impl Streams {
    fn songs(&self) -> std::sync::MutexGuard<'_, HashMap<u64, Arc<Stream>>> {
        self.songs.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn add(&self, stream: Arc<Stream>) -> u64 {
        let number = self.next.fetch_add(1, Ordering::Relaxed);
        self.songs().insert(number, stream);
        number
    }

    pub fn get(&self, number: u64) -> Option<Arc<Stream>> {
        self.songs().get(&number).cloned()
    }

    /// A seek far ahead can still hold the song, so it stops here rather than when the last
    /// hold goes.
    pub fn forget(&self, number: u64) {
        if let Some(stream) = self.songs().remove(&number) {
            stream.stop();
        }
    }
}

/// Silences the muted channels and moves every note but the drums by `transpose` keys. Each
/// change keeps its byte where it is, so nothing else in the file moves.
fn patch(bytes: &mut [u8], muted: u16, transpose: i8) {
    if muted == 0 && transpose == 0 {
        return;
    }
    let word = |bytes: &[u8], at: usize| bytes.get(at..at + 4).map(|piece| u32::from_be_bytes(piece.try_into().unwrap()) as usize);
    let Some(header) = word(bytes, 4) else { return };
    let mut at = 8usize.saturating_add(header);
    while let Some(length) = word(bytes, at + 4) {
        let end = at.saturating_add(8).saturating_add(length).min(bytes.len());
        if &bytes[at..at + 4] == b"MTrk" {
            patch_track(&mut bytes[at + 8..end], muted, transpose);
        }
        at = end;
    }
}

fn patch_track(body: &mut [u8], muted: u16, transpose: i8) {
    // A MIDI variable-length number, as `Reader::number` reads it.
    let number = |body: &[u8], at: &mut usize| -> Option<usize> {
        let mut value = 0usize;
        for _ in 0..4 {
            let byte = *body.get(*at)?;
            *at += 1;
            value = (value << 7) | usize::from(byte & 0x7F);
            if byte & 0x80 == 0 {
                return Some(value);
            }
        }
        None
    };
    let (mut at, mut running) = (0usize, 0u8);
    while number(body, &mut at).is_some() {
        let Some(&first) = body.get(at) else { return };
        // A byte under 0x80 is already the event's first data byte: the status is the last one.
        let status = if first < 0x80 {
            running
        } else {
            at += 1;
            first
        };
        match status {
            0xFF => {
                at += 1;
                let Some(length) = number(body, &mut at) else { return };
                at = at.saturating_add(length);
            }
            0xF0 | 0xF7 => {
                let Some(length) = number(body, &mut at) else { return };
                at = at.saturating_add(length);
            }
            0x80..=0xEF => {
                running = status;
                let (kind, channel) = (status & 0xF0, status & 0x0F);
                if matches!(kind, 0x80 | 0x90 | 0xA0) {
                    if channel != DRUM_CHANNEL {
                        if let Some(key) = body.get_mut(at) {
                            *key = (i16::from(*key) + i16::from(transpose)).clamp(0, 127) as u8;
                        }
                    }
                    if kind == 0x90 && muted & (1 << channel) != 0 {
                        if let Some(loudness) = body.get_mut(at + 1) {
                            *loudness = 0;
                        }
                    }
                }
                at += if matches!(kind, 0xC0 | 0xD0) { 1 } else { 2 };
            }
            _ => return,
        }
    }
}

fn sample(value: f32) -> [u8; 2] {
    ((value.clamp(-1.0, 1.0) * f32::from(i16::MAX)) as i16).to_le_bytes()
}

fn wav_header(frames: usize) -> Vec<u8> {
    let frame_bytes = u32::from(CHANNELS * SAMPLE_BYTES);
    let data = frames as u32 * frame_bytes;
    let mut wav = Vec::with_capacity(WAV_HEADER_BYTES + data as usize);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(data + WAV_HEADER_BYTES as u32 - 8).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
    wav.extend_from_slice(&CHANNELS.to_le_bytes());
    wav.extend_from_slice(&RATE.to_le_bytes());
    wav.extend_from_slice(&(RATE * frame_bytes).to_le_bytes());
    wav.extend_from_slice(&(frame_bytes as u16).to_le_bytes());
    wav.extend_from_slice(&(SAMPLE_BYTES * 8).to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data.to_le_bytes());
    wav
}

/// One note: start and length in seconds, key, and channel.
type Note = (f32, f32, u8, u8);

/// What the player shows beside the sound: the song's name, its instruments and its notes.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SongInfo {
    title: Option<String>,
    /// General MIDI programs, in the order they first play. Drums are `DRUMS`.
    instruments: Vec<u8>,
    /// Each channel that plays and the instrument it starts with, in the order they first play.
    channels: Vec<(u8, u8)>,
    /// In order of start. A big song has millions, so the window asks for a few seconds of them
    /// at a time, by `notes_between`.
    #[serde(skip)]
    notes: Vec<Note>,
    /// When each beat falls, in seconds.
    beats: Vec<f32>,
    /// When each bar starts, in seconds, following the song's time signatures.
    bars: Vec<f32>,
    /// The lowest and highest key played, so the keyboard is laid out before any notes come.
    low: u8,
    high: u8,
    /// The longest note, in seconds: notes that started this long before a time can still sound.
    longest: f32,
    /// When the last note ends, in seconds.
    end: f32,
    /// Notes past what fits in the memory free, which the song still plays but doesn't show.
    left_out: u64,
}

/// Packs notes as columns of little-endian numbers: every start, every length, every key, every
/// channel. The window reads each column in place.
fn pack(notes: &[Note]) -> Vec<u8> {
    let mut packed = Vec::with_capacity(notes.len() * 10);
    packed.extend(notes.iter().flat_map(|note| note.0.to_le_bytes()));
    packed.extend(notes.iter().flat_map(|note| note.1.to_le_bytes()));
    packed.extend(notes.iter().map(|note| note.2));
    packed.extend(notes.iter().map(|note| note.3));
    packed
}

/// The most columns the song's overview strip can ask for.
const MOST_COLUMNS: usize = 4000;

impl SongInfo {
    /// The notes that may sound at some time from `from` to `to` seconds, packed by `pack`.
    pub fn notes_between(&self, from: f32, to: f32) -> Vec<u8> {
        let first = self.notes.partition_point(|note| note.0 < from - self.longest);
        let last = first + self.notes[first..].partition_point(|note| note.0 < to);
        pack(&self.notes[first..last])
    }

    /// Where notes sound across the whole song, in `columns` slices of it up to `end`: each key
    /// and channel once a column, however many notes. As columns: every column (16 bits), every
    /// key, every channel.
    pub fn overview(&self, columns: usize) -> Vec<u8> {
        let columns = columns.clamp(1, MOST_COLUMNS);
        let mut seen = vec![false; columns * 128 * 16];
        let end = self.end.max(f32::MIN_POSITIVE);
        let column = |seconds: f32| ((seconds / end * columns as f32) as usize).min(columns - 1);
        for &(start, long, key, channel) in &self.notes {
            for at in column(start)..=column(start + long) {
                seen[(at * 128 + usize::from(key & 0x7F)) * 16 + usize::from(channel & 0x0F)] = true;
            }
        }
        let found: Vec<usize> = seen.iter().enumerate().filter_map(|(index, seen)| seen.then_some(index)).collect();
        let mut packed = Vec::with_capacity(found.len() * 4);
        packed.extend(found.iter().flat_map(|index| ((index / (128 * 16)) as u16).to_le_bytes()));
        packed.extend(found.iter().map(|index| (index / 16 % 128) as u8));
        packed.extend(found.iter().map(|index| (index % 16) as u8));
        packed
    }
}

/// The song last shown, so the window's asks for its notes need no second read of the file.
#[derive(Clone, Default)]
pub struct Songs(Arc<Mutex<Option<Shown>>>);

/// A song's path, when it last changed, and what was read of it.
type Shown = (PathBuf, Option<SystemTime>, Arc<SongInfo>);

impl Songs {
    /// Blocks while a big song is read, so a second ask for it waits for the first.
    pub fn song(&self, path: &Path) -> Result<Arc<SongInfo>, String> {
        let changed = std::fs::metadata(path).and_then(|meta| meta.modified()).ok();
        let mut last = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some((known, when, song)) = last.as_ref() {
            if known == path && *when == changed {
                return Ok(Arc::clone(song));
            }
        }
        let song = Arc::new(info(path)?);
        *last = Some((path.to_path_buf(), changed, Arc::clone(&song)));
        Ok(song)
    }
}

pub const DRUMS: u8 = 128;
const DRUM_CHANNEL: u8 = 9;
const MOST_BEATS: usize = 20_000;
const DEFAULT_TEMPO: f64 = 500_000.0;

enum Event {
    Tempo(u32),
    On { channel: u8, key: u8 },
    Off { channel: u8, key: u8 },
    Program { channel: u8, program: u8 },
    /// A time signature: so many notes a bar, each a 2 to the `power` part of a whole note.
    Meter { count: u8, power: u8 },
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, count: usize) -> Option<&'a [u8]> {
        let piece = self.bytes.get(self.at..self.at.checked_add(count)?)?;
        self.at += count;
        Some(piece)
    }
    fn byte(&mut self) -> Option<u8> {
        self.take(1).map(|piece| piece[0])
    }
    fn u16(&mut self) -> Option<u16> {
        self.take(2).map(|piece| u16::from_be_bytes([piece[0], piece[1]]))
    }
    fn u32(&mut self) -> Option<u32> {
        self.take(4).map(|piece| u32::from_be_bytes(piece.try_into().unwrap()))
    }
    /// A MIDI variable-length number: seven bits a byte, high bit set on all but the last.
    fn number(&mut self) -> Option<u32> {
        let mut value = 0u32;
        for _ in 0..4 {
            let byte = self.byte()?;
            value = (value << 7) | u32::from(byte & 0x7F);
            if byte & 0x80 == 0 {
                return Some(value);
            }
        }
        None
    }
}

/// The song's name, instruments and notes. A track cut short keeps what came before the cut.
pub fn info(song: &Path) -> Result<SongInfo, String> {
    let bytes = std::fs::read(song).map_err(|error| error.to_string())?;
    read_info(&bytes).ok_or_else(|| "This MIDI file can't be read".into())
}

fn read_info(bytes: &[u8]) -> Option<SongInfo> {
    read_song(bytes, most_notes())
}

/// The song in `bytes`, with at most `room` of its notes.
fn read_song(bytes: &[u8], room: usize) -> Option<SongInfo> {
    let mut file = Reader { bytes, at: 0 };
    if file.take(4)? != b"MThd" {
        return None;
    }
    let header = file.u32()? as usize;
    let _format = file.u16()?;
    let tracks = file.u16()?;
    let division = file.u16()?;
    file.take(header.checked_sub(6)?)?;

    let mut bodies = Vec::new();
    for track in 0..tracks {
        let (Some(kind), Some(length)) = (file.take(4), file.u32()) else { break };
        let Some(body) = file.take(length as usize).or_else(|| file.bytes.get(file.at..)) else { break };
        if kind == b"MTrk" {
            bodies.push((track, body));
        }
    }

    // A song can hold hundreds of millions of notes, so each track is read twice instead of all
    // its events being kept: first for what times the song and sets its instruments, which are
    // few, then for the notes.
    let mut title = None;
    let (mut timed, mut last, mut starts) = (Vec::new(), 0u64, 0usize);
    for &(track, body) in &bodies {
        read_track(body, if track == 0 { Some(&mut title) } else { None }, |tick, event| {
            last = last.max(tick);
            match event {
                Event::On { .. } => starts += 1,
                Event::Off { .. } => {}
                _ => timed.push((tick, event)),
            }
        });
    }
    timed.sort_by_key(|(tick, _)| *tick);

    let (beats, bars) = beats_and_bars(division, &timed, last);
    let clock = Clock::new(division, &timed);
    let mut programs: Vec<Vec<(u64, u8)>> = vec![Vec::new(); 16];
    for (tick, event) in &timed {
        if let Event::Program { channel, program } = *event {
            programs[usize::from(channel)].push((*tick, program));
        }
    }
    let instrument_at = |channel: u8, tick: u64| {
        if channel == DRUM_CHANNEL {
            return DRUMS;
        }
        let changes = &programs[usize::from(channel)];
        let before = changes.partition_point(|(at, _)| *at <= tick);
        before.checked_sub(1).map_or(0, |at| changes[at].1)
    };

    let most = starts.min(room);
    let mut info = SongInfo { title, beats, bars, notes: Vec::with_capacity(most), ..SongInfo::default() };
    // When each channel and each instrument first plays, to list them in that order.
    let mut channels: Vec<((u64, usize, usize), u8, u8)> = Vec::new();
    let mut instruments: Vec<((u64, usize, usize), u8)> = Vec::new();
    for (order, &(_, body)) in bodies.iter().enumerate() {
        let mut held: Vec<Vec<(u8, f32)>> = vec![Vec::new(); 16];
        let mut index = 0;
        read_track(body, None, |tick, event| {
            index += 1;
            let when = (tick, order, index);
            match event {
                Event::On { channel, key } => {
                    let instrument = instrument_at(channel, tick);
                    match channels.iter_mut().find(|(_, known, _)| *known == channel) {
                        Some(first) if when < first.0 => *first = (when, channel, instrument),
                        Some(_) => {}
                        None => channels.push((when, channel, instrument)),
                    }
                    match instruments.iter_mut().find(|(_, known)| *known == instrument) {
                        Some(first) if when < first.0 => first.0 = when,
                        Some(_) => {}
                        None => instruments.push((when, instrument)),
                    }
                    held[usize::from(channel)].push((key, clock.seconds(tick) as f32));
                }
                Event::Off { channel, key } => {
                    let notes = &mut held[usize::from(channel)];
                    if let Some(at) = notes.iter().position(|(held_key, _)| *held_key == key) {
                        let (_, start) = notes.remove(at);
                        if info.notes.len() < most {
                            info.notes.push((start, clock.seconds(tick) as f32 - start, key, channel));
                        } else {
                            info.left_out += 1;
                        }
                    }
                }
                _ => {}
            }
        });
    }
    channels.sort_by_key(|(when, ..)| *when);
    instruments.sort_by_key(|(when, _)| *when);
    info.channels = channels.into_iter().map(|(_, channel, instrument)| (channel, instrument)).collect();
    info.instruments = instruments.into_iter().map(|(_, instrument)| instrument).collect();
    info.notes.sort_unstable_by(|a, b| a.0.total_cmp(&b.0));
    let (mut low, mut high) = (127, 0);
    for &(start, long, key, _) in &info.notes {
        (low, high) = (low.min(key), high.max(key));
        info.longest = info.longest.max(long);
        info.end = info.end.max(start + long);
    }
    (info.low, info.high) = if low > high { (60, 71) } else { (low, high) };
    Some(info)
}

/// As many notes as fit in half the memory free now, so a huge song can't take Perli down with it.
fn most_notes() -> usize {
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    let mut status = MEMORYSTATUSEX { dwLength: size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
    let free = if unsafe { GlobalMemoryStatusEx(&mut status) }.is_ok() { status.ullAvailPhys } else { 1 << 32 };
    usize::try_from(free / 2 / size_of::<Note>() as u64).unwrap_or(usize::MAX)
}

/// Seconds from ticks, following the song's tempo changes.
struct Clock {
    /// Ticks a second, for a song timed in frames, the same at every point of it.
    frames: Option<f64>,
    per_beat: f64,
    /// Each tempo change: its tick, the seconds there, and the new tempo.
    changes: Vec<(u64, f64, f64)>,
}

impl Clock {
    fn new(division: u16, timed: &[(u64, Event)]) -> Self {
        let frames = (division & 0x8000 != 0)
            .then(|| (f64::from(-((division >> 8) as i8)) * f64::from(division & 0xFF)).max(1.0));
        let per_beat = f64::from(division.max(1));
        let mut changes = vec![(0, 0.0, DEFAULT_TEMPO)];
        for (tick, event) in timed {
            if let Event::Tempo(tempo) = event {
                let &(at, seconds, old) = changes.last().expect("starts with one");
                changes.push((*tick, seconds + (tick - at) as f64 * old / 1_000_000.0 / per_beat, f64::from(*tempo)));
            }
        }
        Self { frames, per_beat, changes }
    }

    fn seconds(&self, tick: u64) -> f64 {
        if let Some(per_second) = self.frames {
            return tick as f64 / per_second;
        }
        let before = self.changes.partition_point(|(at, ..)| *at <= tick);
        let (at, seconds, tempo) = self.changes[before.saturating_sub(1)];
        seconds + (tick - at) as f64 * tempo / 1_000_000.0 / self.per_beat
    }
}

/// Each event of a track that Perli uses, with its tick, in the order the track gives them.
fn read_track(body: &[u8], mut title: Option<&mut Option<String>>, mut found: impl FnMut(u64, Event)) {
    let mut track = Reader { bytes: body, at: 0 };
    let mut tick = 0u64;
    let mut running = 0u8;
    while let Some(delta) = track.number() {
        tick += u64::from(delta);
        let Some(mut status) = track.byte() else { return };
        let mut first = None;
        if status < 0x80 {
            first = Some(status);
            status = running;
        }
        let event = match status {
            0xFF => {
                let (Some(kind), Some(length)) = (track.byte(), track.number()) else { return };
                let Some(data) = track.take(length as usize) else { return };
                match (kind, data) {
                    (0x51, [a, b, c]) => Some(Event::Tempo(u32::from_be_bytes([0, *a, *b, *c]))),
                    (0x03, name) => {
                        if let Some(slot) = title.as_deref_mut().filter(|slot| slot.is_none()) {
                            let name = String::from_utf8_lossy(name).trim().to_string();
                            *slot = (!name.is_empty()).then_some(name);
                        }
                        None
                    }
                    (0x58, [count, power, ..]) if *count > 0 => Some(Event::Meter { count: *count, power: *power }),
                    (0x2F, _) => return,
                    _ => None,
                }
            }
            0xF0 | 0xF7 => {
                let Some(length) = track.number() else { return };
                if track.take(length as usize).is_none() {
                    return;
                }
                None
            }
            0x80..=0xEF => {
                running = status;
                let Some(data1) = first.or_else(|| track.byte()) else { return };
                let channel = status & 0x0F;
                let one_byte = matches!(status & 0xF0, 0xC0 | 0xD0);
                let data2 = if one_byte { 0 } else { track.byte().unwrap_or(0) };
                match status & 0xF0 {
                    0x90 if data2 > 0 => Some(Event::On { channel, key: data1 }),
                    0x80 | 0x90 => Some(Event::Off { channel, key: data1 }),
                    0xC0 => Some(Event::Program { channel, program: data1 }),
                    _ => None,
                }
            }
            _ => return,
        };
        if let Some(event) = event {
            found(tick, event);
        }
    }
}

/// When each beat and each bar starts, in seconds, up to the song's last event. A new time
/// signature starts a new bar where it falls.
fn beats_and_bars(division: u16, events: &[(u64, Event)], last: u64) -> (Vec<f32>, Vec<f32>) {
    if division & 0x8000 != 0 {
        return (Vec::new(), Vec::new());
    }
    let per_beat = u64::from(division.max(1));
    let beats: Vec<u64> = (0..).map(|beat| beat * per_beat).take_while(|tick| *tick <= last).take(MOST_BEATS).collect();
    let mut meters = events
        .iter()
        .filter_map(|(tick, event)| match event {
            // A bar of 7/8 is 3.5 beats, so it is counted in ticks.
            Event::Meter { count, power } => Some((*tick, ((per_beat * 4 * u64::from(*count)) >> (*power).min(7)).max(1))),
            _ => None,
        })
        .peekable();
    let (mut bars, mut tick, mut length) = (Vec::new(), 0u64, per_beat * 4);
    while tick <= last && bars.len() < MOST_BEATS {
        while let Some((_, changed)) = meters.next_if(|(at, _)| *at <= tick) {
            length = changed;
        }
        bars.push(tick);
        let end = tick + length;
        tick = meters.peek().map_or(end, |(at, _)| (*at).min(end));
    }
    (seconds_of(per_beat, events, &beats), seconds_of(per_beat, events, &bars))
}

/// When each of `ticks`, in order, falls in seconds, following the tempo changes before it.
fn seconds_of(per_beat: u64, events: &[(u64, Event)], ticks: &[u64]) -> Vec<f32> {
    let mut changes = events
        .iter()
        .filter_map(|(tick, event)| match event {
            Event::Tempo(tempo) => Some((*tick, f64::from(*tempo))),
            _ => None,
        })
        .peekable();
    let (mut tempo, mut from, mut seconds) = (DEFAULT_TEMPO, 0u64, 0.0f64);
    let span = |ticks: u64, tempo: f64| ticks as f64 * tempo / 1_000_000.0 / per_beat as f64;
    ticks
        .iter()
        .map(|&tick| {
            while let Some((at, changed)) = changes.next_if(|(at, _)| *at <= tick) {
                seconds += span(at - from, tempo);
                from = at;
                tempo = changed;
            }
            (seconds + span(tick - from, tempo)) as f32
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One track: a C held for one beat at 120 beats a minute, so half a second.
    fn one_note() -> Vec<u8> {
        let track = [
            0x00, 0x90, 0x3C, 0x64, // note on
            0x60, 0x80, 0x3C, 0x00, // 96 ticks later, note off
            0x00, 0xFF, 0x2F, 0x00, // end of track
        ];
        let mut song = b"MThd\0\0\0\x06\0\0\0\x01\0\x60MTrk".to_vec();
        song.extend_from_slice(&(track.len() as u32).to_be_bytes());
        song.extend_from_slice(&track);
        song
    }

    /// The whole WAV, once it is made.
    fn render(font: &Path, song: &Path, playing: Playing) -> Result<Vec<u8>, String> {
        let stream = stream(font, song, playing)?;
        Ok(stream.read(0, stream.total))
    }

    #[test]
    fn the_window_streams_a_song_in_parts_while_it_is_made() {
        let folder = std::env::temp_dir().join(format!("perli-midi-stream-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        let song = folder.join("one.mid");
        std::fs::write(&song, one_note()).unwrap();
        let font = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources").join(SOUND_FONT);
        let streams = Streams::default();
        let number = streams.add(stream(&font, &song, Playing::default()).unwrap());
        let stream = streams.get(number).unwrap();
        let total = stream.total;
        let whole = stream.read(0, total);
        assert_eq!(whole.len(), total);

        let first = stream.answer(Some("bytes=0-"));
        assert_eq!(first.status(), 206);
        assert_eq!(first.headers()["Content-Range"], format!("bytes 0-{}/{total}", total.min(CHUNK_BYTES) - 1));
        assert_eq!(first.body()[..], whole[..total.min(CHUNK_BYTES)]);
        let part = stream.answer(Some("bytes=40-43"));
        assert_eq!((part.headers()["Content-Range"].to_str().unwrap(), &part.body()[..]), (format!("bytes 40-43/{total}").as_str(), &whole[40..44]));
        assert_eq!(stream.answer(Some("bytes=-4")).body()[..], whole[total - 4..]);
        assert_eq!(stream.answer(Some(&format!("bytes={total}-"))).status(), 416);
        assert_eq!(stream.answer(None).body().len(), total.min(CHUNK_BYTES));

        streams.forget(number);
        assert!(streams.get(number).is_none());
        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn letting_go_of_a_song_stops_making_it_even_while_a_seek_waits() {
        let folder = std::env::temp_dir().join(format!("perli-midi-stop-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        let song = folder.join("long.mid");
        // A note held for longer than the longest song, so the WAV runs to `MOST_SECONDS`.
        let mut long = one_note();
        long.splice(26..27, [0xFF, 0xFF, 0xFF, 0x7F]);
        let length = (long.len() - 22) as u32;
        long[18..22].copy_from_slice(&length.to_be_bytes());
        std::fs::write(&song, long).unwrap();
        let font = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources").join(SOUND_FONT);
        let streams = Streams::default();
        let number = streams.add(stream(&font, &song, Playing::default()).unwrap());

        // A seek near the end holds the song while it waits.
        let seek = streams.get(number).unwrap();
        let (sent, waited) = std::sync::mpsc::channel();
        std::thread::spawn(move || sent.send(seek.answer(Some(&format!("bytes={}-", seek.total - 4))).status()));
        std::thread::sleep(std::time::Duration::from_millis(50));
        let watched = streams.get(number).unwrap();
        streams.forget(number);

        let status = waited.recv_timeout(std::time::Duration::from_secs(1)).expect("the seek still waits");
        assert_eq!(status, 416);
        let made = watched.lock().bytes;
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert_eq!(watched.lock().bytes, made, "still making it");
        assert!(made < watched.total);
        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn a_song_becomes_a_wav_as_long_as_it_plus_the_fade() {
        let folder = std::env::temp_dir().join("perli-midi-test");
        std::fs::create_dir_all(&folder).unwrap();
        let song = folder.join("one.mid");
        std::fs::write(&song, one_note()).unwrap();
        let font = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources").join(SOUND_FONT);

        let wav = render(&font, &song, Playing::default()).unwrap();
        let frames = ((0.5 + TAIL_SECONDS) * f64::from(RATE)) as usize;
        assert_eq!(wav.len(), WAV_HEADER_BYTES + frames * 4);
        // Twice as fast is half as long, and a muted channel makes no sound.
        let fast = render(&font, &song, Playing { speed: 2.0, ..Playing::default() }).unwrap();
        assert_eq!(fast.len(), WAV_HEADER_BYTES + ((0.25 + TAIL_SECONDS) * f64::from(RATE)) as usize * 4);
        let silent = render(&font, &song, Playing { muted: 1, ..Playing::default() }).unwrap();
        assert!(silent[WAV_HEADER_BYTES..].iter().all(|&byte| byte == 0), "the muted channel is silent");
        let moved = render(&font, &song, Playing { transpose: 12, ..Playing::default() }).unwrap();
        assert_ne!(moved, wav, "an octave up sounds different");
        assert_eq!(&wav[..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(wav[4..8].try_into().unwrap()) as usize, wav.len() - 8);
        assert!(wav[WAV_HEADER_BYTES..].iter().any(|&byte| byte != 0), "the note makes sound");

        std::fs::write(&song, b"not a song").unwrap();
        assert!(render(&font, &song, Playing::default()).unwrap_err().starts_with("This MIDI file"));
        std::fs::write(&song, b"MThd\0\0\0\x06\0\0\0\x01\0\x60MTrk\0\0\0\xff\x90").unwrap();
        assert!(render(&font, &song, Playing::default()).unwrap_err().starts_with("This MIDI file"), "a cut-off song");
    }

    #[test]
    fn a_patch_moves_notes_and_silences_channels_in_place() {
        // A note on channel 0, then one on the drums in running status after a drum note-on.
        let mut song = b"MThd\0\0\0\x06\0\0\0\x01\0\x60MTrk\0\0\0\x13".to_vec();
        song.extend_from_slice(b"\0\x90\x3C\x64\x60\x80\x3C\0\0\x99\x24\x64\0\x26\x50\0\xFF\x2F\0");
        let before = song.clone();
        patch(&mut song, 0, 0);
        assert_eq!(song, before);
        patch(&mut song, 1 << 9, 2);
        let track = &song[22..];
        assert_eq!(&track[..8], b"\0\x90\x3E\x64\x60\x80\x3E\0", "the note and its end both move");
        assert_eq!(&track[8..15], b"\0\x99\x24\0\0\x26\0", "drums keep their keys and lose their loudness");
        assert_eq!(song.len(), before.len());
        // A file cut short is left as far as it was read.
        patch(&mut song[..30], 1, 1);
    }

    #[test]
    fn info_names_the_song_and_times_its_notes_by_tempo() {
        // Track 0: name and a tempo of 1 second a beat. Track 1: a piano note, a program
        // change to violin, then a violin note and a drum, the second note in running status.
        let mut song = b"MThd\0\0\0\x06\0\x01\0\x02\0\x60".to_vec();
        let mut track = |body: &[u8]| {
            song.extend_from_slice(b"MTrk");
            song.extend_from_slice(&(body.len() as u32).to_be_bytes());
            song.extend_from_slice(body);
        };
        track(b"\0\xFF\x03\x05 Tune\0\xFF\x51\x03\x0F\x42\x40\0\xFF\x2F\0");
        track(b"\0\x90\x3C\x64\x60\x80\x3C\0\0\xC0\x28\0\x90\x40\x64\x30\x40\0\0\x99\x24\x64\x30\x89\x24\0\0\xFF\x2F\0");
        let info = read_info(&song).unwrap();
        assert_eq!(info.title.as_deref(), Some("Tune"));
        assert_eq!(info.instruments, [0, 40, DRUMS]);
        assert_eq!(info.notes, [(0.0, 1.0, 60, 0), (1.0, 0.5, 64, 0), (1.5, 0.5, 36, 9)]);
        assert_eq!((info.low, info.high, info.longest, info.end), (36, 64, 1.0, 2.0));
        let packed = info.notes_between(0.0, 10.0);
        assert_eq!(packed.len(), 30);
        assert_eq!((&packed[4..8], &packed[12..16]), (&1f32.to_le_bytes()[..], &1f32.to_le_bytes()[..]), "starts, then lengths");
        assert_eq!(&packed[24..], [60, 64, 36, 0, 0, 9], "keys, then channels");
        // From half a second, the C begun at 0 may still sound, as the longest note counts back.
        // The drum at 1.5 starts after the stretch.
        assert_eq!(info.notes_between(0.5, 1.4).len(), 20);
        assert_eq!(info.notes_between(3.5, 4.0).len(), 0);
        // Four columns of half a second: the C runs from the first into the third, where it ends.
        let overview = info.overview(4);
        let count = overview.len() / 4;
        let columns: Vec<u16> = overview[..count * 2].chunks(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect();
        assert_eq!(columns, [0, 1, 2, 2, 3, 3]);
        assert_eq!(&overview[count * 2..count * 3], [60, 60, 60, 64, 36, 64]);
        assert_eq!(&overview[count * 3..], [0, 0, 0, 0, 9, 0]);
        assert_eq!(info.channels, [(0, 0), (9, DRUMS)]);
        assert_eq!((info.beats.as_slice(), info.bars.as_slice()), ([0.0, 1.0, 2.0].as_slice(), [0.0].as_slice()));
        assert!(read_info(b"RIFF").is_none());
        // Cut off in the middle of a track: the notes before the cut stay.
        assert_eq!(read_info(&song[..song.len() - 12]).unwrap().notes.len(), 2);
    }

    /// `count` quarter notes of middle C, one after another, in one track.
    fn notes(count: usize) -> Vec<u8> {
        let mut track = Vec::with_capacity(count * 7 + 4);
        for _ in 0..count {
            track.extend_from_slice(&[0x00, 0x90, 0x3C, 0x64, 0x60, 0x3C, 0x00]);
        }
        track.extend_from_slice(&[0x00, 0xFF, 0x2F, 0x00]);
        let mut song = b"MThd\0\0\0\x06\0\0\0\x01\0\x60MTrk".to_vec();
        song.extend_from_slice(&(track.len() as u32).to_be_bytes());
        song.extend_from_slice(&track);
        song
    }

    #[test]
    fn notes_past_the_memory_free_are_counted_as_left_out() {
        let info = read_song(&notes(5), 3).unwrap();
        assert_eq!((info.notes.len(), info.left_out), (3, 2));
        assert_eq!(info.notes[2], (1.0, 0.5, 60, 0), "the first ones stay");
        assert_eq!(read_song(&notes(5), usize::MAX).unwrap().left_out, 0);
    }

    /// Past the 30 million notes the player once stopped at. Slow, so run by hand.
    #[test]
    #[ignore]
    fn a_song_of_forty_million_notes_shows_whole() {
        let song = notes(40_000_000);
        let started = std::time::Instant::now();
        let info = read_info(&song).unwrap();
        eprintln!("{} notes in {:?}", info.notes.len(), started.elapsed());
        assert_eq!((info.notes.len(), info.left_out), (40_000_000, 0));
    }

    #[test]
    fn bar_lines_follow_a_change_of_time_signature() {
        // 3/4 for one bar, then 7/8, at the default half a second a beat, with a note at tick 960.
        let track = b"\0\xFF\x58\x04\x03\x02\x18\x08\x82\x20\xFF\x58\x04\x07\x03\x18\x08\x85\x20\x90\x3C\x64\0\x80\x3C\0\0\xFF\x2F\0";
        let mut song = b"MThd\0\0\0\x06\0\0\0\x01\0\x60MTrk".to_vec();
        song.extend_from_slice(&(track.len() as u32).to_be_bytes());
        song.extend_from_slice(track);
        let info = read_info(&song).unwrap();
        assert_eq!(info.bars, [0.0, 1.5, 3.25, 5.0]);
        assert_eq!(info.beats.len(), 11);
    }
}
