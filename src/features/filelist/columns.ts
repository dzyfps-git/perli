import type { Sort, SortKey } from "../../api";

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

export function gridTemplate(columns: Column[]) {
  return columns
    .filter((column) => column.visible)
    .map((column) => (column.id === "name" ? `minmax(${NAME_MIN_WIDTH}px, 1fr)` : `${column.width}px`))
    .join(" ");
}

export function typeLabel(name: string, isDir: boolean) {
  if (isDir) return "Folder";
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "File" : `${name.slice(dot + 1).toUpperCase()} file`;
}

/** Applies widths and visibility saved earlier onto the current set of columns. */
export function restoreColumns(saved: unknown): Column[] {
  if (!Array.isArray(saved)) return DEFAULT_COLUMNS;
  return DEFAULT_COLUMNS.map((column) => {
    const found = saved.find((other) => other?.id === column.id);
    return found
      ? { ...column, width: found.width, visible: column.id === "name" || found.visible }
      : column;
  });
}
