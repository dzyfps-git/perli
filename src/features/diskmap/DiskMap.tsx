import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { mapFolder, onMapGrew, stopMap, type MapCell } from "../../api";
import { formatSize } from "../../ui/format";
import { openSheet } from "../../ui/sheet";
import { baseName, join, parentOf } from "../navigation/path";
import { radiiOf, relax, startSpot, type Spot } from "./pack";
import "../settings/settings.css";
import "../fileops/fileops.css";
import "./diskmap.css";

/** The biggest things get a circle each. The rest are too small to see and are only counted. */
const MOST_CELLS = 70;
/** A circle this small has no room for its name. */
const NAMED_FROM = 30;
/** How long the circles may go on settling after something changed, in frames. */
const SETTLE_FRAMES = 240;
const STILL = 0.05;
const ICON_UP = "";
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
let tickets = 0;

/**
 * What fills a folder, as circles: each thing in it is one, as big as everything under it.
 * Folders fill in as they are added up. A click on a folder goes into it.
 */
export function DiskMap(props: {
  folder: string;
  /** Opens a folder in the file list. */
  onOpen: (path: string) => void;
  /** Shows a file in its folder. */
  onShow: (path: string) => void;
  onClose: () => void;
}) {
  const [path, setPath] = createSignal(props.folder);
  const [cells, setCells] = createSignal<MapCell[]>([]);
  const [done, setDone] = createSignal(false);
  const [size, setSize] = createSignal({ width: 0, height: 0 });
  /** Bumped as the circles move, since their spots change in place. */
  const [moved, setMoved] = createSignal(0);
  const spots = new Map<string, Spot>();
  let dialog!: HTMLDialogElement;
  let stage!: HTMLDivElement;
  let close!: ReturnType<typeof openSheet>;
  let ticket = 0;
  let frame = 0;

  const shown = createMemo(() => [...cells()].sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name)).slice(0, MOST_CELLS));
  const names = createMemo(() => shown().map((cell) => cell.name));
  const radii = createMemo(() => {
    const list = radiiOf(shown().map((cell) => cell.bytes), size().width, size().height);
    return new Map(shown().map((cell, at) => [cell.name, list[at]]));
  });
  const facts = createMemo(() => new Map(shown().map((cell, at) => [cell.name, { cell, rank: at / Math.max(1, shown().length - 1) }])));
  const total = () => cells().reduce((sum, cell) => sum + cell.bytes, 0);
  const rest = () => cells().length - shown().length;

  const off = onMapGrew((grew) => {
    if (grew.ticket !== ticket) return;
    const known = new Map(cells().map((cell) => [cell.name, cell]));
    for (const cell of grew.cells) known.set(cell.name, cell);
    setCells([...known.values()]);
    setDone(grew.done);
  });

  createEffect(
    on(path, (folder) => {
      ticket = ++tickets;
      spots.clear();
      setCells([]);
      setDone(false);
      mapFolder(folder, ticket).catch(console.error);
    }),
  );

  /** Lets the circles find their places again, a frame at a time, or at once for those who want no motion. */
  function settle() {
    cancelAnimationFrame(frame);
    const { width, height } = size();
    if (!width || !height) return;
    const list = names().map((name, at) => {
      if (!spots.has(name)) spots.set(name, startSpot(at, width, height));
      return spots.get(name)!;
    });
    const sizes = names().map((name) => radii().get(name)!);
    if (reducedMotion.matches) {
      for (let step = 0; step < SETTLE_FRAMES && relax(list, sizes, width, height) > STILL; step++);
      return setMoved(moved() + 1);
    }
    let left = SETTLE_FRAMES;
    const step = () => {
      const still = relax(list, sizes, width, height) <= STILL;
      setMoved(moved() + 1);
      if (!still && --left > 0) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  }
  createEffect(on([names, radii], settle));

  onMount(() => {
    close = openSheet(dialog);
    const observer = new ResizeObserver(() => setSize({ width: stage.clientWidth, height: stage.clientHeight }));
    observer.observe(stage);
    onCleanup(() => observer.disconnect());
  });
  onCleanup(() => {
    cancelAnimationFrame(frame);
    off.then((stop) => stop());
    stopMap().catch(console.error);
  });

  /** Where a circle is and how big, as the styles both of its layers share. */
  const placed = (name: string) => {
    moved();
    const spot = spots.get(name);
    const radius = radii().get(name) ?? 0;
    return {
      width: `${radius * 2}px`,
      height: `${radius * 2}px`,
      translate: `${(spot?.x ?? 0) - radius}px ${(spot?.y ?? 0) - radius}px`,
      "--rank": facts().get(name)?.rank ?? 0,
    };
  };

  function pick(cell: MapCell) {
    const target = join(path(), cell.name);
    if (cell.folder) setPath(target);
    else close(() => props.onShow(target));
  }

  const up = () => {
    const parent = parentOf(path());
    if (parent) setPath(parent);
  };

  return (
    <dialog
      ref={dialog}
      class="settings confirm disk-map"
      aria-label="Disk map"
      onClose={props.onClose}
      onKeyDown={(event) => event.key === "Backspace" && up()}
    >
      <header class="disk-map-head">
        <button class="disk-map-up" aria-label="Up one folder" disabled={!parentOf(path())} onClick={up}>
          {ICON_UP}
        </button>
        <div class="disk-map-title">
          <h2>{baseName(path()) || path()}</h2>
          <p class="settings-note" aria-live="polite">
            {formatSize(total())}
            {done() ? ` in ${cells().length.toLocaleString()} ${cells().length === 1 ? "item" : "items"}` : " so far, still adding up…"}
          </p>
        </div>
        <button class="disk-map-open" onClick={() => close(() => props.onOpen(path()))}>
          Open this folder
        </button>
      </header>
      <div ref={stage} class="disk-map-stage" data-measuring={done() ? undefined : ""}>
        <svg class="disk-map-filter" aria-hidden="true">
          <filter id="disk-map-goo">
            <feGaussianBlur in="SourceGraphic" stdDeviation="4" result="soft" />
            <feColorMatrix in="soft" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 16 -6" result="goo" />
            <feComposite in="SourceGraphic" in2="goo" operator="atop" />
          </filter>
        </svg>
        <div class="disk-map-goo" aria-hidden="true">
          <For each={names()}>
            {(name) => <span class="disk-blob" data-folder={facts().get(name)?.cell.folder ? "" : undefined} style={placed(name)} />}
          </For>
        </div>
        <For each={names()}>
          {(name) => {
            const cell = () => facts().get(name)!.cell;
            return (
              <button
                class="disk-cell"
                data-folder={cell().folder ? "" : undefined}
                aria-label={`${name}, ${formatSize(cell().bytes)}${cell().folder ? ". Click to look inside" : ""}`}
                style={placed(name)}
                onClick={() => pick(cell())}
              >
                <Show when={(radii().get(name) ?? 0) >= NAMED_FROM}>
                  <span class="disk-cell-name">{name}</span>
                  <span class="disk-cell-size">{formatSize(cell().bytes)}</span>
                </Show>
              </button>
            );
          }}
        </For>
        <Show when={done() && cells().length === 0}>
          <p class="disk-map-empty">Nothing in this folder.</p>
        </Show>
      </div>
      <p class="settings-note">
        A circle is as big as everything under it. Click a folder to look inside, or a file to show it in its folder.
        {rest() > 0 ? ` ${rest().toLocaleString()} smaller ${rest() === 1 ? "item is" : "items are"} not drawn.` : ""}
      </p>
    </dialog>
  );
}
