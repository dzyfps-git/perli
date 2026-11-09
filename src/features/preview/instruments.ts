/** The 128 General MIDI instruments, by program number, and the drums after them. */
const NAMES = (
  "Grand Piano|Bright Piano|Electric Grand|Honky-tonk Piano|Electric Piano|Electric Piano 2|Harpsichord|Clavinet|" +
  "Celesta|Glockenspiel|Music Box|Vibraphone|Marimba|Xylophone|Tubular Bells|Dulcimer|" +
  "Drawbar Organ|Percussive Organ|Rock Organ|Church Organ|Reed Organ|Accordion|Harmonica|Tango Accordion|" +
  "Nylon Guitar|Steel Guitar|Jazz Guitar|Clean Guitar|Muted Guitar|Overdriven Guitar|Distortion Guitar|Guitar Harmonics|" +
  "Acoustic Bass|Finger Bass|Pick Bass|Fretless Bass|Slap Bass|Slap Bass 2|Synth Bass|Synth Bass 2|" +
  "Violin|Viola|Cello|Contrabass|Tremolo Strings|Pizzicato Strings|Harp|Timpani|" +
  "Strings|Slow Strings|Synth Strings|Synth Strings 2|Choir Aahs|Voice Oohs|Synth Voice|Orchestra Hit|" +
  "Trumpet|Trombone|Tuba|Muted Trumpet|French Horn|Brass Section|Synth Brass|Synth Brass 2|" +
  "Soprano Sax|Alto Sax|Tenor Sax|Baritone Sax|Oboe|English Horn|Bassoon|Clarinet|" +
  "Piccolo|Flute|Recorder|Pan Flute|Blown Bottle|Shakuhachi|Whistle|Ocarina|" +
  "Square Lead|Saw Lead|Calliope Lead|Chiff Lead|Charang Lead|Voice Lead|Fifths Lead|Bass Lead|" +
  "New Age Pad|Warm Pad|Polysynth Pad|Choir Pad|Bowed Pad|Metallic Pad|Halo Pad|Sweep Pad|" +
  "Rain|Soundtrack|Crystal|Atmosphere|Brightness|Goblins|Echoes|Sci-fi|" +
  "Sitar|Banjo|Shamisen|Koto|Kalimba|Bagpipe|Fiddle|Shanai|" +
  "Tinkle Bell|Agogo|Steel Drums|Woodblock|Taiko Drum|Melodic Tom|Synth Drum|Reverse Cymbal|" +
  "Guitar Fret Noise|Breath Noise|Seashore|Bird Tweet|Telephone Ring|Helicopter|Applause|Gunshot|Drums"
).split("|");

export const instrumentName = (program: number) => NAMES[program] ?? `Program ${program + 1}`;
