import { getCurrentWindow } from "@tauri-apps/api/window";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { showSnapLayouts } from "../../api";
import { Menu } from "../../ui/Menu";
import { toCrumbs } from "../navigation/path";
import type { Tab, Tabs } from "../tabs/tabs";
import "./titlebar.css";

const ICON_ADD = "";
const ICON_CLOSE = "";
const ICON_MINIMIZE = "";
const ICON_MAXIMIZE = "";
const ICON_RESTORE = "";
const SNAP_HOVER_MS = 500;

function tabTitle(tab: Tab) {
  const titles = tab.panes().map((view) => toCrumbs(view.folder()?.path ?? "").at(-1)?.label ?? "New tab");
  return titles.join(" | ");
}

export function TitleBar(props: { tabs: Tabs; onNewTab: () => void }) {
  const appWindow = getCurrentWindow();
  const [maximized, setMaximized] = createSignal(false);
  const [menu, setMenu] = createSignal<{ x: number; y: number; tab: Tab }>();
  let snapTimer: number | undefined;

  const stopSnapTimer = () => window.clearTimeout(snapTimer);

  function startSnapTimer() {
    snapTimer = window.setTimeout(() => showSnapLayouts().catch(console.error), SNAP_HOVER_MS);
  }

  onMount(async () => {
    const update = async () => setMaximized(await appWindow.isMaximized());
    const unlisten = await appWindow.onResized(update);
    onCleanup(unlisten);
    update();
  });
  onCleanup(stopSnapTimer);

  function menuItems(tab: Tab) {
    const { tabs } = props;
    const list = tabs.tabs();
    const split = tab.panes().length > 1;
    const path = tab.active().folder()?.path;
    return [
      { label: "New tab", action: props.onNewTab },
      { label: "Duplicate", action: () => tabs.duplicate(tab) },
      { label: "Split view", action: () => tabs.openToSide(path!, tab), disabled: split || !path },
      { label: "Swap panes", action: tab.swap, disabled: !split },
      { label: "Close pane", action: () => tabs.closePane(tab, tab.active()), disabled: !split },
      { label: "Move left", action: () => tabs.move(tab, -1), disabled: list[0] === tab },
      { label: "Move right", action: () => tabs.move(tab, 1), disabled: list.at(-1) === tab },
      { label: "Close", action: () => tabs.close(tab), disabled: list.length === 1 },
      { label: "Close others", action: () => tabs.closeOthers(tab), disabled: list.length === 1 },
    ];
  }

  return (
    <header class="titlebar" data-tauri-drag-region>
      <div class="tabs" role="tablist" aria-label="Open folders">
        <For each={props.tabs.tabs()}>
          {(tab) => (
            <div
              class="tab"
              classList={{ "tab-active": tab === props.tabs.active() }}
              role="tab"
              aria-selected={tab === props.tabs.active()}
              tabindex="0"
              onClick={() => props.tabs.activate(tab)}
              onKeyDown={(event) => event.key === "Enter" && props.tabs.activate(tab)}
              onAuxClick={(event) => event.button === 1 && props.tabs.close(tab)}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({ x: event.clientX, y: event.clientY, tab });
              }}
            >
              <span class="tab-title">{tabTitle(tab)}</span>
              <Show when={props.tabs.tabs().length > 1}>
                <button
                  class="tab-close"
                  aria-label={`Close ${tabTitle(tab)}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    props.tabs.close(tab);
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
          class="window-button"
          aria-label={maximized() ? "Restore" : "Maximize"}
          onClick={() => {
            stopSnapTimer();
            appWindow.toggleMaximize();
          }}
          onMouseEnter={startSnapTimer}
          onMouseLeave={stopSnapTimer}
        >
          {maximized() ? ICON_RESTORE : ICON_MAXIMIZE}
        </button>
        <button class="window-button window-close" aria-label="Close" onClick={() => appWindow.close()}>
          {ICON_CLOSE}
        </button>
      </div>

      <Show when={menu()} keyed>
        {(open) => (
          <Menu x={open.x} y={open.y} items={menuItems(open.tab)} onClose={() => setMenu(undefined)} />
        )}
      </Show>
    </header>
  );
}
