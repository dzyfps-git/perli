import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import {
  cancelJobsAndClose,
  clipboardCanPaste,
  clipboardHasFiles,
  setJobOptions,
  setIndexOptions,
  takeSweepReport,
  clipboardText,
  deleteTag,
  disconnectDrive,
  holdClose,
  isFile,
  listPlaces,
  mapDrive,
  onCloseAsked,
  onFolderChanged,
  onOpenAsked,
  asksWaiting,
  askForTabs,
  comeForward,
  otherWindows,
  sendTab,
  keepOnDevice,
  restoreCold,
  fetchRows,
  setTagPaths,
  openWindow,
  mountImage,
  quickAccessPins,
  forgetSession,
  reopenWindow,
  restoreWindows,
  selectInWindow,
  workspaceWindows,
  recentFiles,
  onSearchGrew,
  onSizesGrew,
  openFile,
  openTerminal,
  rowsWhere,
  rowsMatching,
  rankNames,
  redoJob,
  saveSession,
  selectionPaths,
  startJob,
  startState,
  sendToFileDialog,
  stopSizes,
  subfolders,
  undoJob,
  commonTags,
  setTag,
  type Grouping,
  type Filter,
  type Places,
  type Recent,
  type Row,
  type ShellTarget,
  type Sort,
  type OpenAsk,
  type Tag,
  type Terminal,
  renamePlace,
  removePlace,
  shareLink,
  type CloudPlace,
  type SyncPair,
} from "./api";
import { AddPlace, Versions } from "./features/cloud/CloudDialogs";
import {
  closeSync,
  editingSync,
  editSync,
  forgetSync,
  newSync,
  readSyncPairs,
  startSyncTimer,
  SyncSheet,
} from "./features/sync/SyncSheet";
import { isPerliCloud, isPlaceRoot, placeName, placePath } from "./features/cloud/cloud";
import { addingPlace, placeOf, readCloudPlaces, setAddingPlace } from "./features/cloud/cloudState";
import { createFileActions } from "./features/fileops/actions";
import { BatchRename, type RenameRequest } from "./features/fileops/BatchRename";
import { ZipOptions, type ZipRequest } from "./features/fileops/ZipOptions";
import { followFileDrag } from "./features/fileops/fileDrag";
import { checkCut, cutNames, takeBackCut } from "./features/fileops/clipboard";
import { ConfirmDelete, type DeleteRequest } from "./features/fileops/ConfirmDelete";
import { createJobs } from "./features/fileops/jobs";
import { JobsPanel } from "./features/fileops/JobsPanel";
import { NewGallery, type NewPick } from "./features/fileops/NewGallery";
import { LookPicker } from "./features/sidebar/LookPicker";
import { extensionsOf, iconKindOf, kindOf, type Kind } from "./features/filelist/fileKinds";
import { KIND_LABELS } from "./features/filelist/iconTheme";
import { editWhenShown } from "./features/preview/QuickEdit";
import { ColorField } from "./ui/Controls";
import { createShellItems } from "./features/fileops/shellItems";
import { AppPicker } from "./features/dialogs/AppPicker";
import { DisconnectDrive, MapDrive } from "./features/dialogs/NetworkDrives";
import { Properties } from "./features/dialogs/Properties";
import { NO_FILTER, toFilter } from "./features/filelist/filter";
import { FilterChips } from "./features/pathbar/FilterChips";
import { BIN_COLUMNS, FLAT_COLUMNS, nextGrouping, nextSort, SEARCH_COLUMNS, ZIP_COLUMNS } from "./features/filelist/columns";
import { GROUP_CHOICES, groupLabel } from "./features/filelist/groups";
import type { Empty } from "./features/filelist/EmptyState";
import { FileList } from "./features/filelist/FileList";
import { FolderColumns } from "./features/filelist/FolderColumns";
import { FilterDialog } from "./features/filelist/FilterDialog";
import { clampTile, isLargestTile, isSmallestTile, TILE_STEP, type Layout } from "./features/filelist/layout";
import {
  columnsOf,
  detailsPanel,
  pictureWall,
  picturesInGallery,
  newTabOpens,
  newTabFolder,
  setNewTabOpens,
  setNewTabFolder,
  setPictureWall,
  setPicturesInGallery,
  setSizeBars,
  sizeBars,
  previewPane,
  setPreviewPane,
  inlineFolders,
  folderSizes,
  rowDensity,
  setRowDensity,
  setStatusBar,
  setWindowsIcons,
  statusBar,
  windowsIcons,
  type Density,
  forgetSorts,
  grouping,
  setDetailsPanel,
  setFolderSizes,
  setGrouping,
  setLastLayout,
  setLastSort,
  setShowHidden,
  setShowSystem,
  setTileSize,
  openInWindow,
  showHidden,
  columnFiles,
  setColumnFiles,
  showSystem,
  tileSize,
  toggleColumn,
  verifyCopies,
  onePerDrive,
  terminalChoice,
  TERMINAL_NAMES,
  upOnDoubleClick,
  iconTheme,
  setIconTheme,
  saved,
} from "./features/filelist/prefs";
import { SelectPattern } from "./features/filelist/SelectPattern";
import { COPIES_QUERY, FLAT_QUERY, type FolderView, type RowAt } from "./features/navigation/folderView";
import { indexOptions } from "./features/settings/indexPrefs";
import { BIN_PATH, THIS_PC_PATH, isBin, isLibrary, isDriveRoot, isArchiveName, isInside, join, parentOf, baseName, relativeTo, samePath, type Crumb } from "./features/navigation/path";
import { Palette, type Command } from "./features/palette/Palette";
import { wordsFor, type Verb } from "./features/palette/words";
import { PaneDivider } from "./features/tabs/PaneDivider";
import { PathBar, type Suggested, type Suggestion } from "./features/pathbar/PathBar";
import { CompareBar } from "./features/pathbar/CompareBar";
import { formatSize } from "./ui/format";
import { ZipBar } from "./features/pathbar/ZipBar";
import { commandFor, keysFor, keyText } from "./features/keys/keybinds";
import { comboOf, KEYS } from "./features/keys/keys";
import { KeySheet } from "./features/keys/KeySheet";
import { ActivityLog } from "./features/reach/ActivityLog";
import { DropChips } from "./features/reach/DropChips";
import { Space } from "./features/space/SpaceView";
import { TimeRiver } from "./features/space/TimeRiver";
import { CompareThreads } from "./features/compare/Threads";
import { Twins } from "./features/space/TwinsView";
import { readTyped } from "./features/reach/lists";
import {
  forgetNickname,
  forgetServer,
  nicknames,
  noteFolder,
  recentFolders,
  rememberRecent,
  setRememberRecent,
  setNickname,
  setShelfOpen,
  shelfOpen,
  shelve,
} from "./features/reach/reach";
import type { BarItem } from "./features/reach/SelectionBar";
import { Shelf } from "./features/reach/Shelf";
import { DetailsPanel } from "./features/preview/DetailsPanel";
import { PreviewDock, QuickPreview, type PreviewAt } from "./features/preview/QuickPreview";
import { stepWidth } from "./features/preview/DockEdge";
import { Compare, type CompareSide } from "./features/compare/Compare";
import { compareKind } from "./features/compare/comparable";
import { DOCK_STEP } from "./features/preview/dockWidth";
import { MiniPlayer } from "./features/preview/MiniPlayer";
import { CutChip } from "./features/fileops/CutChip";
import { sweptText } from "./features/fileops/progress";
import { audio, now } from "./features/preview/nowPlaying";
import { holdBack } from "./features/preview/popOut";
import type { HandBack } from "./features/mini/handover";
import { BACKDROPS, SCALES, setBackdrop, setUiScale } from "./features/settings/appearance";
import { Settings } from "./features/settings/Settings";
import { HomePage } from "./features/home/HomePage";
import { putOffUpdate, setUpdateSheet, startUpdates, updateSheet, updateState } from "./features/settings/updates";
import { UpdateSheet } from "./features/settings/UpdateSheet";
import { BookmarksBar } from "./features/sidebar/BookmarksBar";
import { holds, placeLabel } from "./features/sidebar/placeLists";
import {
  addBookmarks,
  smartFolders,
  setSmartFolders,
  bookmarkGroups,
  BOOKMARKS,
  bookmarks,
  bookmarksBar,
  groupOf,
  setGroup,
  hiddenSections,
  movePinned,
  pinned,
  SECTIONS,
  setBookmarksBar,
  setBookmarksCompact,
  bookmarksCompact,
  setLook,
  setPinned,
  setSidebarOpen,
  sidebarOpen,
  toggleBookmark,
  togglePinned,
  toggleSection,
} from "./features/sidebar/saved";
import { folderGlyph, FOLDERS, Sidebar } from "./features/sidebar/Sidebar";
import { parseMoved, parseSession, windowExtras } from "./features/tabs/session";
import { createTabs, leaveWindow, leftWindow, type Tab } from "./features/tabs/tabs";
import { ownPlace } from "./ui/windowPlace";
import { createWorkspaces, workspaces } from "./features/tabs/workspaces";
import { NewTag } from "./features/tags/NewTag";
import { refreshTags, TAG_DROP, tagQuery, tags as allTags } from "./features/tags/tags";
import { TitleBar } from "./features/titlebar/TitleBar";
import { Menu, type MenuItem } from "./ui/Menu";
import { NameSheet, type NameAsk } from "./ui/NameSheet";
import { dropOnPicker, pick, PICKER_PLACE, PickerHost, pickerViews, type PickerPanes } from "./features/dialogs/Picker";
import { renamedSmart, withoutSmart, withSmart, type SmartFolder } from "./features/smart/smartList";
import { iconFor } from "./ui/menuLook";
import { Tooltip } from "./ui/Tooltip";
import "./ui/controls.css";

const SAVE_DELAY_MS = 300;
/** Windows closed within this long of each other were closed together, as the taskbar's Close all windows does. */
const CLOSE_TOGETHER_MS = 800;
/** How long a folder bound for its own window waits to hear which file to select there. */
const WINDOW_WAIT_MS = 600;
/** How long a window opened for a folder takes the file named for it after. */
const LATE_SELECT_MS = 10_000;
const MOUSE_BACK = 3;
const MOUSE_FORWARD = 4;
const ICON_SETTINGS = "\uE713";
const ICON_HOME_PAGE = "\uECA5";

// Waits for the frame after the rows are drawn, so this means the user can see them.
function markReady() {
  requestAnimationFrame(() => requestAnimationFrame(() => performance.mark("perli-ready")));
}

// WebView2's find bar, reload and save dialog would break the app's look, so these keys do nothing.
function isBrowserKey(event: KeyboardEvent, key: string) {
  const ctrlKeys = ["f", "g", "n", "r", "s", "+", "=", "-", "0"];
  return ["f3", "f5", "f7"].includes(key) || (event.ctrlKey && ctrlKeys.includes(key));
}

/** The edge of the window is drawn once, as Perli starts. */
const drawsEdge = !matchMedia("(prefers-reduced-motion: reduce)").matches;

const isTyping = (event: Event) =>
  event.target instanceof HTMLInputElement ||
  event.target instanceof HTMLTextAreaElement ||
  event.target instanceof HTMLSelectElement ||
  (event.target instanceof HTMLElement && event.target.isContentEditable);
// A job's Delete key must only ever mean the files, never a focused button.
const isInList = (event: Event) => (event.target as HTMLElement).classList?.contains("file-grid");
/** Inputs that take typed text, whose right-click gives Perli's own Cut, Copy and Paste. */
const TEXT_TYPES = new Set(["text", "search", "url", "email", "tel", "number"]);
function textField(target: EventTarget | null) {
  if (target instanceof HTMLTextAreaElement) return target;
  if (target instanceof HTMLInputElement) return TEXT_TYPES.has(target.type) ? target : undefined;
  if (target instanceof HTMLElement && target.isContentEditable) return target;
}
/** A menu longer than this would only be scrolled past. */
const MOST_CRUMB_FOLDERS = 300;
/** Longer than any press and release of one click. */
const CLICK_MS = 400;
/** Folders opened behind at once. More would be a slip of the hand. */
const MOST_TABS_BEHIND = 8;
/** As many as the path bar offers at once. */
const MOST_OFFERS = 8;
/** What "sort by" and "view" take in the palette. */
const SORT_WORDS = ["name", "modified", "created", "type", "size"];
const VIEW_WORDS = ["list", "grid", "gallery", "columns", "compact", "cozy", "roomy"];
/** Sorted by nothing a column stands for, so the next sort takes its own first direction. */
const UNSORTED: Sort = { key: "found", descending: false };
const ICON_PIN = "\uE718";
const ICON_REOPEN = "\uE7A7";
const ICON_WORKSPACE = "\uE8A9";
const ICON_CHECK = "\uE73E";
const ICON_ADD = "\uE710";
const ICON_RENAME = "\uE8AC";
const ICON_DELETE = "\uE74D";
/** How many files of each kind the palette can find by name. */
const PALETTE_FILES = 200;
const ICON_FOLDER = "\uE8B7";
const ICON_FILE = "\uE7C3";
const ICON_CLOUD = "\uE753";
const ICON_SMART = "\uE71C";
const ICON_DRIVE = "\uEDA2";
/** Commands that need a real folder, which the Recycle Bin is not. */
const FOLDER_ONLY = new Set([
  "copy",
  "cut",
  "paste",
  "duplicate",
  "copyPath",
  "rename",
  "newFolder",
  "newFolderWith",
  "newFile",
  "properties",
  "shelve",
  "copyToOther",
  "moveToOther",
  "terminal",
  "backgroundTab",
  "openToSide",
  "diskMap",
  "timeRiver",
  "twins",
  "colourWall",
  "toFileDialog",
]);
/** Commands that change files, or need a folder on a disk, which a ZIP opened as a folder is not. */
const ZIP_HIDES = new Set([
  "cut",
  "paste",
  "duplicate",
  "rename",
  "delete",
  "deleteForGood",
  "newFolder",
  "newFolderWith",
  "newFile",
  "shelve",
  "moveToOther",
  "terminal",
  "diskMap",
  "timeRiver",
  "twins",
  "colourWall",
  "toFileDialog",
]);
/** A key with no Ctrl or Alt in it types a letter, so it must not run a command while typing. */
const typesText = (combo: string) => !/Ctrl|Alt|^F\d+$/.test(combo);
const blockBrowserZoom = (event: WheelEvent) => event.ctrlKey && event.preventDefault();
const trackWindowFocus = (event: FocusEvent) =>
  document.documentElement.toggleAttribute("data-blurred", event.type === "blur");
/** The columns a view keeps to itself, which the user can't change. */
const ownColumns = (view: FolderView) =>
  view.isBin()
    ? BIN_COLUMNS
    : view.query() === FLAT_QUERY
      ? FLAT_COLUMNS
      : view.query()
        ? SEARCH_COLUMNS
        : view.isZip()
          ? ZIP_COLUMNS
          : undefined;
/** A folder's kept columns, or the ones a search or the bin always has. */
const shownColumns = (view: FolderView) => ownColumns(view) ?? columnsOf(view.columnSet());
/** Tiles of one size or another, which take the tile size items. */
const tiled = (view: FolderView) => view.layout() === "grid" || view.layout() === "gallery";
/** The column view shows the folders above beside the list, but not for a search or the bin. */
const inColumns = (view: FolderView) => view.layout() === "columns" && !view.query() && !view.isBin();

/** What a view's rows can gather under headers by. Only rows from many folders have a folder each. */
function groupByItems(view: FolderView) {
  const groups = view.folder()?.groups ?? [];
  const openKey = groups.find((group) => !view.folded().includes(group.key))?.key;
  const foldedKey = groups.find((group) => view.folded().includes(group.key))?.key;
  return [
    ...GROUP_CHOICES.filter(({ by }) => by !== "folder" || !!view.query() || view.isBin()).map(({ by, label }) => ({
      label,
      checked: view.groupBy() === by,
      // Copies stay in their sets.
      disabled: view.query() === COPIES_QUERY,
      action: () => view.setGroupBy(by),
    })),
    ...(groups.length > 0
      ? [
          { label: "Fold all groups", divider: true, disabled: !openKey, action: () => openKey && view.toggleFold(openKey, true) },
          { label: "Open all groups", disabled: !foldedKey, action: () => foldedKey && view.toggleFold(foldedKey, true) },
        ]
      : []),
  ];
}
const rowPath = (view: FolderView, row: Row) => join(row.location || view.folder()!.path, row.name);
const toggleFlat = (view: FolderView) => view.search(view.query() === FLAT_QUERY ? "" : FLAT_QUERY);
const findCopies = (view: FolderView) => view.search(view.query() === COPIES_QUERY ? "" : COPIES_QUERY);

/** Long enough for "Renamed a long name to another", short enough for a menu. */
const UNDO_LABEL_LENGTH = 48;

/** "Undo: Renamed a.txt to b.txt", cut short where the names are long. */
function undoLabel(verb: string, text: string | null) {
  if (!text) return verb;
  const short = text.length > UNDO_LABEL_LENGTH ? `${text.slice(0, UNDO_LABEL_LENGTH - 1)}…` : text;
  return `${verb}: ${short}`;
}

/** The folder whose look is being chosen, in its own sheet. */
const [lookFor, setLookFor] = createSignal<string>();
/** The kind whose icon color is being picked from the row menu, and where the menu was. */
const [tinting, setTinting] = createSignal<{ x: number; y: number; kind: Kind }>();
/** Kinds Perli reads as plain text, which the preview can edit in place. */
const WRITTEN: ReadonlySet<Kind> = new Set<Kind>(["text", "markdown", "code", "web", "config", "script", "log", "subtitle", "data"]);

function lookItem(path: string): MenuItem {
  return { label: "Folder look…", action: () => setLookFor(path) };
}

/** Pinning, bookmarking and the look of a folder. */
function keepItems(path: string): MenuItem[] {
  const isPinned = holds(pinned(), path);
  const at = pinned().findIndex((item) => item.toLowerCase() === path.toLowerCase());
  return [
    { label: isPinned ? "Unpin from sidebar" : "Pin to sidebar", divider: true, action: () => togglePinned(path) },
    ...(isPinned
      ? [
          { label: "Move up", disabled: at === 0, action: () => movePinned(path, -1) },
          { label: "Move down", disabled: at === pinned().length - 1, action: () => movePinned(path, 1) },
        ]
      : []),
    {
      label: holds(bookmarks(), path) ? "Remove bookmark" : "Add bookmark",
      action: () => toggleBookmark(path),
    },
    ...(holds(bookmarks(), path) ? [groupItem(path)] : []),
    lookItem(path),
  ];
}

/** The one name being asked for, if any. */
const [naming, setNaming] = createSignal<NameAsk>();

/** Puts a bookmark in a group of the bar, or takes it out. */
function groupItem(path: string): MenuItem {
  const now = groupOf(path);
  return {
    label: "Bookmark group",
    items: [
      { label: "None", checked: !now, action: () => setGroup(path, undefined) },
      ...bookmarkGroups().map((group) => ({ label: group, checked: group === now, action: () => setGroup(path, group) })),
      {
        label: "New group…",
        divider: true,
        action: () => setNaming({ title: "New bookmark group", confirm: "Create", done: (name) => setGroup(path, name) }),
      },
    ],
  };
}

// The main layout. Moving parts of the app around should only change this file.
export function App() {
  const tabs = createTabs();
  const spaces = createWorkspaces(tabs);
  // Keys set for a folder or a workspace hold while it is on screen.
  createEffect(() => keysFor({ folder: tabs.activeView().path(), workspace: spaces.current() }));
  /** With two panes in the tab, turning on or off the marks of how their rows stand against each other. */
  const compareItems = () => {
    const tab = tabs.active();
    return tab.panes().length > 1 ? [{ label: "Compare with other pane", checked: tab.comparing(), action: () => tab.setComparing(!tab.comparing()) }] : [];
  };
  /** `from` is the path crumb whose menu this is. */
  const [menu, setMenu] = createSignal<{
    x: number;
    y: number;
    above?: number;
    items: MenuItem[];
    from?: string;
    mount?: HTMLElement;
    /** Runs as the menu closes, picked from or not. */
    closed?: () => void;
  }>();
  /** The settings are a tab of their own: it can exist without being the one in front. */
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [settingsShown, setSettingsShown] = createSignal(false);
  const showSettings = () => {
    setSettingsOpen(true);
    setSettingsShown(true);
  };
  const closeSettings = () => {
    setSettingsShown(false);
    setSettingsOpen(false);
    tabs.activeView().list()?.focus();
  };
  const [paletteOpen, setPaletteOpen] = createSignal(false);
  /** The palette asks for a tab, a workspace or a workspace's new name instead of any command. */
  const [paletteScope, setPaletteScope] = createSignal<"tabs" | "workspaces" | "renameWorkspace">();
  /** Where Alt+Home leads, as Windows tells it at the start. */
  let homePath: string | undefined;
  const [foundFiles, setFoundFiles] = createSignal<Command[]>([]);
  const [edgeShown, setEdgeShown] = createSignal(drawsEdge);
  const [places, setPlaces] = createSignal<Places>();
  const [deleting, setDeleting] = createSignal<DeleteRequest>();
  const [renaming, setRenaming] = createSignal<RenameRequest>();
  const [filtering, setFiltering] = createSignal<FolderView>();
  const [selectingPattern, setSelectingPattern] = createSignal<FolderView>();
  const [namingTag, setNamingTag] = createSignal<FolderView>();
  const [showingProperties, setShowingProperties] = createSignal<{ target: ShellTarget; at: { x: number; y: number } }>();
  const [pickingApp, setPickingApp] = createSignal<string[]>();
  const [drives, setDrives] = createSignal<"map" | "disconnect">();
  /** The cloud file whose older versions show. */
  const [versioning, setVersioning] = createSignal<{ path: string; view: FolderView }>();
  const [previewing, setPreviewing] = createSignal<{ view: FolderView; at: PreviewAt }>();
  const [comparing, setComparing] = createSignal<{ view: FolderView; snapshot: number; kind: "picture" | "text"; sides: [CompareSide, CompareSide] }>();
  const [keysOpen, setKeysOpen] = createSignal(false);
  const [activityOpen, setActivityOpen] = createSignal(false);
  /** The folder the disk map starts in, while the map is open. */
  /** The folder Space is open on, "" for This PC, or nothing while it is closed. */
  const [mapping, setMapping] = createSignal<string>();
  /** The folder the Time river or Twins is open on. */
  const [riverOn, setRiverOn] = createSignal<string>();
  /** The folders Twins looks across, or nothing while it is closed. */
  const [twinsOn, setTwinsOn] = createSignal<string[]>();
  /** The New gallery, where it opens and the view it makes things in. */
  const [making, setMaking] = createSignal<{ view: FolderView; x: number; y: number }>();
  /** A sheet covers the tabs, so nothing behind it may change. */
  const sheetOpen = () =>
    !!deleting() ||
    !!renaming() ||
    !!filtering() ||
    !!namingTag() ||
    !!showingProperties() ||
    !!pickingApp() ||
    !!drives() ||
    !!previewing() ||
    !!comparing() ||
    keysOpen() ||
    mapping() !== undefined ||
    riverOn() !== undefined ||
    twinsOn() !== undefined ||
    updateSheet() ||
    activityOpen() ||
    // Every sheet opens as a modal dialog, so one left off the list above still counts.
    !!document.querySelector("dialog:modal");
  /** The settings page stands where the files do, so the keys of the files rest too. */
  const dialogOpen = () => settingsShown() || sheetOpen();
  // Going to a folder, by any road, puts the files back in front.
  createEffect(
    on([tabs.active, () => tabs.activeView().arrival()], () => setSettingsShown(false), { defer: true }),
  );
  /** The panes and the picker's list, which jobs and outside changes reload alike. */
  const everyView = () => [...tabs.allViews(), ...pickerViews()];
  const jobs = createJobs(everyView, {
    open: (folder) => void tabs.activeView().open(folder),
    // A drive Windows can eject is one the sidebar shows with its eject button.
    ejectRoot: (path) =>
      places()?.drives.find((drive) => drive.removable && path.toLowerCase().startsWith(drive.path.toLowerCase()))?.path,
    driveName: (root) => places()?.drives.find((drive) => samePath(drive.path, root))?.name ?? root,
    tagsChanged,
  });
  const [zipping, setZipping] = createSignal<ZipRequest>();
  // The pane beside the one acting, which a button in a pane that isn't active must still find.
  const actions = createFileActions(jobs, setDeleting, (view) => tabs.active().panes().find((other) => other !== view), setRenaming, setZipping);
  const shell = createShellItems(jobs, actions, {
    properties: (target, at) => setShowingProperties({ target, at }),
    pickApp: setPickingApp,
  });
  const refreshPlaces = () => listPlaces().then(setPlaces).catch(console.error);
  /** The picker offers the folders on show first. The Recycle Bin and archives are no place to save. */
  const pickerPanes = (): PickerPanes => {
    const real = (view: FolderView | undefined) => (view && !view.isBin() && !view.isZip() && !isLibrary(view.folder()?.path) ? view.folder()?.path : undefined);
    const here = tabs.activeView();
    return { here: real(here), there: real(tabs.active().panes().find((other) => other !== here)), home: homePath };
  };
  // Each window keeps its tabs in a file of its own, except a run started on one folder: a detour,
  // which must not replace the saved tabs.
  const [keepSession, setKeepSession] = createSignal(false);
  /** One more window, whose session keeps its place too. */
  let newWindow = false;
  let saveTimer: number | undefined;
  let unsaved: unknown;
  let saving = Promise.resolve();

  /** Writes one at a time, so an older save can never land after a newer one. Rejects when the
   * write fails, and the session then waits for the next flush to try again. */
  function flushSession() {
    window.clearTimeout(saveTimer);
    if (unsaved === undefined) return saving;
    const session = unsaved;
    unsaved = undefined;
    saving = saving
      .catch(() => undefined)
      .then(() => saveSession(JSON.stringify(session)))
      .catch((error: unknown) => {
        unsaved ??= session;
        throw error;
      });
    return saving;
  }

  createEffect(() => setJobOptions(verifyCopies(), onePerDrive()).catch(console.error));
  createEffect(() => setIndexOptions(indexOptions()).catch(console.error));

  createEffect(() => {
    const session = keepSession() ? tabs.session() : undefined;
    if (!session) return;
    unsaved = { ...session, workspace: spaces.current() ?? null, ...(newWindow ? { place: ownPlace() } : {}) };
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => flushSession().catch(console.error), SAVE_DELAY_MS);
  });

  const stopJobs: DeleteRequest = {
    title: "Jobs are still running",
    note: "Closing Perli cancels them. Anything already finished stays.",
    cancelLabel: "Keep working",
    confirmLabel: "Cancel jobs and close",
    // The back end closes the window itself here, with no close event to forget it on.
    confirm: () => leaveSession().catch(console.error).then(cancelJobsAndClose).catch(jobs.report),
  };

  async function onClose(request: number) {
    // A failed save must not keep the window open.
    const [held] = await Promise.all([holdClose(request), flushSession().catch(console.error)]);
    if (held) {
      setDeleting(stopJobs);
      return;
    }
    await leaveSession().catch(console.error);
    await getCurrentWindow().destroy();
  }

  /**
   * Browser-style: a window closed while others stay open is forgotten, kept a while to reopen
   * unless its tabs went to another window. The last one keeps its tabs for the next start, and a
   * Windows restart, which closes no window, keeps them all. So do windows closed all at once:
   * each hides and looks again a moment later, and one with no other left in sight was among them.
   */
  async function leaveSession() {
    if (!keepSession() || (await otherWindows()).length === 0) return;
    if (!leftWindow()) {
      await getCurrentWindow().hide();
      await new Promise((done) => setTimeout(done, CLOSE_TOGETHER_MS));
      if ((await otherWindows()).length === 0) return;
    }
    // Nothing may be written once the file is gone, which would bring it back.
    setKeepSession(false);
    await flushSession();
    await forgetSession(!leftWindow());
  }

  // Covers every way to close, including Alt+F4 and the taskbar.
  const closeListener = onCloseAsked(onClose);
  const dragListener = followFileDrag(
    tabs.allViews,
    jobs.report,
    (x, y, items, closed) => setMenu({ x, y, items, closed }),
    dropNoted,
    (folder) => void tabs.active().active().open(folder),
    setDeleting,
  );
  // Other apps and Windows' own commands change folders without Perli running a job.
  const folderListener = onFolderChanged((id) => everyView().find((view) => view.id === id)?.reload());
  const searchListener = onSearchGrew((id, walk) =>
    tabs.allViews().find((view) => view.id === id)?.searchGrew(walk),
  );
  const sizesListener = onSizesGrew((id) => everyView().find((view) => view.id === id)?.sizesGrew());

  let windowTimer: number | undefined;
  let windowWaiting: string | undefined;
  /** The window opened last for a folder alone, which a file named a little later is selected in. */
  let lastOpened: { folder: string; process: number; at: number } | undefined;

  async function openFolderWindow(folder: string) {
    lastOpened = { folder, process: await openWindow(folder, []), at: Date.now() };
  }

  /**
   * A folder opened from outside Perli gets a tab. Items to select go to the tab that shows their
   * folder already, which is the one opened a moment ago when another app asked to show a file.
   */
  async function openAsked(ask: OpenAsk) {
    if (!ask.folder) return comeForward();
    const folder = ask.folder;
    if (openInWindow() && !ask.here) {
      // "Show in folder" asks twice: for the folder, then for the file to select in it. The folder
      // waits a moment for its file, and a file named after that goes to the window it opened.
      window.clearTimeout(windowTimer);
      const waited = windowWaiting;
      windowWaiting = undefined;
      if (waited && !samePath(waited, folder)) await openFolderWindow(waited);
      if (ask.select.length > 0) {
        const last = lastOpened;
        if (last && samePath(last.folder, folder) && Date.now() - last.at < LATE_SELECT_MS) {
          lastOpened = undefined;
          if (await selectInWindow(last.process, folder, ask.select)) return;
        }
        return void (await openWindow(folder, ask.select));
      }
      windowWaiting = folder;
      windowTimer = window.setTimeout(() => {
        windowWaiting = undefined;
        openFolderWindow(folder).catch(console.error);
      }, WINDOW_WAIT_MS);
      return;
    }
    comeForward().catch(console.error);
    setSettingsShown(false);
    // This PC, from Win+E or a link, is the home page in a tab of its own.
    if (folder === THIS_PC_PATH) {
      if (await tabs.add([homePath ?? ""])) tabs.active().setHome(true);
      return;
    }
    // A tab showing search results there can't select by name, so it gets a plain tab instead.
    const shown =
      ask.select.length > 0 &&
      tabs.tabs().find((tab) => !tab.active().query() && samePath(tab.active().folder()?.path, folder));
    if (shown) tabs.activate(shown);
    const view = shown ? shown.active() : await tabs.add([folder]);
    if (ask.select.length > 0) await view?.reload(ask.select);
  }
  const openListener = onOpenAsked((ask) => openAsked(ask).catch(console.error));

  async function searchIn(view: FolderView, path: string) {
    if (await view.open(path)) view.askSearch();
  }

  function openRow(view: FolderView, row: Row, toSide: boolean) {
    if (view.isBin()) return;
    const path = rowPath(view, row);
    const asFolder = row.isDir || isArchiveName(row.name);
    if (!asFolder) openFile(path).catch(jobs.report);
    else if (toSide) tabs.openToSide(path);
    else view.open(path);
  }

  function preview(view: FolderView, at: RowAt) {
    const folder = view.folder();
    if (!folder) return;
    const snapshot = () => view.folder()?.request ?? at.snapshot;
    const count = () => view.folder()?.count ?? folder.count;
    const selected = () => view.folder()?.selected?.[0];
    const chosen = [...(view.list()?.selection().rows ?? [])];
    setPreviewing({ view, at: { view: view.id, snapshot, index: at.index, count, selected, folder: folder.path, chosen } });
  }

  /** The focused row, which the list's selection gives first. */
  function previewSelected(view: FolderView) {
    const selection = view.list()?.selection();
    if (selection?.rows.length) preview(view, { snapshot: selection.request, index: selection.rows[0] });
  }

  function closePreview() {
    const shown = previewing();
    setPreviewing(undefined);
    shown?.view.list()?.focus();
  }

  const toggleDetails = () => setDetailsPanel(!detailsPanel());
  /** Opens the preview pane if it is shut, then makes it wider or narrower. */
  function resizePreview(step: number) {
    if (!previewPane()) setPreviewPane(true);
    stepWidth(step, document.querySelector(".panes:not([hidden]) .preview-dock"));
  }
  /** Where files from the shelf can land: a real folder, not the Recycle Bin or a search. */
  const dropFolder = () => {
    const view = tabs.activeView();
    return view.isBin() || view.isZip() || view.query() ? undefined : view.folder()?.path;
  };
  /** Says what went wrong, and still lets the caller know that it did. */
  const failed = (failure: unknown) => {
    jobs.report(failure);
    throw failure;
  };
  // The folders seen lately are places to drop on and to move to.
  createEffect(() => noteFolder(tabs.activeView().isZip() ? undefined : tabs.activeView().folder()?.path));
  // With the arrows turned off, nothing could close a folder opened in place.
  createEffect(on(inlineFolders, (on) => on || tabs.allViews().forEach((view) => view.collapseAll()), { defer: true }));
  const toggleSidebar = () => setSidebarOpen(!sidebarOpen());

  const networkItems = (): MenuItem[] => [
    { label: "Map network drive", divider: true, action: () => setDrives("map") },
    { label: "Disconnect network drive", action: () => setDrives("disconnect") },
  ];

  /** Pressing a chevron closes its own menu before the click arrives, which must not reopen it. */
  let crumbClosed = { path: "", at: 0 };
  function closeMenu() {
    const from = menu()?.from;
    if (from) crumbClosed = { path: from, at: performance.now() };
    menu()?.closed?.();
    setMenu(undefined);
  }

  async function showCrumbMenu(view: FolderView, path: string, x: number, y: number) {
    if (crumbClosed.path === path && performance.now() - crumbClosed.at < CLICK_MS) return;
    let items: MenuItem[];
    try {
      const names = await subfolders(path, showHidden(), showSystem());
      items = names.slice(0, MOST_CRUMB_FOLDERS).map((name) => ({ label: name, action: () => view.open(join(path, name)) }));
      if (names.length > MOST_CRUMB_FOLDERS) {
        items.push({ label: `${names.length - MOST_CRUMB_FOLDERS} more, open the folder to see them`, disabled: true });
      }
    } catch {
      items = [];
    }
    setMenu({ x, y, items: items.length > 0 ? items : [{ label: "No folders inside", disabled: true }], from: path });
  }

  function showFolderMenu(event: MouseEvent, view: FolderView, path: string) {
    event.preventDefault();
    if (isPerliCloud(path)) return showCloudFolderMenu(event, view, path);
    const items = [
      { label: "Open", action: () => view.open(path) },
      { label: "Open in new tab", action: () => tabs.add([path]) },
      { label: "Open to side", action: () => tabs.openToSide(path) },
      ...(isBin(path)
        ? []
        : [
            { label: "Search here", action: () => searchIn(view, path) },
            { label: "Find copies here", action: async () => void ((await view.open(path)) && findCopies(view)) },
            { label: "Copy path", action: () => quietly(copyFolderPath(path)) },
            { label: "Sync this folder…", action: () => newSync(path) },
            {
              label: "New tabs open here",
              checked: newTabOpens() === "folder" && samePath(newTabFolder() ?? "", path),
              action: () => {
                const on = !(newTabOpens() === "folder" && samePath(newTabFolder() ?? "", path));
                setNewTabFolder(on ? path : null);
                setNewTabOpens(on ? "folder" : "same");
              },
            },
            ...keepItems(path),
            ...shell.placeItems(path, { x: event.clientX, y: event.clientY }),
            ...(isDriveRoot(path) ? networkItems() : []),
            ...(places()?.drives.some((drive) => drive.removable && samePath(drive.path, path))
              ? [{ label: places()?.drives.find((drive) => samePath(drive.path, path))?.mounted ? "Unmount" : "Eject", divider: true, action: () => jobs.eject(path) }]
              : []),
          ]),
    ];
    setMenu({ x: event.clientX, y: event.clientY, items });
  }

  /** A sync runs as a job. One the timer asks for runs only if it is due. */
  const runSync = (id: string, scheduled = false) =>
    startJob({ kind: "sync", id, scheduled }, tabs.activeView().id)
      .then(readSyncPairs)
      .catch(scheduled ? console.error : jobs.report);
  startSyncTimer(runSync);

  function showSyncMenu(event: MouseEvent, pair: SyncPair) {
    event.preventDefault();
    const items: MenuItem[] = [
      { label: "Run now", action: () => (pair.mirror ? editSync(pair) : runSync(pair.id)) },
      { label: "Look first…", action: () => editSync({ ...pair, ran: 0 }) },
      { label: "Edit…", action: () => editSync(pair) },
      { label: "Open the source", divider: true, action: () => tabs.activeView().open(pair.from) },
      { label: "Open the target", action: () => tabs.activeView().open(pair.to) },
      { label: "Remove sync", divider: true, action: () => quietly(forgetSync(pair)) },
    ];
    setMenu({ x: event.clientX, y: event.clientY, items });
  }

  /** A cloud place of Perli's own, or a folder in one. Windows knows nothing of them. */
  function showCloudFolderMenu(event: MouseEvent, view: FolderView, path: string) {
    const place = placeOf(path);
    const items: MenuItem[] = [
      { label: "Open", action: () => view.open(path) },
      { label: "Open in new tab", action: () => tabs.add([path]) },
      { label: "Open to side", action: () => tabs.openToSide(path) },
      ...(placeName(path)
        ? [
            { label: "Search here", action: () => searchIn(view, path) },
            { label: "Sync this folder…", action: () => newSync(path) },
          ]
        : []),
      ...(place && isPlaceRoot(path)
        ? [
            {
              label: "Rename place…",
              divider: true,
              action: () =>
                setNaming({ title: "Rename cloud place", confirm: "Rename", start: place.name, done: (name) => quietly(renameCloudPlace(place, name)) }),
            },
            { label: "Remove place…", action: () => askRemovePlace(place) },
          ]
        : []),
      { label: "Add a cloud place…", divider: true, action: () => setAddingPlace(true) },
    ];
    setMenu({ x: event.clientX, y: event.clientY, items });
  }

  /** Tabs in the place follow it to its new name. */
  async function renameCloudPlace(place: CloudPlace, name: string) {
    const [before, renamed] = [placePath(place), await renamePlace(place.id, name)];
    await readCloudPlaces();
    for (const each of tabs.allViews()) {
      const shown = each.folder()?.path;
      if (shown && isPerliCloud(shown) && placeName(shown)?.toLowerCase() === place.name.toLowerCase()) {
        void each.open(placePath(renamed) + shown.slice(before.length));
      }
    }
  }

  function askRemovePlace(place: CloudPlace) {
    setDeleting({
      title: `Remove ${place.name}?`,
      note: "Perli forgets the place and its key. Nothing in the cloud changes, and adding it again brings it back.",
      confirmLabel: "Remove",
      safe: true,
      async confirm() {
        await removePlace(place.id).then(readCloudPlaces).catch(jobs.report);
      },
    });
  }

  /** Rows of a cloud place: what Windows' own menu would do there needs a file on this PC. */
  async function showCloudRowMenu(view: FolderView, row: Row, path: string, x: number, y: number) {
    const canPaste = await clipboardCanPaste();
    const one = view.list()?.selection().rows.length === 1;
    const two = view.list()?.selection().rows.length === 2 && !row.isDir;
    const copyLink = () =>
      shareLink(path)
        .then((link) => navigator.clipboard.writeText(link))
        .then(() => jobs.notify("Link copied", "It opens the file in a browser."));
    const items: MenuItem[] = [
      { label: "Open", action: () => openRow(view, row, false) },
      { label: "Quick preview", action: () => previewSelected(view) },
      ...(row.isDir
        ? [
            { label: "Open to side", action: () => openRow(view, row, true) },
            { label: "Open in background tab", action: () => openBehind(view, row) },
            { label: "Search here", action: () => searchIn(view, path) },
          ]
        : [shell.openWithItem(view)]),
      { label: "Cut", divider: true, action: () => actions.cut(view) },
      { label: "Copy", action: () => actions.copy(view) },
      { label: "Paste", disabled: !canPaste, action: () => actions.paste(view, row.isDir ? path : undefined) },
      { label: "Rename", action: () => actions.startRename(view) },
      { label: "Delete", action: () => actions.remove(view, false) },
      { label: "Copy link", divider: true, disabled: !one, action: () => quietly(copyLink()) },
      ...(row.isDir ? [] : [{ label: "Versions…", disabled: !one, action: () => setVersioning({ path, view }) }]),
      ...(row.isCold ? [{ label: "Restore from Glacier", action: () => restoreHere(view, row.name) }] : []),
      // A folder keeps or frees every file in it, as a job with its own card.
      ...(row.isDir
        ? [
            { label: "Keep its files on this device", action: () => keepHere(view, true) },
            { label: "Free their space", action: () => keepHere(view, false) },
          ]
        : [{ label: "Always keep on this device", checked: row.isPinned, action: () => keepHere(view, !row.isPinned) }]),
      { label: "Copy name", divider: true, action: () => quietly(copyName(view)) },
      { label: "Select same", items: sameItems(view, row) },
      ...(two ? [{ label: "Compare", keys: keyText("compare"), action: () => quietly(compare(view)) }] : []),
      ...(tabs.active().other()
        ? [
            { label: "Copy to other pane", divider: true, action: () => actions.toOtherPane(view, "copy") },
            { label: "Move to other pane", action: () => actions.toOtherPane(view, "move") },
          ]
        : []),
    ];
    setMenu({ x, y, items });
  }

  /** The bookmarks of a group, under its button on the bar. Each has its own menu to the side. */
  function showBookmarkGroup(anchor: HTMLElement, group: string) {
    const view = tabs.activeView();
    const box = anchor.getBoundingClientRect();
    const items: MenuItem[] = bookmarks()
      .filter((path) => groupOf(path) === group)
      .map((path) => ({ label: placeLabel(path), icon: folderGlyph(path).icon, action: () => view.open(path) }));
    setMenu({
      x: box.left,
      y: box.bottom + 4,
      items: [
        ...items,
        { label: "Open all in tabs", divider: true, action: () => openTabsBehind(bookmarks().filter((path) => groupOf(path) === group)) },
        {
          label: "Rename group…",
          action: () =>
            setNaming({
              title: "Rename bookmark group",
              confirm: "Rename",
              start: group,
              done: (name) => bookmarks().forEach((path) => groupOf(path) === group && setGroup(path, name)),
            }),
        },
        { label: "Ungroup", action: () => bookmarks().forEach((path) => groupOf(path) === group && setGroup(path, undefined)) },
      ],
    });
  }

  /** Files were dropped on a place of Perli's own, which only takes note of them. */
  async function dropNoted(place: string, paths: string[]) {
    if (place === PICKER_PLACE) dropOnPicker(paths);
    else if (place === BOOKMARKS) {
      const files = await Promise.all(paths.map(isFile));
      addBookmarks(paths.filter((_, at) => !files[at]));
    } else if (place.startsWith(TAG_DROP)) {
      await setTagPaths(paths, Number(place.slice(TAG_DROP.length)), true);
    }
  }

  /** Goes to the folder, then puts its search and filter on. */
  async function openSmart(view: FolderView, smart: SmartFolder) {
    if (!(await view.open(smart.folder))) return;
    view.setFilterForm(smart.filter);
    view.setScope(smart.scope);
    view.search(smart.query);
  }

  /** Keeps what `view` shows now: its folder, its search and its filter. */
  function saveSmart(view: FolderView) {
    const folder = view.folder()?.path;
    if (!folder || view.isBin()) return;
    const query = view.query();
    const start = query && query !== FLAT_QUERY && query !== COPIES_QUERY ? query.replace(/^tag:/, "") : baseName(folder) || folder;
    setNaming({
      title: "New smart folder",
      confirm: "Save",
      start,
      done: (name) =>
        setSmartFolders(withSmart(smartFolders(), { name, folder, query, scope: view.scope(), filter: view.filterForm() })),
    });
  }

  function showSmartMenu(event: MouseEvent, smart: SmartFolder) {
    event.preventDefault();
    const view = tabs.activeView();
    setMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        { label: "Open", action: () => quietly(openSmart(view, smart)) },
        {
          label: "Show in new tab",
          action: () => quietly(tabs.add([smart.folder]).then((opened) => opened && openSmart(opened, smart))),
        },
        {
          label: "Rename…",
          divider: true,
          action: () =>
            setNaming({
              title: "Rename smart folder",
              confirm: "Rename",
              start: smart.name,
              done: (name) => setSmartFolders(renamedSmart(smartFolders(), smart.name, name)),
            }),
        },
        { label: "Remove smart folder", action: () => setSmartFolders(withoutSmart(smartFolders(), smart.name)) },
      ],
    });
  }

  /** Every file with the tag, on every drive, as a search of its own. */
  async function showTagged(view: FolderView, tag: Tag) {
    // The Recycle Bin can't be searched, so the search starts from home. It covers all drives.
    if ((view.isBin() || !view.folder()) && !(await view.open(homePath ?? "C:\\"))) return;
    view.setScope("drives");
    view.search(tagQuery(tag.name));
  }

  function showTagMenu(event: MouseEvent, tag: Tag) {
    event.preventDefault();
    const view = tabs.activeView();
    const path = view.folder()?.path;
    setMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        { label: "Show tagged files", action: () => showTagged(view, tag) },
        {
          label: "Show in new tab",
          disabled: !path,
          action: () => quietly(tabs.add([path!]).then((opened) => opened && showTagged(opened, tag))),
        },
        { label: "Delete tag…", divider: true, action: () => askDeleteTag(tag) },
      ],
    });
  }

  /** Back to the cut files, picked, so a paste elsewhere or a Delete can follow. */
  async function showCut(view: FolderView, folder: string, names: string[]) {
    if (await view.open(folder)) await view.reload(names);
  }

  /** Shows the file among its neighbours, the way Explorer's Open file location does. */
  async function showInFolder(view: FolderView, path: string) {
    const folder = parentOf(path);
    if (folder && (await view.open(folder))) await view.reload([baseName(path)]);
  }

  /** A file's preview, over its folder in the tab on show (or in `view`): for a song or a film playing on. */
  async function previewOf(path: string, view = tabs.activeView()) {
    await showInFolder(view, path);
    const folder = view.folder();
    const index = folder?.selected?.[0];
    if (folder && index !== undefined) preview(view, { snapshot: folder.request, index });
  }

  /** From the disc on the sidebar back to the song's full player, among its own folder. */
  async function backToPlayer() {
    const song = now();
    if (song) await previewOf(song.path);
  }

  // The film's small window hands its film back to the full player, at the same moment.
  void listen<HandBack>("mini-back", ({ payload }) => {
    holdBack(payload);
    comeForward()
      .then(() => previewOf(payload.path))
      .catch(jobs.report);
  });
  // A song here would play under the film there.
  void listen("mini-playing", () => audio.pause());

  // A tab dragged here from another Perli window.
  void listen<string>("tab-arrived", ({ payload }) => {
    const moved = parseMoved(payload);
    if (moved) tabs.adopt(moved.tab);
  });
  // Another window brings every window into one: this one's tabs go there, then it closes.
  void listen<number>("tabs-asked", async ({ payload: asker }) => {
    for (const tab of tabs.tabs()) {
      if (!(await sendTab(asker, JSON.stringify({ tab: tabs.handover(tab) })))) return;
    }
    await leaveWindow();
  });
  // Another window asked for the workspace on screen here: it goes there, and this window closes.
  void listen<[number, string]>("workspace-asked", async ({ payload: [asker, name] }) => {
    if (await spaces.handOver(asker, name)) await leaveWindow();
  });
  void listen<string>("workspace-brought", ({ payload }) => void spaces.take(payload));

  async function gatherWindows() {
    const others = await otherWindows();
    if (others.length === 0) return jobs.notify("No other windows", "Every Perli tab is already in this window.", true);
    let stayed = 0;
    for (const other of others) if (!(await askForTabs(other))) stayed += 1;
    if (stayed > 0) {
      const title = stayed === 1 ? "A window stayed open" : `${stayed} windows stayed open`;
      jobs.notify(title, "Its jobs are still running. Bring it in once they finish.", true);
    }
  }

  function showRecentMenu(event: MouseEvent, view: FolderView, recent: Recent, forget: () => void) {
    event.preventDefault();
    const open = recent.isDir ? () => view.open(recent.path) : () => openFile(recent.path).catch(jobs.report);
    const items: MenuItem[] = [
      { label: "Open", action: open },
      ...(recent.isDir ? [{ label: "Open to side", action: () => tabs.openToSide(recent.path) }] : []),
      { label: "Show in folder", action: () => showInFolder(view, recent.path) },
      { label: "Remove from recent", divider: true, action: forget },
    ];
    setMenu({ x: event.clientX, y: event.clientY, items });
  }

  /** A server from the Network section. Its shares show when it opens. */
  function showServerMenu(event: MouseEvent, view: FolderView, server: string) {
    event.preventDefault();
    const items: MenuItem[] = [
      { label: "Open", action: () => view.open(server) },
      { label: "Open in new tab", action: () => tabs.add([server]) },
      { label: "Open to side", action: () => tabs.openToSide(server) },
      { label: "Copy path", action: () => quietly(copyFolderPath(server)) },
      { label: pinned().some((path) => samePath(path, server)) ? "Unpin" : "Pin", action: () => togglePinned(server) },
      { label: "Forget server", divider: true, action: () => forgetServer(server) },
    ];
    setMenu({ x: event.clientX, y: event.clientY, items });
  }

  function showSectionMenu(event: MouseEvent) {
    const items: MenuItem[] = [
      ...SECTIONS.map((section) => ({
        label: section.label,
        checked: !hiddenSections().includes(section.id),
        action: () => toggleSection(section.id),
      })),
      { label: "Bookmarks bar", divider: true, checked: bookmarksBar(), action: () => setBookmarksBar(!bookmarksBar()) },
      { label: "Bookmarks as icons", checked: bookmarksCompact(), action: () => setBookmarksCompact(!bookmarksCompact()) },
      { label: "Remember recent places", checked: rememberRecent(), action: () => setRememberRecent(!rememberRecent()) },
    ];
    setMenu({ x: event.clientX, y: event.clientY, items });
  }

  /** Like Explorer's Apply to folders: the shown view becomes the one every folder starts with. */
  function viewForAll(view: FolderView) {
    const sort = view.folderSort();
    const layout = view.layout();
    forgetSorts();
    setLastSort(sort);
    setLastLayout(layout);
    for (const other of tabs.allViews()) {
      // A locked folder keeps its own look.
      if (other.isBin() || other.lock()) continue;
      other.setLayout(layout);
      if (!other.query()) other.setSort(sort);
    }
  }

  async function showRowMenu(event: MouseEvent, view: FolderView, row: Row) {
    event.preventDefault();
    const { clientX: x, clientY: y } = event;
    if (view.isBin()) {
      const items = [
        { label: "Restore", action: () => actions.restore(view) },
        { label: "Restore to", items: restorePlaces(view) },
        { label: "Delete permanently", action: () => actions.remove(view, true) },
      ];
      return setMenu({ x, y, items });
    }

    const path = rowPath(view, row);
    if (view.isZip()) {
      const items: MenuItem[] = [
        { label: "Open", action: () => openRow(view, row, false) },
        { label: "Quick preview", action: () => previewSelected(view) },
        ...(row.isDir
          ? [
              { label: "Open to side", action: () => openRow(view, row, true) },
              { label: "Open in background tab", action: () => openBehind(view, row) },
              { label: "Search here", action: () => searchIn(view, path) },
            ]
          : [shell.openWithItem(view)]),
        { label: "Copy", divider: true, keys: keyText("copy"), action: () => actions.copy(view) },
        ...(tabs.active().other() ? [{ label: "Copy to other pane", action: () => actions.toOtherPane(view, "copy") }] : []),
        { label: "Copy name", action: () => quietly(copyName(view)) },
        { label: "Select same", items: sameItems(view, row) },
        ...(view.list()?.selection().rows.length === 2 && !row.isDir ? [{ label: "Compare", keys: keyText("compare"), action: () => quietly(compare(view)) }] : []),
        { label: "Extract all", divider: true, action: () => actions.extractAll(view) },
      ];
      return setMenu({ x, y, items });
    }
    if (isPerliCloud(path)) return showCloudRowMenu(view, row, path, x, y);
    const [canPaste, toolItems] = await Promise.all([clipboardCanPaste(), shell.fileToolItems(view, row, { x, y })]);
    const iconKind = iconKindOf(row.name, row.isDir, iconTheme().extensions);
    const items: MenuItem[] = [
      { label: "Open", action: () => openRow(view, row, false) },
      { label: "Quick preview", action: () => previewSelected(view) },
      ...(!row.isDir && /\.(iso|img|vhdx?)$/i.test(row.name) ? [{ label: "Mount", action: () => quietly(mountAndOpen(view, path)) }] : []),
      ...(!row.isDir && WRITTEN.has(kindOf(row.name, false)) && view.list()?.selection().rows.length === 1
        ? [{ label: "Edit", action: () => (editWhenShown(path), previewSelected(view)) }]
        : []),
      ...(row.isDir
        ? [
            { label: "Open to side", action: () => openRow(view, row, true) },
            { label: "Open in background tab", action: () => openBehind(view, row) },
          ]
        : [shell.openWithItem(view)]),
      ...(row.isDir ? [{ label: "Search here", action: () => searchIn(view, path) }] : []),
      ...(row.isDir ? keepItems(path) : []),
      { label: "Cut", divider: true, action: () => actions.cut(view) },
      { label: "Copy", action: () => actions.copy(view) },
      {
        label: "Paste",
        disabled: !canPaste,
        action: () => actions.paste(view, row.isDir ? path : undefined),
      },
      { label: "Rename", action: () => actions.startRename(view) },
      { label: "Delete", action: () => actions.remove(view, false) },
      { label: "Duplicate", divider: true, keys: keyText("duplicate"), action: () => duplicate(view) },
      { label: "Copy path", action: () => copyPath(view) },
      { label: "Copy name", action: () => quietly(copyName(view)) },
      { label: "New folder with selection", action: () => gather(view) },
      { label: "Put on the shelf", action: () => putOnShelf(view) },
      { label: "Select same", items: sameItems(view, row) },
      ...(kindOf(row.name, row.isDir) === "picture"
        ? [{ label: "Use as folder cover", action: () => setLook(row.location || view.folder()!.path, { cover: path }) }]
        : []),
      ...(view.list()?.selection().rows.length === 2 && !row.isDir ? [{ label: "Compare", keys: keyText("compare"), action: () => quietly(compare(view)) }] : []),
      ...toolItems,
      shell.tagsItem(view, showTagChange, () => setNamingTag(view)),
      ...(windowsIcons() ? [] : [{ label: `Icon color for ${KIND_LABELS[iconKind]}…`, action: () => setTinting({ x, y, kind: iconKind }) }]),
      ...(inCloud(path)
        ? [
            { label: "Always keep on this device", divider: true, checked: row.isPinned, action: () => keepHere(view, true) },
            { label: "Free up space", disabled: row.isCloud && !row.isPinned, action: () => keepHere(view, false) },
          ]
        : []),
    ];
    if (tabs.active().other()) {
      items.push(
        { label: "Copy to other pane", divider: true, action: () => actions.toOtherPane(view, "copy") },
        { label: "Move to other pane", action: () => actions.toOtherPane(view, "move") },
      );
    }
    items.push(...shell.rowItems(view, { x, y }, row.isDir ? path : undefined, () => openRow(view, row, false)));
    setMenu({ x, y, items });
  }

  /** A search would start over, and its rows don't show tags. */
  /** True for a folder a sync app keeps, or anything under one. */
  const inCloud = (path: string) =>
    (places()?.clouds ?? []).some((cloud) => (path + "\\").toLowerCase().startsWith(cloud.path.replace(/\\+$/, "").toLowerCase() + "\\"));

  /** Amazon takes hours to bring a file back from Glacier, so this says so once it has asked. */
  function restoreHere(view: FolderView, name: string) {
    const selection = actions.selected(view);
    if (!selection) return;
    const many = selection.rows.length > 1 ? `${selection.rows.length} files` : name;
    quietly(
      restoreCold(selection).then(() => {
        jobs.notify(`Amazon is bringing back ${many}`, "It opens in 3 to 5 hours, 12 from Deep Archive, and stays for 7 days", true);
        view.reload();
      }),
    );
  }

  /** The sync app does the fetching or the freeing in its own time. The rows show the wish at once. */
  function keepHere(view: FolderView, keep: boolean) {
    const selection = actions.selected(view);
    if (selection) quietly(keepOnDevice(selection, keep).then(() => view.reload()));
  }

  /** Alt+1 to 9 puts the tag in that place on the selected rows, or takes it off if all have it. */
  async function toggleTagKey(view: FolderView, place: number) {
    const tag = allTags()[place - 1];
    const selection = actions.selected(view);
    if (!tag || !selection) return;
    try {
      const rows = { kind: "rows", selection } as const;
      const common = await commonTags(rows);
      await setTag(rows, tag.id, !common.includes(tag.id));
    } catch (failure) {
      jobs.report(failure);
    }
  }

  function showTagChange() {
    for (const view of tabs.allViews()) if (!view.query() || view.query().startsWith(tagQuery(""))) view.reload();
  }

  /** After a tag job, its undo or its redo: a filter forgets a tag that is gone, and the dots show the change. */
  async function tagsChanged() {
    const before = allTags();
    await refreshTags();
    for (const tag of before) {
      if (allTags().some((known) => known.id === tag.id)) continue;
      for (const view of tabs.allViews()) view.forgetTag(tag.id);
    }
    showTagChange();
  }

  function askDeleteTag(tag: Tag) {
    setDeleting({
      title: `Delete the tag ${tag.name}?`,
      note: "It comes off every file that has it. The files stay as they are, and Undo brings the tag back on them.",
      confirmLabel: "Delete tag",
      async confirm() {
        await deleteTag(tag.id).catch(jobs.report);
      },
    });
  }

  function showHeaderMenu(event: MouseEvent, view: FolderView) {
    event.preventDefault();
    const set = view.columnSet();
    const items = columnsOf(set).map((column) => ({
      label: column.label,
      checked: column.visible,
      disabled: column.id === "name",
      action: () => toggleColumn(set, column.id),
    }));
    setMenu({ x: event.clientX, y: event.clientY, items: [...items, { label: "Group by", divider: true, items: groupByItems(view) }] });
  }

  /** The browser's own menu never shows. A text field gets Perli's, in every pane and sheet. */
  function onContextMenu(event: MouseEvent) {
    event.preventDefault();
    const field = textField(event.target);
    if (field) showInputMenu(event, field);
  }

  function showInputMenu(event: MouseEvent, field: HTMLElement) {
    const paste = async () => {
      document.execCommand("insertText", false, await clipboardText());
    };
    const editable = !(field as HTMLInputElement).readOnly && !(field as HTMLInputElement).disabled;
    // A number or a rich field can't say what is selected, so it keeps Cut and Copy on.
    const box = field as HTMLInputElement;
    const picked = box.selectionStart == null || box.selectionStart !== box.selectionEnd;
    const items: MenuItem[] = [
      { label: "Undo", disabled: !editable, action: () => document.execCommand("undo") },
      { label: "Cut", divider: true, disabled: !editable || !picked, action: () => document.execCommand("cut") },
      { label: "Copy", disabled: !picked, action: () => document.execCommand("copy") },
      { label: "Paste", disabled: !editable, action: () => paste().catch(console.error) },
      { label: "Select all", divider: true, action: () => document.execCommand("selectAll") },
    ];
    // Inside a modal sheet the menu must be too, or it would sit out of reach behind it.
    setMenu({ x: event.clientX, y: event.clientY, items, mount: field.closest<HTMLElement>("dialog[open]") ?? undefined });
  }

  function changeOrder(apply: () => void) {
    apply();
    for (const view of tabs.allViews()) view.rearrange();
  }

  const toggleHidden = () => changeOrder(() => setShowHidden(!showHidden()));
  /** Windows' own files show only with hidden files, so asking for them asks for those too. */
  const toggleSystem = () =>
    changeOrder(() => {
      const on = !(showHidden() && showSystem());
      setShowSystem(on);
      if (on) setShowHidden(true);
    });

  /** Selects every row that fits `filter`, such as all of one kind, tag or day. */
  async function selectWhere(view: FolderView, filter: Partial<Filter>) {
    const request = view.folder()?.request;
    if (request === undefined) return;
    const rows = await rowsWhere(view.id, request, { ...toFilter(NO_FILTER), ...filter });
    view.list()?.select(rows);
  }

  function sameItems(view: FolderView, row: Row): MenuItem[] {
    const kind = kindOf(row.name, row.isDir);
    const extension = row.name.includes(".") ? row.name.slice(row.name.lastIndexOf(".") + 1).toLowerCase() : "";
    const day = new Date(row.modified);
    const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate());
    const nextDay = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
    return [
      {
        label: row.isDir ? "Folders" : kind === "file" ? `Same type (.${extension || "none"})` : "Same kind",
        action: () =>
          quietly(
            selectWhere(
              view,
              // Folders have no extension either, so a type of files must leave them out.
              row.isDir ? { kinds: "folders" } : { kinds: "files", extensions: kind === "file" ? [extension] : extensionsOf(kind) },
            ),
          ),
      },
      {
        label: "Changed the same day",
        disabled: row.modified <= 0,
        action: () => quietly(selectWhere(view, { modifiedFrom: dayStart.getTime(), modifiedTo: nextDay.getTime() - 1 })),
      },
      ...row.tags.flatMap((id) => {
        const tag = allTags().find((known) => known.id === id);
        return tag ? [{ label: `Tagged ${tag.name}`, action: () => quietly(selectWhere(view, { tags: [id] })) }] : [];
      }),
    ];
  }

  /** Every row that wasn't selected, and none that was. */
  function invertSelection(view: FolderView) {
    const list = view.list();
    const chosen = new Set(list?.selection().rows);
    const count = view.folder()?.count ?? 0;
    list?.select(Array.from({ length: count }, (_, row) => row).filter((row) => !chosen.has(row)));
  }
  const cycleGrouping = () => changeOrder(() => setGrouping(nextGrouping(grouping())));

  async function toggleSizes() {
    setFolderSizes(!folderSizes());
    if (!folderSizes()) await stopSizes().catch(jobs.report);
    for (const view of tabs.allViews()) {
      if (folderSizes()) view.scanFolder();
      else view.reload();
    }
  }

  function viewItems(view: FolderView): MenuItem[] {
    const layoutItem = (label: string, layout: Layout) => ({
      label,
      checked: view.layout() === layout,
      action: () => view.setLayout(layout),
    });
    const groupItem = (label: string, group: Grouping) => ({
      label,
      checked: grouping() === group,
      action: () => changeOrder(() => setGrouping(group)),
    });
    const sortItem = (label: string, key: Sort["key"]) => ({
      label,
      checked: view.sort().key === key,
      action: () => view.setSort(nextSort(view.sort(), key)),
    });
    const rowsItem = (label: string, density: Density) => ({
      label,
      divider: density === "compact",
      checked: rowDensity() === density,
      action: () => setRowDensity(density),
    });
    const rowItems = [rowsItem("Compact rows", "compact"), rowsItem("Cozy rows", "cozy"), rowsItem("Roomy rows", "roomy")];
    const tileItems = [
      {
        label: "Larger tiles",
        divider: true,
        disabled: isLargestTile(tileSize()),
        action: () => setTileSize(clampTile(tileSize() + TILE_STEP)),
      },
      {
        label: "Smaller tiles",
        disabled: isSmallestTile(tileSize()),
        action: () => setTileSize(clampTile(tileSize() - TILE_STEP)),
      },
      { label: "Picture folders as a wall", checked: pictureWall(), action: () => setPictureWall(!pictureWall()) },
      { label: "Colour wall", action: () => colourWall(view) },
      { label: "Picture folders open in gallery", checked: picturesInGallery(), action: () => setPicturesInGallery(!picturesInGallery()) },
    ];
    const own = ownColumns(view);
    const sortItems = own
      ? [
          ...(view.query() ? [sortItem("Best match", "found")] : []),
          ...own.map((column) => sortItem(column.label, column.id)),
        ]
      : [
          sortItem("Name", "name"),
          sortItem("Date modified", "modified"),
          sortItem("Date created", "created"),
          sortItem("Type", "type"),
          sortItem("Size", "size"),
          sortItem("Tags", "tags"),
          ...(view.columnSet() === "pictures" ? [sortItem("Colour", "colour")] : []),
        ];
    return [
      {
        label: "View",
        divider: true,
        items: [
          layoutItem("List", "list"),
          layoutItem("Grid", "grid"),
          layoutItem("Gallery", "gallery"),
          layoutItem("Columns", "columns"),
          { label: "Files in columns", checked: columnFiles(), action: () => setColumnFiles(!columnFiles()) },
          ...(tiled(view) ? tileItems : rowItems),
          { label: "Windows icons", divider: true, checked: windowsIcons(), action: () => setWindowsIcons(!windowsIcons()) },
          { label: "Details panel", checked: detailsPanel(), action: toggleDetails },
          { label: "Preview pane", checked: previewPane(), action: () => setPreviewPane(!previewPane()) },
          { label: "Status bar", checked: statusBar(), action: () => setStatusBar(!statusBar()) },
          { label: "Size bars", checked: sizeBars(), action: () => setSizeBars(!sizeBars()) },
          { label: "Keep sidebar open", checked: sidebarOpen(), action: toggleSidebar },
        ],
      },
      { label: "Group by", items: groupByItems(view) },
      {
        label: "Sort by",
        items: [
          ...sortItems,
          {
            label: "Descending",
            divider: true,
            checked: view.sort().descending,
            action: () => view.setSort({ ...view.sort(), descending: !view.sort().descending }),
          },
        ],
      },
      ...(own && !view.isZip()
        ? []
        : [
            {
              label: "Grouping",
              items: [
                groupItem("Folders first", "foldersFirst"),
                groupItem("Files first", "filesFirst"),
                groupItem("Mixed", "mixed"),
              ],
            },
          ]),
      {
        label: "Show hidden files",
        divider: true,
        checked: showHidden(),
        action: toggleHidden,
      },
      { label: "Show protected system files", checked: showHidden() && showSystem(), action: toggleSystem },
      ...(view.isBin()
        ? []
        : [{ label: "Flat view", checked: view.query() === FLAT_QUERY, action: () => toggleFlat(view) }]),
      ...(own ? [] : [{ label: "Use this view for all folders", action: () => viewForAll(view) }]),
      ...(view.isBin() || view.query()
        ? []
        : [
            { label: "Lock this folder's view", checked: !!view.lock(), action: () => view.toggleLock() },
            { label: "Lock the folders inside too", checked: !!view.lock()?.value.below, action: () => view.toggleLock(true) },
          ]),
    ];
  }

  /** A new text file waiting for its name, after which it opens to write in. `name` is the one typed. */
  let writing: { view: number; until: number; name?: string } | undefined;
  /** A file that never got made, in a folder Perli can't write to, stops waiting after this. */
  const WRITE_WAIT_MS = 60_000;
  const writesIn = (view: FolderView) => writing?.view === view.id && Date.now() < writing.until;

  /** Pins the folders pinned in File Explorer's Quick access that Perli hasn't pinned yet. */
  async function importQuickAccess() {
    const fresh = (await quickAccessPins()).filter((path) => !holds(pinned(), path));
    setPinned([...pinned(), ...fresh]);
    jobs.notify(fresh.length ? `Pinned ${fresh.length} folder${fresh.length === 1 ? "" : "s"} from Quick access` : "Nothing new to pin", fresh.length ? fresh.map((path) => baseName(path)).join(", ") : "Every Quick access folder is pinned already.");
  }

  /** Mounts a disk image and opens the drive it becomes. */
  async function mountAndOpen(view: FolderView, path: string) {
    const drive = await mountImage(path);
    if (drive) await view.open(drive);
    else jobs.notify("Mounting is taking a while", "The drive opens in the sidebar once Windows mounts it.");
  }

  /** Opens the selected file in the preview, already editing. */
  function writeSelected(view: FolderView) {
    writing = undefined;
    const name = view.list()?.left()?.names[0];
    const folder = view.folder()?.path;
    if (!name || !folder) return;
    editWhenShown(join(folder, name));
    previewSelected(view);
  }

  function makeNew(view: FolderView, pick: NewPick) {
    if (pick.kind === "write") {
      writing = { view: view.id, until: Date.now() + WRITE_WAIT_MS };
      actions.newFrom(view, "txt");
    } else if (pick.kind === "folder" || pick.kind === "file") actions.newItem(view, pick.kind === "folder");
    else if (pick.kind === "clipboard") actions.newFromClipboard(view);
    else if (pick.kind === "type") actions.newFrom(view, pick.extension);
    else if (pick.kind === "own") actions.newFromOwn(view, pick.name, pick.called);
    else actions.openTemplates(view);
  }

  async function showBackgroundMenu(event: MouseEvent, view: FolderView) {
    const { clientX: x, clientY: y } = event;
    // Each says what it will do, so nobody has to guess what a press takes back.
    const undo = [
      { label: undoLabel("Undo", jobs.undoText()), disabled: jobs.latestStep() === null, action: () => actions.undo(view) },
      { label: undoLabel("Redo", jobs.redoText()), disabled: !jobs.canRedo(), action: () => actions.redo(view) },
    ];
    const fileItems: MenuItem[] = view.isZip()
      ? [
          { label: "Extract all", action: () => actions.extractAll(view) },
          { label: "Search here", action: () => view.askSearch() },
          { label: "Select by pattern…", action: () => setSelectingPattern(view) },
          { label: "Invert selection", action: () => invertSelection(view) },
          { label: "Filter…", action: () => setFiltering(view) },
          ...undo,
        ]
      : isLibrary(view.folder()?.path)
      ? [
          // New files go into one of its folders, which open from here.
          ...(places()?.libraries.find((library) => samePath(library.path, view.folder()?.path ?? ""))?.locations ?? []).map((location, at) => ({
            label: `Open ${baseName(location)}${at === 0 ? " (new files go here)" : ""}`,
            action: () => void view.open(location),
          })),
          { label: "Search here", divider: true, action: () => view.askSearch() },
          { label: "Select by pattern…", action: () => setSelectingPattern(view) },
          { label: "Invert selection", action: () => invertSelection(view) },
          { label: "Filter…", action: () => setFiltering(view) },
          ...undo,
        ]
      : view.isBin()
      ? [
          {
            label: "Empty Recycle Bin",
            disabled: view.folder()?.count === 0,
            action: () => actions.empty(view),
          },
          ...undo,
        ]
      : [
          { label: "Paste", disabled: !(await clipboardCanPaste()), action: () => actions.paste(view) },
          { label: "Paste as shortcut", disabled: !(await clipboardHasFiles()), action: () => actions.pasteShortcut(view) },
          { label: "New…", action: () => setMaking({ view, x, y }) },
          { label: "Search here", action: () => view.askSearch() },
          { label: "Find copies", checked: view.query() === COPIES_QUERY, action: () => findCopies(view) },
          ...compareItems(),
          { label: "Select by pattern…", action: () => setSelectingPattern(view) },
          { label: "Invert selection", action: () => invertSelection(view) },
          { label: "Filter…", action: () => setFiltering(view) },
          ...undo,
          { label: "Undo several…", disabled: jobs.latestStep() === null, action: () => setActivityOpen(true) },
          { label: "Activity log", action: () => setActivityOpen(true) },
          { label: "Space", action: () => setMapping(view.folder()?.path ?? "") },
          { label: "Time river", action: () => setRiverOn(view.folder()?.path) },
          { label: "Twins", action: () => void openTwins(view) },
        ];
    const shellItems = view.isBin() || view.isZip() || isLibrary(view.folder()?.path) || isPerliCloud(view.folder()?.path ?? "") ? [] : shell.backgroundItems(view, { x, y });
    setMenu({ x, y, items: [...fileItems, ...viewItems(view), ...shellItems] });
  }

  /** What a list with no rows says, and the few things worth doing from there. */
  function emptyState(view: FolderView): Empty {
    if (view.searching()) return { art: "search", text: "Searching…", actions: [] };
    if (view.filtered()) {
      return {
        art: "filter",
        text: "Nothing fits the filter.",
        actions: [
          { label: "Clear filter", run: () => view.setFilterForm(NO_FILTER) },
          { label: "Change filter", keys: keyText("filter"), run: () => setFiltering(view) },
        ],
      };
    }
    if (view.isBin()) return { art: "bin", text: "The Recycle Bin is empty.", actions: [] };
    if (view.isZip() && !view.query()) {
      // A 7z can lock its very names, so nothing shows until its password is in.
      const hidden = view.locked() && samePath(view.folder()?.path, view.archive() ?? "");
      return { art: "folder", text: hidden ? "Its names are under the password too. Enter it to see inside." : "This folder in the archive is empty.", actions: [] };
    }
    if (view.query() === COPIES_QUERY) {
      return {
        art: "search",
        text: "No copies here. Every file is the only one with its content.",
        actions: [{ label: "Stop looking", keys: "Esc", run: () => view.search("") }],
      };
    }
    if (view.query()) {
      const flat = view.query() === FLAT_QUERY;
      return {
        art: "search",
        text: flat ? "No files in this folder or the ones inside it." : "No matches.",
        actions: [{ label: flat ? "Show this folder only" : "Clear search", keys: "Esc", run: () => view.search("") }],
      };
    }
    return {
      art: "folder",
      text: "This folder is empty.",
      actions: [
        { label: "New folder", keys: keyText("newFolder"), run: () => actions.newItem(view, true) },
        { label: "Paste", keys: keyText("paste"), run: () => actions.paste(view), enabled: clipboardCanPaste },
      ],
    };
  }

  /** The home page over the tab on show, or the tab's folder again when it is already there. */
  function showHomePage() {
    const tab = tabs.active();
    const shown = tab.home() && !settingsShown();
    setSettingsShown(false);
    tab.setHome(!shown);
  }

  /** How a pair's sync is going, while one runs: flowing, or stopped on a clash. */
  function syncingOf(pair: SyncPair) {
    // By the pair's id: a copy between the same two folders, or another pair on them, is not this sync.
    const card = jobs.cards.find((one) => !one.ended && one.pair === pair.id);
    if (!card) return undefined;
    return card.question?.kind === "conflict" ? "clash" : "flow";
  }

  /** A job running from one pane's folder into the other's, for the stream across the divider. */
  function streamOf(tab: Tab) {
    const [first, second] = tab.panes();
    const one = first?.folder()?.path;
    const other = second?.folder()?.path;
    if (!one || !other) return undefined;
    for (const card of jobs.cards) {
      if (card.ended || card.paused || card.question || card.waiting || card.recycle || !card.target) continue;
      // Sources and target may sit deeper than the panes' folders, as from a search or into a folder shown there.
      const target = card.target;
      const between = (from: string, to: string) => card.from.length > 0 && card.from.every((source) => isInside(source, from)) && isInside(target, to);
      const toSecond = between(one, other);
      if (toSecond || between(other, one)) return { toSecond, speed: card.rate.speed };
    }
    return undefined;
  }

  /** Pictures in a gallery wall, ordered by their main colour. */
  function colourWall(view: FolderView) {
    view.setLayout("gallery");
    setPictureWall(true);
    view.setSort({ key: "colour", descending: false });
  }

  /** The folder the Time river and Twins look at: the user's own folder from the home page. */
  const folderHere = () => (tabs.active().home() ? places()?.folders.find((folder) => folder.kind === "home")?.path : undefined) ?? here().folder()?.path;

  /** Leaves the home page for the tab's folder, then does `then` in it. */
  async function leaveHome(then: (view: FolderView) => unknown) {
    const tab = tabs.active();
    tab.setHome(false);
    await then(tab.active());
  }

  /** Opens what Settings says a new tab shows. A set folder that is gone opens the one on show. */
  const newTab = async () => {
    setSettingsShown(false);
    const here = tabs.activeView().folder()?.path;
    const choice = newTabOpens();
    const set = choice === "folder" ? newTabFolder() : null;
    if (set && (await tabs.add([set]))) return;
    // The home page needs a folder behind it, for when a card or Back leaves it.
    const path = choice === "home" ? (homePath ?? here) : here;
    if (path) await tabs.add([path], undefined, false, choice === "home" ? { home: true } : {});
  };

  function splitView() {
    const path = tabs.activeView().folder()?.path;
    if (path && !tabs.active().other()) tabs.openToSide(path);
  }

  // List view has no tiles, so these keys do nothing there.
  function resizeTiles(view: FolderView, change: number) {
    if (tiled(view)) setTileSize(clampTile(tileSize() + change));
  }

  function togglePalette() {
    if (!paletteOpen()) {
      setPaletteScope(undefined);
      listPlaces().then(setPlaces).catch(console.error);
      paletteFiles(tabs.activeView(), setFoundFiles).catch(console.error);
    }
    setPaletteOpen(!paletteOpen());
  }

  /** The palette, asking for one kind of thing. Asked again for the same, it closes. */
  function askFor(scope: "tabs" | "workspaces" | "renameWorkspace") {
    if (paletteOpen() && paletteScope() === scope) return setPaletteOpen(false);
    if (scope === "workspaces") findWorkspacesElsewhere().catch(console.error);
    setPaletteScope(scope);
    setPaletteOpen(true);
  }

  /** The workspaces other windows show, with the window of each. */
  const [elsewhere, setElsewhere] = createSignal(new Map<string, number>());
  async function findWorkspacesElsewhere() {
    const names = workspaces().map((one) => one.name);
    const windows = await workspaceWindows(names);
    setElsewhere(new Map(names.flatMap((name, index) => (windows[index] == null ? [] : [[name, windows[index]!] as const]))));
  }

  async function bringWorkspaceHere(name: string, there: number) {
    if (!(await spaces.bringHere(name, there))) jobs.notify(`"${name}" stayed in its window`, "Its jobs are still running. Bring it here once they finish.", true);
  }

  async function reopenClosedWindow() {
    if (!(await reopenWindow())) jobs.notify("No closed windows", "A window closed while others stay open can be opened again from here.", true);
  }
  /** One of the open or lately closed tabs. */
  const searchTabs = () => askFor("tabs");
  const askWorkspace = () => askFor("workspaces");

  const tabCount = (count: number) => (count === 1 ? "1 tab" : `${count} tabs`);

  /** The workspaces to switch to, and what can be done with the one on screen. */
  function workspaceCommands(): Command[] {
    const now = spaces.current();
    return [
      ...workspaces().flatMap((one) => {
        const there = one.name === now ? undefined : elsewhere().get(one.name);
        const pick: Command = {
          label: one.name,
          group: "Workspaces",
          icon: one.name === now ? ICON_CHECK : ICON_WORKSPACE,
          // The one on screen counts what is open now, not what was kept on leaving it.
          keys: there !== undefined ? "In another window" : tabCount(one.name === now ? tabs.tabs().length : one.tabs.length),
          run: () => {
            setSettingsShown(false);
            spaces.switchTo(one.name).catch(console.error);
          },
        };
        if (there === undefined) return [pick];
        const bring: Command = {
          label: `Bring "${one.name}" here`,
          group: "Workspaces",
          icon: ICON_WORKSPACE,
          keys: "Its window closes",
          run: () => void bringWorkspaceHere(one.name, there).catch(jobs.report),
        };
        return [pick, bring];
      }),
      ...(now === undefined
        ? []
        : [
            { label: "Rename this workspace", group: "This workspace", icon: ICON_RENAME, run: () => askFor("renameWorkspace") },
            { label: "Delete this workspace", group: "This workspace", icon: ICON_DELETE, keys: "Its tabs stay open", run: spaces.remove },
          ]),
    ];
  }

  /** A name typed makes a workspace of it, unless one has it already. */
  function workspaceWords(text: string): Command[] {
    const name = text.trim();
    if (!spaces.free(name)) return [];
    const home = homePath;
    return [
      { label: `Save tabs as workspace "${name}"`, group: "New workspace", icon: ICON_ADD, keys: tabCount(tabs.tabs().length), run: () => spaces.saveAs(name) },
      // With no workspace on screen, starting afresh would leave these tabs in none.
      ...(spaces.current() !== undefined && home
        ? [{ label: `New workspace "${name}"`, group: "New workspace", icon: ICON_ADD, keys: "Starts on Home", run: () => void spaces.create(name, home) }]
        : []),
    ];
  }

  const renameWords = (text: string): Command[] => {
    const name = text.trim();
    return spaces.free(name) ? [{ label: `Rename to "${name}"`, icon: ICON_RENAME, run: () => spaces.rename(name) }] : [];
  };

  /** What the palette asks for, in its own scope. */
  const scoped = () => {
    const scope = paletteScope();
    if (scope === "tabs") return { commands: tabCommands, scope: { label: "Search tabs", placeholder: "Find an open or closed tab" } };
    if (scope === "workspaces")
      return {
        commands: workspaceCommands,
        words: workspaceWords,
        scope: { label: "Workspaces", placeholder: "Pick a workspace, or type a new name", empty: "Type a name to keep these tabs as a workspace" },
      };
    if (scope === "renameWorkspace")
      return {
        commands: () => [],
        words: renameWords,
        scope: { label: "Rename workspace", placeholder: `New name for "${spaces.current() ?? ""}"`, empty: "Type the new name, then press Enter" },
      };
    return undefined;
  };

  function tabCommands(): Command[] {
    const named = (paths: string[]) => paths.map((path) => baseName(path) || path).join(" | ");
    return [
      ...tabs.tabs().map((tab) => ({
        label: named(tab.panes().map((view) => view.path() ?? "New tab")),
        group: "Open tabs",
        icon: tab.pinned() ? ICON_PIN : ICON_FOLDER,
        run: () => {
          setSettingsShown(false);
          tabs.activate(tab);
        },
      })),
      ...tabs.closedList().map((paths, back) => ({
        label: named(paths),
        group: "Recently closed",
        icon: ICON_REOPEN,
        run: () => tabs.reopenClosed(back),
      })),
    ];
  }

  /** Commands said in words, like "sort by size" or "select *.jpg", made from what is typed. */
  function paletteWords(text: string): Command[] {
    const view = tabs.activeView();
    const choice = (word: string) => GROUP_CHOICES.find((group) => group.label.toLowerCase() === word);
    const terminal = (word: string) =>
      (Object.keys(TERMINAL_NAMES) as Terminal[]).find((shell) => TERMINAL_NAMES[shell] === word);
    // Bookmarks and folders opened lately, by name, the first of a name winning.
    const near = new Map<string, string>();
    for (const path of [...bookmarks(), ...recentFolders()]) if (!near.has(baseName(path) || path)) near.set(baseName(path) || path, path);
    const verbs: (Verb & { run: (word: string) => unknown })[] = [
      { says: "go to", words: [...near.keys()], run: (word) => view.open(near.get(word)!) },
      { says: "sort by", words: SORT_WORDS, run: (word) => view.setSort(nextSort(UNSORTED, word as Sort["key"])) },
      {
        says: "group by",
        words: GROUP_CHOICES.filter(({ by }) => by !== "none").map(({ label }) => label.toLowerCase()),
        run: (word) => view.setGroupBy(choice(word)!.by),
      },
      { says: "tag", words: allTags().map((tag) => tag.name), run: (word) => quietly(tagSelected(view, word, true)) },
      { says: "untag", words: allTags().map((tag) => tag.name), run: (word) => quietly(tagSelected(view, word, false)) },
      { says: "view", words: VIEW_WORDS, run: (word) =>
          word === "list" || word === "grid" || word === "gallery" || word === "columns" ? view.setLayout(word) : setRowDensity(word as Density),
      },
      { says: "select", words: "free", run: (word) => quietly(selectMatching(view, word)) },
      { says: "search", words: "free", run: (word) => view.search(word) },
      { says: "open in", words: Object.values(TERMINAL_NAMES), run: (word) => terminalHere(view, terminal(word)) },
    ];
    return wordsFor(text, verbs).map(({ verb, word }) => {
      const says = `${verbs[verb].says[0].toUpperCase()}${verbs[verb].says.slice(1)}`;
      return { label: `${says} ${word}`, group: "Do", icon: iconFor(says), run: () => verbs[verb].run(word) };
    });
  }

  async function tagSelected(view: FolderView, name: string, on: boolean) {
    const tag = allTags().find((known) => known.name === name);
    const selection = actions.selected(view);
    if (!tag || !selection) return;
    await setTag({ kind: "rows", selection }, tag.id, on);
  }

  /** Picks the rows whose names fit a pattern, such as `*.jpg` or `report`. */
  async function selectMatching(view: FolderView, pattern: string) {
    const shown = view.folder();
    if (!shown) return;
    view.list()?.select(await rowsMatching(view.id, shown.request, pattern));
  }

  /** Files the palette can also find by name: the ones opened lately, and the folder on screen. */
  async function paletteFiles(view: FolderView, show: (files: Command[]) => void) {
    const shown = view.folder();
    const plain = shown && !view.query() && !view.isBin();
    const icon = (isDir: boolean) => (isDir ? ICON_FOLDER : ICON_FILE);
    const rows = plain ? await fetchRows(view.id, shown.request, 0, PALETTE_FILES).catch(() => []) : [];
    const here = rows.map(
      (row): Command => ({ label: row.name, group: "This folder", icon: icon(row.isDir), run: () => view.reload([row.name]) }),
    );
    // The folder's own rows show at once: Windows can take a while over the recent files.
    show(here);
    const recent = await recentFiles(PALETTE_FILES).catch(() => []);
    show([
      ...here,
      ...recent.map(
        ({ name, path, isDir }): Command => ({
          label: name,
          group: "Recent files",
          icon: icon(isDir),
          run: () => (isDir ? view.open(path) : openFile(path).catch(jobs.report)),
        }),
      ),
    ]);
  }

  /** The rows a command acts on, which the Recycle Bin and an empty selection have none of. */
  const picked = (view: FolderView) => (view.isBin() ? undefined : actions.selected(view));

  function duplicate(view: FolderView) {
    const folder = view.folder()?.path;
    // Search rows live in many folders, and a copy belongs beside its own file.
    if (folder && !view.query() && actions.writable(view)) actions.copyTo(view, folder);
  }

  async function copyPath(view: FolderView) {
    const selection = picked(view);
    if (!selection) return;
    const paths = await selectionPaths(selection);
    await navigator.clipboard.writeText(paths.join("\n"));
    jobs.notify(paths.length === 1 ? "Path copied" : `${paths.length} paths copied`, paths[0], true);
  }

  async function copyFolderPath(path: string) {
    await navigator.clipboard.writeText(path);
    jobs.notify("Path copied", path, true);
  }

  /** Back or Forward held: the folders that way, nearest first, any of them one click away. */
  function showHistory(view: FolderView, behind: boolean, x: number, y: number) {
    const items = view.historyList(behind).map(({ path, steps }) => ({
      label: baseName(path) || path,
      hint: path,
      icon: folderGlyph(path).icon,
      action: () => view.go(steps),
    }));
    setMenu({ x, y, items });
  }

  /** The crumbs folded away when a path is too long for its bar. */
  function showFolded(view: FolderView, crumbs: Crumb[], x: number, y: number) {
    setMenu({ x, y, items: crumbs.map((crumb) => ({ label: crumb.label, icon: folderGlyph(crumb.path).icon, action: () => view.open(crumb.path) })) });
  }

  /** Just the names, one to a line, for a list or a message. */
  async function copyName(view: FolderView) {
    const selection = picked(view);
    if (!selection) return;
    const names = (await selectionPaths(selection)).map(baseName);
    await navigator.clipboard.writeText(names.join("\n"));
    jobs.notify(names.length === 1 ? "Name copied" : `${names.length} names copied`, names[0], true);
  }

  function gather(view: FolderView) {
    const selection = picked(view);
    const folder = view.folder()?.path;
    if (selection && folder && !view.query() && actions.writable(view)) {
      startJob({ kind: "newFolderFrom", selection, folder, moveIn: true }, view.id).catch(jobs.report);
    }
  }

  async function putOnShelf(view: FolderView) {
    const selection = view.isZip() ? undefined : picked(view);
    if (selection) shelve(await selectionPaths(selection));
  }

  function sendTo(view: FolderView, kind: "copy" | "move", folder: string) {
    const selection = picked(view);
    if (selection) startJob({ kind, selection, folder }, view.id).catch(jobs.report);
  }

  /** Twins looks across the folders picked in the list when there are two or more, else in the folder itself. */
  async function openTwins(view: FolderView, folder = view.folder()?.path) {
    const chosen = tabs.active().home() ? [] : await pickedFolders(view, Infinity);
    const where = chosen.length > 1 ? chosen : folder ? [folder] : [];
    if (where.length > 0) setTwinsOn(where);
  }

  /** Places Twins adds with one click: the other pane's folder, then each drive. */
  const twinOffers = () => {
    const other = tabs.active().other()?.folder()?.path;
    const drives = (places()?.drives ?? []).filter((drive) => !drive.locked).map((drive) => ({ path: drive.path, name: drive.name || drive.path }));
    return [...(other ? [{ path: other, name: baseName(other) || other }] : []), ...drives];
  };

  /** The selected folders, as paths, the first `most` of them. Files are left out first. */
  async function pickedFolders(view: FolderView, most = MOST_TABS_BEHIND) {
    const selection = picked(view);
    if (!selection) return [];
    const paths = await selectionPaths(selection);
    const files = await Promise.all(paths.map((path) => isFile(path)));
    return paths.filter((_, at) => !files[at]).slice(0, most);
  }

  /** Each folder gets a tab, in order, and the tab on show stays where it is. */
  async function openTabsBehind(paths: string[]) {
    // Tabs opened from the one on show line up after it in the order they were opened.
    for (const path of paths) await tabs.add([path], tabs.active(), true);
  }

  function openBehind(view: FolderView, row: Row) {
    if (row.isDir && !view.isBin()) openTabsBehind([rowPath(view, row)]).catch(jobs.report);
  }

  function terminalHere(view: FolderView, shell?: Terminal) {
    const path = view.folder()?.path;
    if (path && !view.isBin() && !view.isZip()) openTerminal(path, shell ?? terminalChoice()).catch(jobs.report);
  }

  async function toggleFullScreen() {
    const appWindow = getCurrentWindow();
    await appWindow.setFullscreen(!(await appWindow.isFullscreen()));
  }

  const here = () => tabs.activeView();
  const quietly = (work: Promise<unknown>) => work.catch(jobs.report);
  const numbered = (name: string, run: (place: number) => unknown) =>
    Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((place) => [`${name}-${place}`, () => run(place)]));

  /** What each command of `KEYS` does, under its id. The keys, the palette and the path bar all run these. */
  const RUN: Record<string, () => unknown> = {
    copy: () => actions.copy(here()),
    cut: () => actions.cut(here()),
    paste: () => actions.paste(here()),
    duplicate: () => duplicate(here()),
    copyPath: () => quietly(copyPath(here())),
    rename: () => actions.startRename(here()),
    delete: () => actions.remove(here(), false),
    deleteForGood: () => actions.remove(here(), true),
    newFolder: () => actions.newItem(here(), true),
    newFolderWith: () => gather(here()),
    newFile: () => actions.newItem(here(), false),
    properties: () => shell.properties(here()),
    shelve: () => quietly(putOnShelf(here())),
    copyToOther: () => actions.toOtherPane(here(), "copy"),
    moveToOther: () => actions.toOtherPane(here(), "move"),
    undo: () => actions.undo(here()),
    redo: () => actions.redo(here()),
    activity: () => setActivityOpen(true),
    diskMap: () => here().isZip() || setMapping(here().folder()?.path ?? ""),
    timeRiver: () => here().isZip() || here().isBin() || setRiverOn(folderHere()),
    twins: () => here().isZip() || here().isBin() || void openTwins(here(), folderHere()),
    colourWall: () => colourWall(here()),
    toFileDialog: () => {
      const folder = here().folder()?.path;
      if (!folder) return;
      sendToFileDialog(folder)
        .then((title) => jobs.notify(`Sent to "${title || "file dialog"}"`, `It now shows ${baseName(folder) || folder}.`))
        .catch(jobs.report);
    },
    back: () => (tabs.active().home() ? tabs.active().setHome(false) : here().back()),
    homePage: showHomePage,
    forward: () => here().forward(),
    up: () => here().up(),
    path: () => here().setEditingPath(true),
    search: () => here().askSearch(),
    refresh: () => here().refresh(),
    terminal: () => terminalHere(here()),
    ...numbered("pinned", (place) => {
      const path = pinned()[place - 1];
      if (path) here().open(path);
    }),
    ...numbered("tag", (place) => toggleTagKey(here(), place)),
    list: () => here().setLayout("list"),
    grid: () => here().setLayout("grid"),
    gallery: () => here().setLayout("gallery"),
    columns: () => here().setLayout("columns"),
    lockView: () => here().toggleLock(),
    largerTiles: () => resizeTiles(here(), TILE_STEP),
    smallerTiles: () => resizeTiles(here(), -TILE_STEP),
    hidden: toggleHidden,
    systemFiles: toggleSystem,
    importQuickAccess: () => quietly(importQuickAccess()),
    filter: () => here().toggleChips(),
    filterMore: () => setFiltering(here()),
    selectPattern: () => setSelectingPattern(here()),
    invertSelection: () => invertSelection(here()),
    details: toggleDetails,
    previewPane: () => setPreviewPane(!previewPane()),
    compare: () => quietly(compare(here())),
    widerPreview: () => resizePreview(DOCK_STEP),
    narrowerPreview: () => resizePreview(-DOCK_STEP),
    sidebar: toggleSidebar,
    fullScreen: () => quietly(toggleFullScreen()),
    shelf: () => setShelfOpen(!shelfOpen()),
    newTab: () => newTab(),
    backgroundTab: () => quietly(pickedFolders(here()).then(openTabsBehind)),
    openToSide: () => quietly(pickedFolders(here()).then(([path]) => (path ? tabs.openToSide(path) : undefined))),
    close: () => tabs.closePane(tabs.active(), here()),
    reopen: () => tabs.reopenClosed(),
    duplicateTab: () => tabs.duplicate(tabs.active()),
    pinTab: () => tabs.togglePinned(tabs.active()),
    tabToWindow: () => quietly(tabs.toWindow(tabs.active())),
    gatherWindows: () => quietly(gatherWindows()),
    reopenWindow: () => quietly(reopenClosedWindow()),
    split: splitView,
    otherPane: () => tabs.active().activate(tabs.active().other() ?? here()),
    nextTab: () => tabs.cycle(1),
    previousTab: () => tabs.cycle(-1),
    ...numbered("tab", (place) => tabs.activateAt(place - 1)),
    settings: showSettings,
    keys: () => setKeysOpen(true),
    home: () => homePath && here().open(homePath),
    tabSearch: searchTabs,
    workspaces: askWorkspace,
    nextWorkspace: () => spaces.cycle(1).catch(console.error),
    previousWorkspace: () => spaces.cycle(-1).catch(console.error),
    stackPanes: () => tabs.active().panes().length > 1 && tabs.active().stack(),
    linkPanes: () => tabs.active().panes().length > 1 && tabs.active().setLinked(!tabs.active().linked()),
    mirrorPane: () => quietly(Promise.resolve(tabs.mirror())),
  };

  /** What the bar over a selection offers. A menu opens under its own button. */
  /** Where deleted items can go instead of back: the other pane, pinned and recent folders, or
   * any folder from Windows' picker. */
  function restorePlaces(view: FolderView): MenuItem[] {
    const other = tabs.active().other();
    const otherPath = other && !other.isBin() ? other.folder()?.path : undefined;
    const seen = new Set<string>();
    const place = (path: string, divider: boolean): MenuItem[] => {
      if (seen.has(path.toLowerCase()) || isBin(path)) return [];
      seen.add(path.toLowerCase());
      return [{ label: baseName(path) || path, divider, action: () => actions.restoreTo(view, path) }];
    };
    const choose = () =>
      pick({ mode: "folder", title: "Restore to", purpose: "folders" })
        .then((picked) => picked && actions.restoreTo(view, picked.path))
        .catch(jobs.report);
    return [
      { label: "Choose a folder…", action: choose },
      ...(otherPath ? place(otherPath, true) : []),
      ...pinned().flatMap((path, at) => place(path, at === 0)),
      ...recentFolders().flatMap((path, at) => place(path, at === 0)),
    ];
  }

  /** Opens the two selected files side by side, the upper one on the left. */
  async function compare(view: FolderView) {
    const selection = view.list()?.selection();
    if (selection?.rows.length !== 2) return jobs.notify("Select two files to compare", "Compare works on two at a time", true);
    const indexes = [...selection.rows].sort((a, b) => a - b);
    const rows = await Promise.all(indexes.map((index) => fetchRows(view.id, selection.request, index, 1).then((found) => found[0])));
    if (rows.some((row) => !row || row.isDir)) return jobs.notify("Select two files to compare", "Folders can't be compared", true);
    const kind = compareKind(rows.map((row) => row.name), rows.map((row) => kindOf(row.name, false))) === "picture" ? "picture" : "text";
    setComparing({ view, snapshot: selection.request, kind, sides: [{ row: rows[0], index: indexes[0] }, { row: rows[1], index: indexes[1] }] });
  }

  function barItems(view: FolderView, two?: Row[]): BarItem[] {
    const item = (label: string, run: BarItem["run"], id?: string): BarItem => ({
      label,
      icon: iconFor(label) ?? "",
      keys: id && keyText(id).replace("Ctrl", "Control"),
      run,
    });
    const under = (anchor: HTMLElement, items: MenuItem[]) => {
      const box = anchor.getBoundingClientRect();
      setMenu({ x: box.left, y: box.bottom + 4, above: box.top - 2, items });
    };
    if (view.isBin()) {
      return [
        item("Restore", () => actions.restore(view)),
        item("Restore to", (anchor) => under(anchor, restorePlaces(view))),
        item("Delete permanently", () => actions.remove(view, true), "deleteForGood"),
      ];
    }
    if (view.isZip()) {
      return [
        item("Copy", () => actions.copy(view), "copy"),
        ...(two && compareKind(two.map((row) => row.name), two.map((row) => kindOf(row.name, row.isDir))) ? [item("Compare", () => quietly(compare(view)), "compare")] : []),
      ];
    }
    const moveTo = (anchor: HTMLElement) => {
      const from = view.folder()?.path;
      const other = tabs.active().other();
      const seen = new Set([from?.toLowerCase()]);
      const place = (path: string, divider: boolean): MenuItem[] => {
        if (seen.has(path.toLowerCase())) return [];
        seen.add(path.toLowerCase());
        return [{ label: baseName(path) || path, divider, action: () => sendTo(view, "move", path) }];
      };
      const otherPath = other && !other.isBin() ? other.folder()?.path : undefined;
      const items = [
        ...(otherPath ? [{ label: "Move to other pane", action: () => actions.toOtherPane(view, "move") }] : []),
        ...pinned().flatMap((path, at) => place(path, at === 0)),
        ...recentFolders().flatMap((path, at) => place(path, at === 0)),
      ];
      under(anchor, items.length > 0 ? items : [{ label: "Pin a folder to move here in one step", disabled: true }]);
    };
    const tag = (anchor: HTMLElement) => {
      const load = shell.tagsItem(view, showTagChange, () => setNamingTag(view)).load;
      load?.()
        .then((items) => under(anchor, items))
        .catch(jobs.report);
    };
    return [
      item("Copy", () => actions.copy(view), "copy"),
      item("Move to", moveTo),
      item("Compress to ZIP", () => actions.compress(view)),
      item("Tags", tag),
      item("Rename", () => actions.startRename(view), "rename"),
      item("Put on the shelf", () => quietly(putOnShelf(view)), "shelve"),
      ...(view.query() ? [] : [item("New folder with selection", () => gather(view), "newFolderWith")]),
      ...(two && compareKind(two.map((row) => row.name), two.map((row) => kindOf(row.name, row.isDir))) ? [item("Compare", () => quietly(compare(view)), "compare")] : []),
    ];
  }

  /** Folders whose names start with what is typed, so Tab can finish the path. */
  async function folderOffers(view: FolderView, text: string): Promise<Suggestion[]> {
    const from = view.folder()?.path;
    if (!text || text.includes("%") || !from || view.isBin()) return [];
    const cut = Math.max(text.lastIndexOf("\\"), text.lastIndexOf("/")) + 1;
    const typedParent = text.slice(0, cut);
    const parent = /^([a-z]:[\\/]|\\\\)/i.test(typedParent) ? typedParent : join(from, typedParent);
    const start = text.slice(cut).toLowerCase();
    const names = await subfolders(parent, showHidden(), showSystem()).catch((): string[] => []);
    return names
      .filter((name) => name.toLowerCase().startsWith(start))
      .slice(0, MOST_OFFERS)
      .map((name) => ({
        label: name,
        hint: parent,
        fill: `${join(parent, name)}\\`,
        run: () => view.open(join(parent, name)),
      }));
  }

  /** What the path bar offers: `>` runs a command, `@` is a nickname, `?` searches, and a path completes. */
  async function suggest(view: FolderView, text: string): Promise<Suggested> {
    const typed = readTyped(text);
    const folder = view.isBin() ? undefined : view.folder()?.path;
    if (typed.kind === "command") {
      const all = commands();
      const order = typed.text ? await rankNames(typed.text, all.map((command) => command.label)) : all.map((_, at) => at);
      const items = order.slice(0, MOST_OFFERS).map((at) => ({ label: all[at].label, hint: all[at].keys, run: all[at].run }));
      return { first: true, items };
    }
    if (typed.kind === "terminal") {
      const run = () => terminalHere(view, typed.shell);
      return { first: true, items: folder ? [{ label: `Open ${TERMINAL_NAMES[typed.shell]} here`, hint: folder, run }] : [] };
    }
    if (typed.kind === "search") {
      const run = () => view.search(typed.text);
      return { first: true, items: typed.text && folder ? [{ label: `Search for “${typed.text}”`, run }] : [] };
    }
    if (typed.kind === "nickname") {
      const { name } = typed;
      const save: Suggestion[] =
        name && folder ? [{ label: `Call this folder @${name}`, hint: folder, run: () => setNickname(name, folder) }] : [];
      if (typed.save) return { first: true, items: save };
      const fitting = Object.entries(nicknames()).filter(([known]) => known.startsWith(name));
      const items: Suggestion[] = fitting.map(([known, path]) => ({
        label: `@${known}`,
        hint: path,
        fill: `@${known}`,
        run: () => view.open(path),
      }));
      if (name in nicknames()) items.push({ label: `Forget @${name}`, run: () => forgetNickname(name) });
      else items.push(...save);
      return { first: true, items };
    }
    return { first: false, items: await folderOffers(view, typed.text) };
  }

  function commands(): Command[] {
    const view = tabs.activeView();
    const goTo = (label: string, path: string, icon = ICON_FOLDER): Command => ({
      label: `Go to ${label}`,
      group: "Go",
      icon,
      run: () => view.open(path),
    });
    const more = (group: string, list: Command[]) =>
      list.map((command) => ({ group, icon: iconFor(command.label), ...command }));
    const known = places();
    const keyed = KEYS.filter(
      (command) => !command.fixed && !command.quiet && !(view.isBin() && FOLDER_ONLY.has(command.id)) && !(view.isZip() && ZIP_HIDES.has(command.id)),
    );
    const inFolder: Command[] = view.isBin()
      ? []
      : view.isZip()
      ? [
          { label: "Extract all", run: () => actions.extractAll(view) },
          { label: "Copy name", run: () => quietly(copyName(view)) },
          { label: "Flat view", run: () => toggleFlat(view) },
          ...keepCommands(view),
        ]
      : [
          { label: "Compress to ZIP", run: () => actions.compress(view) },
          { label: "Compress with options…", run: () => actions.compress(view, { x: innerWidth / 2 - 180, y: innerHeight / 3 }) },
          { label: "Extract", run: () => actions.extract(view, false, true) },
          { label: "Paste as shortcut", run: () => actions.pasteShortcut(view) },
          { label: "Copy name", run: () => quietly(copyName(view)) },
          { label: "Extract here", run: () => actions.extract(view, false) },
          { label: "Extract to own folder", run: () => actions.extract(view, true) },
          { label: "Save as template", run: () => actions.saveTemplate(view) },
          { label: "Open templates folder", run: () => actions.openTemplates(view) },
          { label: "Flat view", run: () => toggleFlat(view) },
          { label: "Find copies", run: () => findCopies(view) },
          ...compareItems().map((item) => ({ label: item.checked ? "Stop comparing folders" : "Compare folders", run: item.action })),
          { label: "Use this view for all folders", run: () => viewForAll(view) },
          ...keepCommands(view),
        ];
    return [
      ...keyed.map((command) => ({
        label: command.label,
        group: command.group,
        icon: iconFor(command.label),
        keys: keyText(command.id),
        run: RUN[command.id],
      })),
      ...more("Files", [{ label: "Quick preview", keys: "Space", run: () => previewSelected(view) }, ...inFolder]),
      ...more("View", [
        { label: "Compact rows", run: () => setRowDensity("compact") },
        { label: "Cozy rows", run: () => setRowDensity("cozy") },
        { label: "Roomy rows", run: () => setRowDensity("roomy") },
        { label: windowsIcons() ? "Perli icons" : "Windows icons", icon: iconFor("Windows icons"), run: () => setWindowsIcons(!windowsIcons()) },
        ...(view.filtered() ? [{ label: "Clear filter", run: () => view.setFilterForm(NO_FILTER) }] : []),
        ...(!view.isBin() && (view.filtered() || view.query())
          ? [{ label: "Save as smart folder", icon: ICON_SMART, run: () => saveSmart(view) }]
          : []),
        { label: statusBar() ? "Hide status bar" : "Always show status bar", run: () => setStatusBar(!statusBar()) },
        ...groupByItems(view).map((item) => ({
          label: item.label === "No groups" ? "Show without groups" : item.label.endsWith("groups") ? item.label : `Group by ${item.label.toLowerCase()}`,
          run: item.action,
        })),
        { label: sizeBars() ? "Hide size bars" : "Show size bars", run: () => setSizeBars(!sizeBars()) },
        { label: columnFiles() ? "Only folders in columns" : "Files in columns", run: () => setColumnFiles(!columnFiles()) },
        { label: pictureWall() ? "Picture folders with names" : "Picture folders as a wall", run: () => setPictureWall(!pictureWall()) },
        {
          label: picturesInGallery() ? "Picture folders open in their layout" : "Picture folders open in gallery",
          run: () => setPicturesInGallery(!picturesInGallery()),
        },
        ...BACKDROPS.map(({ id, label }) => ({ label: `Window backdrop: ${label}`, run: () => setBackdrop(id) })),
        ...SCALES.map((scale) => ({
          label: `Text and interface size: ${Math.round(scale * 100)}%`,
          run: () => setUiScale(scale),
        })),
      ]),
      ...more("Go", [
        { label: "Map network drive", run: () => setDrives("map") },
        { label: "Disconnect network drive", run: () => setDrives("disconnect") },
      ]),
      goTo("Recycle Bin", BIN_PATH, iconFor("Empty Recycle Bin")),
      ...(known?.folders ?? []).map(({ kind, path }) => goTo(FOLDERS[kind].label, path)),
      ...(known?.clouds ?? []).map(({ name, path }) => goTo(name, path, ICON_CLOUD)),
      ...(known?.drives ?? []).map(({ name, path }) => goTo(name, path, ICON_DRIVE)),
      ...pinned().map((path) => goTo(baseName(path) || path, path, iconFor("Pin tab"))),
      ...bookmarks().map((path) => goTo(baseName(path) || path, path, iconFor("Add bookmark"))),
      ...smartFolders().map(
        (smart): Command => ({ label: `Open smart folder: ${smart.name}`, group: "Go", icon: ICON_SMART, run: () => quietly(openSmart(view, smart)) }),
      ),
      ...(view.isBin()
        ? []
        : allTags().map((tag): Command => ({ label: `Show tag: ${tag.name}`, group: "Go", icon: iconFor("Tags"), run: () => showTagged(view, tag) }))),
      ...foundFiles(),
    ];
  }

  function keepCommands(view: FolderView): Command[] {
    const path = view.folder()?.path;
    if (!path || view.query()) return [];
    return [
      { label: holds(pinned(), path) ? "Unpin from sidebar" : "Pin to sidebar", run: () => togglePinned(path) },
      { label: holds(bookmarks(), path) ? "Remove bookmark" : "Add bookmark", run: () => toggleBookmark(path) },
    ];
  }

  function onKeyDown(event: KeyboardEvent) {
    const key = event.key.toLowerCase();
    // Shift changes what a digit key reports, so read which key it is.
    const digit = Number(event.code.match(/^Digit([1-9])$/)?.[1]);

    // Left alone, this key prints the page.
    if (event.ctrlKey && key === "p") {
      event.preventDefault();
      if (!sheetOpen()) togglePalette();
      return;
    }

    // The settings tab closes as a tab does, and steps aside for the keys that go to another tab.
    if (settingsShown() && !sheetOpen() && !paletteOpen()) {
      const closes = key === "escape" || (event.ctrlKey && (key === "w" || key === ","));
      const leaves = event.ctrlKey && (key === "tab" || key === "pagedown" || key === "pageup" || !!digit);
      if (closes) {
        event.preventDefault();
        return closeSettings();
      }
      if (leaves) setSettingsShown(false);
    }

    if (dialogOpen() || paletteOpen()) {
      if (isBrowserKey(event, key)) event.preventDefault();
      return;
    }

    if (key === "escape" && !isTyping(event)) takeBackCut();
    const combo = comboOf(event);
    const command = commandFor(combo);
    const typing = isTyping(event);
    // A file command must only ever mean the files, never a focused button or a box of text.
    const fits =
      command &&
      (command.where === "list" ? isInList(event) : !typing || (command.where !== "free" && !typesText(combo)));
    if (fits) {
      event.preventDefault();
      // Holding a key down must not paste or delete again and again.
      if (command.where !== "list" || !event.repeat) RUN[command.id]?.();
    } else if (isBrowserKey(event, key)) event.preventDefault();
  }

  function onMouseButton(event: MouseEvent) {
    if (event.button === MOUSE_BACK) tabs.activeView().back();
    else if (event.button === MOUSE_FORWARD) tabs.activeView().forward();
  }

  onMount(async () => {
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("mouseup", onMouseButton);
    // First, so a field's own menu wins over any row or pane under it.
    window.addEventListener("contextmenu", onContextMenu, true);
    window.addEventListener("wheel", blockBrowserZoom, { passive: false });
    window.addEventListener("focus", trackWindowFocus);
    window.addEventListener("blur", trackWindowFocus);
    window.addEventListener("focus", checkCut);
    refreshTags();
    startUpdates();
    // Perli closed in the middle of a job last time, and the start put things right.
    takeSweepReport()
      .then(({ putBack, cleaned }) => {
        const text = sweptText(putBack, cleaned);
        if (text) jobs.notify("Perli closed before its jobs finished", text);
      })
      .catch(console.error);
    const start = await startState();
    homePath = start.home ?? undefined;
    const moved = parseMoved(start.moved);
    const session = start.folder ? undefined : moved ? { tabs: [moved.tab], active: 0 } : parseSession(start.session);
    if (session) {
      tabs.restore(session);
    } else {
      const thisPc = start.folder === THIS_PC_PATH;
      const opened = await tabs.activeView().open((thisPc ? undefined : start.folder) ?? start.home ?? "");
      if (thisPc) tabs.active().setHome(true);
      if (opened) performance.mark("perli-folder-open", { detail: opened });
      if (opened && start.select.length > 0) await tabs.activeView().reload(start.select);
    }
    newWindow = start.newWindow;
    setKeepSession(start.keep);
    // Its tabs came back with the session, so its workspace does too. The first window's was kept
    // apart before, which it reads that once.
    const { workspace } = windowExtras(start.session);
    if (keepSession()) spaces.resume(workspace !== undefined ? workspace : newWindow ? undefined : saved("workspace")).catch(console.error);
    // Starts handed over while this window loaded wait in the back end until now.
    await openListener;
    for (const ask of await asksWaiting()) await openAsked(ask).catch(console.error);
    // The other windows open once this one is up, so they never hold up its first look.
    if (keepSession() && !newWindow) restoreWindows().catch(console.error);
  });
  onCleanup(() => {
    window.clearTimeout(saveTimer);
    closeListener.then((stop) => stop());
    openListener.then((stop) => stop());
    folderListener.then((stop) => stop());
    dragListener.then((stop) => stop());
    searchListener.then((stop) => stop());
    sizesListener.then((stop) => stop());
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("mouseup", onMouseButton);
    window.removeEventListener("contextmenu", onContextMenu, true);
    window.removeEventListener("wheel", blockBrowserZoom);
    window.removeEventListener("focus", trackWindowFocus);
    window.removeEventListener("blur", trackWindowFocus);
    window.removeEventListener("focus", checkCut);
  });

  const Pane = (props: { tab: Tab; view: FolderView }) => {
    const { tab, view } = props;
    const activate = () => tab.activate(view);
    const [retrying, setRetrying] = createSignal(false);
    // A folder that couldn't be read, such as a cloud place while offline, is read again as soon
    // as the network is back.
    const backOnline = () => view.error() && void view.retry();
    window.addEventListener("online", backOnline);
    onCleanup(() => window.removeEventListener("online", backOnline));
    return (
      <section
        class="pane"
        data-view={view.id}
        style={{ "--pane-name": `pane-${view.id}` }}
        classList={{ "pane-active": tab.panes().length > 1 && view === tab.active() }}
        onPointerDown={activate}
        onFocusIn={activate}
      >
        <PathBar
          view={view}
          onToggleHidden={toggleHidden}
          onFilter={() => view.toggleChips()}
          onCrumbMenu={(path, x, y) => showCrumbMenu(view, path, x, y)}
          menuFor={menu()?.from}
          onNewTab={(path) => tabs.add([path])}
          suggest={(text) => suggest(view, text)}
          onHistory={(behind, x, y) => showHistory(view, behind, x, y)}
          onCrumbContext={(path, event) => showFolderMenu(event, view, path)}
          onFoldedMenu={(crumbs, x, y) => showFolded(view, crumbs, x, y)}
          linked={tab.panes().length > 1 ? { on: tab.linked(), toggle: () => tab.setLinked(!tab.linked()) } : undefined}
          compare={tab.panes().length > 1 ? { on: tab.comparing(), toggle: () => tab.setComparing(!tab.comparing()) } : undefined}
        />
        <Show when={view.chipsShown()}>
          <FilterChips view={view} onMore={() => setFiltering(view)} onRecycle={() => actions.remove(view, false)} />
        </Show>
        <Show when={selectingPattern() === view}>
          <SelectPattern view={view} onClose={() => setSelectingPattern(undefined)} />
        </Show>
        <div class="file-area">
          <Show when={view.isZip()}>
            <ZipBar view={view} onExtract={() => actions.extractAll(view)} />
          </Show>
          <Show when={tab.comparing() && !view.query()}>
            <CompareBar
              view={view}
              marks={tab.marksOf(view)}
              only={tab.onlyMark(view)}
              onOnly={(mark) => tab.setOnlyMark(view, mark)}
              onCopyOver={() => actions.toOtherPane(view, "copy")}
              onStop={() => tab.setComparing(false)}
            />
          </Show>
          <Show when={view.error()}>
            <div class="message" role="alert">
              <p>{view.error()}</p>
              <Show when={!navigator.onLine}>
                <p class="settings-note">This PC is offline. Perli tries again by itself when the network is back.</p>
              </Show>
              <button
                class="job-choice"
                disabled={retrying()}
                onClick={() => {
                  setRetrying(true);
                  void view.retry().finally(() => setRetrying(false));
                }}
              >
                {retrying() ? "Trying…" : "Try again"}
              </button>
            </div>
          </Show>
          <div class="file-stage">
          <Show when={inColumns(view)}>
            <FolderColumns
              view={view}
              onMenu={(event, path) => showFolderMenu(event, view, path)}
              onNewTab={(path) => tabs.add([path])}
              onFile={(path, look) => void (look ? previewOf(path, view) : showInFolder(view, path))}
              onFileMenu={(event, path) =>
                setMenu({
                  x: event.clientX,
                  y: event.clientY,
                  items: [
                    { label: "Show in folder", action: () => showInFolder(view, path) },
                    { label: "Preview", action: () => previewOf(path, view) },
                    { label: "Copy path", action: () => quietly(copyFolderPath(path)) },
                  ],
                })
              }
            />
          </Show>
          {/* A real arrival starts the list over. A reload only swaps its rows, so nothing blinks. */}
          <Show when={view.folder() && view.arrival()} keyed>
            {(_arrival) => (
              <FileList
                view={view.id}
                folder={view.folder()!.path}
                snapshot={view.folder()!.request}
                rearranged={view.folder()!.rearranged}
                count={view.folder()!.count}
                items={view.folder()!.items}
                selected={view.folder()!.selected}
                reveal={view.folder()!.reveal}
                rename={view.folder()!.rename}
                top={view.folder()!.top}
                scrollTo={view.folder()!.scrollTo}
                onLeave={view.keep}
                onBackgroundDoubleClick={() => upOnDoubleClick() && void view.up()}
                thumbs={!view.isBin()}
                columns={inColumns(view) ? shownColumns(view).filter((column) => column.id === "name") : shownColumns(view)}
                columnSet={view.columnSet()}
                fixedColumns={ownColumns(view) !== undefined}
                groups={view.folder()!.groups}
                largest={view.folder()!.largest}
                groupLabel={(key) =>
                  groupLabel(view.groupBy(), key, new Date(), {
                    tag: (id) => allTags().find((known) => known.id === id)?.name,
                    folder: (path) => relativeTo(view.folder()!.path, path) || "This folder",
                    size: formatSize,
                  })
                }
                onFold={view.toggleFold}
                paths={view.query() === FLAT_QUERY}
                wall={pictureWall() && view.columnSet() === "pictures"}
                cut={view.query() ? undefined : cutNames(view.folder()!.path)}
                marks={tab.marksOf(view)}
                onScrolled={(tops) => tab.scrolled(view, tops)}
                git={view.gitMarks()}
                expanded={view.expanded()}
                // Rows gathered under headers can't also nest under their folders.
                onExpand={
                  inlineFolders() && !view.query() && !view.isBin() && !view.isZip() && view.groupBy() === "none" && !inColumns(view)
                    ? (path) => void view.toggleExpand(path)
                    : undefined
                }
                synced={!view.query() && inCloud(view.folder()!.path)}
                empty={emptyState(view)}
                match={view.query() === FLAT_QUERY || view.query() === COPIES_QUERY ? undefined : view.query()}
                active={tab === tabs.active() && view === tab.active()}
                layout={view.layout() === "columns" ? "list" : view.layout()}
                sort={view.sort()}
                onSort={(key) => view.setSort(nextSort(view.sort(), key))}
                onDragOut={() => actions.dragOut(view)}
                onOpen={(row, toSide) => openRow(view, row, toSide)}
                onMenu={(event, row) => showRowMenu(event, view, row)}
                onTag={(id) => {
                  const tag = allTags().find((known) => known.id === id);
                  if (tag) view.search(tagQuery(tag.name));
                }}
                onBackgroundMenu={(event) => showBackgroundMenu(event, view)}
                onHeaderMenu={(event) => (ownColumns(view) ? event.preventDefault() : showHeaderMenu(event, view))}
                onGroup={cycleGrouping}
                onRename={(selection, name) => {
                  if (writesIn(view)) writing!.name = name;
                  return actions.rename(view, selection, name);
                }}
                onEditEnd={() => {
                  view.editEnded();
                  // Kept as it was, the new file opens at once. A new name waits for the rows to show it.
                  if (writesIn(view) && !writing!.name) writeSelected(view);
                }}
                onFirstPaint={markReady}
                onSwapped={(snapshot) => {
                  view.swapped(snapshot);
                  const named = writesIn(view) && writing!.name;
                  if (named && view.list()?.left()?.names[0]?.toLowerCase() === named.toLowerCase()) writeSelected(view);
                }}
                onEscape={() => view.search("")}
                onPreview={(at) => preview(view, at)}
                onCursor={view.setCursor}
                onOpenBehind={(row) => openBehind(view, row)}
                barItems={(two) => barItems(view, two)}
                connect={view.connectList}
                onUp={inColumns(view) ? () => void view.up() : undefined}
              />
            )}
          </Show>
          </div>
        </div>
      </section>
    );
  };

  return (
    <div class="shell" data-sidebar={sidebarOpen() ? "open" : "rail"} data-arriving={edgeShown() ? "" : undefined}>
      <div class="workspace-pill-place" role="status" aria-live="polite">
        <Show when={spaces.pill()} keyed>
          {(pill) => (
            <div class="workspace-pill">
              <span class="workspace-glyph" aria-hidden="true">
                {ICON_WORKSPACE}
              </span>
              <span>{pill.name}</span>
              <span class="workspace-pill-count">
                · {pill.at} of {pill.of}
              </span>
            </div>
          )}
        </Show>
      </div>
      <TitleBar
        tabs={tabs}
        onNewTab={newTab}
        onTabSearch={searchTabs}
        workspace={spaces.current()}
        onWorkspaces={askWorkspace}
        onReopenWindow={() => void quietly(reopenClosedWindow())}
        settings={
          settingsOpen()
            ? {
                active: settingsShown(),
                onActivate: showSettings,
                onLeave: () => setSettingsShown(false),
                onClose: closeSettings,
              }
            : undefined
        }
      />
      <aside class="sidebar">
        <div class="sidebar-panel">
        <span class="logo">Perli</span>
        <Sidebar
          view={tabs.activeView()}
          onMenu={(event, path) => showFolderMenu(event, tabs.activeView(), path)}
          onRecentMenu={(event, recent, forget) => showRecentMenu(event, tabs.activeView(), recent, forget)}
          onServerMenu={(event, server) => showServerMenu(event, tabs.activeView(), server)}
          onSectionMenu={showSectionMenu}
          onTag={(tag) => showTagged(tabs.activeView(), tag)}
          onTagMenu={showTagMenu}
          onSmart={(smart) => quietly(openSmart(tabs.activeView(), smart))}
          onSmartMenu={showSmartMenu}
          onPlaces={setPlaces}
          onEject={jobs.eject}
          onAddCloud={() => setAddingPlace(true)}
          onSync={(pair) => (pair.ran === 0 || pair.mirror ? editSync(pair) : runSync(pair.id))}
          onSyncMenu={showSyncMenu}
          syncing={syncingOf}
          onNewSync={() => newSync(tabs.activeView().folder()?.path ?? "")}
          report={jobs.report}
        />
        <MiniPlayer onOpen={() => void backToPlayer().catch(jobs.report)} />
        <CutChip onShow={(folder, names) => quietly(showCut(tabs.activeView(), folder, names))} />
        <button
          class="settings-button"
          aria-current={tabs.active().home() && !settingsShown() ? "page" : undefined}
          aria-keyshortcuts={keyText("homePage").replace("Ctrl", "Control") || undefined}
          onClick={showHomePage}
        >
          <span class="settings-icon" aria-hidden="true">
            {ICON_HOME_PAGE}
          </span>
          <span class="settings-label">Home page</span>
        </button>
        <button
          class="settings-button"
          aria-label={updateState() === "ready" ? "Settings, update ready" : "Settings"}
          aria-keyshortcuts="Control+,"
          onClick={showSettings}
        >
          <span class="settings-icon" aria-hidden="true">
            {ICON_SETTINGS}
          </span>
          <span class="settings-label">Settings</span>
          <Show when={updateState() === "ready"}>
            <span class="update-dot" aria-hidden="true" />
          </Show>
        </button>
        </div>
      </aside>
      <main class="files">
        <BookmarksBar
          view={tabs.activeView()}
          onNewTab={(path) => tabs.add([path])}
          onMenu={(event, path) => showFolderMenu(event, tabs.activeView(), path)}
          onGroup={showBookmarkGroup}
          onMore={(anchor, items) => {
            const box = anchor.getBoundingClientRect();
            const compact = { label: "Icons only", divider: true, checked: bookmarksCompact(), action: () => setBookmarksCompact(!bookmarksCompact()) };
            setMenu({ x: box.left, y: box.bottom + 4, items: [...items, compact] });
          }}
        />
        <For each={tabs.tabs()}>
          {(tab) => (
            <div class="panes" hidden={tab !== tabs.active() || settingsShown() || tab.home()}>
              <div
                class="pane-pair"
                classList={{ "panes-swapped": tab.swapped(), "pane-pair-stacked": tab.stacked() }}
                style={{ "--split": tab.split() }}
              >
                <For each={tab.panes()}>{(view) => <Pane tab={tab} view={view} />}</For>
                <Show when={tab.panes().length > 1}>
                  <PaneDivider tab={tab} stream={streamOf(tab)} />
                </Show>
                <Show when={tab.panes().length > 1 && tab.comparing()}>
                  <CompareThreads tab={tab} />
                </Show>
              </div>
              {/* The column view's last column is the details of what is selected. */}
              <Show when={(detailsPanel() || tab.active().layout() === "columns") && tab === tabs.active()}>
                <DetailsPanel view={tab.active()} />
              </Show>
              <Show when={previewPane() && tab === tabs.active()}>
                <PreviewDock
                  view={tab.active()}
                  onOpen={(row) => openRow(tab.active(), row, false)}
                  onClose={() => setPreviewPane(false)}
                  notify={jobs.notify}
                />
              </Show>
            </div>
          )}
        </For>
        <Show when={tabs.active().home() && !settingsShown()}>
          <HomePage
            drives={places()?.drives}
            pinned={pinned()}
            folders={recentFolders()}
            onOpen={(path) => leaveHome((view) => view.open(path))}
            onOpenFile={(path) => leaveHome(() => previewOf(path))}
            onMenu={(event, path) => showFolderMenu(event, tabs.activeView(), path)}
            onEject={jobs.eject}
            onSearch={(text) => leaveHome((view) => view.search(text))}
            onOpenSpace={() => setMapping("")}
          />
        </Show>
        <Settings
          open={settingsOpen()}
          shown={settingsShown()}
          onClose={closeSettings}
          onToggleSizes={toggleSizes}
          onToggleSystem={toggleSystem}
          onTagsChanged={showTagChange}
          onDeleteTag={askDeleteTag}
          onBeforeUpdate={flushSession}
          onKeys={() => setKeysOpen(true)}
          onRevealTemplates={() => {
            closeSettings();
            actions.openTemplates(tabs.activeView());
          }}
          onFailure={jobs.report}
        />
      </main>
      <Show when={menu()} keyed>
        {(open) => <Menu x={open.x} y={open.y} above={open.above} items={open.items} mount={open.mount} onClose={closeMenu} />}
      </Show>
      <Show when={lookFor()} keyed>
        {(path) => <LookPicker path={path} onClose={() => setLookFor(undefined)} onOpen={setLookFor} />}
      </Show>
      <Show when={tinting()} keyed>
        {(at) => (
          <div class="color-at" data-kind={at.kind} style={{ left: `${at.x}px`, top: `${at.y}px` }}>
            <ColorField
              opened
              label={`Icon color for ${KIND_LABELS[at.kind]}`}
              value={iconTheme().colors[at.kind] ?? "var(--kind-color)"}
              onChange={(color) => setIconTheme({ ...iconTheme(), colors: { ...iconTheme().colors, [at.kind]: color } })}
              onClose={() => setTinting(undefined)}
            />
          </div>
        )}
      </Show>
      <Show when={making()} keyed>
        {(open) => (
          <NewGallery x={open.x} y={open.y} onPick={(pick) => makeNew(open.view, pick)} onClose={() => setMaking(undefined)} />
        )}
      </Show>
      <JobsPanel jobs={jobs} />
      <Shelf
        folder={dropFolder}
        onJob={(task) => startJob(task, tabs.activeView().id).catch(jobs.report)}
        onShow={(path) => showInFolder(tabs.activeView(), path)}
        report={jobs.report}
      />
      <DropChips folder={() => tabs.activeView().folder()?.path} other={() => tabs.active().other()?.folder()?.path} />
      <Show when={activityOpen()}>
        <ActivityLog
          canRedo={jobs.canRedo}
          onShow={(path) => showInFolder(tabs.activeView(), path)}
          onUndo={(step, back) => undoJob(tabs.activeView().id, step, back).catch(failed)}
          onRedo={() => redoJob(tabs.activeView().id).catch(failed)}
          onClose={() => setActivityOpen(false)}
        />
      </Show>
      <Show when={keysOpen()}>
        <KeySheet onClose={() => setKeysOpen(false)} />
      </Show>
      <Show when={mapping() !== undefined}>
        <Space
          folder={mapping()!}
          drives={places()?.drives ?? []}
          pictures={places()?.folders.find((folder) => folder.kind === "pictures")?.path}
          downloads={places()?.folders.find((folder) => folder.kind === "downloads")?.path}
          onOpen={(path) => void leaveHome((view) => view.open(path))}
          onShow={(path) => void leaveHome((view) => showInFolder(view, path))}
          onClose={() => setMapping(undefined)}
        />
      </Show>
      <Show when={riverOn()} keyed>
        {(folder) => (
          <TimeRiver
            folder={folder}
            showHidden={showHidden()}
            showSystem={showHidden() && showSystem()}
            downloads={places()?.folders.find((one) => one.kind === "downloads")?.path}
            onShowDay={(path, day) =>
              void leaveHome(async (view) => {
                await view.open(path);
                // The day's files anywhere under the river's folder, whatever reach and depth the pane had.
                view.setScope("below");
                view.setDepth(null);
                view.search(FLAT_QUERY);
                view.setFilterForm({ ...NO_FILTER, from: day, to: day });
              })
            }
            onShow={(path) => void leaveHome((view) => showInFolder(view, path))}
            onClose={() => setRiverOn(undefined)}
          />
        )}
      </Show>
      <Show when={twinsOn()} keyed>
        {(folders) => <Twins folders={folders} more={twinOffers()} onShow={(path) => void leaveHome((view) => showInFolder(view, path))} onClose={() => setTwinsOn(undefined)} />}
      </Show>
      <Show when={deleting()} keyed>
        {(request) => <ConfirmDelete request={request} onClose={() => setDeleting(undefined)} />}
      </Show>
      <Show when={renaming()} keyed>
        {(request) => <BatchRename request={request} onClose={() => setRenaming(undefined)} />}
      </Show>
      <Show when={zipping()} keyed>
        {(request) => <ZipOptions request={request} onClose={() => setZipping(undefined)} />}
      </Show>
      <Show when={filtering()} keyed>
        {(view) => <FilterDialog view={view} onClose={() => setFiltering(undefined)} onSave={() => saveSmart(view)} />}
      </Show>
      <Show when={updateSheet()}>
        <UpdateSheet onBeforeUpdate={flushSession} onLater={putOffUpdate} onClose={() => setUpdateSheet(false)} />
      </Show>
      <Show when={naming()} keyed>
        {(ask) => <NameSheet ask={ask} onClose={() => setNaming(undefined)} />}
      </Show>
      <PickerHost panes={pickerPanes} report={jobs.report} />
      <Show when={namingTag()} keyed>
        {(view) => (
          <NewTag
            selection={() => actions.selected(view)}
            onDone={showTagChange}
            onClose={() => setNamingTag(undefined)}
          />
        )}
      </Show>
      <Show when={showingProperties()} keyed>
        {({ target, at }) => (
          <Properties
            target={target}
            onPickApp={setPickingApp}
            onWindows={(lasting) => shell.windowsProperties(lasting, at)}
            onChanged={showTagChange}
            onClose={() => setShowingProperties(undefined)}
          />
        )}
      </Show>
      <Show when={pickingApp()} keyed>
        {(paths) => <AppPicker paths={paths} onClose={() => setPickingApp(undefined)} />}
      </Show>
      <Show when={drives() === "map"}>
        <MapDrive
          onMapped={(letter) => {
            refreshPlaces();
            jobs.notify(`Mapped ${letter}`, "It is with the drives in the sidebar.");
          }}
          onWindows={() => mapDrive().then(refreshPlaces).catch(jobs.report)}
          onClose={() => setDrives(undefined)}
        />
      </Show>
      <Show when={addingPlace()}>
        <AddPlace
          onAdded={(place) => {
            jobs.notify(`Added ${place.name}`, "It is under Cloud in the sidebar.");
            void tabs.activeView().open(placePath(place));
          }}
        />
      </Show>
      <Show when={editingSync()} keyed>
        {(pair) => <SyncSheet pair={pair} onRun={(saved) => runSync(saved.id)} onClose={closeSync} />}
      </Show>
      <Show when={versioning()} keyed>
        {(ask) => <Versions path={ask.path} onBack={() => void ask.view.reload()} onClose={() => setVersioning(undefined)} />}
      </Show>
      <Show when={drives() === "disconnect"}>
        <DisconnectDrive
          onUnmapped={refreshPlaces}
          onWindows={() => disconnectDrive().then(refreshPlaces).catch(jobs.report)}
          onClose={() => setDrives(undefined)}
        />
      </Show>
      <Show when={comparing()} keyed>
        {(ask) => (
          <Compare
            view={ask.view.id}
            snapshot={ask.snapshot}
            kind={ask.kind}
            sides={ask.sides}
            onRecycle={(side) => {
              startJob({ kind: "recycle", selection: { view: ask.view.id, request: ask.snapshot, rows: [side.index] } }, ask.view.id).catch(jobs.report);
              setComparing(undefined);
            }}
            onClose={() => {
              setComparing(undefined);
              ask.view.list()?.focus();
            }}
          />
        )}
      </Show>
      <Show when={previewing()} keyed>
        {({ view, at }) => (
          <QuickPreview
            at={at}
            onStep={(index) => view.list()?.select([index])}
            onOpen={(row) => openRow(view, row, false)}
            onClose={closePreview}
            onDock={() => {
              setPreviewPane(true);
              closePreview();
            }}
            onOpenWith={(path) => setPickingApp([path])}
            onShow={(path) => showInFolder(view, path)}
            notify={jobs.notify}
          />
        )}
      </Show>
      <Palette
        open={paletteOpen()}
        commands={scoped()?.commands ?? commands}
        words={scoped() ? scoped()!.words : paletteWords}
        scope={scoped()?.scope}
        onClose={() => setPaletteOpen(false)}
        focusList={() => tabs.activeView().list()?.focus()}
      />
      <Tooltip />
      <Show when={edgeShown()}>
        <span
          class="edge-draw"
          role="presentation"
          onAnimationEnd={(event) => event.animationName === "edge-fade" && setEdgeShown(false)}
        />
      </Show>
    </div>
  );
}
