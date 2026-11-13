import { getCurrentWindow } from "@tauri-apps/api/window";
import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import {
  cancelJobsAndClose,
  clipboardCanPaste,
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
  comeForward,
  ejectDrive,
  keepOnDevice,
  fetchRows,
  setTagPaths,
  openWindow,
  recentFiles,
  onSearchGrew,
  onSizesGrew,
  openFile,
  openTerminal,
  rankNames,
  redoJob,
  saveSession,
  selectionPaths,
  startJob,
  startState,
  stopSizes,
  subfolders,
  undoJob,
  type Grouping,
  type Places,
  type Recent,
  type Row,
  type ShellTarget,
  type Sort,
  type OpenAsk,
  type Tag,
} from "./api";
import { createFileActions } from "./features/fileops/actions";
import { BatchRename, type RenameRequest } from "./features/fileops/BatchRename";
import { followFileDrag } from "./features/fileops/fileDrag";
import { checkCut, cutNames, takeBackCut } from "./features/fileops/clipboard";
import { ConfirmDelete, type DeleteRequest } from "./features/fileops/ConfirmDelete";
import { createJobs } from "./features/fileops/jobs";
import { JobsPanel } from "./features/fileops/JobsPanel";
import { createShellItems } from "./features/fileops/shellItems";
import { AppPicker } from "./features/dialogs/AppPicker";
import { DisconnectDrive, MapDrive } from "./features/dialogs/NetworkDrives";
import { Properties } from "./features/dialogs/Properties";
import { NO_FILTER } from "./features/filelist/filter";
import { BIN_COLUMNS, nextGrouping, nextSort, SEARCH_COLUMNS } from "./features/filelist/columns";
import type { Empty } from "./features/filelist/EmptyState";
import { FileList } from "./features/filelist/FileList";
import { FilterDialog } from "./features/filelist/FilterDialog";
import { clampTile, isLargestTile, isSmallestTile, TILE_STEP, type Layout } from "./features/filelist/layout";
import {
  columns,
  detailsPanel,
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
  setTileSize,
  openInWindow,
  showHidden,
  tileSize,
  toggleColumn,
} from "./features/filelist/prefs";
import { SelectPattern } from "./features/filelist/SelectPattern";
import { FLAT_QUERY, type FolderView, type RowAt } from "./features/navigation/folderView";
import { BIN_PATH, isBin, isDriveRoot, join, parentOf, baseName, samePath } from "./features/navigation/path";
import { Palette, type Command } from "./features/palette/Palette";
import { PathBar, type Suggested, type Suggestion } from "./features/pathbar/PathBar";
import { commandFor, keyText } from "./features/keys/keybinds";
import { comboOf, KEYS } from "./features/keys/keys";
import { KeySheet } from "./features/keys/KeySheet";
import { ActivityLog } from "./features/reach/ActivityLog";
import { DropChips } from "./features/reach/DropChips";
import { readTyped } from "./features/reach/lists";
import {
  forgetNickname,
  nicknames,
  noteFolder,
  recentFolders,
  setNickname,
  setShelfOpen,
  shelfOpen,
  shelve,
} from "./features/reach/reach";
import type { BarItem } from "./features/reach/SelectionBar";
import { Shelf } from "./features/reach/Shelf";
import { DetailsPanel } from "./features/preview/DetailsPanel";
import { QuickPreview, type PreviewAt } from "./features/preview/QuickPreview";
import { BACKDROPS, SCALES, setBackdrop, setUiScale } from "./features/settings/appearance";
import { Settings } from "./features/settings/Settings";
import { startUpdates, updateState } from "./features/settings/updates";
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
  lookOf,
  movePinned,
  pinned,
  SECTIONS,
  setBookmarksBar,
  setLook,
  setSidebarOpen,
  sidebarOpen,
  toggleBookmark,
  togglePinned,
  toggleSection,
} from "./features/sidebar/saved";
import { folderGlyph, FOLDERS, Sidebar } from "./features/sidebar/Sidebar";
import { parseSession } from "./features/tabs/session";
import { createTabs, type Tab } from "./features/tabs/tabs";
import { NewTag } from "./features/tags/NewTag";
import { refreshTags, TAG_COLORS, TAG_DROP, tagQuery, tags as allTags } from "./features/tags/tags";
import { TitleBar } from "./features/titlebar/TitleBar";
import { Menu, type MenuItem } from "./ui/Menu";
import { NameSheet, type NameAsk } from "./ui/NameSheet";
import { renamedSmart, withoutSmart, withSmart, type SmartFolder } from "./features/smart/smartList";
import { iconFor } from "./ui/menuLook";
import { Tooltip } from "./ui/Tooltip";
import "./ui/controls.css";

const SAVE_DELAY_MS = 300;
/** How long a folder bound for its own window waits to hear which file to select there. */
const WINDOW_WAIT_MS = 600;
const MOUSE_BACK = 3;
const MOUSE_FORWARD = 4;
const ICON_SETTINGS = "\uE713";

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

const isTyping = (event: Event) => event.target instanceof HTMLInputElement;
// A job's Delete key must only ever mean the files, never a focused button.
const isInList = (event: Event) => (event.target as HTMLElement).classList?.contains("file-grid");
const hideBrowserMenu = (event: MouseEvent) => event.preventDefault();
/** A menu longer than this would only be scrolled past. */
const MOST_CRUMB_FOLDERS = 300;
/** Longer than any press and release of one click. */
const CLICK_MS = 400;
/** Folders opened behind at once. More would be a slip of the hand. */
const MOST_TABS_BEHIND = 8;
/** As many as the path bar offers at once. */
const MOST_OFFERS = 8;
const TERMINALS = { cmd: "Command Prompt", wt: "Windows Terminal", powershell: "Windows PowerShell", pwsh: "PowerShell" };
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
]);
/** A key with no Ctrl or Alt in it types a letter, so it must not run a command while typing. */
const typesText = (combo: string) => !/Ctrl|Alt|^F\d+$/.test(combo);
const blockBrowserZoom = (event: WheelEvent) => event.ctrlKey && event.preventDefault();
const trackWindowFocus = (event: FocusEvent) =>
  document.documentElement.toggleAttribute("data-blurred", event.type === "blur");
/** The columns a view keeps to itself, which the user can't change. */
const ownColumns = (view: FolderView) => (view.isBin() ? BIN_COLUMNS : view.query() ? SEARCH_COLUMNS : undefined);
const rowPath = (view: FolderView, row: Row) => join(row.location || view.folder()!.path, row.name);
const toggleFlat = (view: FolderView) => view.search(view.query() === FLAT_QUERY ? "" : FLAT_QUERY);

/** Glyphs a folder can wear, from Segoe Fluent Icons. */
const LOOK_ICONS: [string, string | undefined][] = [
  ["Folder", undefined],
  ["Star", "\uE734"],
  ["Heart", "\uEB51"],
  ["Work", "\uE821"],
  ["Code", "\uE943"],
  ["Music", "\uE8D6"],
  ["Pictures", "\uE8B9"],
  ["Video", "\uE714"],
  ["Games", "\uE7FC"],
  ["Package", "\uE7B8"],
  ["Lock", "\uE72E"],
  ["People", "\uE716"],
  ["Globe", "\uE774"],
];

function lookItem(path: string): MenuItem {
  const look = lookOf(path);
  return {
    label: "Folder look",
    items: [
      {
        label: "Color",
        items: [
          { label: "None", checked: look?.color === undefined, action: () => setLook(path, { color: undefined }) },
          ...TAG_COLORS.map((name, color) => ({
            label: name,
            checked: look?.color === color,
            action: () => setLook(path, { color }),
          })),
        ],
      },
      {
        label: "Icon",
        items: LOOK_ICONS.map(([label, icon]) => ({
          label,
          checked: look?.icon === icon,
          action: () => setLook(path, { icon }),
        })),
      },
    ],
  };
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
  /** `from` is the path crumb whose menu this is. */
  const [menu, setMenu] = createSignal<{ x: number; y: number; items: MenuItem[]; from?: string }>();
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
  const [previewing, setPreviewing] = createSignal<{ view: FolderView; at: PreviewAt }>();
  const [keysOpen, setKeysOpen] = createSignal(false);
  const [activityOpen, setActivityOpen] = createSignal(false);
  /** A sheet covers the tabs, so nothing behind it may change. */
  const sheetOpen = () =>
    !!deleting() ||
    !!renaming() ||
    !!filtering() ||
    !!selectingPattern() ||
    !!namingTag() ||
    !!showingProperties() ||
    !!pickingApp() ||
    !!drives() ||
    !!previewing() ||
    keysOpen() ||
    activityOpen();
  /** The settings page stands where the files do, so the keys of the files rest too. */
  const dialogOpen = () => settingsShown() || sheetOpen();
  // Going to a folder, by any road, puts the files back in front.
  createEffect(
    on([tabs.active, () => tabs.activeView().arrival()], () => setSettingsShown(false), { defer: true }),
  );
  const jobs = createJobs(tabs.allViews);
  const actions = createFileActions(jobs, setDeleting, () => tabs.active().other(), setRenaming);
  const shell = createShellItems(jobs, actions, {
    properties: (target, at) => setShowingProperties({ target, at }),
    pickApp: setPickingApp,
  });
  const refreshPlaces = () => listPlaces().then(setPlaces).catch(console.error);
  // A run started on one folder is a detour, so it must not replace the saved tabs.
  const [keepSession, setKeepSession] = createSignal(false);
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

  createEffect(() => {
    const session = keepSession() ? tabs.session() : undefined;
    if (!session) return;
    unsaved = session;
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => flushSession().catch(console.error), SAVE_DELAY_MS);
  });

  const stopJobs: DeleteRequest = {
    title: "Jobs are still running",
    note: "Closing Perli cancels them. Anything already finished stays.",
    cancelLabel: "Keep working",
    confirmLabel: "Cancel jobs and close",
    confirm: () => cancelJobsAndClose().catch(jobs.report),
  };

  async function onClose(request: number) {
    // A failed save must not keep the window open.
    const [held] = await Promise.all([holdClose(request), flushSession().catch(console.error)]);
    if (held) setDeleting(stopJobs);
    else await getCurrentWindow().destroy();
  }

  // Covers every way to close, including Alt+F4 and the taskbar.
  const closeListener = onCloseAsked(onClose);
  const dragListener = followFileDrag(tabs.allViews, jobs.report, (x, y, items) => setMenu({ x, y, items }), dropNoted);
  // Other apps and Windows' own commands change folders without Perli running a job.
  const folderListener = onFolderChanged((id) => tabs.allViews().find((view) => view.id === id)?.reload());
  const searchListener = onSearchGrew((id, walk) =>
    tabs.allViews().find((view) => view.id === id)?.searchGrew(walk),
  );
  const sizesListener = onSizesGrew((id) => tabs.allViews().find((view) => view.id === id)?.sizesGrew());

  let windowTimer: number | undefined;
  let windowWaiting: string | undefined;

  /**
   * A folder opened from outside Perli gets a tab. Items to select go to the tab that shows their
   * folder already, which is the one opened a moment ago when another app asked to show a file.
   */
  async function openAsked(ask: OpenAsk) {
    if (!ask.folder) return comeForward();
    const folder = ask.folder;
    if (openInWindow()) {
      // "Show in folder" asks twice: for the folder, then for the file to select in it. A window
      // can't be reached once it is open, so the folder waits a moment for its file.
      // ponytail: a file named later than this gets a second window. Windows names it in well
      // under the wait on every machine tried.
      window.clearTimeout(windowTimer);
      const waited = windowWaiting;
      windowWaiting = undefined;
      if (waited && !samePath(waited, folder)) await openWindow(waited, []);
      if (ask.select.length > 0) return openWindow(folder, ask.select);
      windowWaiting = folder;
      windowTimer = window.setTimeout(() => {
        windowWaiting = undefined;
        openWindow(folder, []).catch(console.error);
      }, WINDOW_WAIT_MS);
      return;
    }
    comeForward().catch(console.error);
    setSettingsShown(false);
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
    if (!row.isDir) openFile(path).catch(console.error);
    else if (toSide) tabs.openToSide(path);
    else view.open(path);
  }

  function preview(view: FolderView, at: RowAt) {
    const folder = view.folder();
    if (!folder) return;
    const snapshot = () => view.folder()?.request ?? at.snapshot;
    const count = () => view.folder()?.count ?? folder.count;
    const selected = () => view.folder()?.selected?.[0];
    setPreviewing({ view, at: { view: view.id, snapshot, index: at.index, count, selected, folder: folder.path } });
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
  /** Where files from the shelf can land: a real folder, not the Recycle Bin or a search. */
  const dropFolder = () => {
    const view = tabs.activeView();
    return view.isBin() || view.query() ? undefined : view.folder()?.path;
  };
  /** Says what went wrong, and still lets the caller know that it did. */
  const failed = (failure: unknown) => {
    jobs.report(failure);
    throw failure;
  };
  // The folders seen lately are places to drop on and to move to.
  createEffect(() => noteFolder(tabs.activeView().folder()?.path));
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
    setMenu(undefined);
  }

  async function showCrumbMenu(view: FolderView, path: string, x: number, y: number) {
    if (crumbClosed.path === path && performance.now() - crumbClosed.at < CLICK_MS) return;
    let items: MenuItem[];
    try {
      const names = await subfolders(path, showHidden());
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
    const items = [
      { label: "Open", action: () => view.open(path) },
      { label: "Open to side", action: () => tabs.openToSide(path) },
      ...(isBin(path)
        ? []
        : [
            { label: "Search here", action: () => searchIn(view, path) },
            ...keepItems(path),
            ...shell.placeItems(path, { x: event.clientX, y: event.clientY }),
            ...(isDriveRoot(path) ? networkItems() : []),
            ...(places()?.drives.some((drive) => drive.removable && samePath(drive.path, path))
              ? [{ label: "Eject", divider: true, action: () => quietly(ejectDrive(path)) }]
              : []),
          ]),
    ];
    setMenu({ x: event.clientX, y: event.clientY, items });
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
    if (place === BOOKMARKS) {
      const files = await Promise.all(paths.map(isFile));
      addBookmarks(paths.filter((_, at) => !files[at]));
    } else if (place.startsWith(TAG_DROP)) {
      await setTagPaths(paths, Number(place.slice(TAG_DROP.length)), true);
      showTagChange();
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
    const start = query && query !== FLAT_QUERY ? query.replace(/^tag:/, "") : baseName(folder) || folder;
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
  function showTagged(view: FolderView, tag: Tag) {
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

  /** Shows the file among its neighbours, the way Explorer's Open file location does. */
  async function showInFolder(view: FolderView, path: string) {
    const folder = parentOf(path);
    if (folder && (await view.open(folder))) view.reload([baseName(path)]);
  }

  function showRecentMenu(event: MouseEvent, view: FolderView, recent: Recent) {
    event.preventDefault();
    const open = recent.isDir ? () => view.open(recent.path) : () => openFile(recent.path).catch(jobs.report);
    const items: MenuItem[] = [
      { label: "Open", action: open },
      ...(recent.isDir ? [{ label: "Open to side", action: () => tabs.openToSide(recent.path) }] : []),
      { label: "Show in folder", action: () => showInFolder(view, recent.path) },
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
      if (other.isBin()) continue;
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
        { label: "Delete permanently", action: () => actions.remove(view, true) },
      ];
      return setMenu({ x, y, items });
    }

    const path = rowPath(view, row);
    const [canPaste, toolItems] = await Promise.all([clipboardCanPaste(), shell.fileToolItems(view, row)]);
    const items: MenuItem[] = [
      { label: "Open", action: () => openRow(view, row, false) },
      { label: "Quick preview", action: () => previewSelected(view) },
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
      { label: "New folder with selection", action: () => gather(view) },
      { label: "Put on the shelf", action: () => putOnShelf(view) },
      ...toolItems,
      shell.tagsItem(view, showTagChange, () => setNamingTag(view)),
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

  /** The sync app does the fetching or the freeing in its own time. The rows show the wish at once. */
  function keepHere(view: FolderView, keep: boolean) {
    const selection = actions.selected(view);
    if (selection) quietly(keepOnDevice(selection, keep).then(() => view.reload()));
  }

  function showTagChange() {
    for (const view of tabs.allViews()) if (!view.query() || view.query().startsWith(tagQuery(""))) view.reload();
  }

  function askDeleteTag(tag: Tag) {
    setDeleting({
      title: `Delete the tag ${tag.name}?`,
      note: "It comes off every file that has it. The files stay as they are.",
      confirmLabel: "Delete tag",
      async confirm() {
        await deleteTag(tag.id).catch(jobs.report);
        for (const view of tabs.allViews()) view.forgetTag(tag.id);
        await refreshTags();
        showTagChange();
      },
    });
  }

  function showHeaderMenu(event: MouseEvent) {
    event.preventDefault();
    const items = columns().map((column) => ({
      label: column.label,
      checked: column.visible,
      disabled: column.id === "name",
      action: () => toggleColumn(column.id),
    }));
    setMenu({ x: event.clientX, y: event.clientY, items });
  }

  function showInputMenu(event: MouseEvent) {
    const paste = async () => {
      document.execCommand("insertText", false, await clipboardText());
    };
    const items = [
      { label: "Cut", action: () => document.execCommand("cut") },
      { label: "Copy", action: () => document.execCommand("copy") },
      { label: "Paste", action: () => paste().catch(console.error) },
    ];
    setMenu({ x: event.clientX, y: event.clientY, items });
  }

  function changeOrder(apply: () => void) {
    apply();
    for (const view of tabs.allViews()) view.rearrange();
  }

  const toggleHidden = () => changeOrder(() => setShowHidden(!showHidden()));
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
        ];
    return [
      {
        label: "View",
        divider: true,
        items: [
          layoutItem("List", "list"),
          layoutItem("Grid", "grid"),
          ...(view.layout() === "grid" ? tileItems : rowItems),
          { label: "Windows icons", divider: true, checked: windowsIcons(), action: () => setWindowsIcons(!windowsIcons()) },
          { label: "Details panel", checked: detailsPanel(), action: toggleDetails },
          { label: "Status bar", checked: statusBar(), action: () => setStatusBar(!statusBar()) },
          { label: "Keep sidebar open", checked: sidebarOpen(), action: toggleSidebar },
        ],
      },
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
      ...(own
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
      ...(view.isBin()
        ? []
        : [{ label: "Flat view", checked: view.query() === FLAT_QUERY, action: () => toggleFlat(view) }]),
      ...(own ? [] : [{ label: "Use this view for all folders", action: () => viewForAll(view) }]),
    ];
  }

  async function showBackgroundMenu(event: MouseEvent, view: FolderView) {
    const { clientX: x, clientY: y } = event;
    const undo = [
      { label: "Undo", disabled: jobs.latestStep() === null, action: () => actions.undo(view) },
      { label: "Redo", disabled: !jobs.canRedo(), action: () => actions.redo(view) },
    ];
    const fileItems: MenuItem[] = view.isBin()
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
          shell.newItem(view),
          { label: "Search here", action: () => view.askSearch() },
          { label: "Select by pattern…", action: () => setSelectingPattern(view) },
          { label: "Filter…", action: () => setFiltering(view) },
          ...undo,
          { label: "Activity log", action: () => setActivityOpen(true) },
        ];
    const shellItems = view.isBin() ? [] : shell.backgroundItems(view, { x, y });
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

  const newTab = async () => {
    setSettingsShown(false);
    const path = tabs.activeView().folder()?.path;
    if (path) await tabs.add([path]);
  };

  function splitView() {
    const path = tabs.activeView().folder()?.path;
    if (path && !tabs.active().other()) tabs.openToSide(path);
  }

  // List view has no tiles, so these keys do nothing there.
  function resizeTiles(view: FolderView, change: number) {
    if (view.layout() === "grid") setTileSize(clampTile(tileSize() + change));
  }

  function togglePalette() {
    if (!paletteOpen()) {
      listPlaces().then(setPlaces).catch(console.error);
      paletteFiles(tabs.activeView(), setFoundFiles).catch(console.error);
    }
    setPaletteOpen(!paletteOpen());
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
    if (folder && !view.query()) actions.copyTo(view, folder);
  }

  async function copyPath(view: FolderView) {
    const selection = picked(view);
    if (!selection) return;
    const paths = await selectionPaths(selection);
    await navigator.clipboard.writeText(paths.join("\n"));
    jobs.notify(paths.length === 1 ? "Path copied" : `${paths.length} paths copied`, paths[0]);
  }

  function gather(view: FolderView) {
    const selection = picked(view);
    const folder = view.folder()?.path;
    if (selection && folder && !view.query()) {
      startJob({ kind: "newFolderFrom", selection, folder, moveIn: true }, view.id).catch(jobs.report);
    }
  }

  async function putOnShelf(view: FolderView) {
    const selection = picked(view);
    if (selection) shelve(await selectionPaths(selection));
  }

  function sendTo(view: FolderView, kind: "copy" | "move", folder: string) {
    const selection = picked(view);
    if (selection) startJob({ kind, selection, folder }, view.id).catch(jobs.report);
  }

  /** The selected folders, as paths. Files are left out. */
  async function pickedFolders(view: FolderView) {
    const selection = picked(view);
    if (!selection) return [];
    const paths = (await selectionPaths(selection)).slice(0, MOST_TABS_BEHIND);
    const files = await Promise.all(paths.map((path) => isFile(path)));
    return paths.filter((_, at) => !files[at]);
  }

  /** Each folder gets a tab, in order, and the tab on show stays where it is. */
  async function openTabsBehind(paths: string[]) {
    let after = tabs.active();
    for (const path of paths) {
      await tabs.add([path], after, true);
      after = tabs.tabs()[tabs.tabs().indexOf(after) + 1] ?? after;
    }
  }

  function openBehind(view: FolderView, row: Row) {
    if (row.isDir && !view.isBin()) openTabsBehind([rowPath(view, row)]).catch(jobs.report);
  }

  function terminalHere(view: FolderView, shell?: keyof typeof TERMINALS) {
    const path = view.folder()?.path;
    if (path && !view.isBin()) openTerminal(path, shell).catch(jobs.report);
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
    back: () => here().back(),
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
    list: () => here().setLayout("list"),
    grid: () => here().setLayout("grid"),
    largerTiles: () => resizeTiles(here(), TILE_STEP),
    smallerTiles: () => resizeTiles(here(), -TILE_STEP),
    hidden: toggleHidden,
    filter: () => setFiltering(here()),
    selectPattern: () => setSelectingPattern(here()),
    details: toggleDetails,
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
    split: splitView,
    otherPane: () => tabs.active().activate(tabs.active().other() ?? here()),
    nextTab: () => tabs.cycle(1),
    previousTab: () => tabs.cycle(-1),
    ...numbered("tab", (place) => tabs.activateAt(place - 1)),
    settings: showSettings,
    keys: () => setKeysOpen(true),
  };

  /** What the bar over a selection offers. A menu opens under its own button. */
  function barItems(view: FolderView): BarItem[] {
    const item = (label: string, run: BarItem["run"], id?: string): BarItem => ({
      label,
      icon: iconFor(label) ?? "",
      keys: id && keyText(id).replace("Ctrl", "Control"),
      run,
    });
    const under = (anchor: HTMLElement, items: MenuItem[]) => {
      const box = anchor.getBoundingClientRect();
      setMenu({ x: box.left, y: box.bottom + 4, items });
    };
    if (view.isBin()) {
      return [
        item("Restore", () => actions.restore(view)),
        item("Delete permanently", () => actions.remove(view, true), "deleteForGood"),
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
    const names = await subfolders(parent, showHidden()).catch((): string[] => []);
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
      return { first: true, items: folder ? [{ label: `Open ${TERMINALS[typed.shell]} here`, hint: folder, run }] : [] };
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
    const keyed = KEYS.filter((command) => !command.fixed && !command.quiet && !(view.isBin() && FOLDER_ONLY.has(command.id)));
    const inFolder: Command[] = view.isBin()
      ? []
      : [
          { label: "Compress to ZIP", run: () => actions.compress(view) },
          { label: "Extract here", run: () => actions.extract(view, false) },
          { label: "Extract to own folder", run: () => actions.extract(view, true) },
          { label: "Save as template", run: () => actions.saveTemplate(view) },
          { label: "Open templates folder", run: () => actions.openTemplates(view) },
          { label: "Flat view", run: () => toggleFlat(view) },
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
    window.addEventListener("contextmenu", hideBrowserMenu);
    window.addEventListener("wheel", blockBrowserZoom, { passive: false });
    window.addEventListener("focus", trackWindowFocus);
    window.addEventListener("blur", trackWindowFocus);
    window.addEventListener("focus", checkCut);
    refreshTags();
    startUpdates();
    const start = await startState();
    const session = start.folder ? undefined : parseSession(start.session);
    if (session) {
      tabs.restore(session);
    } else {
      const opened = await tabs.activeView().open(start.folder ?? start.home ?? "");
      if (opened) performance.mark("perli-folder-open", { detail: opened });
      if (opened && start.select.length > 0) await tabs.activeView().reload(start.select);
    }
    setKeepSession(!start.folder);
    // Starts handed over while this window loaded wait in the back end until now.
    await openListener;
    for (const ask of await asksWaiting()) await openAsked(ask).catch(console.error);
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
    window.removeEventListener("contextmenu", hideBrowserMenu);
    window.removeEventListener("wheel", blockBrowserZoom);
    window.removeEventListener("focus", trackWindowFocus);
    window.removeEventListener("blur", trackWindowFocus);
    window.removeEventListener("focus", checkCut);
  });

  const Pane = (props: { tab: Tab; view: FolderView }) => {
    const { tab, view } = props;
    const activate = () => tab.activate(view);
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
          onFilter={() => setFiltering(view)}
          onInputMenu={showInputMenu}
          onCrumbMenu={(path, x, y) => showCrumbMenu(view, path, x, y)}
          menuFor={menu()?.from}
          onNewTab={(path) => tabs.add([path])}
          suggest={(text) => suggest(view, text)}
        />
        <div class="file-area">
          <Show when={view.error()}>
            <p class="message" role="alert">
              {view.error()}
            </p>
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
                selected={view.folder()!.selected}
                reveal={view.folder()!.reveal}
                rename={view.folder()!.rename}
                top={view.folder()!.top}
                thumbs={!view.isBin()}
                columns={ownColumns(view) ?? columns()}
                fixedColumns={ownColumns(view) !== undefined}
                cut={view.query() ? undefined : cutNames(view.folder()!.path)}
                synced={!view.query() && inCloud(view.folder()!.path)}
                empty={emptyState(view)}
                match={view.query() === FLAT_QUERY ? undefined : view.query()}
                active={tab === tabs.active() && view === tab.active()}
                layout={view.layout()}
                sort={view.sort()}
                onSort={(key) => view.setSort(nextSort(view.sort(), key))}
                onDragOut={() => actions.dragOut(view)}
                onOpen={(row, toSide) => openRow(view, row, toSide)}
                onMenu={(event, row) => showRowMenu(event, view, row)}
                onBackgroundMenu={(event) => showBackgroundMenu(event, view)}
                onHeaderMenu={(event) => (ownColumns(view) ? event.preventDefault() : showHeaderMenu(event))}
                onGroup={cycleGrouping}
                onRename={(selection, name) => actions.rename(view, selection, name)}
                onEditEnd={view.editEnded}
                onInputMenu={showInputMenu}
                onFirstPaint={markReady}
                onSwapped={view.swapped}
                onEscape={() => view.search("")}
                onPreview={(at) => preview(view, at)}
                onCursor={view.setCursor}
                onOpenBehind={(row) => openBehind(view, row)}
                barItems={() => barItems(view)}
                connect={view.connectList}
              />
            )}
          </Show>
        </div>
      </section>
    );
  };

  return (
    <div class="shell" data-sidebar={sidebarOpen() ? "open" : "rail"} data-arriving={edgeShown() ? "" : undefined}>
      <TitleBar
        tabs={tabs}
        onNewTab={newTab}
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
          onRecentMenu={(event, recent) => showRecentMenu(event, tabs.activeView(), recent)}
          onSectionMenu={showSectionMenu}
          onTag={(tag) => showTagged(tabs.activeView(), tag)}
          onTagMenu={showTagMenu}
          onSmart={(smart) => quietly(openSmart(tabs.activeView(), smart))}
          onSmartMenu={showSmartMenu}
          onPlaces={setPlaces}
          report={jobs.report}
        />
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
        />
        <For each={tabs.tabs()}>
          {(tab) => (
            <div class="panes" classList={{ "panes-swapped": tab.swapped() }} hidden={tab !== tabs.active() || settingsShown()}>
              <For each={tab.panes()}>{(view) => <Pane tab={tab} view={view} />}</For>
              <Show when={detailsPanel() && tab === tabs.active()}>
                <DetailsPanel view={tab.active()} />
              </Show>
            </div>
          )}
        </For>
        <Settings
          open={settingsOpen()}
          shown={settingsShown()}
          onClose={closeSettings}
          onToggleSizes={toggleSizes}
          onTagsChanged={showTagChange}
          onDeleteTag={askDeleteTag}
          onBeforeUpdate={flushSession}
          onKeys={() => setKeysOpen(true)}
        />
      </main>
      <Show when={menu()} keyed>
        {(open) => <Menu x={open.x} y={open.y} items={open.items} onClose={closeMenu} />}
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
          onUndo={(step) => undoJob(tabs.activeView().id, step).catch(failed)}
          onRedo={() => redoJob(tabs.activeView().id).catch(failed)}
          onClose={() => setActivityOpen(false)}
        />
      </Show>
      <Show when={keysOpen()}>
        <KeySheet onClose={() => setKeysOpen(false)} />
      </Show>
      <Show when={deleting()} keyed>
        {(request) => <ConfirmDelete request={request} onClose={() => setDeleting(undefined)} />}
      </Show>
      <Show when={renaming()} keyed>
        {(request) => <BatchRename request={request} onClose={() => setRenaming(undefined)} />}
      </Show>
      <Show when={filtering()} keyed>
        {(view) => <FilterDialog view={view} onClose={() => setFiltering(undefined)} onSave={() => saveSmart(view)} />}
      </Show>
      <Show when={selectingPattern()} keyed>
        {(view) => <SelectPattern view={view} onClose={() => setSelectingPattern(undefined)} />}
      </Show>
      <Show when={naming()} keyed>
        {(ask) => <NameSheet ask={ask} onClose={() => setNaming(undefined)} />}
      </Show>
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
      <Show when={drives() === "disconnect"}>
        <DisconnectDrive
          onUnmapped={refreshPlaces}
          onWindows={() => disconnectDrive().then(refreshPlaces).catch(jobs.report)}
          onClose={() => setDrives(undefined)}
        />
      </Show>
      <Show when={previewing()} keyed>
        {({ view, at }) => (
          <QuickPreview
            at={at}
            onStep={(index) => view.list()?.select([index])}
            onOpen={(row) => openRow(view, row, false)}
            onClose={closePreview}
          />
        )}
      </Show>
      <Palette
        open={paletteOpen()}
        commands={commands}
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
