//! MIDI files played through the bundled SoundFont. The whole song becomes one WAV, which the
//! page's own audio player plays, so pausing, seeking and volume need nothing here.

use std::fs::File;
use std::io::BufReader;
use std::path::Path;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use rustysynth::{MidiFile, MidiFileSequencer, SoundFont, Synthesizer, SynthesizerSettings};

/// The SoundFont beside perli.exe. Its license is in TimGM6mb-LICENSE.txt beside it.
pub const SOUND_FONT: &str = "TimGM6mb.sf2";
const RATE: u32 = 44_100;
const CHANNELS: u16 = 2;
const SAMPLE_BYTES: u16 = 2;
/// Long enough for the last notes to fade out.
const TAIL_SECONDS: f64 = 2.0;
// ponytail: the whole song is rendered before it plays, about 10.6 MB a minute. Stream it to
// the speakers instead if songs longer than this matter.
const MOST_SECONDS: f64 = 20.0 * 60.0;
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

/// The song as a 16-bit stereo WAV.
pub fn render(sound_font: &Path, song: &Path, playing: Playing) -> Result<Vec<u8>, String> {
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

    let mut wav = wav_header(frames);
    let (mut left, mut right) = (vec![0.0; BLOCK_FRAMES], vec![0.0; BLOCK_FRAMES]);
    let mut done = 0;
    while done < frames {
        let count = BLOCK_FRAMES.min(frames - done);
        sequencer.render(&mut left[..count], &mut right[..count]);
        for (l, r) in left[..count].iter().zip(&right[..count]) {
            wav.extend_from_slice(&sample(*l));
            wav.extend_from_slice(&sample(*r));
        }
        done += count;
    }
    Ok(wav)
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

/// What the player shows beside the sound: the song's name, its instruments and its notes.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SongInfo {
    title: Option<String>,
    /// General MIDI programs, in the order they first play. Drums are `DRUMS`.
    instruments: Vec<u8>,
    /// Each channel that plays and the instrument it starts with, in the order they first play.
    channels: Vec<(u8, u8)>,
    /// Each note as start and length in seconds, key, and channel.
    notes: Vec<(f32, f32, u8, u8)>,
    /// When each beat falls, in seconds.
    beats: Vec<f32>,
    /// When each bar starts, in seconds, following the song's time signatures.
    bars: Vec<f32>,
}

pub const DRUMS: u8 = 128;
const DRUM_CHANNEL: u8 = 9;
// ponytail: a piano roll past this many notes shows only the first ones.
const MOST_NOTES: usize = 200_000;
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
    let mut file = Reader { bytes, at: 0 };
    if file.take(4)? != b"MThd" {
        return None;
    }
    let header = file.u32()? as usize;
    let _format = file.u16()?;
    let tracks = file.u16()?;
    let division = file.u16()?;
    file.take(header.checked_sub(6)?)?;

    let mut title = None;
    let mut events = Vec::new();
    for track in 0..tracks {
        let (Some(kind), Some(length)) = (file.take(4), file.u32()) else { break };
        let Some(body) = file.take(length as usize).or_else(|| file.bytes.get(file.at..)) else { break };
        if kind == b"MTrk" {
            read_track(body, &mut events, if track == 0 { Some(&mut title) } else { None });
        }
    }
    events.sort_by_key(|(tick, _)| *tick);

    let seconds_at = timing(division, &events);
    let (beats, bars) = beats_and_bars(division, &events);
    let mut info = SongInfo { title, beats, bars, ..SongInfo::default() };
    let mut programs = [0u8; 16];
    let mut held: Vec<Vec<(u8, f32)>> = vec![Vec::new(); 16];
    for ((_, event), seconds) in events.iter().zip(seconds_at) {
        let seconds = seconds as f32;
        match *event {
            Event::Program { channel, program } => programs[usize::from(channel)] = program,
            Event::On { channel, key } => {
                let instrument = if channel == DRUM_CHANNEL { DRUMS } else { programs[usize::from(channel)] };
                if !info.instruments.contains(&instrument) {
                    info.instruments.push(instrument);
                }
                if !info.channels.iter().any(|(known, _)| *known == channel) {
                    info.channels.push((channel, instrument));
                }
                held[usize::from(channel)].push((key, seconds));
            }
            Event::Off { channel, key } => {
                let notes = &mut held[usize::from(channel)];
                if let Some(at) = notes.iter().position(|(held_key, _)| *held_key == key) {
                    let (_, start) = notes.remove(at);
                    if info.notes.len() < MOST_NOTES {
                        info.notes.push((start, seconds - start, key, channel));
                    }
                }
            }
            Event::Tempo(_) | Event::Meter { .. } => {}
        }
    }
    info.notes.sort_by(|a, b| a.0.total_cmp(&b.0));
    Some(info)
}

fn read_track(body: &[u8], events: &mut Vec<(u64, Event)>, mut title: Option<&mut Option<String>>) {
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
            events.push((tick, event));
        }
    }
}

/// When each event happens, in seconds, following the tempo changes before it.
fn timing(division: u16, events: &[(u64, Event)]) -> Vec<f64> {
    if division & 0x8000 != 0 {
        // Frames a second and ticks a frame, the same at every point of the song.
        let frames = f64::from(-((division >> 8) as i8));
        let per_second = frames * f64::from(division & 0xFF);
        return events.iter().map(|(tick, _)| *tick as f64 / per_second.max(1.0)).collect();
    }
    let per_beat = f64::from(division.max(1));
    let (mut tempo, mut last_tick, mut seconds) = (DEFAULT_TEMPO, 0u64, 0.0);
    events
        .iter()
        .map(|(tick, event)| {
            seconds += (tick - last_tick) as f64 * tempo / 1_000_000.0 / per_beat;
            last_tick = *tick;
            if let Event::Tempo(next) = event {
                tempo = f64::from(*next);
            }
            seconds
        })
        .collect()
}

/// When each beat and each bar starts, in seconds, up to the song's last event. A new time
/// signature starts a new bar where it falls.
fn beats_and_bars(division: u16, events: &[(u64, Event)]) -> (Vec<f32>, Vec<f32>) {
    if division & 0x8000 != 0 {
        return (Vec::new(), Vec::new());
    }
    let per_beat = u64::from(division.max(1));
    let last = events.last().map_or(0, |(tick, _)| *tick);
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
        assert_eq!(info.channels, [(0, 0), (9, DRUMS)]);
        assert_eq!((info.beats.as_slice(), info.bars.as_slice()), ([0.0, 1.0, 2.0].as_slice(), [0.0].as_slice()));
        assert!(read_info(b"RIFF").is_none());
        // Cut off in the middle of a track: the notes before the cut stay.
        assert_eq!(read_info(&song[..song.len() - 12]).unwrap().notes.len(), 2);
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
