import { createEffect, onCleanup } from "solid-js";

/** A note as start and length in seconds, key, and channel. */
export type Note = [start: number, long: number, key: number, channel: number];

/** How many seconds of the song the stage shows at once. */
const SPAN = 6;
const KEYS_WIDE = 46;
const KEYS_TALL = 52;
const RULER = 16;
const BLACK = [1, 3, 6, 8, 10];
const DRUMS = 9;

/** One color for each channel, spread around the wheel so neighbours differ. */
export const channelColor = (channel: number, alpha = 1) => `hsl(${(channel * 47 + 265) % 360} 72% 64% / ${alpha})`;

/** The first note that starts at or after `seconds`. */
function firstFrom(notes: Note[], seconds: number) {
  let low = 0;
  let high = notes.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (notes[middle][0] < seconds) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * A MIDI song as it plays. Sideways, the notes run past a keyboard on the left under a ruler of
 * bars and beats. Falling, they drop onto a keyboard along the bottom. Either way the keys light
 * in their channel's color while they sound.
 */
export function MidiStage(props: {
  notes: Note[];
  beats: number[];
  /** When each bar starts, in seconds. */
  bars: number[];
  /** Silent channels, one bit each. */
  muted: number;
  falling: boolean;
  /** Where the song is, read each frame. */
  time: () => number;
  playing: boolean;
}) {
  let canvas!: HTMLCanvasElement;
  let frame = 0;

  function draw() {
    const box = canvas.getBoundingClientRect();
    const scale = devicePixelRatio;
    const [wide, tall] = [Math.max(1, Math.round(box.width * scale)), Math.max(1, Math.round(box.height * scale))];
    if (canvas.width !== wide || canvas.height !== tall) {
      canvas.width = wide;
      canvas.height = tall;
    }
    const pen = canvas.getContext("2d")!;
    const style = getComputedStyle(canvas);
    const [ink, quiet, line] = ["--text", "--text-muted", "--border"].map((name) => style.getPropertyValue(name));
    pen.clearRect(0, 0, wide, tall);
    pen.font = `${10 * scale}px ${style.fontFamily}`;
    pen.textBaseline = "middle";

    const { notes, beats, bars, muted, falling } = props;
    const now = props.time();
    // The keys from the C under the lowest note to the B over the highest.
    let [low, high, longest] = [127, 0, 0];
    for (const [, long, key] of notes) {
      low = Math.min(low, key);
      high = Math.max(high, key);
      longest = Math.max(longest, long);
    }
    if (low > high) [low, high] = [60, 71];
    low -= low % 12;
    high += 11 - (high % 12);
    const keys = high - low + 1;
    const lit = new Map<number, number>();
    const start = firstFrom(notes, now - longest);
    const silent = (channel: number) => (muted & (1 << channel)) !== 0;

    if (falling) {
      const floor = tall - KEYS_TALL * scale;
      const slot = wide / keys;
      const perSecond = floor / SPAN;
      pen.fillStyle = line;
      for (const [times, alpha] of [[beats, 0.4], [bars, 1]] as const) {
        pen.globalAlpha = alpha;
        for (let at = firstFromBeats(times, now); at < times.length && times[at] < now + SPAN; at++) {
          pen.fillRect(0, floor - (times[at] - now) * perSecond, wide, scale);
        }
      }
      pen.globalAlpha = 1;
      for (let at = start; at < notes.length && notes[at][0] < now + SPAN; at++) {
        const [begin, long, key, channel] = notes[at];
        if (begin + long < now) continue;
        const sounding = begin <= now && !silent(channel);
        if (sounding) lit.set(key, channel);
        const bottom = floor - (begin - now) * perSecond;
        const top = Math.max(0, bottom - long * perSecond);
        pen.fillStyle = channelColor(channel, silent(channel) ? 0.22 : sounding ? 1 : 0.78);
        pen.beginPath();
        pen.roundRect((key - low) * slot + scale, top, Math.max(scale, slot - 2 * scale), Math.max(scale, Math.min(bottom, floor) - top), 2 * scale);
        pen.fill();
      }
      for (let key = low; key <= high; key++) {
        const black = BLACK.includes(key % 12);
        const sounding = lit.get(key);
        pen.fillStyle = sounding !== undefined ? channelColor(sounding) : black ? ink : quiet;
        pen.globalAlpha = sounding !== undefined ? 1 : black ? 0.75 : 0.22;
        const height = (black ? 0.62 : 1) * KEYS_TALL * scale;
        pen.fillRect((key - low) * slot + scale / 2, floor + 2 * scale, slot - scale, height - 2 * scale);
      }
      pen.globalAlpha = 1;
      return;
    }

    const left = KEYS_WIDE * scale;
    const top = RULER * scale;
    const row = (tall - top) / keys;
    const perSecond = (wide - left) / SPAN;
    pen.fillStyle = line;
    pen.globalAlpha = 0.4;
    for (let beat = firstFromBeats(beats, now); beat < beats.length && beats[beat] < now + SPAN; beat++) {
      pen.fillRect(left + (beats[beat] - now) * perSecond, top, scale, tall);
    }
    pen.globalAlpha = 1;
    for (let bar = firstFromBeats(bars, now); bar < bars.length && bars[bar] < now + SPAN; bar++) {
      const x = left + (bars[bar] - now) * perSecond;
      pen.fillStyle = line;
      pen.fillRect(x, 0, scale, tall);
      pen.fillStyle = quiet;
      pen.fillText(String(bar + 1), x + 4 * scale, top / 2);
    }
    pen.globalAlpha = 1;
    for (let at = start; at < notes.length && notes[at][0] < now + SPAN; at++) {
      const [begin, long, key, channel] = notes[at];
      if (begin + long < now) continue;
      const sounding = begin <= now && !silent(channel);
      if (sounding) lit.set(key, channel);
      const x = Math.max(left, left + (begin - now) * perSecond);
      const end = left + (begin + long - now) * perSecond;
      pen.fillStyle = channelColor(channel, silent(channel) ? 0.22 : sounding ? 1 : 0.78);
      pen.beginPath();
      pen.roundRect(x, top + (high - key) * row + scale / 2, Math.max(scale, end - x), Math.max(scale, row - scale), Math.min(3 * scale, row / 2));
      pen.fill();
    }
    for (let key = low; key <= high; key++) {
      const black = BLACK.includes(key % 12);
      const sounding = lit.get(key);
      pen.fillStyle = sounding !== undefined ? channelColor(sounding) : black ? ink : quiet;
      pen.globalAlpha = sounding !== undefined ? 1 : black ? 0.75 : 0.22;
      pen.fillRect(0, top + (high - key) * row + scale / 2, (black ? 0.62 : 1) * left - 2 * scale, Math.max(scale, row - scale));
      if (key % 12 === 0 && row >= 7 * scale) {
        pen.globalAlpha = 1;
        pen.fillStyle = sounding !== undefined ? "#000" : ink;
        pen.fillText(`C${key / 12 - 1}`, 4 * scale, top + (high - key + 0.5) * row);
      }
    }
    pen.globalAlpha = 1;
  }

  function run() {
    draw();
    if (props.playing) frame = requestAnimationFrame(run);
  }

  // Any change draws at once, and playing keeps it moving.
  createEffect(() => {
    void [props.notes, props.beats, props.bars, props.muted, props.falling];
    cancelAnimationFrame(frame);
    if (props.playing) run();
    else draw();
  });

  onCleanup(() => cancelAnimationFrame(frame));

  return (
    <canvas
      ref={(element) => {
        canvas = element;
        const watcher = new ResizeObserver(() => draw());
        watcher.observe(element);
        onCleanup(() => watcher.disconnect());
      }}
      class="midi-stage"
      role="img"
      aria-label={props.falling ? "The notes, falling onto the keyboard" : "The notes, running past the keyboard"}
      data-drums={DRUMS}
    />
  );
}

/** The first beat at or after `seconds`. */
function firstFromBeats(beats: number[], seconds: number) {
  let low = 0;
  let high = beats.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (beats[middle] < seconds) low = middle + 1;
    else high = middle;
  }
  return low;
}
