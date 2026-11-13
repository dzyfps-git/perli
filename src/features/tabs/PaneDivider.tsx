import { createSignal, For, Show } from "solid-js";
import type { Tab } from "./tabs";
import { EVEN_SPLIT, snapped, SPLIT_MAX, SPLIT_MIN, SPLIT_SNAPS } from "./tabList";

/** How far an arrow key moves the divider. */
const KEY_STEP = 0.05;

/**
 * The bar between two panes. Drag it, and it settles at a third, a half or two thirds when it
 * comes near one, which ticks show while it moves. A double click or Enter gives each pane half.
 */
export function PaneDivider(props: { tab: Tab }) {
  const [dragging, setDragging] = createSignal(false);
  let bar!: HTMLDivElement;

  const along = (event: PointerEvent) => {
    const box = bar.parentElement!.getBoundingClientRect();
    return props.tab.stacked() ? (event.clientY - box.top) / box.height : (event.clientX - box.left) / box.width;
  };

  function onKeyDown(event: KeyboardEvent) {
    const back = props.tab.stacked() ? "ArrowUp" : "ArrowLeft";
    const on = props.tab.stacked() ? "ArrowDown" : "ArrowRight";
    const next =
      event.key === back
        ? props.tab.split() - KEY_STEP
        : event.key === on
          ? props.tab.split() + KEY_STEP
          : event.key === "Home"
            ? SPLIT_MIN
            : event.key === "End"
              ? SPLIT_MAX
              : event.key === "Enter"
                ? EVEN_SPLIT
                : undefined;
    if (next === undefined) return;
    event.preventDefault();
    props.tab.setSplit(snapped(next));
  }

  return (
    <>
      <div
        ref={bar}
        class="pane-divider"
        classList={{ "pane-divider-dragging": dragging() }}
        role="separator"
        tabindex="0"
        aria-label="Pane size"
        aria-orientation={props.tab.stacked() ? "horizontal" : "vertical"}
        aria-valuemin={SPLIT_MIN * 100}
        aria-valuemax={SPLIT_MAX * 100}
        aria-valuenow={Math.round(props.tab.split() * 100)}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          bar.setPointerCapture(event.pointerId);
          setDragging(true);
        }}
        onPointerMove={(event) => dragging() && props.tab.setSplit(snapped(along(event)))}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
        onDblClick={() => props.tab.setSplit(EVEN_SPLIT)}
        onKeyDown={onKeyDown}
      />
      <Show when={dragging()}>
        <For each={SPLIT_SNAPS}>
          {(snap) => (
            <span
              class="split-tick"
              classList={{ "split-tick-on": Math.abs(snap - props.tab.split()) < 1e-9 }}
              style={{ "--at": snap }}
              aria-hidden="true"
            />
          )}
        </For>
      </Show>
    </>
  );
}
