import { For, onCleanup, onMount, Show } from "solid-js";
import { openFile, startFolder, type Row } from "./api";
import { FileList } from "./features/filelist/FileList";
import type { FolderView } from "./features/navigation/folderView";
import { join } from "./features/navigation/path";
import { Palette } from "./features/palette/Palette";
import { PathBar } from "./features/pathbar/PathBar";
import { Sidebar } from "./features/sidebar/Sidebar";
import { createTabs } from "./features/tabs/tabs";
import { TitleBar } from "./features/titlebar/TitleBar";

// Waits for the frame after the rows are drawn, so this means the user can see them.
function markReady() {
  requestAnimationFrame(() => requestAnimationFrame(() => performance.mark("perli-ready")));
}

// The main layout. Moving parts of the app around should only change this file.
export function App() {
  const tabs = createTabs();

  function openRow(view: FolderView, row: Row) {
    const path = join(view.folder()!.path, row.name);
    if (row.isDir) view.open(path);
    else openFile(path).catch(console.error);
  }

  const newTab = async () => {
    const path = tabs.active().folder()?.path;
    if (path) await tabs.add(path);
  };

  function onKeyDown(event: KeyboardEvent) {
    const view = tabs.active();
    const key = event.key.toLowerCase();

    if (event.altKey && key === "arrowleft") view.back();
    else if (event.altKey && key === "arrowright") view.forward();
    else if (event.altKey && key === "arrowup") view.up();
    else if (key === "backspace") view.up();
    else if (event.ctrlKey && event.shiftKey && key === "t") tabs.reopenClosed();
    else if (event.ctrlKey && key === "t") newTab();
    else if (event.ctrlKey && key === "w") tabs.close(view);
    else if (event.ctrlKey && key === "tab") tabs.cycle(event.shiftKey ? -1 : 1);
    else return;
    event.preventDefault();
  }

  onMount(async () => {
    window.addEventListener("keydown", onKeyDown);
    const opened = await tabs.active().open(await startFolder());
    if (opened) performance.mark("perli-folder-open", { detail: opened });
  });
  onCleanup(() => window.removeEventListener("keydown", onKeyDown));

  return (
    <div class="shell">
      <TitleBar tabs={tabs} onNewTab={newTab} />
      <aside class="sidebar">
        <span class="logo">Perli</span>
        <Sidebar view={tabs.active()} />
      </aside>
      <main class="files">
        <PathBar view={tabs.active()} />
        <For each={tabs.tabs()}>
          {(view) => (
            <div class="file-area" hidden={view !== tabs.active()}>
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
                    active={view === tabs.active()}
                    onOpen={(row) => openRow(view, row)}
                    onFirstPaint={markReady}
                  />
                )}
              </Show>
            </div>
          )}
        </For>
      </main>
      <Palette />
    </div>
  );
}
