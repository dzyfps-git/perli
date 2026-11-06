import { For, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import "./menu.css";

export interface MenuItem {
  label: string;
  action: () => void;
  disabled?: boolean;
  /** Set on items that show an on or off state. */
  checked?: boolean;
  /** Draws a line above this item, to start a new group. */
  divider?: boolean;
}

const EDGE_GAP = 4;

/** A floating glass menu. It closes on outside click, Escape or after choosing an item. */
export function Menu(props: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  let menu!: HTMLDivElement;
  const focusedBefore = document.activeElement as HTMLElement | null;

  function onKeyDown(event: KeyboardEvent) {
    const buttons = [...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") props.onClose();
    else if (event.key === "ArrowDown") buttons[(index + 1) % buttons.length]?.focus();
    else if (event.key === "ArrowUp") buttons[(index - 1 + buttons.length) % buttons.length]?.focus();
    else return;
    event.preventDefault();
    event.stopPropagation();
  }

  function onPointerDown(event: PointerEvent) {
    if (!menu.contains(event.target as Node)) props.onClose();
  }

  onMount(() => {
    window.addEventListener("pointerdown", onPointerDown, true);
    const { width, height } = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(EDGE_GAP, Math.min(props.x, innerWidth - width - EDGE_GAP))}px`;
    menu.style.top = `${Math.max(EDGE_GAP, Math.min(props.y, innerHeight - height - EDGE_GAP))}px`;
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  });
  onCleanup(() => {
    window.removeEventListener("pointerdown", onPointerDown, true);
    focusedBefore?.focus();
  });

  return (
    <Portal>
      <div
        ref={menu}
        class="menu"
        role="menu"
        style={{ left: `${props.x}px`, top: `${props.y}px` }}
        onKeyDown={onKeyDown}
      >
        <For each={props.items}>
          {(item) => (
            <button
              role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
              class="menu-item"
              classList={{ "menu-divider": item.divider }}
              aria-checked={item.checked}
              disabled={item.disabled}
              onClick={() => {
                props.onClose();
                item.action();
              }}
            >
              {item.label}
            </button>
          )}
        </For>
      </div>
    </Portal>
  );
}
