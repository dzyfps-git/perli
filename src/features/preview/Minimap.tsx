import { createEffect, onCleanup, onMount } from "solid-js";
import type { ViewRect } from "./zoomView";

/** The map's longest side. */
const EDGE = 160;
/** A film on the map redraws this often. */
const LIVE_MS = 250;

export interface MinimapProps {
  /** What to draw small: the picture's canvas, the film, the page. */
  source: () => CanvasImageSource | undefined;
  /** Width over height, as shown. */
  aspect: () => number;
  /** Quarter turns the picture shows at. */
  turn?: () => number;
  view: () => ViewRect;
  /** Puts this point, from 0 to 1 on each side, in the middle of what shows. */
  onMove: (center: { x: number; y: number }) => void;
  /** Redraws as it plays, for a film. */
  live?: boolean;
}

/**
 * The whole of a zoomed picture, small in a corner, with the part on show marked. A click puts
 * that spot in the middle; the mark drags.
 */
export function Minimap(props: MinimapProps) {
  let canvas!: HTMLCanvasElement;
  const size = () => {
    const aspect = props.aspect() || 1;
    return aspect >= 1 ? { width: EDGE, height: Math.round(EDGE / aspect) } : { width: Math.round(EDGE * aspect), height: EDGE };
  };

  function draw() {
    const source = props.source();
    const { width, height } = size();
    if (!source) return;
    canvas.width = Math.round(width * devicePixelRatio);
    canvas.height = Math.round(height * devicePixelRatio);
    const context = canvas.getContext("2d")!;
    const turn = props.turn?.() ?? 0;
    const [across, down] = turn % 2 ? [canvas.height, canvas.width] : [canvas.width, canvas.height];
    context.setTransform(1, 0, 0, 1, canvas.width / 2, canvas.height / 2);
    context.rotate((turn * Math.PI) / 2);
    try {
      context.drawImage(source, -across / 2, -down / 2, across, down);
    } catch {
      // A film between frames has nothing to draw yet; the next look draws it.
    }
  }

  createEffect(() => {
    size();
    props.turn?.();
    draw();
  });

  onMount(() => {
    if (!props.live) return;
    const timer = setInterval(draw, LIVE_MS);
    onCleanup(() => clearInterval(timer));
  });

  function onPointerDown(event: PointerEvent) {
    if (event.button !== 0) return;
    event.stopPropagation();
    const map = event.currentTarget as HTMLElement;
    map.setPointerCapture(event.pointerId);
    const box = map.getBoundingClientRect();
    const point = (at: PointerEvent) => ({ x: (at.clientX - box.left) / box.width, y: (at.clientY - box.top) / box.height });
    const view = props.view();
    const start = point(event);
    const inside = start.x >= view.x && start.x <= view.x + view.width && start.y >= view.y && start.y <= view.y + view.height;
    // Dragging the mark keeps hold of it where it was taken; a click elsewhere brings it there.
    const grip = inside ? { x: start.x - (view.x + view.width / 2), y: start.y - (view.y + view.height / 2) } : { x: 0, y: 0 };
    const move = (at: PointerEvent) => {
      const now = point(at);
      props.onMove({ x: now.x - grip.x, y: now.y - grip.y });
    };
    move(event);
    map.addEventListener("pointermove", move);
    map.addEventListener("pointerup", () => map.removeEventListener("pointermove", move), { once: true });
  }

  return (
    <div
      class="minimap"
      style={{ width: `${size().width}px`, height: `${size().height}px` }}
      aria-hidden="true"
      onPointerDown={onPointerDown}
      onWheel={(event) => event.stopPropagation()}
      onDblClick={(event) => event.stopPropagation()}
    >
      <canvas ref={canvas} />
      <div
        class="minimap-view"
        style={{
          left: `${props.view().x * 100}%`,
          top: `${props.view().y * 100}%`,
          width: `${props.view().width * 100}%`,
          height: `${props.view().height * 100}%`,
        }}
      />
    </div>
  );
}
