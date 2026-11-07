import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
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
}

const EDGE_GAP = 4;
const SIDE_GAP = 2;
/** Lines a side menu's first item up with the item that opened it. */
const SIDE_INSET = 5;
const SIDE_DELAY_MS = 150;
const LOADING: MenuItem[] = [{ label: "Loading…", disabled: true }];
const NOTHING: MenuItem[] = [{ label: "Nothing here", disabled: true }];

const opensSide = (item: MenuItem) => !!(item.items || item.load);

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

  function openSide(item: MenuItem, button: HTMLElement) {
    if (side()?.item === item) return;
    const { left, right } = menu.getBoundingClientRect();
    const y = button.getBoundingClientRect().top - SIDE_INSET;
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
    const { width, height } = menu.getBoundingClientRect();
    const overflows = props.x + width + EDGE_GAP > innerWidth;
    const x = props.parent && overflows ? props.parent.left - SIDE_GAP - width : props.x;
    menu.style.left = `${Math.max(EDGE_GAP, Math.min(x, innerWidth - width - EDGE_GAP))}px`;
    menu.style.top = `${Math.max(EDGE_GAP, Math.min(props.y, innerHeight - height - EDGE_GAP))}px`;
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
        <For each={props.items}>
          {(item) => (
            <button
              role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
              class="menu-item"
              classList={{ "menu-divider": item.divider }}
              aria-checked={item.checked}
              aria-haspopup={opensSide(item) ? "menu" : undefined}
              aria-expanded={opensSide(item) ? side()?.item === item : undefined}
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
            >
              {item.label}
            </button>
          )}
        </For>
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
