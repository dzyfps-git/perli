import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { clipboardText, openFile, startFolder, type Row, type SortKey } from "./api";
import { nextSort } from "./features/filelist/columns";
import { FileList } from "./features/filelist/FileList";
import { clampTile, isLargestTile, isSmallestTile, TILE_STEP, type Layout } from "./features/filelist/layout";
import {
  columns,
  filesFirst,
  setFilesFirst,
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
import { Sidebar } from "./features/sidebar/Sidebar";
import { createTabs, type Tab } from "./features/tabs/tabs";
import { TitleBar } from "./features/titlebar/TitleBar";
import { Menu, type MenuItem } from "./ui/Menu";

// Waits for the frame after the rows are drawn, so this means the user can see them.
function markReady() {
  requestAnimationFrame(() => requestAnimationFrame(() => performance.mark("perli-ready")));
}

// WebView2's find bar, reload and save dialog would break the app's look, so these keys do nothing.
function isBrowserKey(event: KeyboardEvent, key: string) {
  const ctrlKeys = ["f", "g", "r", "s", "+", "=", "-", "0"];
  return ["f3", "f5", "f7"].includes(key) || (event.ctrlKey && ctrlKeys.includes(key));
}

const isTyping = (event: Event) => event.target instanceof HTMLInputElement;
const hideBrowserMenu = (event: MouseEvent) => event.preventDefault();
const blockBrowserZoom = (event: WheelEvent) => event.ctrlKey && event.preventDefault();
const trackWindowFocus = (event: FocusEvent) =>
  document.documentElement.toggleAttribute("data-blurred", event.type === "blur");

// The main layout. Moving parts of the app around should only change this file.
export function App() {
  const tabs = createTabs();
  const [menu, setMenu] = createSignal<{ x: number; y: number; items: MenuItem[] }>();

  function openRow(view: FolderView, row: Row, toSide: boolean) {
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

  function showViewMenu(view: FolderView, x: number, y: number) {
    const layoutItem = (label: string, layout: Layout) => ({
      label,
      checked: view.layout() === layout,
      action: () => view.setLayout(layout),
    });
    const sortItem = (label: string, key: SortKey, divider = false) => ({
      label,
      divider,
      checked: view.sort().key === key,
      action: () => view.setSort(nextSort(view.sort(), key)),
    });
    const tileItems = [
      {
        label: "Larger tiles",
        disabled: isLargestTile(tileSize()),
        action: () => setTileSize(clampTile(tileSize() + TILE_STEP)),
      },
      {
        label: "Smaller tiles",
        disabled: isSmallestTile(tileSize()),
        action: () => setTileSize(clampTile(tileSize() - TILE_STEP)),
      },
    ];
    const items: MenuItem[] = [
      layoutItem("List", "list"),
      layoutItem("Grid", "grid"),
      ...(view.layout() === "grid" ? tileItems : []),
      sortItem("Sort by name", "name", true),
      sortItem("Sort by date modified", "modified"),
      sortItem("Sort by date created", "created"),
      sortItem("Sort by type", "type"),
      sortItem("Sort by size", "size"),
      {
        label: "Descending",
        checked: view.sort().descending,
        action: () => view.setSort({ ...view.sort(), descending: !view.sort().descending }),
      },
      {
        label: "Files first",
        divider: true,
        checked: filesFirst(),
        action: () => changeOrder(() => setFilesFirst(!filesFirst())),
      },
      {
        label: "Show hidden files",
        checked: showHidden(),
        action: () => changeOrder(() => setShowHidden(!showHidden())),
      },
    ];
    setMenu({ x, y, items });
  }

  const newTab = async () => {
    const path = tabs.activeView().folder()?.path;
    if (path) await tabs.add([path]);
  };

  function splitView() {
    const path = tabs.activeView().folder()?.path;
    if (path && !tabs.active().other()) tabs.openToSide(path);
  }

  function onKeyDown(event: KeyboardEvent) {
    const view = tabs.activeView();
    const tab = tabs.active();
    const key = event.key.toLowerCase();

    if (event.altKey && key === "arrowleft") view.back();
    else if (event.altKey && key === "arrowright") view.forward();
    else if (event.altKey && key === "arrowup") view.up();
    else if (key === "backspace" && !isTyping(event)) view.up();
    else if ((event.ctrlKey && key === "l") || (event.altKey && key === "d")) view.setEditingPath(true);
    else if (event.ctrlKey && event.shiftKey && key === "t") tabs.reopenClosed();
    else if (event.ctrlKey && key === "t") newTab();
    else if (event.ctrlKey && key === "w") tabs.closePane(tab, view);
    else if (event.ctrlKey && key === "\\") splitView();
    else if (key === "f6") tab.activate(tab.other() ?? view);
    else if (event.ctrlKey && key === "tab") tabs.cycle(event.shiftKey ? -1 : 1);
    else if (key === "backspace" || !isBrowserKey(event, key)) return;
    event.preventDefault();
  }

  onMount(async () => {
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("contextmenu", hideBrowserMenu);
    window.addEventListener("wheel", blockBrowserZoom, { passive: false });
    window.addEventListener("focus", trackWindowFocus);
    window.addEventListener("blur", trackWindowFocus);
    const opened = await tabs.activeView().open(await startFolder());
    if (opened) performance.mark("perli-folder-open", { detail: opened });
  });
  onCleanup(() => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("contextmenu", hideBrowserMenu);
    window.removeEventListener("wheel", blockBrowserZoom);
    window.removeEventListener("focus", trackWindowFocus);
    window.removeEventListener("blur", trackWindowFocus);
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
          onOptions={(x, y) => showViewMenu(view, x, y)}
          onInputMenu={showInputMenu}
        />
        <div class="file-area">
          <Show when={view.error()}>
            <p class="message" role="alert">
              {view.error()}
            </p>
          </Show>
          <Show when={view.folder()} keyed>
            {(opened) => (
              <FileList
                view={view.id}
                snapshot={opened.request}
                count={opened.count}
                selected={opened.selected}
                active={tab === tabs.active() && view === tab.active()}
                layout={view.layout()}
                sort={view.sort()}
                onSort={(key) => view.setSort(nextSort(view.sort(), key))}
                onOpen={(row, toSide) => openRow(view, row, toSide)}
                onMenu={(event, row) => row.isDir && showFolderMenu(event, view, join(opened.path, row.name))}
                onBackgroundMenu={(event) => showViewMenu(view, event.clientX, event.clientY)}
                onHeaderMenu={showHeaderMenu}
                onFirstPaint={markReady}
                shareSelection={view.readSelectionFrom}
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
      <Palette />
    </div>
  );
}
