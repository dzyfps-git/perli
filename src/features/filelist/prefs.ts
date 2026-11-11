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
/** Costs a walk of every folder opened, so it waits to be asked for. */
export const [folderSizes, setFolderSizes] = stored("folder-sizes", saved("folder-sizes") === true);
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
/** A card with a file's details and a preview, when the pointer rests on its row. */
export const [hoverCards, setHoverCards] = stored("hover-cards", saved("hover-cards") !== false);
/** Where a folder opened from outside Perli goes while Perli runs. */
export const [openInWindow, setOpenInWindow] = stored("open-in-window", saved("open-in-window") === true);
/** How tall list rows are. Roomy rows have a second line under the name. */
export type Density = "compact" | "cozy" | "roomy";
export const ROW_HEIGHTS: Record<Density, number> = { compact: 28, cozy: 34, roomy: 46 };
const savedDensity = saved("row-density");
export const [rowDensity, setRowDensity] = stored<Density>(
  "row-density",
  typeof savedDensity === "string" && savedDensity in ROW_HEIGHTS ? (savedDensity as Density) : "cozy",
);
/** Windows' icon for every file, in place of Perli's own. */
export const [windowsIcons, setWindowsIcons] = stored("windows-icons", saved("windows-icons") === true);
/** The count and the selection, always on show at the bottom of each pane. */
export const [statusBar, setStatusBar] = stored("status-bar", saved("status-bar") === true);
export const [detailsPanel, setDetailsPanel] = stored("details-panel", saved("details-panel") === true);

const [sortMemory, setSortMemory] = stored<SortMemory>(
  "folder-sorts",
  (saved("folder-sorts") as SortMemory | null) ?? {},
);

export const rememberedSort = (path: string): Sort | undefined => sortMemory()[folderKey(path)];

export const rememberSort = (path: string, sort: Sort) => setSortMemory(remembered(sortMemory(), path, sort));

/** Every folder goes back to the sort new panes start with. */
export const forgetSorts = () => setSortMemory({});

export const moveColumn = (id: SortKey, target: SortKey) => setColumns(movedColumn(columns(), id, target));

export function setColumnWidth(id: SortKey, width: number) {
  setColumns(columns().map((column) => (column.id === id ? { ...column, width } : column)));
}

export function toggleColumn(id: SortKey) {
  setColumns(
    columns().map((column) => (column.id === id ? { ...column, visible: !column.visible } : column)),
  );
}
