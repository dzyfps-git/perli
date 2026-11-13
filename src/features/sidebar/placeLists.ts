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

/** Which group each bookmark is in, by path in lower case. A bookmark not in here stands alone. */
export type Groups = Record<string, string>;

/** `groups` with `path` in `group`, or in none. */
export function withGroup(groups: Groups, path: string, group: string | undefined): Groups {
  const next = { ...groups };
  if (group) next[lookKey(path)] = group;
  else delete next[lookKey(path)];
  return next;
}

/** The groups in use, each once, in the order their first bookmark has. */
export const groupsOf = (paths: string[], groups: Groups) => [
  ...new Set(paths.flatMap((path) => groups[lookKey(path)] ?? [])),
];

/** Folder looks are kept by path, in lower case. */
export interface Look {
  /** Which of the `--tag-` colors. */
  color?: number;
  /** A Segoe Fluent Icons glyph. */
  icon?: string;
  /** A picture shown for the folder in place of its icon. */
  cover?: string;
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
  if (look.cover === undefined) delete look.cover;
  if (Object.keys(look).length > 0) next[key] = look;
  else delete next[key];
  return next;
}

/** `path` taken out of `list` and put back at `index` of what is left, as a drag drops it. */
export function movedTo(list: string[], path: string, index: number) {
  const from = list.findIndex((item) => same(item, path));
  if (from < 0) return list;
  const rest = list.filter((_, at) => at !== from);
  rest.splice(Math.max(0, Math.min(index, rest.length)), 0, list[from]);
  return rest;
}

/** Items under Today, Yesterday and Earlier by when they were opened, leaving out an empty day. */
export function byDay<T extends { opened: number }>(items: T[], now: Date) {
  const midnight = (back: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - back).getTime();
  const days = [
    { label: "Today", from: midnight(0) },
    { label: "Yesterday", from: midnight(1) },
    { label: "Earlier", from: -Infinity },
  ];
  return days
    .map((day) => ({ label: day.label, items: items.filter((item) => days.find((first) => item.opened >= first.from) === day) }))
    .filter((day) => day.items.length > 0);
}
