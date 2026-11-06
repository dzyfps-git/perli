import { onCleanup, onMount, Show } from "solid-js";
import { openFile, startFolder, type Row } from "./api";
import { FileList } from "./features/filelist/FileList";
import { createFolderView } from "./features/navigation/folderView";
import { join } from "./features/navigation/path";
import { Palette } from "./features/palette/Palette";
import { PathBar } from "./features/pathbar/PathBar";

// Waits for the frame after the rows are drawn, so this means the user can see them.
function markReady() {
  requestAnimationFrame(() => requestAnimationFrame(() => performance.mark("perli-ready")));
}

// The main layout. Moving parts of the app around should only change this file.
export function App() {
  const view = createFolderView(0);

  function openRow(row: Row) {
    const path = join(view.folder()!.path, row.name);
    if (row.isDir) view.open(path);
    else openFile(path).catch(console.error);
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.altKey && event.key === "ArrowLeft") view.back();
    else if (event.altKey && event.key === "ArrowRight") view.forward();
    else if (event.altKey && event.key === "ArrowUp") view.up();
    else if (event.key === "Backspace") view.up();
    else return;
    event.preventDefault();
  }

  onMount(async () => {
    window.addEventListener("keydown", onKeyDown);
    const opened = await view.open(await startFolder());
    if (opened) performance.mark("perli-folder-open", { detail: opened });
  });
  onCleanup(() => window.removeEventListener("keydown", onKeyDown));

  return (
    <div class="shell">
      <aside class="sidebar">
        <span class="logo">Perli</span>
      </aside>
      <main class="files">
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
                onOpen={openRow}
                onFirstPaint={markReady}
              />
            )}
          </Show>
        </div>
      </main>
      <Palette />
    </div>
  );
}
