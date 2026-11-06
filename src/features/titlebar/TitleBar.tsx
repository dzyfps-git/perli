import { getCurrentWindow } from "@tauri-apps/api/window";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { placeSnapArea } from "../../api";
import { Menu } from "../../ui/Menu";
import type { FolderView } from "../navigation/folderView";
import { toCrumbs } from "../navigation/path";
import type { Tabs } from "../tabs/tabs";
import "./titlebar.css";

const ICON_ADD = "";
const ICON_CLOSE = "";
const ICON_MINIMIZE = "";
const ICON_MAXIMIZE = "";
const ICON_RESTORE = "";

function tabTitle(view: FolderView) {
  const crumbs = toCrumbs(view.folder()?.path ?? "");
  return crumbs.at(-1)?.label ?? "New tab";
}

export function TitleBar(props: { tabs: Tabs; onNewTab: () => void }) {
  const appWindow = getCurrentWindow();
  const [maximized, setMaximized] = createSignal(false);
  const [menu, setMenu] = createSignal<{ x: number; y: number; view: FolderView }>();
  const [maximizeHovered, setMaximizeHovered] = createSignal(false);
  let maximizeButton!: HTMLButtonElement;

  // A native window covers the maximize button, so Windows sees a real one. See snap.rs.
  function moveSnapArea() {
    const { x, y, width, height } = maximizeButton.getBoundingClientRect();
    const [left, top, right, bottom] = [x, y, x + width, y + height].map((edge) =>
      Math.round(edge * window.devicePixelRatio),
    );
    placeSnapArea(left, top, right - left, bottom - top).catch(console.error);
  }

  onMount(async () => {
    moveSnapArea();
    window.addEventListener("resize", moveSnapArea);
    onCleanup(() => window.removeEventListener("resize", moveSnapArea));

    onCleanup(await appWindow.listen<boolean>("snap-hover", (event) => setMaximizeHovered(event.payload)));

    const update = async () => setMaximized(await appWindow.isMaximized());
    onCleanup(await appWindow.onResized(update));
    update();
  });

  function menuItems(view: FolderView) {
    const { tabs } = props;
    const list = tabs.tabs();
    return [
      { label: "New tab", action: props.onNewTab },
      { label: "Duplicate", action: () => tabs.duplicate(view) },
      { label: "Move left", action: () => tabs.move(view, -1), disabled: list[0] === view },
      { label: "Move right", action: () => tabs.move(view, 1), disabled: list.at(-1) === view },
      { label: "Close", action: () => tabs.close(view), disabled: list.length === 1 },
      { label: "Close others", action: () => tabs.closeOthers(view), disabled: list.length === 1 },
    ];
  }

  return (
    <header class="titlebar" data-tauri-drag-region>
      <div class="tabs" role="tablist" aria-label="Open folders">
        <For each={props.tabs.tabs()}>
          {(view) => (
            <div
              class="tab"
              classList={{ "tab-active": view === props.tabs.active() }}
              role="tab"
              aria-selected={view === props.tabs.active()}
              tabindex="0"
              onClick={() => props.tabs.activate(view)}
              onKeyDown={(event) => event.key === "Enter" && props.tabs.activate(view)}
              onAuxClick={(event) => event.button === 1 && props.tabs.close(view)}
              onContextMenu={(event) => {
                event.preventDefault();
                // A native window sits over the maximize button and would take the menu's clicks.
                const below = maximizeButton.getBoundingClientRect().bottom;
                setMenu({ x: event.clientX, y: Math.max(event.clientY, below), view });
              }}
            >
              <span class="tab-title">{tabTitle(view)}</span>
              <Show when={props.tabs.tabs().length > 1}>
                <button
                  class="tab-close"
                  aria-label={`Close ${tabTitle(view)}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    props.tabs.close(view);
                  }}
                >
                  {ICON_CLOSE}
                </button>
              </Show>
            </div>
          )}
        </For>
        <button class="tab-add" aria-label="New tab" onClick={props.onNewTab}>
          {ICON_ADD}
        </button>
      </div>

      <div class="window-buttons">
        <button class="window-button" aria-label="Minimize" onClick={() => appWindow.minimize()}>
          {ICON_MINIMIZE}
        </button>
        <button
          ref={maximizeButton}
          class="window-button"
          classList={{ "window-button-hover": maximizeHovered() }}
          aria-label={maximized() ? "Restore" : "Maximize"}
          onClick={() => appWindow.toggleMaximize()}
        >
          {maximized() ? ICON_RESTORE : ICON_MAXIMIZE}
        </button>
        <button class="window-button window-close" aria-label="Close" onClick={() => appWindow.close()}>
          {ICON_CLOSE}
        </button>
      </div>

      <Show when={menu()} keyed>
        {(open) => (
          <Menu x={open.x} y={open.y} items={menuItems(open.view)} onClose={() => setMenu(undefined)} />
        )}
      </Show>
    </header>
  );
}
