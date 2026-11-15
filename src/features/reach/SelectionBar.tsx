import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { formatSize } from "../../ui/format";
import { Menu } from "../../ui/Menu";
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
const ICON_MORE = "";

/**
 * The bar that floats over a list while rows are selected: how many, how big, and what to do
 * with them. Pressing a button leaves the focus in the list, so the keys keep working there.
 *
 * The bar fits whatever room it has: the names slide away to leave the icons, and if even those
 * don't fit, the last actions wait behind More.
 */
export function SelectionBar(props: { count: number; of: number; bytes: number; items: BarItem[]; onClear: () => void }) {
  let bar!: HTMLDivElement;
  let more: HTMLButtonElement | undefined;
  /** Icons only, with the names in the hover text. */
  const [bare, setBare] = createSignal(false);
  /** How many of the last actions wait behind More. */
  const [folded, setFolded] = createSignal(0);
  const [moreAt, setMoreAt] = createSignal<{ x: number; y: number; above: number }>();
  const shown = () => props.items.slice(0, props.items.length - folded());
  const waiting = () => props.items.slice(props.items.length - folded());

  const told = () => {
    const count = props.count.toLocaleString();
    const size = props.bytes > 0 ? ` · ${formatSize(props.bytes)}` : "";
    return `${count}${props.of > 1 ? ` of ${props.of.toLocaleString()}` : ""} selected${size}`;
  };

  let fitted = false;
  const tooWide = () => bar.scrollWidth > bar.clientWidth;
  /** Tries the roomiest look first, with transitions held, then slides from the old look to the one that fits. */
  function fit() {
    const was = bare();
    bar.setAttribute("data-measuring", "");
    setBare(false);
    setFolded(0);
    if (tooWide()) {
      setBare(true);
      while (folded() < props.items.length && tooWide()) setFolded(folded() + 1);
    }
    const now = bare();
    if (fitted) {
      setBare(was);
      void bar.offsetWidth;
    }
    bar.removeAttribute("data-measuring");
    setBare(now);
    fitted = true;
  }

  onMount(() => {
    // Its first answer comes as soon as it watches, so the bar fits before it is seen.
    const watch = new ResizeObserver(() => fit());
    watch.observe(bar.parentElement!);
    onCleanup(() => watch.disconnect());
  });
  // Inside an effect the change only reaches the page once it ends, so the fit waits for that.
  createEffect(
    on(
      () => [told(), props.items.map((item) => item.label).join("\n")],
      () => queueMicrotask(() => bar.isConnected && fit()),
      { defer: true },
    ),
  );

  function openMore() {
    const box = more!.getBoundingClientRect();
    setMoreAt({ x: box.left, y: box.bottom + 4, above: box.top - 2 });
  }

  return (
    <div
      ref={bar}
      class="selection-bar"
      classList={{ "selection-bare": bare() }}
      role="toolbar"
      aria-label="Selection"
      onPointerDown={(event) => event.preventDefault()}
    >
      <span class="selection-count" role="status">
        {told()}
      </span>
      <For each={shown()}>
        {(item) => (
          <button class="selection-action" aria-label={item.label} aria-keyshortcuts={item.keys} onClick={(event) => item.run(event.currentTarget)}>
            <span class="selection-icon" aria-hidden="true">
              {item.icon}
            </span>
            <span class="selection-label">{item.label}</span>
          </button>
        )}
      </For>
      <Show when={folded() > 0}>
        <button ref={more} class="selection-action selection-more" aria-label="More actions" aria-haspopup="menu" onClick={openMore}>
          <span class="selection-icon" aria-hidden="true">
            {ICON_MORE}
          </span>
        </button>
      </Show>
      <button class="selection-action selection-clear" aria-label="Clear selection" aria-keyshortcuts="Escape" onClick={props.onClear}>
        <span class="selection-icon" aria-hidden="true">
          {ICON_CLEAR}
        </span>
      </button>
      <Show when={moreAt()} keyed>
        {(at) => (
          <Menu
            x={at.x}
            y={at.y}
            above={at.above}
            items={waiting().map((item) => ({ label: item.label, icon: item.icon, action: () => item.run(more!) }))}
            onClose={() => setMoreAt(undefined)}
          />
        )}
      </Show>
    </div>
  );
}
