import { createSignal } from "solid-js";
import { windowsAccent } from "../../api";
import { saved, stored } from "../filelist/prefs";
import { isDaytime, newPalette, savedPalettes, windowsColors, type Palette } from "./palettes";

export const THEMES = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "hour", label: "By the hour" },
] as const;

export const ACCENTS = [
  { id: "perli", label: "Perli" },
  { id: "ocean", label: "Ocean" },
  { id: "forest", label: "Forest" },
  { id: "ember", label: "Ember" },
  { id: "rose", label: "Rose" },
  { id: "mono", label: "Mono" },
] as const;

/** The accent that follows the color picked in Windows. */
export const WINDOWS_ACCENT = "windows";

/** What Windows paints behind the window, where Perli lets it show through. */
export const BACKDROPS = [
  { id: "mica", label: "Mica" },
  { id: "tabbed", label: "Mica Alt" },
  { id: "acrylic", label: "Acrylic" },
  { id: "solid", label: "Solid" },
] as const;
export type Backdrop = (typeof BACKDROPS)[number]["id"];

/** How big everything is drawn, as the zoom of the whole page. */
export const SCALES = [0.9, 1, 1.1, 1.25, 1.5];

export type Theme = (typeof THEMES)[number]["id"];
/** One of `ACCENTS`, or the id of one of the user's palettes. */
export type Accent = string;

function savedChoice<T extends string>(key: string, choices: readonly { id: T }[]) {
  const value = saved(key);
  return choices.find((choice) => choice.id === value)?.id ?? choices[0].id;
}

export const [palettes, setPalettes] = stored<Palette[]>("palettes", savedPalettes(saved("palettes")));
export const [theme, setTheme] = stored<Theme>("theme", savedChoice("theme", THEMES));
export const [accent, setAccent] = stored<Accent>("accent", savedChoice("accent", [...ACCENTS, { id: WINDOWS_ACCENT }, ...palettes()]));
export const [backdrop, setBackdrop] = stored<Backdrop>("backdrop", savedChoice("backdrop", BACKDROPS));
const savedScale = saved("ui-scale");
export const [uiScale, setUiScale] = stored<number>(
  "ui-scale",
  SCALES.includes(savedScale as number) ? (savedScale as number) : 1,
);

const [clock, setClock] = createSignal(new Date());

/** The time "By the hour" goes by, read again when it may have turned. */
export const readClock = () => setClock(new Date());

/** Light or dark as drawn. "By the hour" is light by day and dark by night. */
export const drawnTheme = (value: Theme = theme()) =>
  value === "hour" ? (isDaytime(clock()) ? "light" : "dark") : value;

/** The clock moved past a turn since it was last read, as after the PC slept. */
export const turnedSinceRead = () => isDaytime(clock()) !== isDaytime(new Date());

const [windowsColor, setWindowsColor] = createSignal<string | null>(null);

/** Asks Windows for its accent color again. */
export const readWindowsColor = () => windowsAccent().then(setWindowsColor).catch(console.error);

/** The three colors of an accent that no style rule paints: Windows' own, or one of the user's palettes. */
export function accentColors(id: Accent): readonly string[] | undefined {
  if (id === WINDOWS_ACCENT) return windowsColors(windowsColor() ?? "#6b7cff");
  return palettes().find((palette) => palette.id === id)?.colors;
}

/** The palette shown, if it is one of the user's own. */
export const ownPalette = () => palettes().find((palette) => palette.id === accent());

export function addPalette() {
  const palette = newPalette(palettes());
  setPalettes([...palettes(), palette]);
  setAccent(palette.id);
}

export const changePalette = (palette: Palette) =>
  setPalettes(palettes().map((known) => (known.id === palette.id ? palette : known)));

export function deletePalette(id: string) {
  setPalettes(palettes().filter((palette) => palette.id !== id));
  if (accent() === id) setAccent(ACCENTS[0].id);
}
