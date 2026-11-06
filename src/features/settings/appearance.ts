import { saved, stored } from "../filelist/prefs";

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
export type Accent = (typeof ACCENTS)[number]["id"];

function savedChoice<T extends string>(key: string, choices: readonly { id: T }[]) {
  const value = saved(key);
  return choices.find((choice) => choice.id === value)?.id ?? choices[0].id;
}

export const [theme, setTheme] = stored<Theme>("theme", savedChoice("theme", THEMES));
export const [accent, setAccent] = stored<Accent>("accent", savedChoice("accent", ACCENTS));
