import { For, Show } from "solid-js";
import type { FolderView } from "../navigation/folderView";
import { samePath } from "../navigation/path";
import { placeLabel } from "./placeLists";
import { bookmarks, bookmarksBar } from "./saved";
import { folderGlyph } from "./Sidebar";

const MIDDLE_BUTTON = 1;

/** Folders kept one click away. A middle click opens one in a new tab. */
export function BookmarksBar(props: {
  view: FolderView;
  onNewTab: (path: string) => void;
  onMenu: (event: MouseEvent, path: string) => void;
}) {
  return (
    <Show when={bookmarksBar() && bookmarks().length > 0}>
      <nav class="bookmarks" aria-label="Bookmarks">
        <For each={bookmarks()}>
          {(path) => (
            <button
              class="bookmark"
              data-drop={path}
              aria-current={samePath(props.view.folder()?.path, path) ? "location" : undefined}
              aria-description={path}
              onClick={(event) => (event.ctrlKey ? props.onNewTab(path) : props.view.open(path))}
              onAuxClick={(event) => event.button === MIDDLE_BUTTON && props.onNewTab(path)}
              onContextMenu={(event) => props.onMenu(event, path)}
            >
              <span class="place-icon" aria-hidden="true" style={{ color: folderGlyph(path).color }}>
                {folderGlyph(path).icon}
              </span>
              <span class="place-label">{placeLabel(path)}</span>
            </button>
          )}
        </For>
      </nav>
    </Show>
  );
}
