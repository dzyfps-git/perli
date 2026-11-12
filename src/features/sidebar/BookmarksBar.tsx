import { For, Show } from "solid-js";
import type { FolderView } from "../navigation/folderView";
import { samePath } from "../navigation/path";
import { dragging } from "../reach/reach";
import { placeLabel } from "./placeLists";
import { bookmarkGroups, BOOKMARKS, bookmarks, bookmarksBar, groupOf } from "./saved";
import { folderGlyph } from "./Sidebar";

const MIDDLE_BUTTON = 1;
const ICON_GROUP = "";
const ICON_OPENS = "";

/**
 * Folders kept one click away. A middle click opens one in a new tab. Bookmarks put in a group
 * share one button, which opens them as a menu. A folder dragged onto the bar becomes a bookmark.
 */
export function BookmarksBar(props: {
  view: FolderView;
  onNewTab: (path: string) => void;
  onMenu: (event: MouseEvent, path: string) => void;
  /** Shows the bookmarks of `group` under its button. */
  onGroup: (anchor: HTMLElement, group: string) => void;
}) {
  const loose = () => bookmarks().filter((path) => !groupOf(path));
  const holdsCurrent = (group: string) =>
    bookmarks().some((path) => groupOf(path) === group && samePath(props.view.folder()?.path, path));

  return (
    <Show when={bookmarksBar() && (bookmarks().length > 0 || dragging())}>
      <nav class="bookmarks" classList={{ "bookmarks-floating": bookmarks().length === 0 }} aria-label="Bookmarks" data-drop={BOOKMARKS}>
        <For each={bookmarkGroups()}>
          {(group) => (
            <button
              class="bookmark bookmark-group"
              aria-haspopup="menu"
              aria-current={holdsCurrent(group) ? "location" : undefined}
              onClick={(event) => props.onGroup(event.currentTarget, group)}
            >
              <span class="place-icon" aria-hidden="true">
                {ICON_GROUP}
              </span>
              <span class="place-label">{group}</span>
              <span class="bookmark-opens" aria-hidden="true">
                {ICON_OPENS}
              </span>
            </button>
          )}
        </For>
        <For each={loose()}>
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
        <Show when={dragging()}>
          <span class="bookmark-hint">Drop a folder here to bookmark it</span>
        </Show>
      </nav>
    </Show>
  );
}
