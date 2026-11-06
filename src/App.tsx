import { getCurrentWindow } from "@tauri-apps/api/window";
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
  clipboardHasFiles,
  clipboardText,
  openFile,
  saveSession,
  startState,
  type Grouping,
  type Row,
  type SortKey,
} from "./api";
import { createFileActions } from "./features/fileops/actions";
import { checkCut, cutNames, takeBackCut } from "./features/fileops/clipboard";
import { ConfirmDelete, type DeleteRequest } from "./features/fileops/ConfirmDelete";
import { createJobs } from "./features/fileops/jobs";
import { JobsPanel } from "./features/fileops/JobsPanel";
import { BIN_COLUMNS, nextGrouping, nextSort } from "./features/filelist/columns";
import { FileList } from "./features/filelist/FileList";
import { clampTile, isLargestTile, isSmallestTile, TILE_STEP, type Layout } from "./features/filelist/layout";
import {
  columns,
  grouping,
  setGrouping,
  setShowHidden,
  setTileSize,
  showHidden,
  tileSize,
  toggleColumn,
} from "./features/filelist/prefs";
import type { FolderView } from "./features/navigation/folderView";
import { join } from "./features/navigation/path";
import { Palette } from "./features/palette/Palette";
import { PathBar } from "./features/pathbar/PathBar";
import { Settings } from "./features/settings/Settings";
import { Sidebar } from "./features/sidebar/Sidebar";
import { parseSession } from "./features/tabs/session";
import { createTabs, type Tab } from "./features/tabs/tabs";
import { TitleBar } from "./features/titlebar/TitleBar";
import { Menu, type MenuItem } from "./ui/Menu";
import { Tooltip } from "./ui/Tooltip";

const SAVE_DELAY_MS = 300;
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
const blockBrowserZoom = (event: WheelEvent) => event.ctrlKey && event.preventDefault();
const trackWindowFocus = (event: FocusEvent) =>
  document.documentElement.toggleAttribute("data-blurred", event.type === "blur");

// The main layout. Moving parts of the app around should only change this file.
export function App() {
  const tabs = createTabs();
  const [menu, setMenu] = createSignal<{ x: number; y: number; items: MenuItem[] }>();
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [deleting, setDeleting] = createSignal<DeleteRequest>();
  const jobs = createJobs(tabs.allViews);
  const actions = createFileActions(jobs, setDeleting, () => tabs.active().other());
  // A run started on one folder is a detour, so it must not replace the saved tabs.
  const [keepSession, setKeepSession] = createSignal(false);
  let saveTimer: number | undefined;
  let unsaved: unknown;
  let saving = Promise.resolve();

  /** Writes one at a time, so an older save can never land after a newer one. */
  function flushSession() {
    window.clearTimeout(saveTimer);
    if (unsaved === undefined) return saving;
    const text = JSON.stringify(unsaved);
    unsaved = undefined;
    saving = saving.then(() => saveSession(text)).catch(console.error);
    return saving;
  }

  createEffect(() => {
    const session = keepSession() ? tabs.session() : undefined;
    if (!session) return;
    unsaved = session;
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(flushSession, SAVE_DELAY_MS);
  });

  // Covers every way to close, including Alt+F4 and the taskbar.
  const closeListener = getCurrentWindow().onCloseRequested(flushSession);

  function openRow(view: FolderView, row: Row, toSide: boolean) {
    if (view.isBin()) return;
    const path = join(view.folder()!.path, row.name);
    if (!row.isDir) openFile(path).catch(console.error);
    else if (toSide) tabs.openToSide(path);
    else view.open(path);
  }

  function showFolderMenu(event: MouseEvent, view: FolderView, path: string) {
    event.preventDefault();
    const items = [
      { label: "Open", action: () => view.open(path) },
      { label: "Open to side", action: () => tabs.openToSide(path) },
    ];
    setMenu({ x: event.clientX, y: event.clientY, items });
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

    const path = join(view.folder()!.path, row.name);
    const single = view.list()?.selection().rows.length === 1;
    const canPaste = await clipboardHasFiles();
    const items: MenuItem[] = [
      { label: "Open", action: () => openRow(view, row, false) },
      ...(row.isDir ? [{ label: "Open to side", action: () => openRow(view, row, true) }] : []),
      { label: "Cut", divider: true, action: () => actions.cut(view) },
      { label: "Copy", action: () => actions.copy(view) },
      {
        label: "Paste",
        disabled: !canPaste,
        action: () => actions.paste(view, row.isDir ? path : undefined),
      },
      { label: "Rename", disabled: !single, action: () => actions.startRename(view) },
      { label: "Delete", action: () => actions.remove(view, false) },
    ];
    if (tabs.active().other()) {
      items.push(
        { label: "Copy to other pane", divider: true, action: () => actions.toOtherPane(view, "copy") },
        { label: "Move to other pane", action: () => actions.toOtherPane(view, "move") },
      );
    }
    setMenu({ x, y, items });
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
    const sortItem = (label: string, key: SortKey) => ({
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
    const sortItems = view.isBin()
      ? BIN_COLUMNS.map((column) => sortItem(column.label, column.id))
      : [
          sortItem("Name", "name"),
          sortItem("Date modified", "modified"),
          sortItem("Date created", "created"),
          sortItem("Type", "type"),
          sortItem("Size", "size"),
        ];
    return [
      {
        label: "View",
        divider: true,
        items: [
          layoutItem("List", "list"),
          layoutItem("Grid", "grid"),
          ...(view.layout() === "grid" ? tileItems : []),
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
      ...(view.isBin()
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
    ];
  }

  async function showBackgroundMenu(event: MouseEvent, view: FolderView) {
    const { clientX: x, clientY: y } = event;
    const undo = { label: "Undo", disabled: jobs.undoSteps() === 0, action: () => actions.undo(view) };
    const fileItems: MenuItem[] = view.isBin()
      ? [
          {
            label: "Empty Recycle Bin",
            disabled: view.folder()?.count === 0,
            action: () => actions.empty(view),
          },
          undo,
        ]
      : [
          { label: "Paste", disabled: !(await clipboardHasFiles()), action: () => actions.paste(view) },
          { label: "New folder", action: () => actions.newItem(view, true) },
          { label: "New file", action: () => actions.newItem(view, false) },
          undo,
        ];
    setMenu({ x, y, items: [...fileItems, ...viewItems(view)] });
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

  /** Holding a key down must not paste or delete again and again. */
  function onFileKey(event: KeyboardEvent, view: FolderView, key: string) {
    if (!isInList(event) || event.altKey) return false;
    const { ctrlKey: ctrl, shiftKey: shift } = event;
    const run = (action: () => void) => {
      if (!event.repeat) action();
      return true;
    };
    if (ctrl && key === "c") return run(() => actions.copy(view));
    if (ctrl && key === "x") return run(() => actions.cut(view));
    if (ctrl && key === "v") return run(() => actions.paste(view));
    if (ctrl && key === "z") return run(() => actions.undo(view));
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

    if (settingsOpen() || deleting()) {
      // The dialog covers the tabs, so nothing behind it may change.
      if (isBrowserKey(event, key)) event.preventDefault();
      return;
    }

    if (key === "escape" && !isTyping(event)) takeBackCut();
    if (onFileKey(event, view, key)) event.preventDefault();
    else if (event.altKey && key === "arrowleft") view.back();
    else if (event.altKey && key === "arrowright") view.forward();
    else if (event.altKey && key === "arrowup") view.up();
    else if (key === "backspace" && !isTyping(event)) view.up();
    else if ((event.ctrlKey && key === "l") || (event.altKey && key === "d")) view.setEditingPath(true);
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
    const start = await startState();
    const session = start.folder ? undefined : parseSession(start.session);
    if (session) {
      tabs.restore(session);
    } else {
      const opened = await tabs.activeView().open(start.folder ?? start.home ?? "");
      if (opened) performance.mark("perli-folder-open", { detail: opened });
    }
    setKeepSession(!start.folder);
  });
  onCleanup(() => {
    window.clearTimeout(saveTimer);
    closeListener.then((stop) => stop());
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
        classList={{ "pane-active": tab.panes().length > 1 && view === tab.active() }}
        onPointerDown={activate}
        onFocusIn={activate}
      >
        <PathBar
          view={view}
          onToggleHidden={toggleHidden}
          onInputMenu={showInputMenu}
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
                snapshot={view.folder()!.request}
                rearranged={view.folder()!.rearranged}
                count={view.folder()!.count}
                selected={view.folder()!.selected}
                reveal={view.folder()!.reveal}
                rename={view.folder()!.rename}
                columns={view.isBin() ? BIN_COLUMNS : columns()}
                fixedColumns={view.isBin()}
                cut={cutNames(view.folder()!.path)}
                emptyText={view.isBin() ? "The Recycle Bin is empty." : "This folder is empty."}
                active={tab === tabs.active() && view === tab.active()}
                layout={view.layout()}
                sort={view.sort()}
                onSort={(key) => view.setSort(nextSort(view.sort(), key))}
                onOpen={(row, toSide) => openRow(view, row, toSide)}
                onMenu={(event, row) => showRowMenu(event, view, row)}
                onBackgroundMenu={(event) => showBackgroundMenu(event, view)}
                onHeaderMenu={(event) => (view.isBin() ? event.preventDefault() : showHeaderMenu(event))}
                onGroup={cycleGrouping}
                onRename={(selection, name) => actions.rename(view, selection, name)}
                onEditEnd={view.editEnded}
                onInputMenu={showInputMenu}
                onFirstPaint={markReady}
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
        />
        <button class="settings-button" onClick={() => setSettingsOpen(true)}>
          <span class="settings-icon" aria-hidden="true">
            {ICON_SETTINGS}
          </span>
          Settings
        </button>
      </aside>
      <main class="files">
        <For each={tabs.tabs()}>
          {(tab) => (
            <div class="panes" classList={{ "panes-swapped": tab.swapped() }} hidden={tab !== tabs.active()}>
              <For each={tab.panes()}>{(view) => <Pane tab={tab} view={view} />}</For>
            </div>
          )}
        </For>
      </main>
      <Show when={menu()} keyed>
        {(open) => <Menu x={open.x} y={open.y} items={open.items} onClose={() => setMenu(undefined)} />}
      </Show>
      <JobsPanel jobs={jobs} />
      <Show when={deleting()} keyed>
        {(request) => <ConfirmDelete request={request} onClose={() => setDeleting(undefined)} />}
      </Show>
      <Palette />
      <Settings open={settingsOpen()} onClose={() => setSettingsOpen(false)} />
      <Tooltip />
    </div>
  );
}
