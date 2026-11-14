import { createSignal, For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { previewWidth, setPreviewWidth } from "../filelist/prefs";
import { DOCK_MAX, DOCK_MIN, DOCK_SNAPS, DOCK_STEP, dockShare, dragged } from "./dockWidth";

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const FOLD_MS = 180;

/** The share the pane has now, also before its edge was ever dragged. */
function shareOf(dock: Element) {
  const room = dock.parentElement!.getBoundingClientRect().width;
  return previewWidth() ?? dock.getBoundingClientRect().width / Math.max(1, room);
}

/** Makes the preview pane wider by `step` (narrower when below zero), from what it shows now. */
export function stepWidth(step: number, dock: Element | null) {
  setPreviewWidth(dockShare((dock ? shareOf(dock) : (previewWidth() ?? 0.36)) + step));
}

/**
 * The preview pane's left edge. Drag it, and it settles at a third or a half of the room, which
 * ticks show while it moves. Let go far enough right, it folds the pane shut. A double click or
 * Enter gives the pane its first width back.
 */
export function DockEdge(props: { onFold: () => void }) {
  const [drag, setDrag] = createSignal<{ x: number; y: number; folds: boolean; room: DOMRect }>();
  let edge!: HTMLDivElement;
  /** What the pane had before this drag, which it gets back when the drag folds it. */
  let before: number | null = null;
  const dock = () => edge.parentElement!;

  function move(event: PointerEvent) {
    const room = dock().parentElement!.getBoundingClientRect();
    const next = dragged(event.clientX, room.left, room.right);
    setDrag({ x: event.clientX, y: event.clientY, folds: next.folds, room });
    dock().classList.toggle("preview-dock-folding", next.folds);
    setPreviewWidth(next.share);
  }

  function end() {
    const folds = drag()?.folds;
    setDrag(undefined);
    if (!folds) return;
    setPreviewWidth(before);
    if (reducedMotion.matches) return props.onFold();
    dock()
      .animate({ opacity: [0.45, 0], translate: ["0 0", "32px 0"] }, { duration: FOLD_MS, easing: "ease-in", fill: "forwards" })
      .finished.then(props.onFold, props.onFold);
  }

  function onKeyDown(event: KeyboardEvent) {
    // The edge is on the pane's left, so going left makes the pane wider.
    const steps: Record<string, number> = { ArrowLeft: DOCK_STEP, ArrowRight: -DOCK_STEP };
    if (event.key in steps) stepWidth(steps[event.key], dock());
    else if (event.key === "Home") setPreviewWidth(DOCK_MIN);
    else if (event.key === "End") setPreviewWidth(DOCK_MAX);
    else if (event.key === "Enter") setPreviewWidth(null);
    else return;
    event.preventDefault();
  }

  return (
    <>
      <div
        ref={edge}
        class="dock-edge"
        classList={{ "dock-edge-dragging": !!drag() }}
        role="separator"
        tabindex="0"
        aria-label="Preview pane size"
        data-tip="Drag to resize · double-click to reset"
        aria-orientation="vertical"
        aria-valuemin={DOCK_MIN * 100}
        aria-valuemax={DOCK_MAX * 100}
        aria-valuenow={Math.round((previewWidth() ?? 0.36) * 100)}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          before = previewWidth();
          edge.setPointerCapture(event.pointerId);
          move(event);
        }}
        onPointerMove={(event) => drag() && move(event)}
        onPointerUp={end}
        onPointerCancel={end}
        onDblClick={() => setPreviewWidth(null)}
        onKeyDown={onKeyDown}
      />
      <Show when={drag()}>
        {(now) => (
          <Portal>
            <For each={DOCK_SNAPS}>
              {(snap) => (
                <span
                  class="split-tick dock-tick"
                  classList={{ "split-tick-on": !now().folds && Math.abs(snap - (previewWidth() ?? 0)) < 1e-9 }}
                  style={{ left: `${now().room.right - snap * now().room.width - 3}px`, top: `${now().room.top}px` }}
                  aria-hidden="true"
                />
              )}
            </For>
            <span class="dock-pill" classList={{ "dock-pill-folds": now().folds }} style={{ left: `${now().x}px`, top: `${now().y}px` }} aria-hidden="true">
              {now().folds ? "Let go to close" : `${Math.round((previewWidth() ?? 0) * 100)}%`}
            </span>
          </Portal>
        )}
      </Show>
    </>
  );
}
