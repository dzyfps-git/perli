import { For, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import "./menu.css";

export interface MenuItem {
  label: string;
  action: () => void;
  disabled?: boolean;
}

/** A floating glass menu. It closes on outside click, Escape or after choosing an item. */
export function Menu(props: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  let menu!: HTMLDivElement;

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
    menu.querySelector("button")?.focus();
  });
  onCleanup(() => window.removeEventListener("pointerdown", onPointerDown, true));

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
              role="menuitem"
              class="menu-item"
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
