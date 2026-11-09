//! MIDI files played through the bundled SoundFont. The whole song becomes one WAV, which the
//! page's own audio player plays, so pausing, seeking and volume need nothing here.

use std::fs::File;
use std::io::BufReader;
use std::path::Path;
use std::sync::Arc;

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
}
