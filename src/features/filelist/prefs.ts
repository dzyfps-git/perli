import { createSignal } from "solid-js";
import type { Sort, SortKey } from "../../api";
import { restoreColumns, type Column } from "./columns";
import type { Layout } from "./layout";

function saved(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(`perli-${key}`) ?? "null");
  } catch {
    return null;
  }
}

function stored<T>(key: string, start: T) {
  const [value, setValue] = createSignal<T>(start);
  const set = (next: T) => {
    setValue(() => next);
    localStorage.setItem(`perli-${key}`, JSON.stringify(next));
  };
  return [value, set] as const;
}

export const [columns, setColumns] = stored<Column[]>("columns", restoreColumns(saved("columns")));
export const [showHidden, setShowHidden] = stored("show-hidden", saved("show-hidden") === true);
export const [filesFirst, setFilesFirst] = stored("files-first", saved("files-first") === true);
export const [tileSize, setTileSize] = stored("tile-size", (saved("tile-size") as number | null) ?? 112);
/** What new panes start with. Each pane then keeps its own. */
export const [lastSort, setLastSort] = stored<Sort>(
  "sort",
  (saved("sort") as Sort | null) ?? { key: "name", descending: false },
);
export const [lastLayout, setLastLayout] = stored<Layout>(
  "layout",
  (saved("layout") as Layout | null) ?? "list",
);

export function setColumnWidth(id: SortKey, width: number) {
  setColumns(columns().map((column) => (column.id === id ? { ...column, width } : column)));
}

export function toggleColumn(id: SortKey) {
  setColumns(
    columns().map((column) => (column.id === id ? { ...column, visible: !column.visible } : column)),
  );
}
