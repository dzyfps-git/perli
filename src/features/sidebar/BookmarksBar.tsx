import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import type { MenuItem } from "../../ui/Menu";
import type { FolderView } from "../navigation/folderView";
import { samePath } from "../navigation/path";
import { dragging } from "../reach/reach";
import { placeLabel } from "./placeLists";
import { allLooks, bookmarkGroups, BOOKMARKS, bookmarks, bookmarksBar, bookmarksCompact, groupOf } from "./saved";
import { folderGlyph } from "./Sidebar";

const MIDDLE_BUTTON = 1;
const ICON_GROUP = "";
const ICON_OPENS = "";
/** Room the button for bookmarks that don't fit takes at the bar's end. */
const MORE_ROOM = 36;
const GROUP_KEY = "group:";

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
  /** Shows the bookmarks that don't fit on the bar, as a menu under its last button. */
  onMore: (anchor: HTMLElement, items: MenuItem[]) => void;
}) {
  const loose = () => bookmarks().filter((path) => !groupOf(path));
  const holdsCurrent = (group: string) =>
    bookmarks().some((path) => groupOf(path) === group && samePath(props.view.folder()?.path, path));
  /** The buttons that don't fit, by their `data-key`. They keep their room but can't be seen. */
  const [over, setOver] = createSignal<string[]>([]);
  let bar: HTMLElement | undefined;
  const watcher = new ResizeObserver(() => fit());
  onCleanup(() => watcher.disconnect());

  function fit() {
    if (!bar?.isConnected) return setOver([]);
    const buttons = [...bar.querySelectorAll<HTMLElement>("[data-key]")];
    const end = (button: HTMLElement) => button.offsetLeft + button.offsetWidth;
    const room = buttons.every((button) => end(button) <= bar!.clientWidth) ? Infinity : bar.clientWidth - MORE_ROOM;
    const hidden = buttons.filter((button) => end(button) > room);
    for (const button of buttons) button.toggleAttribute("data-over", hidden.includes(button));
    setOver(hidden.map((button) => button.dataset.key!));
  }
  createEffect(on([bookmarks, bookmarkGroups, bookmarksCompact, allLooks], () => requestAnimationFrame(fit)));

  const opens = (path: string): MenuItem => ({
    label: placeLabel(path),
    icon: folderGlyph(path).icon,
    action: () => props.view.open(path),
  });
  const moreItems = (): MenuItem[] =>
    over().map((key) => {
      if (!key.startsWith(GROUP_KEY)) return opens(key);
      const group = key.slice(GROUP_KEY.length);
      return { label: group, icon: ICON_GROUP, items: bookmarks().filter((path) => groupOf(path) === group).map(opens) };
    });

  return (
    <Show when={bookmarksBar() && (bookmarks().length > 0 || dragging())}>
      <nav
        ref={(element) => {
          bar = element;
          watcher.observe(element);
        }}
        class="bookmarks"
        classList={{ "bookmarks-floating": bookmarks().length === 0 }}
        aria-label="Bookmarks"
        data-drop={BOOKMARKS}
        data-compact={bookmarksCompact() ? "" : undefined}
      >
        <For each={bookmarkGroups()}>
          {(group) => (
            <button
              class="bookmark bookmark-group"
              data-key={GROUP_KEY + group}
              aria-label={bookmarksCompact() ? group : undefined}
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
              data-key={path}
              data-drop={path}
              aria-label={bookmarksCompact() ? placeLabel(path) : undefined}
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
        <Show when={over().length}>
          <button
            class="bookmark bookmark-more"
            aria-label={`${over().length} more ${over().length === 1 ? "bookmark" : "bookmarks"}`}
            aria-haspopup="menu"
            onClick={(event) => props.onMore(event.currentTarget, moreItems())}
          >
            <span aria-hidden="true">»</span>
          </button>
        </Show>
      </nav>
    </Show>
  );
}
