//! MIDI files played through the bundled SoundFont. The whole song becomes one WAV, which the
//! page's own audio player plays, so pausing, seeking and volume need nothing here.

use std::fs::File;
use std::io::BufReader;
use std::path::Path;
use std::sync::Arc;

use serde::Serialize;
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

/// The song as a 16-bit stereo WAV.
pub fn render(sound_font: &Path, song: &Path) -> Result<Vec<u8>, String> {
    let font = SoundFont::new(&mut BufReader::new(File::open(sound_font).map_err(|error| error.to_string())?))
        .map_err(|error| format!("The SoundFont can't be read: {error}"))?;
    let song = MidiFile::new(&mut BufReader::new(File::open(song).map_err(|error| error.to_string())?))
        .map_err(|error| format!("This MIDI file can't be read: {error}"))?;
    let seconds = (song.get_length() + TAIL_SECONDS).min(MOST_SECONDS);
    let frames = (seconds * f64::from(RATE)) as usize;
    let synthesizer = Synthesizer::new(&Arc::new(font), &SynthesizerSettings::new(RATE as i32))
        .map_err(|error| error.to_string())?;
    let mut sequencer = MidiFileSequencer::new(synthesizer);
    sequencer.play(&Arc::new(song), false);

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
pub struct SongInfo {
    title: Option<String>,
    /// General MIDI programs, in the order they first play. Drums are `DRUMS`.
    instruments: Vec<u8>,
    /// Each note as start and length in seconds, key, and channel.
    notes: Vec<(f32, f32, u8, u8)>,
}

pub const DRUMS: u8 = 128;
const DRUM_CHANNEL: u8 = 9;
// ponytail: a piano roll past this many notes shows only the first ones.
const MOST_NOTES: usize = 200_000;
const DEFAULT_TEMPO: f64 = 500_000.0;

enum Event {
    Tempo(u32),
    On { channel: u8, key: u8 },
    Off { channel: u8, key: u8 },
    Program { channel: u8, program: u8 },
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
    let mut info = SongInfo { title, ..SongInfo::default() };
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
            Event::Tempo(_) => {}
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

        let wav = render(&font, &song).unwrap();
        let frames = ((0.5 + TAIL_SECONDS) * f64::from(RATE)) as usize;
        assert_eq!(wav.len(), WAV_HEADER_BYTES + frames * 4);
        assert_eq!(&wav[..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(wav[4..8].try_into().unwrap()) as usize, wav.len() - 8);
        assert!(wav[WAV_HEADER_BYTES..].iter().any(|&byte| byte != 0), "the note makes sound");

        std::fs::write(&song, b"not a song").unwrap();
        assert!(render(&font, &song).unwrap_err().starts_with("This MIDI file"));
        std::fs::write(&song, b"MThd\0\0\0\x06\0\0\0\x01\0\x60MTrk\0\0\0\xff\x90").unwrap();
        assert!(render(&font, &song).unwrap_err().starts_with("This MIDI file"), "a cut-off song");
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
        assert!(read_info(b"RIFF").is_none());
        // Cut off in the middle of a track: the notes before the cut stay.
        assert_eq!(read_info(&song[..song.len() - 12]).unwrap().notes.len(), 2);
    }
}
