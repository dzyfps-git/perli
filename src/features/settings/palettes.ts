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
