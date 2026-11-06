import { createSignal } from "solid-js";
import type { Grouping, Sort, SortKey } from "../../api";
import { movedColumn, restoreColumns, type Column } from "./columns";
import type { Layout } from "./layout";
import { folderKey, remembered, type SortMemory } from "./sortMemory";

export function saved(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(`perli-${key}`) ?? "null");
  } catch {
    return null;
  }
}

export function stored<T>(key: string, start: T) {
  const [value, setValue] = createSignal<T>(start);
  const set = (next: T) => {
    setValue(() => next);
    localStorage.setItem(`perli-${key}`, JSON.stringify(next));
  };
  return [value, set] as const;
}

export const [columns, setColumns] = stored<Column[]>("columns", restoreColumns(saved("columns")));
export const [showHidden, setShowHidden] = stored("show-hidden", saved("show-hidden") === true);
export const [grouping, setGrouping] = stored<Grouping>(
  "grouping",
  (saved("grouping") as Grouping | null) ?? "foldersFirst",
);
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

const [sortMemory, setSortMemory] = stored<SortMemory>(
  "folder-sorts",
  (saved("folder-sorts") as SortMemory | null) ?? {},
);

export const rememberedSort = (path: string): Sort | undefined => sortMemory()[folderKey(path)];

export const rememberSort = (path: string, sort: Sort) => setSortMemory(remembered(sortMemory(), path, sort));

export const moveColumn = (id: SortKey, target: SortKey) => setColumns(movedColumn(columns(), id, target));

export function setColumnWidth(id: SortKey, width: number) {
  setColumns(columns().map((column) => (column.id === id ? { ...column, width } : column)));
}

export function toggleColumn(id: SortKey) {
  setColumns(
    columns().map((column) => (column.id === id ? { ...column, visible: !column.visible } : column)),
  );
}
