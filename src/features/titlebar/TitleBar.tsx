import { getCurrentWindow } from "@tauri-apps/api/window";
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { placeSnapArea } from "../../api";
import { Menu } from "../../ui/Menu";
import { toCrumbs } from "../navigation/path";
import { lookOf } from "../sidebar/saved";
import type { Tab, Tabs } from "../tabs/tabs";
import "./titlebar.css";

const ICON_ADD = "";
const ICON_CLOSE = "";
const ICON_MINIMIZE = "";
const ICON_MAXIMIZE = "";
const ICON_RESTORE = "";

const ICON_SETTINGS = "";

const ICON_PIN = "\uE718";

/** The settings, when they are open as a tab after the folders. */
export interface SettingsTab {
  active: boolean;
  onActivate: () => void;
  /** A folder tab was picked, so the settings step back. */
  onLeave: () => void;
  onClose: () => void;
}

/** The colour its folder wears in the sidebar, if any. */
function tint(tab: Tab) {
  const color = lookOf(tab.active().path() ?? "")?.color;
  return color === undefined ? undefined : `var(--tag-${color})`;
}

function tabTitle(tab: Tab) {
  const titles = tab.panes().map((view) => toCrumbs(view.path() ?? "").at(-1)?.label ?? "New tab");
  return titles.join(" | ");
}

export function TitleBar(props: { tabs: Tabs; onNewTab: () => void; settings?: SettingsTab }) {
  const appWindow = getCurrentWindow();
  const [maximized, setMaximized] = createSignal(false);
  const [menu, setMenu] = createSignal<{ x: number; y: number; tab: Tab }>();
  const [maximizeHovered, setMaximizeHovered] = createSignal(false);
  let maximizeButton!: HTMLButtonElement;
  let strip!: HTMLDivElement;
  let ink!: HTMLSpanElement;

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

  function moveInk() {
    const tab = strip.querySelector<HTMLElement>(".tab-active");
    if (!tab) return;
    ink.style.transform = `translateX(${tab.offsetLeft}px)`;
    ink.style.width = `${tab.offsetWidth}px`;
  }

  createEffect(() => {
    props.tabs.tabs();
    props.tabs.active();
    props.settings?.active;
    for (const tab of props.tabs.tabs()) tab.pinned();
    moveInk();
  });

  onMount(() => {
    const observer = new ResizeObserver(moveInk);
    observer.observe(strip);
    onCleanup(() => observer.disconnect());
  });

  const isActive = (tab: Tab) => tab === props.tabs.active() && !props.settings?.active;
  function activate(tab: Tab) {
    props.settings?.onLeave();
    props.tabs.activate(tab);
  }

  function menuItems(tab: Tab) {
    const { tabs } = props;
    const list = tabs.tabs();
    const split = tab.panes().length > 1;
    const path = tab.active().folder()?.path;
    const alone = list.length === 1;
    return [
      { label: "New tab", action: props.onNewTab },
      { label: "Reopen closed tab", action: tabs.reopenClosed, disabled: !tabs.canReopen() },
      { label: "Duplicate", action: () => tabs.duplicate(tab) },
      { label: tab.pinned() ? "Unpin tab" : "Pin tab", action: () => tabs.togglePinned(tab) },
      { label: "Move to new window", action: () => tabs.toWindow(tab).catch(console.error), disabled: alone || !path },
      { label: "Split view", action: () => tabs.openToSide(path!, tab), disabled: split || !path },
      { label: "Swap panes", action: tab.swap, disabled: !split },
      { label: "Close pane", action: () => tabs.closePane(tab, tab.active()), disabled: !split },
      { label: "Move left", action: () => tabs.move(tab, -1), disabled: list[0] === tab },
      { label: "Move right", action: () => tabs.move(tab, 1), disabled: list.at(-1) === tab },
      { label: "Close", action: () => tabs.close(tab), disabled: alone || tab.pinned() },
      { label: "Close others", action: () => tabs.closeOthers(tab), disabled: alone },
      { label: "Close tabs to the right", action: () => tabs.closeRight(tab), disabled: list.at(-1) === tab },
    ];
  }

  return (
    <header class="titlebar" data-tauri-drag-region>
      <div ref={strip} class="tabs" role="tablist" aria-label="Open folders">
        <For each={props.tabs.tabs()}>
          {(tab) => (
            <div
              class="tab"
              classList={{ "tab-active": isActive(tab), "tab-pinned": tab.pinned() }}
              style={{ "--tab-name": `tab-${tab.id}`, "--tab-tint": tint(tab) }}
              data-tinted={tint(tab) ? "" : undefined}
              // The saved path, so a restored tab not yet opened still takes a drag.
              data-drop={tab.active().path()}
              role="tab"
              aria-selected={isActive(tab)}
              tabindex="0"
              onClick={() => activate(tab)}
              onKeyDown={(event) => event.key === "Enter" && activate(tab)}
              onAuxClick={(event) => event.button === 1 && props.tabs.close(tab)}
              onContextMenu={(event) => {
                event.preventDefault();
                // A native window sits over the maximize button and would take the menu's clicks.
                const below = maximizeButton.getBoundingClientRect().bottom;
                setMenu({ x: event.clientX, y: Math.max(event.clientY, below), tab });
              }}
            >
              <Show when={tab.pinned()}>
                <span class="tab-glyph tab-pin" aria-hidden="true">
                  {ICON_PIN}
                </span>
              </Show>
              <span class="tab-title">{tabTitle(tab)}</span>
              <Show when={props.tabs.tabs().length > 1 && !tab.pinned()}>
                <button
                  class="tab-close"
                  aria-label={`Close ${tabTitle(tab)}`}
                  aria-keyshortcuts="Control+W"
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
        <Show when={props.settings}>
          <div
            class="tab tab-settings"
            classList={{ "tab-active": props.settings?.active }}
            role="tab"
            aria-selected={props.settings?.active}
            tabindex="0"
            onClick={() => props.settings?.onActivate()}
            onKeyDown={(event) => event.key === "Enter" && props.settings?.onActivate()}
            onAuxClick={(event) => event.button === 1 && props.settings?.onClose()}
          >
            <span class="tab-glyph" aria-hidden="true">
              {ICON_SETTINGS}
            </span>
            <span class="tab-title">Settings</span>
            <button
              class="tab-close"
              aria-label="Close settings"
              aria-keyshortcuts="Control+W"
              onClick={(event) => {
                event.stopPropagation();
                props.settings?.onClose();
              }}
            >
              {ICON_CLOSE}
            </button>
          </div>
        </Show>
        <button class="tab-add" aria-label="New tab" aria-keyshortcuts="Control+T" onClick={props.onNewTab}>
          {ICON_ADD}
        </button>
        <span ref={ink} class="tab-ink" />
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
        <button class="window-button window-close" aria-label="Close" aria-keyshortcuts="Alt+F4" onClick={() => appWindow.close()}>
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
