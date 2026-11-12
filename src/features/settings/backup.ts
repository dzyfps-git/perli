/** Perli's settings as one file, to carry to another computer or keep safe. */

const PREFIX = "perli-";
/**
 * What is kept but is no setting: where reading stopped in each book, comic and song, the files
 * on the shelf, and the folders and commands used lately.
 */
const NOT_SETTINGS = ["comic-pages", "book-places", "song-resume", "shelf", "recent-folders", "palette-recent"];

export interface TagLook {
  name: string;
  color: number;
}

export interface Backup {
  /** Each setting as it is stored, by its name without the prefix. */
  prefs: Record<string, string>;
  tags: TagLook[];
}

/** The settings among everything stored. `entries` are storage keys and their values. */
export function settingsOf(entries: [key: string, value: string][]): Record<string, string> {
  const named = entries.flatMap(([key, value]): [string, string][] =>
    key.startsWith(PREFIX) && !NOT_SETTINGS.includes(key.slice(PREFIX.length)) ? [[key.slice(PREFIX.length), value]] : [],
  );
  return Object.fromEntries(named.sort(([a], [b]) => a.localeCompare(b)));
}

export const packed = (backup: Backup) => JSON.stringify({ app: "Perli", kind: "settings", version: 1, ...backup }, null, 2);

/** Reads a file of settings, keeping only what is usable. Throws when it is not one. */
export function unpacked(text: string): Backup {
  let file: { app?: unknown; kind?: unknown; prefs?: unknown; tags?: unknown };
  try {
    file = JSON.parse(text);
  } catch {
    throw new Error("This is not a file of Perli settings.");
  }
  if (file?.app !== "Perli" || file.kind !== "settings" || !file.prefs || typeof file.prefs !== "object") {
    throw new Error("This is not a file of Perli settings.");
  }
  const prefs = Object.entries(file.prefs).filter(
    (pair): pair is [string, string] => typeof pair[1] === "string" && !NOT_SETTINGS.includes(pair[0]),
  );
  const tags = (Array.isArray(file.tags) ? file.tags : []).filter(
    (tag): tag is TagLook => typeof tag?.name === "string" && Number.isInteger(tag.color) && tag.color >= 0,
  );
  return { prefs: Object.fromEntries(prefs), tags: tags.map(({ name, color }) => ({ name, color })) };
}

/** The tags of `wanted` that `known` has none of by that name, in any case. */
export const missingTags = (wanted: TagLook[], known: { name: string }[]) =>
  wanted.filter((tag) => !known.some((other) => other.name.toLowerCase() === tag.name.toLowerCase()));

export const storageKey = (name: string) => PREFIX + name;
