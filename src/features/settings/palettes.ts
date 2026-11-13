/** An accent the user made: three close colors, used in light and dark alike. */
export interface Palette {
  id: string;
  name: string;
  colors: [string, string, string];
}

const COLOR = /^#[0-9a-f]{6}$/i;
const PREFIX = "custom-";
/** Perli's own colors, which a new palette starts from. */
export const START_COLORS: Palette["colors"] = ["#9db4ff", "#c4b5fd", "#f0a6d4"];

const isPalette = (value: unknown): value is Palette => {
  const palette = value as Palette;
  return (
    typeof palette?.id === "string" &&
    palette.id.startsWith(PREFIX) &&
    typeof palette.name === "string" &&
    Array.isArray(palette.colors) &&
    palette.colors.length === 3 &&
    palette.colors.every((color) => typeof color === "string" && COLOR.test(color))
  );
};

/** Only the whole palettes of what was saved, since storage can hold anything. */
export const savedPalettes = (value: unknown) => (Array.isArray(value) ? value.filter(isPalette) : []);

/** The next palette, numbered past every one so far, so an id is never used twice. */
export function newPalette(palettes: Palette[]): Palette {
  const numbers = palettes.map((palette) => Number(palette.id.slice(PREFIX.length)) || 0);
  const next = Math.max(0, ...numbers) + 1;
  return { id: `${PREFIX}${next}`, name: `Custom ${next}`, colors: [...START_COLORS] };
}

/** The style that paints an element in `palette`. */
export const paletteStyle = ({ colors }: Palette) => ({
  "--accent-start": colors[0],
  "--accent": colors[1],
  "--accent-end": colors[2],
});

const hue = (red: number, green: number, blue: number, most: number, spread: number) => {
  if (spread === 0) return 0;
  if (most === red) return ((green - blue) / spread + 6) % 6;
  return most === green ? (blue - red) / spread + 2 : (red - green) / spread + 4;
};

/** One channel of a color from its hue in sixths, saturation and lightness. */
function channel(sixths: number, saturation: number, lightness: number, offset: number) {
  const k = (offset + sixths * 2) % 12;
  const a = saturation * Math.min(lightness, 1 - lightness);
  const value = lightness - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  return Math.round(value * 255)
    .toString(16)
    .padStart(2, "0");
}

/**
 * Three close colors around the accent Windows uses: its own hue in the middle and a step to
 * each side. Lightness is kept in the middle range, so a very dark or pale accent still reads
 * on both themes.
 */
export function windowsColors(color: string): Palette["colors"] | undefined {
  if (!COLOR.test(color)) return undefined;
  const [red, green, blue] = [1, 3, 5].map((at) => parseInt(color.slice(at, at + 2), 16) / 255);
  const [most, least] = [Math.max(red, green, blue), Math.min(red, green, blue)];
  const lightness = Math.min(0.72, Math.max(0.5, (most + least) / 2));
  const spread = most - least;
  const saturation = spread === 0 ? 0 : spread / (1 - Math.abs(most + least - 1) || 1);
  const sixths = hue(red, green, blue, most, spread);
  const shade = (turn: number) => {
    const turned = (sixths + turn + 6) % 6;
    return `#${channel(turned, saturation, lightness, 0)}${channel(turned, saturation, lightness, 8)}${channel(turned, saturation, lightness, 4)}`;
  };
  return [shade(-0.5), shade(0), shade(0.5)];
}

/** "By the hour" is light from this hour of the morning until the evening one. */
const DAY_STARTS = 7;
const NIGHT_STARTS = 19;

export const isDaytime = (now: Date) => now.getHours() >= DAY_STARTS && now.getHours() < NIGHT_STARTS;

/** Milliseconds from `now` until "By the hour" next turns light or dark. */
export function untilTurn(now: Date) {
  const at = (day: number, hour: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + day, hour).getTime();
  const turns = [at(0, DAY_STARTS), at(0, NIGHT_STARTS), at(1, DAY_STARTS)].filter((time) => time > now.getTime());
  return Math.min(...turns) - now.getTime();
}

/** Hues are counted in this many slices when a picture's colour is looked for. */
const HUE_SLICES = 24;

/**
 * A palette from a picture's RGBA pixels: its most common lively hue, made into three close
 * colours the way Windows' accent is. Grey, nearly black and nearly white pixels don't count,
 * unless the picture has nothing else.
 */
export function paletteFromPixels(pixels: ArrayLike<number>): Palette["colors"] {
  const sum = () => ({ weight: 0, red: 0, green: 0, blue: 0 });
  const slices = Array.from({ length: HUE_SLICES }, sum);
  const every = sum();
  const add = (into: ReturnType<typeof sum>, weight: number, red: number, green: number, blue: number) => {
    into.weight += weight;
    into.red += red * weight;
    into.green += green * weight;
    into.blue += blue * weight;
  };
  for (let at = 0; at + 3 < pixels.length; at += 4) {
    if (pixels[at + 3] < 128) continue;
    const [red, green, blue] = [pixels[at] / 255, pixels[at + 1] / 255, pixels[at + 2] / 255];
    add(every, 1, red, green, blue);
    const [most, least] = [Math.max(red, green, blue), Math.min(red, green, blue)];
    const lightness = (most + least) / 2;
    const spread = most - least;
    const saturation = spread === 0 ? 0 : spread / (1 - Math.abs(2 * lightness - 1));
    if (saturation < 0.25 || lightness < 0.12 || lightness > 0.92) continue;
    add(slices[Math.floor((hue(red, green, blue, most, spread) / 6) * HUE_SLICES) % HUE_SLICES], saturation, red, green, blue);
  }
  const best = slices.reduce((heaviest, slice) => (slice.weight > heaviest.weight ? slice : heaviest));
  const chosen = best.weight > 0 ? best : every;
  if (chosen.weight === 0) return [...START_COLORS];
  const hex = (part: number) =>
    Math.round((part / chosen.weight) * 255)
      .toString(16)
      .padStart(2, "0");
  return windowsColors(`#${hex(chosen.red)}${hex(chosen.green)}${hex(chosen.blue)}`) ?? [...START_COLORS];
}

/** A palette as the text of a file, to keep or to give to someone. */
export const paletteText = ({ name, colors }: Palette) => JSON.stringify({ perliPalette: 1, name, colors }, null, 2);

/** The palette in a file's text, with a new id beside `palettes`. Nothing if it holds none. */
export function paletteFromText(text: string, palettes: Palette[]): Palette | undefined {
  let value: Partial<Palette>;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const fresh = newPalette(palettes);
  const read = { ...value, id: fresh.id };
  if (!isPalette(read)) return undefined;
  return { id: fresh.id, name: read.name.trim() || fresh.name, colors: [read.colors[0], read.colors[1], read.colors[2]] };
}
