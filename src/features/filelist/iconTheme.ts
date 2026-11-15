/**
 * The user's own look for file icons: a style for all of them, a color per kind over Perli's
 * own, and extensions shown as another kind. It can be saved to a file and shared.
 */
import type { Kind } from "./fileKinds";

export type IconStyle = "tile" | "line" | "solid";
const STYLES: readonly IconStyle[] = ["tile", "line", "solid"];

export interface IconTheme {
  style: IconStyle;
  /** Hex colors by kind. A kind left out keeps Perli's own. */
  colors: Partial<Record<Kind, string>>;
  /** Extensions, lower case and without the dot, and the kind each shows as. */
  extensions: Record<string, Kind>;
  /** Kinds take hues around the accent, and change with it. Colors of the user's own still win. */
  accent: boolean;
}

export const PLAIN_THEME: IconTheme = { style: "tile", colors: {}, extensions: {}, accent: false };

const COLOR = /^#[0-9a-f]{6}$/i;
const EXTENSION = /^[a-z0-9_+~-]{1,24}$/;
const isKind = (value: unknown): value is Kind => typeof value === "string" && Object.hasOwn(KIND_LABELS, value);

/** An extension as typed, such as "*.NFO" or ".nfo", the way the theme keeps it. Empty if it can't be one. */
export function extensionKey(typed: string) {
  const key = typed.trim().replace(/^\*?\./, "").toLowerCase();
  return EXTENSION.test(key) ? key : "";
}

/** Only the well-formed parts of what was saved, since storage and files can hold anything. */
export function cleanTheme(value: unknown): IconTheme {
  const theme = (value ?? {}) as Partial<Record<keyof IconTheme, unknown>>;
  const entries = (part: unknown) => (part && typeof part === "object" ? Object.entries(part) : []);
  return {
    style: STYLES.includes(theme.style as IconStyle) ? (theme.style as IconStyle) : "tile",
    colors: Object.fromEntries(entries(theme.colors).filter(([kind, color]) => isKind(kind) && typeof color === "string" && COLOR.test(color))),
    extensions: Object.fromEntries(entries(theme.extensions).filter(([extension, kind]) => extensionKey(extension) === extension && isKind(kind))),
    accent: theme.accent === true,
  };
}

export const themeText = (theme: IconTheme) => JSON.stringify({ perliIcons: 1, ...theme }, null, 2);

/** The theme in a file's text. Nothing if the file holds none. */
export function themeFromText(text: string): IconTheme | undefined {
  try {
    const value = JSON.parse(text);
    return value?.perliIcons === 1 ? cleanTheme(value) : undefined;
  } catch {
    return undefined;
  }
}

/** How each kind is named in Settings, in the order it lists them. */
export const KIND_LABELS: Record<Kind, string> = {
  folder: "Folders",
  file: "Other files",
  picture: "Pictures",
  video: "Videos",
  audio: "Music and sound",
  pdf: "PDFs",
  doc: "Documents",
  text: "Text",
  sheet: "Spreadsheets",
  slides: "Slides",
  markdown: "Markdown",
  code: "Code",
  web: "Web pages",
  data: "Data",
  archive: "Archives",
  app: "Apps",
  installer: "Installers",
  library: "System files",
  font: "Fonts",
  book: "Books and comics",
  model: "3D models",
  vector: "Vector art",
  design: "Design files",
  database: "Databases",
  disk: "Disk images",
  shortcut: "Shortcuts",
  script: "Scripts",
  config: "Settings files",
  log: "Logs",
  subtitle: "Subtitles",
  key: "Keys and certificates",
  mail: "Mail",
};
