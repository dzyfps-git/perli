// Pinned folders and bookmarks are plain lists of paths. Windows paths ignore case.

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export const holds = (list: string[], path: string) => list.some((item) => same(item, path));

/** Adds `path` at the end, or takes it out if it is there. */
export const toggled = (list: string[], path: string) =>
  holds(list, path) ? list.filter((item) => !same(item, path)) : [...list, path];

/** Swaps `path` with its neighbour one `step` away. At either end nothing moves. */
export function moved(list: string[], path: string, step: -1 | 1) {
  const from = list.findIndex((item) => same(item, path));
  const to = from + step;
  if (from < 0 || to < 0 || to >= list.length) return list;
  const next = [...list];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

/** Only the text paths of what was saved, since storage can hold anything. */
export const savedPaths = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** The folder's own name. A drive keeps its whole path, since its name would be empty. */
export function placeLabel(path: string) {
  const trimmed = path.replace(/\\+$/, "");
  const name = trimmed.slice(trimmed.lastIndexOf("\\") + 1);
  return name && !/^[a-z]:$/i.test(trimmed) ? name : path;
}

/** Folder looks are kept by path, in lower case. */
export interface Look {
  /** Which of the `--tag-` colors. */
  color?: number;
  /** A Segoe Fluent Icons glyph. */
  icon?: string;
}

export type Looks = Record<string, Look>;

export const lookKey = (path: string) => path.replace(/\\+$/, "").toLowerCase();

/** `looks` with `change` made to the look of `path`. A look with nothing left is dropped. */
export function withLook(looks: Looks, path: string, change: Look): Looks {
  const key = lookKey(path);
  const look = { ...looks[key], ...change };
  const next = { ...looks };
  if (look.color === undefined) delete look.color;
  if (look.icon === undefined) delete look.icon;
  if (Object.keys(look).length > 0) next[key] = look;
  else delete next[key];
  return next;
}
