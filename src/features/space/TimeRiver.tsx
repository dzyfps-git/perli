import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { activity, changedBetween, onRiverGrew, recentFiles, river, stopRiver, type Activity, type Recent } from "../../api";
import { formatSize } from "../../ui/format";
import { openSheet } from "../../ui/sheet";
import { baseName, join } from "../navigation/path";
import { rememberRecent } from "../reach/reach";
import type { Palette, Rgb } from "./draw";
import { readPalette, reducedMotion, watchPalette } from "./lenses";
import { addQuarters, columns, DAY, dayEnd, dayKey, dayStart, HOUR, hourStart, panned, riverOf, softened, sumBetween, ticks, wholeSpan, zoomed, type River } from "./river";
import "../settings/settings.css";
import "./space.css";

const ICON_OUT = "";
const ICON_IN = "";
/** Pixels each stretch of the river takes. */
const COLUMN = 3;
const SPECKS = 240;
/** The river's frames a second while its specks drift. */
const FPS = 30;
const MARGIN = { left: 20, right: 20, top: 26, bottom: 34 };
/** Lines of each part of a day's journal. */
const MOST_LINES = 8;
let tickets = 0;

const rgba = ([red, green, blue]: Rgb, alpha: number) => `rgba(${red},${green},${blue},${Math.max(0, Math.min(1, alpha))})`;
const longDay = (time: number) => new Date(time).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });

/** Specks scattered once: where along the river each starts, how far off its middle, how fast it drifts. */
const specks = Array.from({ length: SPECKS }, (_, at) => {
  const random = (salt: number) => ((Math.sin(at * 12.9898 + salt * 78.233) * 43758.5453) % 1 + 1) % 1;
  return { along: random(1), off: random(2) - 0.5, speed: 0.004 + random(3) * 0.008 };
});

/**
 * The Time river: every file under a folder by when it last changed, as a river that is wider
 * where more changed. Wheel or the buttons zoom from years to hours, dragging scrubs along it,
 * and a click on a day tells what happened then.
 */
export function TimeRiver(props: {
  folder: string;
  /** Hidden and system files count too, as the file list shows them. */
  showHidden: boolean;
  showSystem: boolean;
  downloads?: string;
  /** Shows the files under the folder that changed on `day`, as `YYYY-MM-DD`. */
  onShowDay: (folder: string, day: string) => void;
  /** Shows a file in its folder. */
  onShow: (path: string) => void;
  onClose: () => void;
}) {
  const known = new Map<number, [number, number]>();
  const [flow, setFlow] = createSignal<River>(riverOf(known));
  const [done, setDone] = createSignal(false);
  const [span, setSpan] = createSignal<[number, number]>(wholeSpan(flow()));
  /** Once the user zooms or scrubs, the span stays where they put it as more is counted. */
  let moved = false;
  const [picked, setPicked] = createSignal<number>();
  const [pointer, setPointer] = createSignal<number>();
  const [size, setSize] = createSignal({ width: 0, height: 0 });
  const [palette, setPalette] = createSignal<Palette>(readPalette());
  const [log, setLog] = createSignal<Activity[]>([]);
  const [opened, setOpened] = createSignal<Recent[]>([]);
  const [downloaded, setDownloaded] = createSignal<string[]>([]);
  let dialog!: HTMLDialogElement;
  let stage!: HTMLDivElement;
  let canvas!: HTMLCanvasElement;
  let close!: ReturnType<typeof openSheet>;
  let frame = 0;
  let last = 0;
  const ticket = ++tickets;

  const whole = createMemo(() => wholeSpan(flow()));
  const total = createMemo(() => sumBetween(flow(), -Infinity, Infinity));
  const plot = () => ({ left: MARGIN.left, width: Math.max(1, size().width - MARGIN.left - MARGIN.right), top: MARGIN.top, height: Math.max(1, size().height - MARGIN.top - MARGIN.bottom) });
  const timeAt = (x: number) => span()[0] + ((x - plot().left) / plot().width) * (span()[1] - span()[0]);
  const xOf = (time: number) => plot().left + ((time - span()[0]) / (span()[1] - span()[0])) * plot().width;
  /** Hours show when the span is short enough to tell them apart. */
  const fine = () => span()[1] - span()[0] < 4 * DAY;

  const off = onRiverGrew((grew) => {
    if (grew.ticket !== ticket) return;
    addQuarters(known, grew.quarters);
    setFlow(riverOf(known));
    if (!moved) setSpan(wholeSpan(flow()));
    if (grew.done) setDone(true);
  });
  river(props.folder, ticket, props.showHidden, props.showSystem).catch(console.error);
  activity().then(setLog).catch(() => setLog([]));
  if (rememberRecent()) recentFiles(300).then(setOpened).catch(() => setOpened([]));

  createEffect(() => {
    const day = picked();
    setDownloaded([]);
    if (day === undefined || !props.downloads) return;
    changedBetween(props.downloads, day, dayEnd(day)).then(setDownloaded).catch(() => setDownloaded([]));
  });

  /** The stretch of the river at the pointer: a day, or an hour when zoomed in close. */
  const stretchAt = (time: number): [number, number] => (fine() ? [hourStart(time), hourStart(time) + HOUR] : [dayStart(time), dayEnd(time)]);

  function paint(seconds: number) {
    const context = canvas.getContext("2d");
    const { width, height } = size();
    if (!context || !width) return;
    const colors = palette();
    const area = plot();
    const [from, to] = span();
    context.clearRect(0, 0, width, height);

    const count = Math.max(2, Math.floor(area.width / COLUMN));
    const banks = softened(columns(flow(), from, to, count), 2);
    const most = Math.max(1, ...banks);
    const widest = area.height * 0.82;
    const middle = area.top + area.height / 2;
    const thick = banks.map((files) => (files > 0 ? 2 + (widest - 2) * Math.sqrt(files / most) : 0.6));
    // The river bends a little, the same way whatever the zoom, so it reads as water and not a chart.
    const bend = (x: number) => middle + Math.sin(x / 140) * area.height * 0.035;
    const xAt = (at: number) => area.left + (at + 0.5) * (area.width / count);

    const picks = picked();
    if (picks !== undefined) {
      const [left, right] = [xOf(picks), xOf(dayEnd(picks))];
      context.fillStyle = rgba(colors.accent[1], 0.1);
      context.fillRect(left, area.top - 8, Math.max(2, right - left), area.height + 16);
    }

    context.beginPath();
    thick.forEach((size, at) => context[at ? "lineTo" : "moveTo"](xAt(at), bend(xAt(at)) - size / 2));
    for (let at = thick.length - 1; at >= 0; at--) context.lineTo(xAt(at), bend(xAt(at)) + thick[at] / 2);
    context.closePath();
    context.fillStyle = rgba(colors.muted, colors.dark ? 0.16 : 0.12);
    context.fill();
    context.strokeStyle = rgba(colors.muted, 0.42);
    context.lineWidth = 1;
    context.stroke();

    // Files as specks drifting down the river, more where it runs wider.
    const drift = reducedMotion.matches ? 0 : seconds;
    for (const speck of specks) {
      const along = (speck.along + drift * speck.speed) % 1;
      const at = Math.min(count - 1, Math.floor(along * count));
      if (thick[at] < 4 || speck.along * 7 % 1 > thick[at] / widest + 0.15) continue;
      const x = xAt(at);
      context.fillStyle = rgba(colors.text, 0.18 + 0.4 * (thick[at] / widest));
      context.beginPath();
      context.arc(x, bend(x) + speck.off * thick[at] * 0.8, 1.1, 0, Math.PI * 2);
      context.fill();
    }

    const at = pointer();
    if (at !== undefined) {
      context.strokeStyle = rgba(colors.text, 0.3);
      context.beginPath();
      context.moveTo(at, area.top - 8);
      context.lineTo(at, area.top + area.height + 8);
      context.stroke();
    }

    context.font = `11px ui-monospace, "Cascadia Mono", Consolas, monospace`;
    context.textAlign = "center";
    for (const tick of ticks(from, to, area.width)) {
      const x = xOf(tick.time);
      context.fillStyle = rgba(colors.muted, tick.major ? 0.95 : 0.7);
      context.fillText(tick.label, x, height - 12);
      context.fillRect(x, height - MARGIN.bottom + 4, 1, tick.major ? 6 : 3);
    }
  }

  /** Draws while the specks drift, a few times a second at most, and once on each change otherwise. */
  function loop(time: number) {
    frame = requestAnimationFrame(loop);
    if (time - last < 1000 / FPS) return;
    last = time;
    paint(time / 1000);
  }
  const repaint = () => reducedMotion.matches && paint(0);
  createEffect(() => {
    flow();
    span();
    picked();
    pointer();
    palette();
    size();
    repaint();
  });

  // Scrubbing: a drag moves along the river, and a click with no drag picks the day under it.
  let pressed: { x: number; span: [number, number]; dragged: boolean } | undefined;
  function down(event: PointerEvent) {
    canvas.setPointerCapture(event.pointerId);
    pressed = { x: event.clientX, span: span(), dragged: false };
  }
  function move(event: PointerEvent) {
    const x = event.clientX - canvas.getBoundingClientRect().left;
    setPointer(x);
    if (!pressed) return;
    const by = event.clientX - pressed.x;
    if (Math.abs(by) > 3) pressed.dragged = true;
    if (!pressed.dragged) return;
    moved = true;
    const perPixel = (pressed.span[1] - pressed.span[0]) / plot().width;
    setSpan(panned(pressed.span, -by * perPixel, whole()));
  }
  function up(event: PointerEvent) {
    if (pressed && !pressed.dragged) pick(timeAt(event.clientX - canvas.getBoundingClientRect().left));
    pressed = undefined;
  }
  function wheel(event: WheelEvent) {
    event.preventDefault();
    zoomBy(event.deltaY > 0 ? 1.25 : 0.8, timeAt(event.clientX - canvas.getBoundingClientRect().left));
  }

  function zoomBy(factor: number, at = picked() !== undefined ? picked()! + DAY / 2 : (span()[0] + span()[1]) / 2) {
    moved = true;
    setSpan(zoomed(span(), at, factor, whole()));
  }

  function pick(time: number) {
    const day = dayStart(time);
    setPicked(picked() === day ? undefined : day);
  }

  /** Steps the picked day by `by` days, keeping it in view. */
  function step(by: number) {
    const day = picked() ?? dayStart((span()[0] + span()[1]) / 2);
    const next = new Date(day);
    next.setDate(next.getDate() + by);
    setPicked(next.getTime());
    const [from, to] = span();
    if (next.getTime() < from || next.getTime() + DAY > to) {
      moved = true;
      setSpan(panned(span(), next.getTime() + DAY / 2 - (from + to) / 2, whole()));
    }
  }

  function keys(event: KeyboardEvent) {
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    const act: Record<string, () => void> = {
      ArrowLeft: () => step(-1),
      ArrowRight: () => step(1),
      "+": () => zoomBy(0.8),
      "=": () => zoomBy(0.8),
      "-": () => zoomBy(1.25),
      "0": () => all(),
      Home: () => all(),
      Enter: () => showDay(),
    };
    if (!act[event.key] || (event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    act[event.key]();
  }

  function all() {
    moved = false;
    setSpan(whole());
  }

  function showDay() {
    const day = picked();
    if (day !== undefined) close(() => props.onShowDay(props.folder, dayKey(day)));
  }

  const card = createMemo(() => {
    const x = pointer();
    if (x === undefined || x < plot().left || x > plot().left + plot().width) return undefined;
    const [from, to] = stretchAt(timeAt(x));
    const { files, bytes } = sumBetween(flow(), from, to);
    const when = fine()
      ? `${new Date(from).toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${new Date(from).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`
      : new Date(from).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
    const what = files ? `${files.toLocaleString()} ${files === 1 ? "file" : "files"} · ${formatSize(bytes)}` : "Nothing changed";
    return { x, flip: x > size().width - 220, lines: [when, what] };
  });

  const day = createMemo(() => {
    const start = picked();
    if (start === undefined) return undefined;
    const end = dayEnd(start);
    const within = (time: number) => time >= start && time < end;
    return {
      start,
      ...sumBetween(flow(), start, end),
      log: log().filter((step) => within(step.at)).slice(0, MOST_LINES),
      opened: opened().filter((file) => within(file.opened)).slice(0, MOST_LINES),
    };
  });

  onMount(() => {
    close = openSheet(dialog);
    const resize = new ResizeObserver(() => {
      const width = stage.clientWidth;
      const height = stage.clientHeight;
      const ratio = devicePixelRatio || 1;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      canvas.getContext("2d")?.setTransform(ratio, 0, 0, ratio, 0, 0);
      setSize({ width, height });
    });
    resize.observe(stage);
    const unwatch = watchPalette(setPalette);
    if (!reducedMotion.matches) frame = requestAnimationFrame(loop);
    onCleanup(() => {
      resize.disconnect();
      unwatch();
    });
  });

  onCleanup(() => {
    cancelAnimationFrame(frame);
    off.then((stop) => stop());
    stopRiver().catch(console.error);
  });

  const status = () => {
    const { files, bytes } = total();
    const counted = `${files.toLocaleString()} ${files === 1 ? "file" : "files"}, ${formatSize(bytes)}`;
    return done() ? counted : `${counted} so far, still counting…`;
  };

  return (
    <dialog ref={dialog} class="settings confirm space river" aria-label="Time river" onClose={props.onClose} onKeyDown={keys}>
      <header class="space-head">
        <div class="space-title">
          <h2>Time river · {baseName(props.folder) || props.folder}</h2>
          <p class="settings-note" aria-live="polite">
            {status()}
          </p>
        </div>
        <button class="space-button space-up" aria-label="Zoom out" aria-keyshortcuts="-" onClick={() => zoomBy(1.25)}>
          {ICON_OUT}
        </button>
        <button class="space-button space-up" aria-label="Zoom in" aria-keyshortcuts="+" onClick={() => zoomBy(0.8)}>
          {ICON_IN}
        </button>
        <button class="space-button" aria-keyshortcuts="0" onClick={all}>
          All of it
        </button>
      </header>
      <div class="river-body">
        <div ref={stage} class="space-stage" data-measuring={done() ? undefined : ""}>
          <canvas
            ref={canvas}
            tabIndex={0}
            role="application"
            aria-label="The river of days. Left and Right pick a day, plus and minus zoom, Enter shows that day's files."
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerLeave={() => setPointer(undefined)}
            onWheel={wheel}
          />
          <Show when={card()}>
            {(shown) => (
              <div class="space-card" data-flip={shown().flip ? "" : undefined} style={{ left: `${shown().x + (shown().flip ? -12 : 12)}px`, top: "10px" }} aria-hidden="true">
                <span class="space-card-name">{shown().lines[0]}</span>
                <span>{shown().lines[1]}</span>
              </div>
            )}
          </Show>
          <Show when={done() && total().files === 0}>
            <p class="space-empty">No files here to tell the time by.</p>
          </Show>
        </div>
        <aside class="river-journal" aria-live="polite">
          <Show when={day()} fallback={<p class="settings-note">Click a day to see what happened then: what changed here, what was downloaded and opened, and what Perli did.</p>}>
            {(shown) => (
              <>
                <h3>{longDay(shown().start)}</h3>
                <p class="settings-note">
                  {shown().files ? `${shown().files.toLocaleString()} ${shown().files === 1 ? "file" : "files"} changed here · ${formatSize(shown().bytes)}` : "Nothing here changed that day."}
                </p>
                <Show when={shown().files > 0}>
                  <button class="space-button river-show" onClick={showDay}>
                    Show these files
                  </button>
                </Show>
                <Journal title="Downloaded" lines={downloaded().slice(0, MOST_LINES).map((name) => ({ text: name, path: join(props.downloads!, name) }))} onShow={(path) => close(() => props.onShow(path))} />
                <Journal title="Opened" lines={shown().opened.map((file) => ({ text: file.name, path: file.path }))} onShow={(path) => close(() => props.onShow(path))} />
                <Journal title="Done in Perli" lines={shown().log.map((step) => ({ text: step.text, path: step.path }))} onShow={(path) => close(() => props.onShow(path))} />
              </>
            )}
          </Show>
        </aside>
      </div>
      <p class="settings-note">Each file sits on the day it last changed, so the river runs wider where more was done. Drag to move along it, and wheel to zoom from years to hours.</p>
    </dialog>
  );
}

/** One part of a day's journal, each line a way to the file it names. */
function Journal(props: { title: string; lines: { text: string; path: string }[]; onShow: (path: string) => void }) {
  return (
    <Show when={props.lines.length > 0}>
      <h4>{props.title}</h4>
      <ul class="river-lines">
        <For each={props.lines}>
          {(line) => (
            <li>
              <Show when={line.path} fallback={<span>{line.text}</span>}>
                <button class="space-link" onClick={() => props.onShow(line.path)}>
                  {line.text}
                </button>
              </Show>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}
