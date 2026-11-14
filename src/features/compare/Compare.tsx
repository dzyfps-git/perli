import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, onMount, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { fetchBigPicture, pictureSize, wholeText, type Row } from "../../api";
import { formatSize } from "../../ui/format";
import { openSheet } from "../../ui/sheet";
import { draw } from "../preview/QuickPreview";
import { coloredLines, languageOf } from "../preview/highlight";
import { lineEnding } from "../preview/table";
import { sideChips, WHOLE, zoomed, type Lens } from "./comparable";
import { changedSpans, diffLines, linesOf, patchOf, rowsOf, spacesAside, type Row as DiffRow } from "./diff";
import "../preview/preview.css";
import "./compare.css";

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const dates = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const ICON_CLOSE = "";
const ICON_SWAP = "";
const ICON_UP = "";
const ICON_DOWN = "";
/** How far an arrow key moves the swipe line. */
const LINE_STEP = 0.05;
const BLINK_MS = 800;
const SWEEP_MS = 900;
/** Colors whole texts up to this size. */
const MOST_COLORED = 1024 * 1024;
/** Longer lines are marked whole, not word by word. */
const MOST_WORDED = 2000;

/** One of the two files, by its row in the list. */
export interface CompareSide {
  row: Row;
  index: number;
}

export interface CompareProps {
  view: number;
  snapshot: number;
  kind: "picture" | "text";
  sides: [CompareSide, CompareSide];
  onRecycle: (side: CompareSide) => void;
  onClose: () => void;
}

/** Two files side by side: two pictures under a swipe line, or two texts with what changed marked. */
export function Compare(props: CompareProps) {
  let dialog!: HTMLDialogElement;
  let tools!: HTMLSpanElement;
  let close!: () => void;
  const [swapped, setSwapped] = createSignal(false);
  /** The sides in the order they show, left first. */
  const sides = () => (swapped() ? [props.sides[1], props.sides[0]] : props.sides);
  let keys: ((event: KeyboardEvent) => boolean) | undefined;

  onMount(() => {
    close = openSheet(dialog);
  });

  function onKeyDown(event: KeyboardEvent) {
    if (event.ctrlKey || event.altKey || event.metaKey || (event.target as HTMLElement).matches("input, textarea")) return;
    if (event.key.toLowerCase() === "x") setSwapped(!swapped());
    else if (!keys?.(event)) return;
    event.preventDefault();
  }

  return (
    <dialog ref={dialog} class="quick-preview compare" aria-label="Compare" onKeyDown={onKeyDown} onClose={props.onClose}>
      <header class="compare-head">
        <span class="compare-title">
          <span>{sides()[0].row.name}</span>
          <button class="compare-icon-button" aria-label="Swap sides" aria-keyshortcuts="X" onClick={() => setSwapped(!swapped())}>
            {ICON_SWAP}
          </button>
          <span>{sides()[1].row.name}</span>
        </span>
        <span ref={tools} class="compare-slot" />
        <button class="compare-icon-button" aria-label="Close" aria-keyshortcuts="Escape" onClick={() => close()}>
          {ICON_CLOSE}
        </button>
      </header>
      {props.kind === "picture" ? (
        <PictureCompare {...props} sides={sides()} swapped={swapped()} tools={() => tools} keys={(handler) => (keys = handler)} />
      ) : (
        <TextCompare {...props} sides={sides()} swapped={swapped()} tools={() => tools} keys={(handler) => (keys = handler)} />
      )}
    </dialog>
  );
}

interface ViewProps extends Omit<CompareProps, "sides"> {
  /** In the order they show, left first. */
  sides: CompareSide[];
  swapped: boolean;
  /** Where the view's tools go, in the header. */
  tools: () => HTMLElement;
  keys: (handler: (event: KeyboardEvent) => boolean) => void;
}

/** A row of choices where the one picked wears a pill that slides over to the next pick. */
function Choices<T extends string>(props: { label: string; value: T; choices: { id: T; label: string; key: string }[]; onPick: (id: T) => void }) {
  const at = () => Math.max(0, props.choices.findIndex((choice) => choice.id === props.value));
  return (
    <div class="compare-choices" role="radiogroup" aria-label={props.label} style={{ "--at": at(), "--of": props.choices.length }}>
      <span class="compare-choice-pill" aria-hidden="true" />
      <For each={props.choices}>
        {(choice) => (
          <button role="radio" aria-checked={choice.id === props.value} aria-keyshortcuts={choice.key} onClick={() => props.onPick(choice.id)}>
            {choice.label}
          </button>
        )}
      </For>
    </div>
  );
}

/** The tools of the view on show, in the header's slot. */
function Tools(props: { slot: () => HTMLElement; children: JSX.Element }) {
  return (
    <Portal mount={props.slot()} ref={(element: HTMLDivElement) => (element.className = "compare-tools")}>
      {props.children}
    </Portal>
  );
}

/** What each file is, and what it has over the other, with a way to recycle the one not wanted. */
function Footer(props: { sides: CompareSide[]; facts: (side: CompareSide) => string[]; pixels?: (side: CompareSide) => number | undefined; onRecycle: (side: CompareSide) => void }) {
  const measure = (side: CompareSide) => ({ bytes: side.row.size, modified: side.row.modified, pixels: props.pixels?.(side) });
  return (
    <footer class="compare-sides">
      <For each={props.sides}>
        {(side, at) => (
          <div class="compare-side">
            <span class="preview-name">{side.row.name}</span>
            <span class="preview-facts">{props.facts(side).join("  ·  ")}</span>
            <For each={sideChips(measure(side), measure(props.sides[1 - at()]), formatSize)}>{(chip) => <span class="compare-chip">{chip}</span>}</For>
            <button class="details-button compare-recycle" onClick={() => props.onRecycle(side)}>
              Recycle this one
            </button>
          </div>
        )}
      </For>
    </footer>
  );
}

const fileFacts = (side: CompareSide) => [formatSize(side.row.size), side.row.modified > 0 ? dates.format(side.row.modified) : ""].filter(Boolean);

type PictureMode = "swipe" | "side" | "blink" | "difference";
const PICTURE_MODES: { id: PictureMode; label: string; key: string }[] = [
  { id: "swipe", label: "Swipe", key: "1" },
  { id: "side", label: "Side by side", key: "2" },
  { id: "blink", label: "Blink", key: "3" },
  { id: "difference", label: "Difference", key: "4" },
];

/** Two pictures over each other, cut by a line that can be dragged, or beside, blinking, or as their difference. */
function PictureCompare(props: ViewProps) {
  const [mode, setMode] = createSignal<PictureMode>("swipe");
  const [vertical, setVertical] = createSignal(false);
  const [cut, setCut] = createSignal(0.5);
  const [lens, setLens] = createSignal<Lens>(WHOLE);
  const [flip, setFlip] = createSignal(false);
  const [blinking, setBlinking] = createSignal(true);
  const [failed, setFailed] = createSignal<string>();
  const sizes = new Map<number, [number, number] | null>();
  const [sized, setSized] = createSignal(0);
  let stage!: HTMLDivElement;
  const edge = Math.min(4096, Math.ceil(Math.max(screen.width, screen.height) * devicePixelRatio));

  let drawn = 0;
  function load(canvas: HTMLCanvasElement, side: CompareSide) {
    fetchBigPicture(props.view, props.snapshot, side.index, edge)
      .then((picture) => {
        if (!picture) return setFailed(`${side.row.name} can't be shown.`);
        draw(canvas, picture);
        if (++drawn === 2) sweep();
      })
      .catch((failure) => setFailed(String(failure)));
    pictureSize(props.view, props.snapshot, side.index)
      .then((size) => {
        sizes.set(side.index, size);
        setSized(sized() + 1);
      })
      .catch(() => undefined);
  }

  /** On opening, the line sweeps in from the side and settles in the middle, so both are seen. */
  function sweep() {
    if (reducedMotion.matches || mode() !== "swipe") return;
    const start = performance.now();
    const frame = (now: number) => {
      const t = Math.min(1, (now - start) / SWEEP_MS);
      // Out past the middle, then back: a soft overshoot.
      const eased = 1 - Math.pow(1 - t, 3) * Math.cos(t * Math.PI * 1.5);
      setCut(0.92 - 0.42 * eased);
      if (t < 1) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  // Blink turns from one to the other until Space takes over.
  const timer = window.setInterval(() => mode() === "blink" && blinking() && setFlip(!flip()), BLINK_MS);
  onCleanup(() => window.clearInterval(timer));

  /** Where the pointer is, from the middle of the part of the stage it is over. */
  function fromMiddle(event: { clientX: number; clientY: number }) {
    const halves = [...stage.querySelectorAll<HTMLElement>(".compare-layer")];
    const over = mode() === "side" ? (halves.find((half) => half.getBoundingClientRect().right >= event.clientX) ?? halves[1]) : stage;
    const box = over.getBoundingClientRect();
    return { x: event.clientX - box.left - box.width / 2, y: event.clientY - box.top - box.height / 2 };
  }

  function cutAt(event: PointerEvent) {
    const box = stage.getBoundingClientRect();
    const share = vertical() ? (event.clientY - box.top) / box.height : (event.clientX - box.left) / box.width;
    setCut(Math.min(1, Math.max(0, share)));
  }

  let grab: { x: number; y: number; lens: Lens; line: boolean; moved: boolean } | undefined;
  function onPointerDown(event: PointerEvent) {
    if (event.button !== 0) return;
    const line = (event.target as HTMLElement).closest(".compare-line") !== null;
    grab = { x: event.clientX, y: event.clientY, lens: lens(), line, moved: false };
    stage.setPointerCapture(event.pointerId);
  }
  function onPointerMove(event: PointerEvent) {
    if (!grab) return;
    const dx = event.clientX - grab.x;
    const dy = event.clientY - grab.y;
    if (Math.hypot(dx, dy) > 3) grab.moved = true;
    if (grab.line) cutAt(event);
    else if (grab.moved && grab.lens.scale > 1) setLens({ ...grab.lens, x: grab.lens.x + dx, y: grab.lens.y + dy });
  }
  function onPointerUp(event: PointerEvent) {
    // A click where the pictures are not zoomed puts the line there.
    if (grab && !grab.moved && !grab.line && mode() === "swipe") cutAt(event);
    grab = undefined;
  }

  props.keys((event) => {
    const key = event.key.toLowerCase();
    const picked = PICTURE_MODES.find((choice) => choice.key === key);
    const back = vertical() ? "arrowup" : "arrowleft";
    const on = vertical() ? "arrowdown" : "arrowright";
    if (picked) setMode(picked.id);
    else if (key === "v") setVertical(!vertical());
    else if ((key === back || key === on) && mode() === "swipe") setCut(Math.min(1, Math.max(0, cut() + (key === on ? LINE_STEP : -LINE_STEP))));
    else if (key === " " || ((key === back || key === on) && mode() === "blink")) {
      setMode("blink");
      setBlinking(false);
      setFlip(!flip());
    } else if (key === "0") setLens(WHOLE);
    else if (key === "+" || key === "=") setLens(zoomed(lens(), 1.5, { x: 0, y: 0 }));
    else if (key === "-") setLens(zoomed(lens(), 1 / 1.5, { x: 0, y: 0 }));
    else return false;
    return true;
  });

  // Swapping slides the two pictures past each other, once they have traded places on the page.
  createEffect(
    on(
      () => props.swapped,
      () => {
        if (reducedMotion.matches) return;
        requestAnimationFrame(() =>
          stage.querySelectorAll(".compare-layer").forEach((layer, slot) =>
            layer.animate({ translate: [`${slot === 0 ? 48 : -48}px 0`, "0 0"], opacity: [0.3, 1] }, { duration: 420, easing: "cubic-bezier(0.3, 1.25, 0.5, 1)" }),
          ),
        );
      },
      { defer: true },
    ),
  );

  const clip = (slot: number) => {
    if (slot === 0 || mode() !== "swipe") return undefined;
    const share = `${cut() * 100}%`;
    return vertical() ? `inset(${share} 0 0 0)` : `inset(0 0 0 ${share})`;
  };
  const pixels = (side: CompareSide) => {
    sized();
    const size = sizes.get(side.index);
    return size ? size[0] * size[1] : undefined;
  };

  return (
    <>
      <Tools slot={props.tools}>
        <Choices label="How to compare" value={mode()} choices={PICTURE_MODES} onPick={setMode} />
        <Show when={mode() === "swipe"}>
          <button class="preview-chip" aria-pressed={vertical()} aria-keyshortcuts="V" onClick={() => setVertical(!vertical())}>
            {vertical() ? "Top and bottom" : "Left and right"}
          </button>
        </Show>
        <Show when={lens().scale > 1}>
          <button class="preview-chip" aria-keyshortcuts="0" onClick={() => setLens(WHOLE)}>
            {Math.round(lens().scale * 100)}% · Fit
          </button>
        </Show>
      </Tools>
      <div
        ref={stage}
        class="compare-stage"
        data-mode={mode()}
        data-vertical={vertical() ? "" : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (grab = undefined)}
        onWheel={(event) => {
          event.preventDefault();
          setLens(zoomed(lens(), Math.exp(-event.deltaY * 0.0015), fromMiddle(event)));
        }}
        onDblClick={() => setLens(WHOLE)}
      >
        <For each={props.sides}>
          {(side, slot) => (
            <div
              class="compare-layer"
              classList={{ "compare-hidden": mode() === "blink" && slot() === 1 && !flip() }}
              style={{ "clip-path": clip(slot()) }}
            >
              <div class="compare-pan" style={{ transform: `translate(${lens().x}px, ${lens().y}px) scale(${lens().scale})` }}>
                <canvas ref={(canvas) => load(canvas, side)} aria-label={side.row.name} />
              </div>
              <span class="compare-label" data-slot={slot()}>
                {side.row.name}
              </span>
            </div>
          )}
        </For>
        <Show when={mode() === "swipe"}>
          <div class="compare-line" style={{ "--cut": cut() }} role="slider" aria-label="Swipe line" aria-valuenow={Math.round(cut() * 100)} data-tip="Drag, or use the arrow keys">
            <span class="compare-knob" aria-hidden="true" />
          </div>
        </Show>
        <Show when={mode() === "blink"}>
          <span class="compare-blink-note" role="status">
            {props.sides[flip() ? 1 : 0].row.name} · {blinking() ? "Space to flip by hand" : "Space flips"}
          </span>
        </Show>
        <Show when={failed()}>
          <p class="preview-note" role="alert">
            {failed()}
          </p>
        </Show>
      </div>
      <Footer
        sides={props.sides}
        pixels={pixels}
        facts={(side) => {
          sized();
          const size = sizes.get(side.index);
          return [...(size ? [`${size[0]} × ${size[1]}`] : []), ...fileFacts(side)];
        }}
        onRecycle={props.onRecycle}
      />
    </>
  );
}

/** A text, its lines, and those lines colored, when its kind has colors. */
interface Text {
  source: string;
  lines: string[];
  html?: string[];
}

async function readText(props: { view: number; snapshot: number }, side: CompareSide): Promise<Text> {
  const source = await wholeText(props.view, props.snapshot, side.index);
  if (source === null) throw new Error(`${side.row.name} is not text.`);
  const language = languageOf(side.row.name);
  const html = language && source.length <= MOST_COLORED ? await coloredLines(language, source).catch(() => undefined) : undefined;
  return { source, lines: linesOf(source), html };
}

/** Escapes a line for the page. */
const escaped = (text: string) => text.replace(/[&<>]/g, (char) => (char === "&" ? "&amp;" : char === "<" ? "&lt;" : "&gt;"));

/** Two texts with what changed between them marked, line by line and inside lines word by word. */
function TextCompare(props: ViewProps) {
  // A failure comes back as its message, since reading a resource that failed would throw.
  const [read] = createResource(
    () => [props.sides[0], props.sides[1]] as const,
    ([a, b]) => Promise.all([readText(props, a), readText(props, b)]).catch((failure: Error) => failure.message ?? String(failure)),
  );
  const texts = () => {
    const both = read();
    return typeof both === "string" ? undefined : both;
  };
  const failure = () => {
    const both = read();
    return typeof both === "string" ? both : undefined;
  };
  const [oneColumn, setOneColumn] = createSignal(false);
  const [spaces, setSpaces] = createSignal(false);
  /** The lines of each fold that was opened, kept so their rows stay the same rows. */
  const [unfolded, setUnfolded] = createSignal(new Map<DiffRow, DiffRow[]>());
  const [current, setCurrent] = createSignal(-1);
  const [copied, setCopied] = createSignal(false);
  let scroller!: HTMLDivElement;

  const lines = createMemo(() => {
    const both = texts();
    return both ? diffLines(both[0].lines, both[1].lines, spaces() ? spacesAside : undefined) : [];
  });
  const rows = createMemo(() => rowsOf(lines()));
  // New lines bring new folds, all shut.
  createEffect(on(rows, () => setUnfolded(new Map()), { defer: true }));
  /** Rows on show: folds that were opened give back their lines. */
  const shown = createMemo(() => rows().flatMap((row) => unfolded().get(row) ?? [row]));
  const opened = createMemo(() => new Set([...unfolded().values()].flat()));
  function unfold(row: DiffRow & { kind: "fold" }) {
    const lines = row.lines.map((line): DiffRow => ({ kind: "same", a: line.a!, b: line.b! }));
    setUnfolded(new Map(unfolded()).set(row, lines));
  }
  /** Where each run of changes starts, among the rows on show, and how far down the texts it is. */
  const changes = createMemo(() => {
    const found: { row: number; share: number }[] = [];
    const all = shown();
    let line = 0;
    all.forEach((row, at) => {
      if (row.kind === "change" && all[at - 1]?.kind !== "change") found.push({ row: at, share: line / Math.max(1, lines().length) });
      line += row.kind === "fold" ? row.lines.length : 1;
    });
    return found;
  });
  // Marks the changed words again once the rows on show have changed.
  createEffect(on([shown, oneColumn], () => queueMicrotask(markWords)));
  const counts = createMemo(() => ({
    added: lines().filter((line) => line.kind === "new").length,
    removed: lines().filter((line) => line.kind === "gone").length,
  }));
  const endings = () => {
    const both = texts();
    if (!both) return undefined;
    const [a, b] = both.map((text) => lineEnding(text.source));
    return a === b ? undefined : `${a} vs ${b}`;
  };

  function jump(step: number) {
    const all = changes();
    if (all.length === 0) return;
    const next = (Math.max(-1, current()) + step + all.length) % all.length;
    goTo(next);
  }

  function goTo(change: number) {
    setCurrent(change);
    const row = scroller.querySelector<HTMLElement>(`[data-row="${changes()[change].row}"]`);
    if (!row) return;
    row.scrollIntoView({ block: "center", behavior: reducedMotion.matches ? "auto" : "smooth" });
    if (!reducedMotion.matches) row.animate({ backgroundColor: ["color-mix(in srgb, var(--accent) 35%, transparent)", "transparent"] }, { duration: 900, easing: "ease-out" });
  }

  async function copyPatch() {
    const both = texts();
    if (!both) return;
    await navigator.clipboard.writeText(patchOf(props.sides[0].row.name, props.sides[1].row.name, both[0].lines, both[1].lines, lines()));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  props.keys((event) => {
    const key = event.key.toLowerCase();
    if (key === "n") jump(event.shiftKey ? -1 : 1);
    else if (key === "p") jump(-1);
    else if (key === "u") setOneColumn(!oneColumn());
    else if (key === "w") setSpaces(!spaces());
    else return false;
    return true;
  });

  /** A line's own HTML: colored when its kind has colors, plain and escaped when not. */
  const lineHtml = (side: 0 | 1, at: number | undefined) => {
    const text = texts()?.[side];
    if (!text || at === undefined) return "";
    return text.html?.[at] ?? escaped(text.lines[at]);
  };

  /** Marks the words that changed in each changed line that has a partner, with the page's own highlights. */
  function markWords() {
    const both = texts();
    if (!both || !("highlights" in CSS)) return;
    const gone: Range[] = [];
    const fresh: Range[] = [];
    for (const cell of scroller.querySelectorAll<HTMLElement>(".diff-line[data-pair]")) {
      const [a, b] = cell.dataset.pair!.split(",").map(Number);
      const textA = both[0].lines[a];
      const textB = both[1].lines[b];
      if (textA.length > MOST_WORDED || textB.length > MOST_WORDED) continue;
      const spans = changedSpans(textA, textB);
      const isA = cell.dataset.side === "0";
      for (const [start, end] of isA ? spans.a : spans.b) {
        const range = rangeIn(cell, start, end);
        if (range) (isA ? gone : fresh).push(range);
      }
    }
    CSS.highlights.set("diff-gone-word", new Highlight(...gone));
    CSS.highlights.set("diff-new-word", new Highlight(...fresh));
  }
  onCleanup(() => {
    if (!("highlights" in CSS)) return;
    CSS.highlights.delete("diff-gone-word");
    CSS.highlights.delete("diff-new-word");
  });

  const number = (at: number | undefined) => (at === undefined ? "" : String(at + 1));
  const cell = (side: 0 | 1, at: number | undefined, kind: string, pair?: string) => (
    <>
      <span class="diff-number" aria-hidden="true">
        {number(at)}
      </span>
      <span class="diff-line" data-kind={at === undefined ? "none" : kind} data-side={side} data-pair={pair} innerHTML={lineHtml(side, at)} />
    </>
  );

  return (
    <>
      <Tools slot={props.tools}>
        <Choices
          label="Layout"
          value={oneColumn() ? "one" : "side"}
          choices={[
            { id: "side", label: "Side by side", key: "U" },
            { id: "one", label: "One column", key: "U" },
          ]}
          onPick={(id) => setOneColumn(id === "one")}
        />
        <button class="preview-chip" aria-pressed={spaces()} aria-keyshortcuts="W" onClick={() => setSpaces(!spaces())}>
          Ignore spaces
        </button>
        <Show when={changes().length > 0}>
          <button class="compare-icon-button" aria-label="Previous change" aria-keyshortcuts="Shift+N" onClick={() => jump(-1)}>
            {ICON_UP}
          </button>
          <button class="compare-icon-button" aria-label="Next change" aria-keyshortcuts="N" onClick={() => jump(1)}>
            {ICON_DOWN}
          </button>
          <button class="preview-chip" onClick={() => void copyPatch()}>
            {copied() ? "Copied" : "Copy as patch"}
          </button>
        </Show>
      </Tools>
      <div class="compare-text">
        <Show when={failure()}>
          <p class="preview-note" role="alert">
            {failure()}
          </p>
        </Show>
        <Show when={texts()}>
          <div class="diff-summary" role="status">
            <Show
              when={changes().length > 0}
              fallback={
                <span class="diff-same">
                  <svg class="diff-check" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M5 12.5l4.5 4.5L19 7.5" />
                  </svg>
                  {endings() ? `Same lines. Only the line endings differ (${endings()}).` : spaces() ? "These files are the same, apart from spaces." : "These files are the same."}
                </span>
              }
            >
              <span class="compare-chip diff-chip-new">+{counts().added.toLocaleString()}</span>
              <span class="compare-chip diff-chip-gone">−{counts().removed.toLocaleString()}</span>
              <span class="preview-facts">
                {changes().length.toLocaleString()} {changes().length === 1 ? "change" : "changes"}
                {current() >= 0 ? ` · ${current() + 1} of ${changes().length}` : ""}
              </span>
              <Show when={endings()}>
                <span class="compare-chip">{endings()}</span>
              </Show>
            </Show>
          </div>
          <div ref={(element) => (scroller = element)} class="diff-scroll" tabindex="0" data-one={oneColumn() ? "" : undefined}>
            <div class="diff-rows" style={{ "--number": `${String(Math.max(texts()![0].lines.length, texts()![1].lines.length)).length + 1}ch` }}>
              <For each={shown()}>
                {(row, at) => {
                  if (row.kind === "fold") {
                    return (
                      <button class="diff-fold" data-row={at()} onClick={() => unfold(row)}>
                        {row.lines.length.toLocaleString()} same lines
                      </button>
                    );
                  }
                  const pair = row.kind === "change" && row.a !== undefined && row.b !== undefined ? `${row.a},${row.b}` : undefined;
                  return (
                    <div class="diff-row" classList={{ "diff-unfolded": opened().has(row) }} data-row={at()} data-kind={row.kind}>
                      <Show
                        when={oneColumn()}
                        fallback={
                          <>
                            {cell(0, row.a, row.kind === "same" ? "same" : "gone", pair)}
                            {cell(1, row.b, row.kind === "same" ? "same" : "new", pair)}
                          </>
                        }
                      >
                        <Show when={row.kind === "same"} fallback={<OneColumnChange cell={cell} a={row.a} b={row.b} pair={pair} />}>
                          {cell(1, row.b, "same")}
                        </Show>
                      </Show>
                    </div>
                  );
                }}
              </For>
            </div>
          </div>
          <div class="diff-strip" aria-label="Where the changes are">
            <For each={changes()}>
              {(change, at) => (
                <button
                  class="diff-mark"
                  classList={{ "diff-mark-on": at() === current() }}
                  style={{ top: `${change.share * 100}%` }}
                  aria-label={`Change ${at() + 1}`}
                  tabindex="-1"
                  onClick={() => goTo(at())}
                />
              )}
            </For>
          </div>
        </Show>
      </div>
      <Footer
        sides={props.sides}
        facts={(side) => {
          const text = texts()?.[props.sides.indexOf(side)];
          return [...(text ? [`${text.lines.length.toLocaleString()} lines`] : []), ...fileFacts(side)];
        }}
        onRecycle={props.onRecycle}
      />
    </>
  );
}

/** A changed row in one column: the line as it was, then as it is. */
function OneColumnChange(props: { cell: (side: 0 | 1, at: number | undefined, kind: string, pair?: string) => JSX.Element; a?: number; b?: number; pair?: string }) {
  return (
    <>
      <Show when={props.a !== undefined}>
        <div class="diff-one">{props.cell(0, props.a, "gone", props.pair)}</div>
      </Show>
      <Show when={props.b !== undefined}>
        <div class="diff-one">{props.cell(1, props.b, "new", props.pair)}</div>
      </Show>
    </>
  );
}

/** A range over the characters `start` to `end` of the text inside `element`, across its spans. */
function rangeIn(element: HTMLElement, start: number, end: number) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let passed = 0;
  let begun = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent!.length;
    if (!begun && start < passed + length) {
      range.setStart(node, start - passed);
      begun = true;
    }
    if (begun && end <= passed + length) {
      range.setEnd(node, end - passed);
      return range;
    }
    passed += length;
  }
  return undefined;
}
