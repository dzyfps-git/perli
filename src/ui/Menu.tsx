import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { labelKeys } from "../features/keys/keybinds";
import { canStar, iconFor, keysFor, opensSide, starredFirst } from "./menuLook";
import "./menu.css";

export interface MenuItem {
  label: string;
  action?: () => void;
  disabled?: boolean;
  /** Set on items that show an on or off state. */
  checked?: boolean;
  /** Draws a line above this item, to start a new group. */
  divider?: boolean;
  /** Opens a side menu instead of running an action. */
  items?: MenuItem[];
  /** Adds to the side menu what Windows has to look up, so the menu never waits for it. */
  load?: () => Promise<MenuItem[]>;
  /** A glyph of the icon font. Without one, the label's usual icon is shown, if it has one. */
  icon?: string;
  /** A small picture in place of the icon, such as another app's own. */
  picture?: { width: number; height: number; pixels: Uint8ClampedArray<ArrayBuffer> };
  /** A key hint. Without one, the label's usual keys are shown, if it has any. */
  keys?: string;
}

/** Room kept to every window edge, which `max-height` in menu.css leaves twice. */
const EDGE_GAP = 8;
const SIDE_GAP = 2;
/** Lines a side menu's first item up with the item that opened it. */
const SIDE_INSET = 5;
const SIDE_DELAY_MS = 150;
const LOADING: MenuItem[] = [{ label: "Loading…", disabled: true }];
const NOTHING: MenuItem[] = [{ label: "Nothing here", disabled: true }];
const STARS_KEY = "perli-menu-stars";
const ICON_STAR = "";

function savedStars(): string[] | null {
  try {
    return JSON.parse(localStorage.getItem(STARS_KEY) ?? "null");
  } catch {
    return null;
  }
}

/** Labels of the items kept on top of every menu they are in. Null until the first one is starred. */
const [stars, setStars] = createSignal(savedStars());

function toggleStar(label: string) {
  const now = stars() ?? [];
  const next = now.includes(label) ? now.filter((other) => other !== label) : [...now, label];
  setStars(next);
  localStorage.setItem(STARS_KEY, JSON.stringify(next));
}

/** The key hint of an item: its own, or the keys of the command it runs as they are now. */
const keysOf = (item: MenuItem) => item.keys ?? labelKeys(item.label, keysFor(item.label));
const isStarred = (item: MenuItem) => !!stars()?.includes(item.label);
function drawPicture(canvas: HTMLCanvasElement, picture: NonNullable<MenuItem["picture"]>) {
  canvas.width = picture.width;
  canvas.height = picture.height;
  canvas.getContext("2d")?.putImageData(new ImageData(picture.pixels, picture.width, picture.height), 0, 0);
}

/** A floating glass menu. It closes on outside click, Escape or after choosing an item. */
export function Menu(props: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
  /** Set on side menus: where to flip to at the window edge, and how to go back. */
  parent?: { left: number; onBack: () => void };
  /** Set when this replaces a menu already on screen, which should not appear again. */
  still?: boolean;
}) {
  let menu!: HTMLDivElement;
  let sideTimer: ReturnType<typeof setTimeout> | undefined;
  const focusedBefore = document.activeElement as HTMLElement | null;
  const [side, setSide] = createSignal<{
    item: MenuItem;
    items: MenuItem[];
    loaded?: boolean;
    x: number;
    y: number;
    left: number;
  }>();
  // Side menus keep their own order, because what is in them belongs together.
  const items = () => (props.parent ? props.items : starredFirst(props.items, isStarred));
  const showHint = () => !props.parent && stars() === null && props.items.some(canStar);

  function openSide(item: MenuItem, button: HTMLElement) {
    if (side()?.item === item) return;
    // Offsets ignore the grow-in scale, so a side menu opened mid-animation still lines up.
    const left = menu.offsetLeft;
    const right = left + menu.offsetWidth;
    const y = menu.offsetTop + button.offsetTop - menu.scrollTop - SIDE_INSET;
    const first = item.items ?? [];
    const open = { item, items: first.length > 0 ? first : LOADING, x: right + SIDE_GAP, y, left };
    setSide(open);
    item
      .load?.()
      .catch((failure) => {
        console.error(failure);
        return [];
      })
      .then((more) => {
        const items = [...first, ...more];
        if (side()?.item === item) setSide({ ...open, items: items.length > 0 ? items : NOTHING, loaded: true });
      });
  }

  function onKeyDown(event: KeyboardEvent) {
    const buttons = [...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") (props.parent?.onBack ?? props.onClose)();
    else if (event.key === "ArrowLeft" && props.parent) props.parent.onBack();
    else if (event.key === "ArrowRight") {
      if (buttons[index]?.ariaHasPopup) buttons[index].click();
    }
    else if (event.key === "ArrowDown") buttons[(index + 1) % buttons.length]?.focus();
    else if (event.key === "ArrowUp") buttons[(index - 1 + buttons.length) % buttons.length]?.focus();
    else return;
    event.preventDefault();
    event.stopPropagation();
  }

  function onPointerDown(event: PointerEvent) {
    if (!(event.target as Element).closest(".menu")) props.onClose();
  }

  onMount(() => {
    window.addEventListener("pointerdown", onPointerDown, true);
    const [width, height] = [menu.offsetWidth, menu.offsetHeight];
    const overflows = props.x + width + EDGE_GAP > innerWidth;
    const x = props.parent && overflows ? props.parent.left - SIDE_GAP - width : props.x;
    const left = Math.max(EDGE_GAP, Math.min(x, innerWidth - width - EDGE_GAP));
    const top = Math.max(EDGE_GAP, Math.min(props.y, innerHeight - height - EDGE_GAP));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    // It grows out of where it was asked for, even when the window edge pushed it aside.
    menu.style.transformOrigin = `${props.x - left}px ${props.y - top}px`;
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  });
  onCleanup(() => {
    clearTimeout(sideTimer);
    window.removeEventListener("pointerdown", onPointerDown, true);
    focusedBefore?.focus();
  });

  return (
    <Portal>
      <div
        ref={menu}
        class="menu"
        classList={{ "menu-still": props.still }}
        role="menu"
        style={{ left: `${props.x}px`, top: `${props.y}px` }}
        onKeyDown={onKeyDown}
        onPointerLeave={() => clearTimeout(sideTimer)}
      >
        <For each={items()}>
          {(item) => (
            <button
              role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
              class="menu-item"
              classList={{ "menu-divider": item.divider }}
              aria-checked={item.checked}
              aria-haspopup={opensSide(item) ? "menu" : undefined}
              aria-expanded={opensSide(item) ? side()?.item === item : undefined}
              aria-keyshortcuts={keysOf(item)?.replaceAll("Ctrl", "Control")}
              disabled={item.disabled}
              onPointerEnter={(event) => {
                const button = event.currentTarget;
                clearTimeout(sideTimer);
                sideTimer = setTimeout(
                  () => (opensSide(item) ? openSide(item, button) : setSide(undefined)),
                  SIDE_DELAY_MS,
                );
              }}
              onClick={(event) => {
                if (opensSide(item)) return openSide(item, event.currentTarget);
                props.onClose();
                item.action?.();
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                if (!props.parent && canStar(item)) toggleStar(item.label);
              }}
            >
              <span class="menu-icon" aria-hidden="true">
                <Show when={item.picture} fallback={item.icon ?? iconFor(item.label)}>
                  {(picture) => <canvas ref={(canvas) => drawPicture(canvas, picture())} />}
                </Show>
              </span>
              <span class="menu-label">{item.label}</span>
              <Show when={!props.parent && canStar(item) && isStarred(item)}>
                <span class="menu-star" aria-label="Starred">
                  {ICON_STAR}
                </span>
              </Show>
              <Show when={keysOf(item)}>
                {(keys) => (
                  <span class="menu-keys">
                    <For each={keys().split("+")}>{(key) => <kbd>{key}</kbd>}</For>
                  </span>
                )}
              </Show>
            </button>
          )}
        </For>
        <Show when={showHint()}>
          <p class="menu-hint">Right-click an item to keep it on top</p>
        </Show>
      </div>
      <Show when={side()} keyed>
        {(open) => (
          <Menu
            x={open.x}
            y={open.y}
            items={open.items}
            still={open.loaded}
            onClose={props.onClose}
            parent={{ left: open.left, onBack: () => setSide(undefined) }}
          />
        )}
      </Show>
    </Portal>
  );
}
