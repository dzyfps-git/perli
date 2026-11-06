import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { openFile, startFolder, type Row } from "./api";
import { FileList } from "./features/filelist/FileList";
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
    else if (key === "backspace") view.up();
    else if (event.ctrlKey && event.shiftKey && key === "t") tabs.reopenClosed();
    else if (event.ctrlKey && key === "t") newTab();
    else if (event.ctrlKey && key === "w") tabs.closePane(tab, view);
    else if (event.ctrlKey && key === "\\") splitView();
    else if (key === "f6") tab.activate(tab.other() ?? view);
    else if (event.ctrlKey && key === "tab") tabs.cycle(event.shiftKey ? -1 : 1);
    else return;
    event.preventDefault();
  }

  onMount(async () => {
    window.addEventListener("keydown", onKeyDown);
    const opened = await tabs.activeView().open(await startFolder());
    if (opened) performance.mark("perli-folder-open", { detail: opened });
  });
  onCleanup(() => window.removeEventListener("keydown", onKeyDown));

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
        <PathBar view={view} />
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
                active={tab === tabs.active() && view === tab.active()}
                onOpen={(row, toSide) => openRow(view, row, toSide)}
                onMenu={(event, row) => row.isDir && showFolderMenu(event, view, join(opened.path, row.name))}
                onFirstPaint={markReady}
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
