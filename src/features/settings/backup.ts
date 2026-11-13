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
  /** The tag's number on the computer it was saved on, which settings such as smart folders use. */
  id?: number;
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
  return {
    prefs: Object.fromEntries(prefs),
    tags: tags.map(({ name, color, id }) => ({ name, color, ...(Number.isInteger(id) ? { id } : {}) })),
  };
}

/** The tags of `wanted` that `known` has none of by that name, in any case. */
export const missingTags = (wanted: TagLook[], known: { name: string }[]) =>
  wanted.filter((tag) => !known.some((other) => other.name.toLowerCase() === tag.name.toLowerCase()));

export const storageKey = (name: string) => PREFIX + name;

/** Settings that hold tags by number, and where in each the numbers are. */
const TAG_HOLDERS: Record<string, (value: unknown, map: (ids: number[]) => number[]) => unknown> = {
  "smart-folders": (list, map) =>
    Array.isArray(list)
      ? list.map((smart) => (Array.isArray(smart?.filter?.tags) ? { ...smart, filter: { ...smart.filter, tags: map(smart.filter.tags) } } : smart))
      : list,
  // Filters pinned to folders, keyed by folder.
  "folder-filters": (forms, map) =>
    forms && typeof forms === "object" && !Array.isArray(forms)
      ? Object.fromEntries(
          Object.entries(forms).map(([folder, form]) => [folder, Array.isArray(form?.tags) ? { ...form, tags: map(form.tags) } : form]),
        )
      : forms,
};

/**
 * `prefs` with each tag number of the saving computer changed to the number of the tag with the
 * same name here. A file from before tags carried their numbers is left as it is.
 */
export function remapTags(prefs: Record<string, string>, saved: TagLook[], here: { id: number; name: string }[]) {
  if (!saved.some((tag) => tag.id !== undefined)) return prefs;
  const numbers = new Map<number, number>();
  for (const tag of saved) {
    const found = here.find((other) => other.name.toLowerCase() === tag.name.toLowerCase());
    if (tag.id !== undefined && found) numbers.set(tag.id, found.id);
  }
  const map = (ids: number[]) => ids.flatMap((id) => (numbers.has(id) ? [numbers.get(id)!] : []));
  const next = { ...prefs };
  for (const [name, remap] of Object.entries(TAG_HOLDERS)) {
    if (!(name in next)) continue;
    try {
      next[name] = JSON.stringify(remap(JSON.parse(next[name]), map));
    } catch {
      // Not JSON: Perli reads it as nothing anyway.
    }
  }
  return next;
}

/** The stored settings a restore must take away, because the file has none of them. */
export const staleSettings = (current: Record<string, string>, restored: Record<string, string>) =>
  Object.keys(current).filter((name) => !(name in restored));
