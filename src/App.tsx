import { createResource, Match, Switch } from "solid-js";
import { openFolder, startFolder } from "./api";
import { FileList } from "./features/filelist/FileList";

async function openStartFolder() {
  return openFolder(await startFolder());
}

// Waits for the frame after the rows are drawn, so this means the user can see them.
function markReady() {
  requestAnimationFrame(() => requestAnimationFrame(() => performance.mark("perli-ready")));
}

// The main layout. Moving parts of the app around should only change this file.
export function App() {
  const [folder] = createResource(openStartFolder);

  return (
    <div class="shell">
      <aside class="sidebar">
        <span class="logo">Perli</span>
      </aside>
      <main class="files">
        <Switch>
          <Match when={folder.error}>
            <p class="message" role="alert">
              {String(folder.error)}
            </p>
          </Match>
          <Match when={folder()}>
            {(opened) => <FileList count={opened().count} onFirstPaint={markReady} />}
          </Match>
        </Switch>
      </main>
    </div>
  );
}
