import { getCurrentWindow } from "@tauri-apps/api/window";
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
  cancelJobsAndClose,
  clipboardCanPaste,
  clipboardText,
  deleteTag,
  disconnectDrive,
  holdClose,
  listPlaces,
  mapDrive,
  onCloseAsked,
  onFolderChanged,
  onOpenAsked,
  comeForward,
  openWindow,
  onSearchGrew,
  onSizesGrew,
  openFile,
  openTerminal,
  saveSession,
  startState,
  stopSizes,
  subfolders,
  type Grouping,
  type Places,
  type Recent,
  type Row,
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
import { NO_FILTER } from "./features/filelist/filter";
import { BIN_COLUMNS, nextGrouping, nextSort, SEARCH_COLUMNS } from "./features/filelist/columns";
import { FileList } from "./features/filelist/FileList";
import { FilterDialog } from "./features/filelist/FilterDialog";
import { clampTile, isLargestTile, isSmallestTile, TILE_STEP, type Layout } from "./features/filelist/layout";
import {
  columns,
  detailsPanel,
  folderSizes,
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
import { PathBar } from "./features/pathbar/PathBar";
import { DetailsPanel } from "./features/preview/DetailsPanel";
import { QuickPreview, type PreviewAt } from "./features/preview/QuickPreview";
import { Settings } from "./features/settings/Settings";
import { startUpdates, updateState } from "./features/settings/updates";
import { BookmarksBar } from "./features/sidebar/BookmarksBar";
import { holds } from "./features/sidebar/placeLists";
import {
  bookmarks,
  bookmarksBar,
  hiddenSections,
  lookOf,
  movePinned,
  pinned,
  SECTIONS,
  setBookmarksBar,
  setLook,
  toggleBookmark,
  togglePinned,
  toggleSection,
} from "./features/sidebar/saved";
import { FOLDERS, Sidebar } from "./features/sidebar/Sidebar";
import { parseSession } from "./features/tabs/session";
import { createTabs, type Tab } from "./features/tabs/tabs";
import { NewTag } from "./features/tags/NewTag";
import { refreshTags, TAG_COLORS } from "./features/tags/tags";
import { TitleBar } from "./features/titlebar/TitleBar";
import { Menu, type MenuItem } from "./ui/Menu";
import { Tooltip } from "./ui/Tooltip";

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

const isTyping = (event: Event) => event.target instanceof HTMLInputElement;
// A job's Delete key must only ever mean the files, never a focused button.
const isInList = (event: Event) => (event.target as HTMLElement).classList?.contains("file-grid");
const hideBrowserMenu = (event: MouseEvent) => event.preventDefault();
/** A menu longer than this would only be scrolled past. */
const MOST_CRUMB_FOLDERS = 300;
/** Longer than any press and release of one click. */
const CLICK_MS = 400;
const blockBrowserZoom = (event: WheelEvent) => event.ctrlKey && event.preventDefault();
const trackWindowFocus = (event: FocusEvent) =>
  document.documentElement.toggleAttribute("data-blurred", event.type === "blur");
/** The columns a view keeps to itself, which the user can't change. */
const ownColumns = (view: FolderView) => (view.isBin() ? BIN_COLUMNS : view.query() ? SEARCH_COLUMNS : undefined);
const rowPath = (view: FolderView, row: Row) => join(row.location || view.folder()!.path, row.name);
const emptyText = (view: FolderView) => {
  if (view.searching()) return "Searching…";
  if (view.filtered()) return "Nothing fits the filter.";
  if (view.isBin()) return "The Recycle Bin is empty.";
  return view.query() ? "No matches." : "This folder is empty.";
};
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
    lookItem(path),
  ];
}

// The main layout. Moving parts of the app around should only change this file.
export function App() {
  const tabs = createTabs();
  /** `from` is the path crumb whose menu this is. */
  const [menu, setMenu] = createSignal<{ x: number; y: number; items: MenuItem[]; from?: string }>();
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [paletteOpen, setPaletteOpen] = createSignal(false);
  const [places, setPlaces] = createSignal<Places>();
  const [deleting, setDeleting] = createSignal<DeleteRequest>();
  const [renaming, setRenaming] = createSignal<RenameRequest>();
  const [filtering, setFiltering] = createSignal<FolderView>();
  const [selectingPattern, setSelectingPattern] = createSignal<FolderView>();
  const [namingTag, setNamingTag] = createSignal<FolderView>();
  const [previewing, setPreviewing] = createSignal<{ view: FolderView; at: PreviewAt }>();
  /** The dialog covers the tabs, so nothing behind it may change. */
  const dialogOpen = () =>
    settingsOpen() ||
    !!deleting() ||
    !!renaming() ||
    !!filtering() ||
    !!selectingPattern() ||
    !!namingTag() ||
    !!previewing();
  const jobs = createJobs(tabs.allViews);
  const actions = createFileActions(jobs, setDeleting, () => tabs.active().other(), setRenaming);
  const shell = createShellItems(jobs, actions);
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
  const dragListener = followFileDrag(tabs.allViews, jobs.report, (x, y, items) => setMenu({ x, y, items }));
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
    const shown = ask.select.length > 0 && tabs.tabs().find((tab) => samePath(tab.active().folder()?.path, folder));
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

  const networkItems = (): MenuItem[] => [
    { label: "Map network drive", divider: true, action: () => mapDrive().catch(jobs.report) },
    { label: "Disconnect network drive", action: () => disconnectDrive().catch(jobs.report) },
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
          ]),
    ];
    setMenu({ x: event.clientX, y: event.clientY, items });
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
      row.isDir
        ? { label: "Open to side", action: () => openRow(view, row, true) }
        : shell.openWithItem(view),
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
      ...toolItems,
      shell.tagsItem(view, showTagChange, () => setNamingTag(view)),
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
  function showTagChange() {
    for (const view of tabs.allViews()) if (!view.query()) view.reload();
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
          ...(view.layout() === "grid" ? tileItems : []),
          { label: "Details panel", divider: true, checked: detailsPanel(), action: toggleDetails },
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
        ];
    const shellItems = view.isBin() ? [] : shell.backgroundItems(view, { x, y });
    setMenu({ x, y, items: [...fileItems, ...viewItems(view), ...shellItems] });
  }

  const newTab = async () => {
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
    if (!paletteOpen()) listPlaces().then(setPlaces).catch(console.error);
    setPaletteOpen(!paletteOpen());
  }

  /** What only makes sense on a real folder. The Recycle Bin has its own rules. */
  function folderCommands(view: FolderView): Command[] {
    const terminal = () => {
      const path = view.folder()?.path;
      if (path) openTerminal(path).catch(jobs.report);
    };
    return [
      { label: "New folder", keys: "Ctrl+Shift+N", run: () => actions.newItem(view, true) },
      { label: "New file", keys: "Ctrl+N", run: () => actions.newItem(view, false) },
      { label: "Paste", keys: "Ctrl+V", run: () => actions.paste(view) },
      { label: "Copy", keys: "Ctrl+C", run: () => actions.copy(view) },
      { label: "Cut", keys: "Ctrl+X", run: () => actions.cut(view) },
      { label: "Rename", keys: "F2", run: () => actions.startRename(view) },
      { label: "Properties", keys: "Alt+Enter", run: () => shell.properties(view) },
      { label: "Compress to ZIP", run: () => actions.compress(view) },
      { label: "Extract here", run: () => actions.extract(view, false) },
      { label: "Extract to own folder", run: () => actions.extract(view, true) },
      { label: "Save as template", run: () => actions.saveTemplate(view) },
      { label: "Open templates folder", run: () => actions.openTemplates(view) },
      { label: "Open in terminal", run: terminal },
      { label: "Flat view", run: () => toggleFlat(view) },
      { label: "Use this view for all folders", run: () => viewForAll(view) },
      ...keepCommands(view),
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

  function commands(): Command[] {
    const view = tabs.activeView();
    const tab = tabs.active();
    const goTo = (label: string, path: string): Command => ({
      label: `Go to ${label}`,
      run: () => view.open(path),
    });
    const known = places();
    return [
      { label: "Search", keys: "Ctrl+F", run: () => view.askSearch() },
      { label: "Go to path", keys: "Ctrl+L", run: () => view.setEditingPath(true) },
      { label: "New tab", keys: "Ctrl+T", run: newTab },
      { label: "Close", keys: "Ctrl+W", run: () => tabs.closePane(tab, view) },
      { label: "Reopen closed tab", keys: "Ctrl+Shift+T", run: () => tabs.reopenClosed() },
      { label: "Split view", keys: "Ctrl+\\", run: splitView },
      { label: "Refresh", keys: "F5", run: () => view.refresh() },
      { label: "Back", keys: "Alt+Left", run: () => view.back() },
      { label: "Forward", keys: "Alt+Right", run: () => view.forward() },
      { label: "Up", keys: "Alt+Up", run: () => view.up() },
      { label: "Show hidden files", keys: "Ctrl+H", run: toggleHidden },
      { label: "List view", keys: "Ctrl+Shift+1", run: () => view.setLayout("list") },
      { label: "Grid view", keys: "Ctrl+Shift+2", run: () => view.setLayout("grid") },
      { label: "Quick preview", keys: "Space", run: () => previewSelected(view) },
      { label: "Details panel", keys: "Alt+Shift+P", run: toggleDetails },
      { label: "Select by pattern", keys: "Ctrl+Shift+A", run: () => setSelectingPattern(view) },
      { label: "Filter", keys: "Ctrl+Shift+F", run: () => setFiltering(view) },
      ...(view.filtered() ? [{ label: "Clear filter", run: () => view.setFilterForm(NO_FILTER) }] : []),
      ...(view.isBin() ? [] : folderCommands(view)),
      { label: "Undo", keys: "Ctrl+Z", run: () => actions.undo(view) },
      { label: "Redo", keys: "Ctrl+Y", run: () => actions.redo(view) },
      { label: "Delete", keys: "Delete", run: () => actions.remove(view, false) },
      { label: "Settings", keys: "Ctrl+,", run: () => setSettingsOpen(true) },
      { label: "Map network drive", run: () => mapDrive().catch(jobs.report) },
      { label: "Disconnect network drive", run: () => disconnectDrive().catch(jobs.report) },
      goTo("Recycle Bin", BIN_PATH),
      ...(known?.folders ?? []).map(({ kind, path }) => goTo(FOLDERS[kind].label, path)),
      ...(known?.clouds ?? []).map(({ name, path }) => goTo(name, path)),
      ...(known?.drives ?? []).map(({ name, path }) => goTo(name, path)),
      ...[...pinned(), ...bookmarks()].map((path) => goTo(baseName(path) || path, path)),
    ];
  }

  /** Holding a key down must not paste or delete again and again. */
  function onFileKey(event: KeyboardEvent, view: FolderView, key: string) {
    if (!isInList(event)) return false;
    const { ctrlKey: ctrl, shiftKey: shift } = event;
    const run = (action: () => void) => {
      if (!event.repeat) action();
      return true;
    };
    if (event.altKey) return key === "enter" && run(() => shell.properties(view));
    if (ctrl && key === "c") return run(() => actions.copy(view));
    if (ctrl && key === "x") return run(() => actions.cut(view));
    if (ctrl && key === "v") return run(() => actions.paste(view));
    if (ctrl && key === "z") return run(() => actions.undo(view));
    if (ctrl && key === "y") return run(() => actions.redo(view));
    if (ctrl && key === "n") return run(() => actions.newItem(view, shift));
    if (key === "delete") return run(() => actions.remove(view, shift));
    if (key === "f2") return run(() => actions.startRename(view));
    if (key === "f7") return run(() => actions.toOtherPane(view, "copy"));
    if (key === "f8") return run(() => actions.toOtherPane(view, "move"));
    return false;
  }

  function onKeyDown(event: KeyboardEvent) {
    const view = tabs.activeView();
    const tab = tabs.active();
    const key = event.key.toLowerCase();
    // Shift changes what a digit key reports, so read which key it is.
    const digit = Number(event.code.match(/^Digit([1-9])$/)?.[1]);

    // Left alone, this key prints the page.
    if (event.ctrlKey && key === "p") {
      event.preventDefault();
      if (!dialogOpen()) togglePalette();
      return;
    }

    if (dialogOpen() || paletteOpen()) {
      if (isBrowserKey(event, key)) event.preventDefault();
      return;
    }

    if (key === "escape" && !isTyping(event)) takeBackCut();
    if (onFileKey(event, view, key)) event.preventDefault();
    else if (event.altKey && key === "arrowleft") view.back();
    else if (event.altKey && key === "arrowright") view.forward();
    else if (event.altKey && key === "arrowup") view.up();
    else if (event.altKey && event.shiftKey && key === "p") toggleDetails();
    else if (key === "backspace" && !isTyping(event)) view.up();
    else if ((event.ctrlKey && key === "l") || (event.altKey && key === "d")) view.setEditingPath(true);
    else if (event.ctrlKey && event.shiftKey && key === "f") setFiltering(view);
    else if (event.ctrlKey && event.shiftKey && key === "a") setSelectingPattern(view);
    else if (event.ctrlKey && key === "f") view.askSearch();
    else if (event.ctrlKey && event.shiftKey && key === "t") tabs.reopenClosed();
    else if (event.ctrlKey && key === "t") newTab();
    else if (event.ctrlKey && key === "w") tabs.closePane(tab, view);
    else if (event.ctrlKey && key === "\\") splitView();
    else if (key === "f6") tab.activate(tab.other() ?? view);
    else if (key === "f5") view.refresh();
    else if (event.ctrlKey && key === "tab") tabs.cycle(event.shiftKey ? -1 : 1);
    else if (event.ctrlKey && key === "pagedown") tabs.cycle(1);
    else if (event.ctrlKey && key === "pageup") tabs.cycle(-1);
    else if (event.ctrlKey && event.shiftKey && digit === 1) view.setLayout("list");
    else if (event.ctrlKey && event.shiftKey && digit === 2) view.setLayout("grid");
    else if (event.ctrlKey && !event.shiftKey && digit) tabs.activateAt(digit - 1);
    else if (event.ctrlKey && key === "h") toggleHidden();
    else if (event.ctrlKey && key === ",") setSettingsOpen(true);
    else if (event.ctrlKey && (key === "+" || key === "=")) resizeTiles(view, TILE_STEP);
    else if (event.ctrlKey && key === "-") resizeTiles(view, -TILE_STEP);
    else if (key === "backspace" || !isBrowserKey(event, key)) return;
    event.preventDefault();
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
                emptyText={emptyText(view)}
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
                connect={view.connectList}
              />
            )}
          </Show>
        </div>
      </section>
    );
  };

  return (
    <div class="shell">
      <TitleBar tabs={tabs} onNewTab={newTab} />
      <aside class="sidebar">
        <span class="logo">Perli</span>
        <Sidebar
          view={tabs.activeView()}
          onMenu={(event, path) => showFolderMenu(event, tabs.activeView(), path)}
          onRecentMenu={(event, recent) => showRecentMenu(event, tabs.activeView(), recent)}
          onSectionMenu={showSectionMenu}
        />
        <button
          class="settings-button"
          aria-label={updateState() === "ready" ? "Settings, update ready" : "Settings"}
          aria-keyshortcuts="Control+,"
          onClick={() => setSettingsOpen(true)}
        >
          <span class="settings-icon" aria-hidden="true">
            {ICON_SETTINGS}
          </span>
          Settings
          <Show when={updateState() === "ready"}>
            <span class="update-dot" aria-hidden="true" />
          </Show>
        </button>
      </aside>
      <main class="files">
        <BookmarksBar
          view={tabs.activeView()}
          onNewTab={(path) => tabs.add([path])}
          onMenu={(event, path) => showFolderMenu(event, tabs.activeView(), path)}
        />
        <For each={tabs.tabs()}>
          {(tab) => (
            <div class="panes" classList={{ "panes-swapped": tab.swapped() }} hidden={tab !== tabs.active()}>
              <For each={tab.panes()}>{(view) => <Pane tab={tab} view={view} />}</For>
              <Show when={detailsPanel() && tab === tabs.active()}>
                <DetailsPanel view={tab.active()} />
              </Show>
            </div>
          )}
        </For>
      </main>
      <Show when={menu()} keyed>
        {(open) => <Menu x={open.x} y={open.y} items={open.items} onClose={closeMenu} />}
      </Show>
      <JobsPanel jobs={jobs} />
      <Show when={deleting()} keyed>
        {(request) => <ConfirmDelete request={request} onClose={() => setDeleting(undefined)} />}
      </Show>
      <Show when={renaming()} keyed>
        {(request) => <BatchRename request={request} onClose={() => setRenaming(undefined)} />}
      </Show>
      <Show when={filtering()} keyed>
        {(view) => <FilterDialog view={view} onClose={() => setFiltering(undefined)} />}
      </Show>
      <Show when={selectingPattern()} keyed>
        {(view) => <SelectPattern view={view} onClose={() => setSelectingPattern(undefined)} />}
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
      <Settings
        open={settingsOpen()}
        onClose={() => setSettingsOpen(false)}
        onToggleSizes={toggleSizes}
        onTagsChanged={showTagChange}
        onDeleteTag={askDeleteTag}
        onBeforeUpdate={flushSession}
      />
      <Tooltip />
    </div>
  );
}
