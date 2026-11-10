import { createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { Thumb } from "../../api";
import { draw } from "./QuickPreview";

const ICON_ZOOM_IN = "";
const ICON_ZOOM_OUT = "";
const ICON_FIT = "";
const ICON_TURN = "";

/** Windows draws pictures this big at most, so 1:1 past it is the biggest one stretched. */
const MOST_EDGE = 4096;
const MOST_ZOOM = 16;
const STEP = 1.25;
/** How far one notch of the wheel zooms. */
const WHEEL = 0.0015;

export interface PictureViewProps {
  load: (edge: number) => Promise<Thumb | null>;
  size: () => Promise<[number, number] | null>;
  keys: (handler: ((event: KeyboardEvent) => boolean) | undefined) => void;
  note: (text: string | undefined) => void;
}

/**
 * A picture that fits the window, with wheel zoom toward the pointer, drag to pan, 1:1 and turns.
 * It starts at the window's size and loads the full picture once it is zoomed past that.
 */
export function PictureView(live: PictureViewProps) {
  // The preview's props follow the row it shows. This view stays with the file it opened on.
  const props = { ...live };
  let stage!: HTMLDivElement;
  let canvas!: HTMLCanvasElement;
  /** The picture's own pixels, or those drawn when Windows can't say. */
  const [natural, setNatural] = createSignal<[number, number]>();
  /** Null fits the window. 1 shows one of the picture's pixels on each screen pixel. */
  const [zoom, setZoom] = createSignal<number | null>(null);
  const [pan, setPan] = createSignal({ x: 0, y: 0 });
  /** Quarter turns. It only grows or shrinks, so a turn always spins the short way. */
  const [turn, setTurn] = createSignal(0);
  const [box, setBox] = createSignal({ width: 0, height: 0 });
  const [dragging, setDragging] = createSignal(false);
  let drawnEdge = 0;
  let loadingFull = false;
  let gone = false;

  const fit = createMemo(() => {
    const own = natural();
    const { width, height } = box();
    if (!own || !width) return 1;
    const [w, h] = turn() % 2 ? [own[1], own[0]] : own;
    return Math.min((width * devicePixelRatio) / w, (height * devicePixelRatio) / h, 1);
  });
  const scale = () => zoom() ?? fit();

  async function load(edge: number) {
    const picture = await props.load(edge);
    if (gone || !picture) return picture;
    draw(canvas, picture);
    drawnEdge = Math.max(picture.width, picture.height);
    return picture;
  }

  /** The full picture, once the view shows more of it than the first one had. */
  function sharpen() {
    const own = natural();
    if (!own || loadingFull) return;
    const needed = Math.min(Math.max(...own) * scale(), MOST_EDGE);
    if (needed <= drawnEdge * 1.05) return;
    loadingFull = true;
    load(Math.min(Math.max(...own), MOST_EDGE)).catch(console.error);
  }

  /** Zooms to `next`, keeping the point `at` (from the middle of the stage) where it is. */
  function zoomTo(next: number | null, at = { x: 0, y: 0 }) {
    const before = scale();
    const after = next === null ? fit() : Math.min(Math.max(next, Math.min(fit(), 0.05)), MOST_ZOOM);
    const from = pan();
    const ratio = after / before;
    setZoom(next === null || Math.abs(after - fit()) < 0.001 ? null : after);
    setPan(zoom() === null ? { x: 0, y: 0 } : { x: at.x - (at.x - from.x) * ratio, y: at.y - (at.y - from.y) * ratio });
    sharpen();
  }

  const fromMiddle = (event: MouseEvent) => {
    const rect = stage.getBoundingClientRect();
    return { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 };
  };

  function onWheel(event: WheelEvent) {
    event.preventDefault();
    zoomTo(scale() * Math.exp(-event.deltaY * WHEEL), fromMiddle(event));
  }

  function onPointerDown(event: PointerEvent) {
    if (event.button !== 0 || zoom() === null) return;
    stage.setPointerCapture(event.pointerId);
    setDragging(true);
    const start = { x: event.clientX - pan().x, y: event.clientY - pan().y };
    const move = (moved: PointerEvent) => setPan({ x: moved.clientX - start.x, y: moved.clientY - start.y });
    const up = () => {
      setDragging(false);
      stage.removeEventListener("pointermove", move);
    };
    stage.addEventListener("pointermove", move);
    stage.addEventListener("pointerup", up, { once: true });
    stage.addEventListener("pointercancel", up, { once: true });
  }

  const tools = {
    in: () => zoomTo(scale() * STEP),
    out: () => zoomTo(scale() / STEP),
    actual: () => zoomTo(zoom() === null ? 1 : null),
    fit: () => zoomTo(null),
    turn: (by: number) => {
      setTurn(turn() + by);
      zoomTo(null);
    },
  };

  props.keys((event) => {
    if (event.ctrlKey || event.altKey || event.target instanceof HTMLInputElement && event.target.type !== "range") return false;
    const key = event.key.toLowerCase();
    if (key === "+" || key === "=") tools.in();
    else if (key === "-") tools.out();
    else if (key === "1") zoomTo(1);
    else if (key === "0") tools.fit();
    else if (key === "r") tools.turn(event.shiftKey ? -1 : 1);
    else return false;
    return true;
  });

  onMount(() => {
    const measure = () => setBox({ width: stage.clientWidth, height: stage.clientHeight });
    const watch = new ResizeObserver(measure);
    watch.observe(stage);
    onCleanup(() => watch.disconnect());
    measure();
    const edge = Math.ceil(Math.max(stage.clientWidth, stage.clientHeight) * devicePixelRatio);
    Promise.all([load(edge), props.size().catch(() => null)])
      .then(([picture, own]) => {
        if (gone) return;
        const size = own ?? (picture ? ([picture.width, picture.height] as [number, number]) : undefined);
        setNatural(size);
        if (own) props.note(`${own[0].toLocaleString()} × ${own[1].toLocaleString()} px`);
      })
      .catch(console.error);
  });

  onCleanup(() => {
    gone = true;
    props.keys(undefined);
    props.note(undefined);
  });

  const style = () => {
    const own = natural();
    const { x, y } = pan();
    return {
      visibility: own ? undefined : ("hidden" as const),
      width: own ? `${own[0] / devicePixelRatio}px` : undefined,
      height: own ? `${own[1] / devicePixelRatio}px` : undefined,
      transform: `translate(-50%, -50%) translate(${x}px, ${y}px) rotate(${turn() * 90}deg) scale(${scale()})`,
    };
  };

  return (
    <div
      ref={stage}
      class="picture-stage"
      data-zoomed={zoom() !== null || undefined}
      data-dragging={dragging() || undefined}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onDblClick={(event) => zoomTo(zoom() === null ? 1 : null, zoom() === null ? fromMiddle(event) : undefined)}
    >
      <canvas ref={canvas} class="preview-picture" style={style()} />
      <div class="preview-tools picture-tools" role="toolbar" aria-label="Picture">
        <button class="strip-icon" aria-label="Zoom out" aria-keyshortcuts="-" onClick={tools.out}>
          {ICON_ZOOM_OUT}
        </button>
        <button class="zoom-chip" aria-label="Zoom, click to fit" aria-keyshortcuts="0" onClick={tools.fit}>
          {Math.round(scale() * 100)}%
        </button>
        <button class="strip-icon" aria-label="Zoom in" aria-keyshortcuts="+" onClick={tools.in}>
          {ICON_ZOOM_IN}
        </button>
        <button class="strip-icon zoom-actual" aria-label="Actual size" aria-keyshortcuts="1" aria-pressed={zoom() === 1} onClick={tools.actual}>
          1:1
        </button>
        <button class="strip-icon" aria-label="Fit to window" aria-keyshortcuts="0" aria-pressed={zoom() === null} onClick={tools.fit}>
          {ICON_FIT}
        </button>
        <button class="strip-icon" aria-label="Turn right" aria-keyshortcuts="R" onClick={() => tools.turn(1)}>
          {ICON_TURN}
        </button>
      </div>
    </div>
  );
}
