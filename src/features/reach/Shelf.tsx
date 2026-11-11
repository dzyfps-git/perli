import { createEffect, createResource, For, on, Show } from "solid-js";
import { isFile, startDragPaths, type Task } from "../../api";
import { kindOf } from "../filelist/fileKinds";
import { baseName } from "../navigation/path";
import { dragging, pruneShelf, setShelf, setShelfOpen, SHELF, shelf, shelfOpen } from "./reach";
import "./reach.css";

const ICON_CLOSE = "";
const ICON_ALL = "";
/** How far the pointer goes before a press on a file becomes a drag of it. */
const DRAG_DISTANCE = 5;

/**
 * A tray where files wait. It slides in while files are dragged, takes a drop without moving
 * anything, and keeps what it holds across folders, tabs and runs. Files leave it by being
 * dragged out to somewhere real, or by Copy here and Move here.
 */
export function Shelf(props: {
  /** The folder on show, when files can go there. */
  folder: () => string | undefined;
  onJob: (task: Task) => void;
  /** Shows a file where it lives. */
  onShow: (path: string) => void;
  report: (failure: unknown) => void;
}) {
  const shown = () => dragging() || shelfOpen() || shelf().length > 0;
  // A folder and a file can share a name, so each path says which it is.
  const [files] = createResource(shelf, (paths) => Promise.all(paths.map((path) => isFile(path).catch(() => true))));
  let press: { x: number; y: number; paths: string[] } | undefined;

  // Files moved or deleted since they were parked would only fail later.
  createEffect(on(shown, (now) => now && pruneShelf().catch(console.error)));

  function onPointerMove(event: PointerEvent) {
    if (!press || (event.buttons & 1) === 0) return (press = undefined);
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < DRAG_DISTANCE) return;
    const { paths } = press;
    press = undefined;
    // Windows runs the drag. What it left behind is only known by looking afterwards.
    startDragPaths(paths)
      .then(pruneShelf)
      .catch(props.report);
  }

  const hold = (event: PointerEvent, paths: string[]) => {
    if (event.button === 0) press = { x: event.clientX, y: event.clientY, paths };
  };
  const remove = (path: string) => setShelf(shelf().filter((kept) => kept !== path));

  function send(kind: "copyPaths" | "movePaths") {
    const folder = props.folder();
    if (!folder) return;
    props.onJob({ kind, paths: shelf(), folder });
    // Moved files are no longer where the shelf has them.
    if (kind === "movePaths") setShelf([]);
  }

  function close() {
    setShelf([]);
    setShelfOpen(false);
  }

  return (
    <aside
      class="shelf"
      classList={{ "shelf-on": shown(), "shelf-waiting": dragging() }}
      data-drop={SHELF}
      aria-label="Shelf"
      aria-hidden={!shown()}
      inert={!shown()}
      onPointerMove={onPointerMove}
      onPointerDown={(event) => event.preventDefault()}
    >
      <Show
        when={shelf().length > 0}
        fallback={<p class="shelf-empty">{dragging() ? "Drop here to park. Nothing moves." : "Drag files here to park them."}</p>}
      >
        <button class="shelf-all" aria-label={`Drag all ${shelf().length} out`} onPointerDown={(event) => hold(event, shelf())}>
          <span aria-hidden="true">{ICON_ALL}</span>
          {shelf().length}
        </button>
        <ul class="shelf-items">
          <For each={shelf()}>
            {(path, at) => (
              <li class="shelf-item">
                <button class="shelf-file" aria-label={path} onPointerDown={(event) => hold(event, [path])} onClick={() => props.onShow(path)}>
                  <span class="file-icon" data-kind={kindOf(baseName(path), files()?.[at()] === false)} aria-hidden="true" />
                  <span class="shelf-name">{baseName(path) || path}</span>
                </button>
                <button class="shelf-remove" aria-label={`Take ${baseName(path)} off the shelf`} onClick={() => remove(path)}>
                  {ICON_CLOSE}
                </button>
              </li>
            )}
          </For>
        </ul>
        <div class="shelf-actions">
          <button class="job-choice" disabled={!props.folder()} onClick={() => send("copyPaths")}>
            Copy here
          </button>
          <button class="job-choice" disabled={!props.folder()} onClick={() => send("movePaths")}>
            Move here
          </button>
        </div>
      </Show>
      <button class="shelf-close" aria-label={shelf().length > 0 ? "Clear the shelf" : "Hide the shelf"} onClick={close}>
        {ICON_CLOSE}
      </button>
    </aside>
  );
}
