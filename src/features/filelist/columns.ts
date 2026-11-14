import type { Grouping, PropKey, Sort, SortKey } from "../../api";

/** Columns read from each file's own properties, a screenful at a time. A sort by one reads
 *  them all in Rust. */
export type PropColumn = PropKey;
export type ColumnId = SortKey | PropColumn;

/** Which Windows property each one shows. A `date:` one comes as milliseconds. */
export const PROP_NAMES: Record<PropColumn, string> = {
  artist: "System.Music.Artist",
  album: "System.Music.AlbumTitle",
  length: "System.Media.Duration",
  taken: "date:System.Photo.DateTaken",
  dimensions: "System.Image.Dimensions",
};

export const isProp = (id: ColumnId): id is PropColumn => id in PROP_NAMES;

/** The columns that suit a folder: its songs' or pictures' own, or the plain ones. */
export type ColumnSet = "plain" | "music" | "pictures";

export interface Column {
  id: ColumnId;
  label: string;
  /** Pixels. The name column ignores this and takes the space left over. */
  width: number;
  visible: boolean;
}

export const MIN_COLUMN_WIDTH = 60;
const NAME_MIN_WIDTH = 120;
const LARGEST_FIRST: Sort["key"][] = ["modified", "created", "size", "taken", "length"];

export const DEFAULT_COLUMNS: Column[] = [
  { id: "name", label: "Name", width: 0, visible: true },
  { id: "modified", label: "Modified", width: 160, visible: true },
  { id: "created", label: "Created", width: 160, visible: false },
  { id: "type", label: "Type", width: 110, visible: false },
  { id: "size", label: "Size", width: 90, visible: true },
];

const EXTRA_COLUMNS: Column[] = [
  { id: "artist", label: "Artist", width: 160, visible: false },
  { id: "album", label: "Album", width: 160, visible: false },
  { id: "length", label: "Length", width: 80, visible: false },
  { id: "taken", label: "Date taken", width: 160, visible: false },
  { id: "dimensions", label: "Dimensions", width: 110, visible: false },
];

const SET_SHOWS: Record<ColumnSet, ColumnId[]> = {
  plain: [],
  music: ["artist", "length"],
  pictures: ["taken", "dimensions"],
};

/** What a set of columns starts as: the plain ones, with its own extras put before Size. */
export function startColumns(set: ColumnSet): Column[] {
  const shows = SET_SHOWS[set];
  const extras = EXTRA_COLUMNS.map((column) => ({ ...column, visible: shows.includes(column.id) }));
  const shown = extras.filter((column) => column.visible);
  const size = DEFAULT_COLUMNS.findIndex((column) => column.id === "size");
  return [...DEFAULT_COLUMNS.slice(0, size), ...shown, ...DEFAULT_COLUMNS.slice(size), ...extras.filter((column) => !column.visible)];
}

/** The Recycle Bin's own columns. "modified" holds when an item was deleted. */
export const BIN_COLUMNS: Column[] = [
  { id: "name", label: "Name", width: 0, visible: true },
  { id: "location", label: "Original location", width: 220, visible: true },
  { id: "modified", label: "Date deleted", width: 160, visible: true },
  { id: "size", label: "Size", width: 90, visible: true },
];

/** A search's own columns. "location" holds the folder a row was found in. */
export const SEARCH_COLUMNS: Column[] = [
  { id: "name", label: "Name", width: 0, visible: true },
  { id: "location", label: "Folder", width: 260, visible: true },
  { id: "modified", label: "Modified", width: 160, visible: true },
  { id: "size", label: "Size", width: 90, visible: true },
];

/** A flat view's own columns. Where each row is shows under its name. */
export const FLAT_COLUMNS: Column[] = [
  { id: "name", label: "Name", width: 0, visible: true },
  { id: "modified", label: "Modified", width: 160, visible: true },
  { id: "size", label: "Size", width: 90, visible: true },
];

export function nextSort(sort: Sort, key: Sort["key"]): Sort {
  if (sort.key === key) return { key, descending: !sort.descending };
  return { key, descending: LARGEST_FIRST.includes(key) };
}

const GROUPINGS: Grouping[] = ["foldersFirst", "filesFirst", "mixed"];

export const nextGrouping = (grouping: Grouping) =>
  GROUPINGS[(GROUPINGS.indexOf(grouping) + 1) % GROUPINGS.length];

export function gridTemplate(columns: Column[]) {
  return columns
    .filter((column) => column.visible)
    .map((column) => (column.id === "name" ? `minmax(${NAME_MIN_WIDTH}px, 1fr)` : `${column.width}px`))
    .join(" ");
}

/** The narrowest the visible columns can go, gaps not included. */
export function columnsWidth(columns: Column[]) {
  return columns
    .filter((column) => column.visible)
    .reduce((total, column) => total + (column.id === "name" ? NAME_MIN_WIDTH : column.width), 0);
}

/** Moves a column to where `target` is. Name always stays first. */
export function movedColumn(columns: Column[], id: ColumnId, target: ColumnId) {
  if (id === "name" || target === "name") return columns;
  const moving = columns.find((column) => column.id === id)!;
  const others = columns.filter((column) => column !== moving);
  others.splice(columns.findIndex((column) => column.id === target), 0, moving);
  return others;
}

/** The title to trade places with: the pointer must pass its middle, or wide and narrow titles
    would trade back and forth. `middles` are x positions in title order. Name is never a target. */
export function dragTarget(middles: number[], from: number, x: number) {
  return middles.findIndex((middle, index) => index > 0 && (index > from ? x > middle : index < from && x < middle));
}

export function typeLabel(name: string, isDir: boolean) {
  if (isDir) return "Folder";
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "File" : `${name.slice(dot + 1).toUpperCase()} file`;
}

/** Applies order, widths and visibility saved earlier onto the current set of columns. */
export function restoreColumns(saved: unknown, start = DEFAULT_COLUMNS): Column[] {
  if (!Array.isArray(saved)) return start;
  const position = ({ id }: Column) => {
    const index = saved.findIndex((other) => other?.id === id);
    if (id === "name") return -1;
    return index < 0 ? saved.length : index;
  };
  return start.map((column) => {
    const found = saved.find((other) => other?.id === column.id);
    return found
      ? { ...column, width: found.width, visible: column.id === "name" || found.visible }
      : column;
  }).sort((a, b) => position(a) - position(b));
}
