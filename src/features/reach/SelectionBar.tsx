import { For } from "solid-js";
import { formatSize } from "../../ui/format";
import "./reach.css";

export interface BarItem {
  label: string;
  /** A glyph from Segoe Fluent Icons. */
  icon: string;
  /** Keys in the form `aria-keyshortcuts` takes, for the hover text. */
  keys?: string;
  /** `anchor` is the button, for an item that opens a menu under itself. */
  run: (anchor: HTMLElement) => void;
}

const ICON_CLEAR = "";

/**
 * The bar that floats over a list while rows are selected: how many, how big, and what to do
 * with them. Pressing a button leaves the focus in the list, so the keys keep working there.
 */
export function SelectionBar(props: { count: number; of: number; bytes: number; items: BarItem[]; onClear: () => void }) {
  const told = () => {
    const count = props.count.toLocaleString();
    const size = props.bytes > 0 ? ` · ${formatSize(props.bytes)}` : "";
    return `${count}${props.of > 1 ? ` of ${props.of.toLocaleString()}` : ""} selected${size}`;
  };
  return (
    <div class="selection-bar" role="toolbar" aria-label="Selection" onPointerDown={(event) => event.preventDefault()}>
      <span class="selection-count" role="status">
        {told()}
      </span>
      <For each={props.items}>
        {(item) => (
          <button class="selection-action" aria-label={item.label} aria-keyshortcuts={item.keys} onClick={(event) => item.run(event.currentTarget)}>
            <span class="selection-icon" aria-hidden="true">
              {item.icon}
            </span>
            <span class="selection-label">{item.label}</span>
          </button>
        )}
      </For>
      <button class="selection-action selection-clear" aria-label="Clear selection" aria-keyshortcuts="Escape" onClick={props.onClear}>
        <span class="selection-icon" aria-hidden="true">
          {ICON_CLEAR}
        </span>
      </button>
    </div>
  );
}
