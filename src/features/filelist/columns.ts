import type { Grouping, Sort, SortKey } from "../../api";

export interface Column {
  id: SortKey;
  label: string;
  /** Pixels. The name column ignores this and takes the space left over. */
  width: number;
  visible: boolean;
}

export const MIN_COLUMN_WIDTH = 60;
const NAME_MIN_WIDTH = 120;
const LARGEST_FIRST: SortKey[] = ["modified", "created", "size"];

export const DEFAULT_COLUMNS: Column[] = [
  { id: "name", label: "Name", width: 0, visible: true },
  { id: "modified", label: "Modified", width: 160, visible: true },
  { id: "created", label: "Created", width: 160, visible: false },
  { id: "type", label: "Type", width: 110, visible: false },
  { id: "size", label: "Size", width: 90, visible: true },
];

export function nextSort(sort: Sort, key: SortKey): Sort {
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
export function movedColumn(columns: Column[], id: SortKey, target: SortKey) {
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
export function restoreColumns(saved: unknown): Column[] {
  if (!Array.isArray(saved)) return DEFAULT_COLUMNS;
  const position = ({ id }: Column) => {
    const index = saved.findIndex((other) => other?.id === id);
    if (id === "name") return -1;
    return index < 0 ? saved.length : index;
  };
  return DEFAULT_COLUMNS.map((column) => {
    const found = saved.find((other) => other?.id === column.id);
    return found
      ? { ...column, width: found.width, visible: column.id === "name" || found.visible }
      : column;
  }).sort((a, b) => position(a) - position(b));
}
