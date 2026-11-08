import { saved, stored } from "../filelist/prefs";
import { newPalette, savedPalettes, type Palette } from "./palettes";

export const THEMES = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
] as const;

export const ACCENTS = [
  { id: "perli", label: "Perli" },
  { id: "ocean", label: "Ocean" },
  { id: "forest", label: "Forest" },
  { id: "ember", label: "Ember" },
  { id: "rose", label: "Rose" },
  { id: "mono", label: "Mono" },
] as const;

export type Theme = (typeof THEMES)[number]["id"];
/** One of `ACCENTS`, or the id of one of the user's palettes. */
export type Accent = string;

function savedChoice<T extends string>(key: string, choices: readonly { id: T }[]) {
  const value = saved(key);
  return choices.find((choice) => choice.id === value)?.id ?? choices[0].id;
}

export const [palettes, setPalettes] = stored<Palette[]>("palettes", savedPalettes(saved("palettes")));
export const [theme, setTheme] = stored<Theme>("theme", savedChoice("theme", THEMES));
export const [accent, setAccent] = stored<Accent>("accent", savedChoice("accent", [...ACCENTS, ...palettes()]));

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
