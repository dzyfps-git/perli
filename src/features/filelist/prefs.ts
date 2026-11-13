import { createSignal } from "solid-js";
import type { GroupBy, Grouping, Sort, Terminal } from "../../api";
import { movedColumn, restoreColumns, startColumns, type Column, type ColumnId, type ColumnSet } from "./columns";
import type { Layout } from "./layout";
import { NO_FILTER, type FilterForm } from "./filter";
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

/** Each set of columns is kept on its own, so a folder of songs keeps its artist column. */
function columnStore(set: ColumnSet) {
  const key = set === "plain" ? "columns" : `columns-${set}`;
  return stored<Column[]>(key, restoreColumns(saved(key), startColumns(set)));
}
const COLUMN_SETS = { plain: columnStore("plain"), music: columnStore("music"), pictures: columnStore("pictures") };
export const columnsOf = (set: ColumnSet) => COLUMN_SETS[set][0]();
const setColumnsOf = (set: ColumnSet, next: Column[]) => COLUMN_SETS[set][1](next);
export const [showHidden, setShowHidden] = stored("show-hidden", saved("show-hidden") === true);
/** Windows' own protected files. They only show with hidden files too. */
export const [showSystem, setShowSystem] = stored("show-system", saved("show-system") === true);
export const [grouping, setGrouping] = stored<Grouping>(
  "grouping",
  (saved("grouping") as Grouping | null) ?? "foldersFirst",
);
/** Soft bars behind the Size column, as long as each row's share of the biggest. */
export const [sizeBars, setSizeBars] = stored("size-bars", saved("size-bars") !== false);
/** Picture folders in the grid show an even wall of pictures, edge to edge, with no names. */
export const [pictureWall, setPictureWall] = stored("picture-wall", saved("picture-wall") === true);
/** Costs a walk of every folder opened, so it waits to be asked for. */
export const [folderSizes, setFolderSizes] = stored("folder-sizes", saved("folder-sizes") === true);
/** Read each copied file back and compare it with its original. Slower, so off at first. */
export const [verifyCopies, setVerifyCopies] = stored("verify-copies", saved("verify-copies") === true);
/** Copies to or from one drive wait their turn, which a hard disk likes better than all at once. */
export const [onePerDrive, setOnePerDrive] = stored("one-per-drive", saved("one-per-drive") === true);
export const [tileSize, setTileSize] = stored("tile-size", (saved("tile-size") as number | null) ?? 112);
/** A double click on no row goes up a folder. Off at first, so a missed click goes nowhere. */
export const [upOnDoubleClick, setUpOnDoubleClick] = stored("up-on-double-click", saved("up-on-double-click") === true);
/** Each terminal Perli can start, by the name Rust takes, in the order they are offered. */
export const TERMINAL_NAMES: Record<Terminal, string> = {
  wt: "Windows Terminal",
  pwsh: "PowerShell",
  powershell: "Windows PowerShell",
  cmd: "Command Prompt",
};
/** Which terminal "Open in terminal" starts: the last one picked. */
export const [terminalChoice, setTerminalChoice] = stored<Terminal>(
  "terminal",
  (Object.keys(TERMINAL_NAMES) as Terminal[]).find((name) => name === saved("terminal")) ?? "wt",
);
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
/** How the date columns read: the PC's own short form, how long ago, or ISO. */
export type DateForm = "short" | "ago" | "iso";
export const [dateForm, setDateForm] = stored<DateForm>(
  "date-form",
  (["short", "ago", "iso"] as const).find((form) => form === saved("date-form")) ?? "short",
);
/** The bar of buttons that floats over the list while rows are selected. */
export const [selectionBar, setSelectionBar] = stored("selection-bar", saved("selection-bar") !== false);
export const [detailsPanel, setDetailsPanel] = stored("details-panel", saved("details-panel") === true);
/** Arrows beside the folders of a list, which open them in place. */
export const [inlineFolders, setInlineFolders] = stored("inline-folders", saved("inline-folders") !== false);
/** The preview kept beside the list, following the selection. */
export const [previewPane, setPreviewPane] = stored("preview-pane", saved("preview-pane") === true);

const [sortMemory, setSortMemory] = stored<SortMemory>(
  "folder-sorts",
  (saved("folder-sorts") as SortMemory | null) ?? {},
);

export const rememberedSort = (path: string): Sort | undefined => sortMemory()[folderKey(path)];

export const rememberSort = (path: string, sort: Sort) => setSortMemory(remembered(sortMemory(), path, sort));

/** Every folder goes back to the sort new panes start with. */
export const forgetSorts = () => setSortMemory({});

/** Filters the user pinned to a folder, as typed, so they come back each time it opens. */
const [filterMemory, setFilterMemory] = stored<Record<string, FilterForm>>(
  "folder-filters",
  (saved("folder-filters") as Record<string, FilterForm> | null) ?? {},
);

/** Old saved forms may lack newer parts. */
export const rememberedFilter = (path: string): FilterForm | undefined => {
  const form = filterMemory()[folderKey(path)];
  return form && { ...NO_FILTER, ...form };
};

/** No form unpins it. */
export const rememberFilter = (path: string, form: FilterForm | undefined) =>
  setFilterMemory(remembered(filterMemory(), path, form));

const MAX_RECENT_SEARCHES = 8;

export const [recentSearches, setRecentSearches] = stored<string[]>(
  "recent-searches",
  (saved("recent-searches") as string[] | null) ?? [],
);

/** Newest first, each once whatever its case. */
export function rememberSearch(text: string) {
  const others = recentSearches().filter((other) => other.toLowerCase() !== text.toLowerCase());
  setRecentSearches([text, ...others].slice(0, MAX_RECENT_SEARCHES));
}

export const forgetSearch = (text: string) => setRecentSearches(recentSearches().filter((other) => other !== text));

/** How each folder's rows gather under headers, where the user chose that. */
const [groupMemory, setGroupMemory] = stored<Record<string, GroupBy>>(
  "folder-groups",
  (saved("folder-groups") as Record<string, GroupBy> | null) ?? {},
);

export const rememberedGroup = (path: string): GroupBy => groupMemory()[folderKey(path)] ?? "none";

/** No groups is where every folder starts, so it needs no keeping. */
export const rememberGroup = (path: string, by: GroupBy) =>
  setGroupMemory(remembered(groupMemory(), path, by === "none" ? undefined : by));

export const moveColumn = (set: ColumnSet, id: ColumnId, target: ColumnId) =>
  setColumnsOf(set, movedColumn(columnsOf(set), id, target));

export function setColumnWidth(set: ColumnSet, id: ColumnId, width: number) {
  setColumnsOf(set, columnsOf(set).map((column) => (column.id === id ? { ...column, width } : column)));
}

export function toggleColumn(set: ColumnSet, id: ColumnId) {
  setColumnsOf(
    set,
    columnsOf(set).map((column) => (column.id === id ? { ...column, visible: !column.visible } : column)),
  );
}
