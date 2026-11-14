import * as pdfjs from "pdfjs-dist";
import worker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { convertFileSrc } from "@tauri-apps/api/core";
import { batch, createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { saved, stored } from "../filelist/prefs";
import { findIn, scrollToRange } from "./FindBar";
import { Minimap } from "./Minimap";
import { minimapShown, setMinimapShown } from "./viewerPrefs";
import { seenPart, type ViewRect } from "./zoomView";

pdfjs.GlobalWorkerOptions.workerSrc = worker;

const ICON_FIND = "";
const ICON_UP = "";
const ICON_DOWN = "";
const ICON_CLOSE = "";
const ICON_STRIP = "";
const ICON_OUTLINE = "";
const ICON_SPREAD = "";
const ICON_NIGHT = "";
const ICON_COPY = "";
const ICON_ZOOM_IN = "";
const ICON_ZOOM_OUT = "";

/** pdf.js's own files: character maps for Asian text, the 14 standard fonts, and the image
 *  decoders it uses in place of WebAssembly, which the window's security rules leave out. */
const FILES = import.meta.env.DEV ? "/node_modules/pdfjs-dist/" : "/pdfjs/";
/** CSS pixels per PDF point, so 100% is the page's printed size. */
const CSS_UNITS = pdfjs.PixelsPerInch.PDF_TO_CSS_UNITS;
const GAP = 12;
const PAD = 16;
const LEAST_ZOOM = 0.25;
const MOST_ZOOM = 8;
const ZOOM_STEP = 1.2;
const WHEEL = 0.0015;
/** A page drawn bigger than this many pixels is drawn coarser, which saves the memory. */
const MOST_PIXELS = 16_000_000;
const THUMB_WIDTH = 112;
const COPY_SCALE = 2;
const DONE_MS = 1400;
const MOST_PLACES = 200;
const MOST_MATCHES = 5000;
/** Paper sizes by name, in millimetres, short side first. */
const PAPERS: [string, number, number][] = [
  ["A3", 297, 420],
  ["A4", 210, 297],
  ["A5", 148, 210],
  ["Letter", 215.9, 279.4],
  ["Legal", 215.9, 355.6],
  ["Tabloid", 279.4, 431.8],
];

type Fit = "width" | "page" | "zoom";
const [fit, setFit] = stored<Fit>("pdf-fit", saved("pdf-fit") === "page" ? "page" : "width");
const [spread, setSpread] = stored("pdf-spread", saved("pdf-spread") === true);
const [night, setNight] = stored("pdf-night", saved("pdf-night") === true);
const [side, setSide] = stored<"pages" | "outline" | "">("pdf-side", saved("pdf-side") === "outline" ? "outline" : saved("pdf-side") === "pages" ? "pages" : "");

const places = () => (saved("pdf-pages") as Record<string, number> | null) ?? {};
function keepPage(path: string, page: number) {
  const all = places();
  delete all[path];
  if (page) all[path] = page;
  localStorage.setItem("perli-pdf-pages", JSON.stringify(Object.fromEntries(Object.entries(all).slice(-MOST_PLACES))));
}

/** A paper size's name for a page `width` by `height` points, or its size in millimetres. */
export function paperName(width: number, height: number) {
  const [short, long] = [Math.min(width, height), Math.max(width, height)].map((side) => (side * 25.4) / 72);
  const named = PAPERS.find(([, a, b]) => Math.abs(a - short) < 2 && Math.abs(b - long) < 2);
  return named ? named[0] : `${Math.round((width * 25.4) / 72)} × ${Math.round((height * 25.4) / 72)} mm`;
}

interface Heading {
  title: string;
  dest: string | unknown[] | null;
  items: Heading[];
}

interface Size {
  width: number;
  height: number;
}

export interface PdfViewProps {
  path: string;
  /** The file's path, opened for the window to read parts of. */
  open: () => Promise<string>;
  keys: (handler: ((event: KeyboardEvent) => boolean) | undefined) => void;
  note: (text: string | undefined) => void;
}

/**
 * A PDF, page under page: a strip of the pages or the document's own outline beside it, find
 * across every page, text to select, fit to the width or the page, two pages side by side, night
 * pages, the place kept for next time, and a page copied as a picture.
 */
export function PdfView(live: PdfViewProps) {
  const props = { ...live };
  let scroller!: HTMLDivElement;
  let findInput: HTMLInputElement | undefined;
  let pageInput: HTMLInputElement | undefined;
  let task: pdfjs.PDFDocumentLoadingTask | undefined;
  let gone = false;
  const [doc, setDoc] = createSignal<pdfjs.PDFDocumentProxy>();
  const [problem, setProblem] = createSignal<string>();
  /** The password asked for, and whether the last one was wrong. */
  const [locked, setLocked] = createSignal<{ answer: (password: string) => void; wrong: boolean }>();
  /** Each page's size in points. Until a page is read it takes the first one's. */
  const [sizes, setSizes] = createSignal<Size[]>([]);
  const [stage, setStage] = createSignal<Size>({ width: 0, height: 0 });
  const [zoom, setZoom] = createSignal(1);
  const [current, setCurrent] = createSignal(0);
  const [outline, setOutline] = createSignal<Heading[]>([]);
  const [facts, setFacts] = createSignal<string[]>([]);
  const [offer, setOffer] = createSignal(0);
  const [copied, setCopied] = createSignal(false);
  /** Bumped as the page scrolls, for the map. */
  const [moved, setMoved] = createSignal(0);
  const savedPage = places()[props.path] ?? 0;

  // Each page draws itself while it is near the view.
  const shown = new Map<Element, (near: boolean) => void>();
  const canvases = new Map<number, HTMLCanvasElement>();
  const textLayers = new Map<number, HTMLElement>();
  /** Made on mount, so its margin reaches a view's height past the scroller's edges. */
  let watch!: IntersectionObserver;
  const onSeen = (entries: IntersectionObserverEntry[]) => {
    for (const entry of entries) shown.get(entry.target)?.(entry.isIntersecting);
  };

  const count = () => sizes().length;
  const sizeOf = (at: number) => sizes()[at] ?? sizes()[0] ?? { width: 612, height: 792 };
  /** CSS pixels per point the pages show at. A fit is to the biggest page, so it holds as pages scroll by. */
  const scale = createMemo(() => {
    if (fit() === "zoom") return zoom() * CSS_UNITS;
    const room = stage();
    const widest = sizes().reduce((most, one) => Math.max(most, one.width), 1);
    const tallest = sizes().reduce((most, one) => Math.max(most, one.height), 1);
    const width = Math.max(room.width - PAD * 2 - (spread() ? GAP : 0), 50) / (spread() ? widest * 2 : widest);
    return fit() === "page" ? Math.min(width, Math.max(room.height - PAD * 2, 50) / tallest) : width;
  });
  const percent = () => Math.round((scale() / CSS_UNITS) * 100);
  /** Pages in rows: one each, or two side by side. */
  const rows = createMemo(() => {
    const all = Array.from({ length: count() }, (_, at) => at);
    if (!spread()) return all.map((at) => [at]);
    const paired: number[][] = [];
    for (let at = 0; at < all.length; at += 2) paired.push(all.slice(at, at + 2));
    return paired;
  });

  onMount(() => {
    watch = new IntersectionObserver(onSeen, { root: scroller, rootMargin: "100% 0px" });
    const room = new ResizeObserver(() => keepPlace(() => setStage({ width: scroller.clientWidth, height: scroller.clientHeight })));
    room.observe(scroller);
    onCleanup(() => room.disconnect());
    if (!scroller.closest(".preview-docked")) scroller.focus({ preventScroll: true });
    void load().catch((reason) => !gone && setProblem(`This PDF can't be read: ${reason instanceof Error ? reason.message : reason}`));
  });

  async function load() {
    const url = convertFileSrc(await props.open());
    if (gone) return;
    task = pdfjs.getDocument({
      url,
      cMapUrl: `${FILES}cmaps/`,
      standardFontDataUrl: `${FILES}standard_fonts/`,
      wasmUrl: `${FILES}wasm/`,
      useWasm: false,
    });
    task.onPassword = (answer: (password: string) => void, reason: number) =>
      setLocked({ answer, wrong: reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD });
    const opened = await task.promise;
    if (gone) return;
    setLocked(undefined);
    const first = (await opened.getPage(1)).getViewport({ scale: 1 });
    batch(() => {
      setSizes(Array.from({ length: opened.numPages }, () => ({ width: first.width, height: first.height })));
      setDoc(opened);
      if (savedPage > 0 && savedPage < opened.numPages) setOffer(savedPage);
    });
    void opened.getOutline().then((found) => !gone && setOutline((found as Heading[] | null) ?? []));
    void opened.getMetadata().then(({ info }) => {
      const known = info as Record<string, unknown>;
      const text = (key: string) => (typeof known[key] === "string" && (known[key] as string).trim()) || undefined;
      setFacts(
        [
          text("Title"),
          text("Author") && `by ${text("Author")}`,
          paperName(first.width, first.height),
          text("PDFFormatVersion") && `PDF ${text("PDFFormatVersion")}`,
          text("EncryptFilterName") && "Locked",
          text("Producer") ?? text("Creator"),
        ].filter((fact): fact is string => !!fact),
      );
    });
  }

  onCleanup(() => {
    gone = true;
    watch.disconnect();
    props.keys(undefined);
    props.note(undefined);
    closeFind();
    void task?.destroy();
  });

  createEffect(() => {
    if (count()) props.note(`Page ${current() + 1} of ${count()}`);
  });
  createEffect(on(current, (at) => doc() && keepPage(props.path, at), { defer: true }));

  const pageElement = (at: number) => scroller.querySelector<HTMLElement>(`[data-page="${at}"]`);

  /**
   * Makes a change that resizes pages (a page found to be bigger than the first, a side panel
   * opening) and keeps the spot being read where it was on screen.
   */
  function keepPlace(change: () => void) {
    const at = current();
    const before = pageElement(at);
    const into = before ? (scroller.scrollTop - before.offsetTop) / scale() : 0;
    change();
    const after = pageElement(at);
    if (after) scroller.scrollTop = after.offsetTop + into * scale();
  }

  function go(at: number, top = 0) {
    const target = pageElement(Math.min(Math.max(at, 0), count() - 1));
    if (!target) return;
    setOffer(0);
    scroller.scrollTo({ top: target.offsetTop - PAD + top * scale(), left: scroller.scrollLeft });
  }

  /**
   * The page being read is the last to start above the middle of the view, or the last page once
   * the view is at the bottom. Pages run top to bottom, so a halving search finds it straight
   * after a jump, before any observer has caught up.
   */
  function onScroll() {
    setMoved(moved() + 1);
    const top = (at: number) => pageElement(at)?.offsetTop ?? Infinity;
    const middle = scroller.scrollTop + scroller.clientHeight / 2;
    const bottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
    let low = 0;
    let high = count() - 1;
    if (bottom) low = high;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (top(mid) <= middle) low = mid;
      else high = mid - 1;
    }
    // Two pages side by side: the left one names the pair.
    while (low > 0 && top(low - 1) === top(low)) low--;
    if (low !== current()) setCurrent(low);
  }

  /** Zooms, keeping the point under `at` (on screen) where it is. */
  function zoomTo(next: number, at?: { x: number; y: number }) {
    const view = scroller.getBoundingClientRect();
    const point = at ?? { x: view.left + view.width / 2, y: view.top + view.height / 2 };
    const before = scale();
    const after = Math.min(Math.max(next, LEAST_ZOOM), MOST_ZOOM) * CSS_UNITS;
    const fromLeft = scroller.scrollLeft + point.x - view.left;
    const fromTop = scroller.scrollTop + point.y - view.top;
    batch(() => {
      setZoom(after / CSS_UNITS);
      setFit("zoom");
    });
    const ratio = after / before;
    scroller.scrollTo({ left: fromLeft * ratio - (point.x - view.left), top: fromTop * ratio - (point.y - view.top) });
  }

  /** A change of fit keeps the page being read in view. */
  function refit(next: Fit) {
    const at = current();
    setFit(next);
    requestAnimationFrame(() => go(at));
  }

  function onWheel(event: WheelEvent) {
    if (!event.ctrlKey) return;
    event.preventDefault();
    zoomTo((scale() / CSS_UNITS) * Math.exp(-event.deltaY * WHEEL), { x: event.clientX, y: event.clientY });
  }

  /** Draws a page and the text over it while it is near the view, and lets go of it after. */
  function Page(page: { at: number }) {
    const at = page.at;
    let box!: HTMLDivElement;
    let canvas!: HTMLCanvasElement;
    let text!: HTMLDivElement;
    const [close, setClose] = createSignal(false);
    let drawing: pdfjs.RenderTask | undefined;
    let layer: pdfjs.TextLayer | undefined;
    let drawnAt = 0;
    /** Bumped by each drawing, so one overtaken by a later zoom gives way. */
    let ticket = 0;

    async function draw(shown: number) {
      const mine = ++ticket;
      drawing?.cancel();
      layer?.cancel();
      const proxy = await doc()!.getPage(at + 1);
      if (gone || !close() || mine !== ticket) return;
      const natural = proxy.getViewport({ scale: 1 });
      const size = sizes()[at];
      if (size.width !== natural.width || size.height !== natural.height) {
        keepPlace(() => setSizes(sizes().map((one, place) => (place === at ? { width: natural.width, height: natural.height } : one))));
        return;
      }
      const viewport = proxy.getViewport({ scale: shown });
      const pixels = Math.min(devicePixelRatio, Math.sqrt(MOST_PIXELS / (viewport.width * viewport.height)));
      const drawn = document.createElement("canvas");
      drawn.width = Math.floor(viewport.width * pixels);
      drawn.height = Math.floor(viewport.height * pixels);
      drawing = proxy.render({ canvas: drawn, viewport, transform: pixels !== 1 ? [pixels, 0, 0, pixels, 0, 0] : undefined });
      try {
        await drawing.promise;
      } catch (reason) {
        if (reason instanceof pdfjs.RenderingCancelledException) return;
        throw reason;
      }
      if (mine !== ticket) return;
      // The old picture stays until the new one is ready, so a zoom never flashes white.
      canvas.width = drawn.width;
      canvas.height = drawn.height;
      canvas.getContext("2d")!.drawImage(drawn, 0, 0);
      drawn.width = drawn.height = 0;
      drawnAt = shown;
      canvases.set(at, canvas);
      setMoved(moved() + 1);
      text.replaceChildren();
      layer = new pdfjs.TextLayer({ textContentSource: proxy.streamTextContent(), container: text, viewport });
      await layer.render().catch(() => {});
      if (!gone && close() && mine === ticket) {
        textLayers.set(at, text);
        paintFound();
      }
    }

    function forget() {
      if (!drawnAt && !drawing) return;
      ticket++;
      drawing?.cancel();
      drawing = undefined;
      layer?.cancel();
      canvas.width = canvas.height = 0;
      text.replaceChildren();
      canvases.delete(at);
      textLayers.delete(at);
      drawnAt = 0;
    }

    onMount(() => {
      shown.set(box, setClose);
      watch.observe(box);
    });
    onCleanup(() => {
      watch.unobserve(box);
      shown.delete(box);
      forget();
    });
    createEffect(() => {
      const shownAt = scale();
      sizes()[at];
      if (!close()) return forget();
      if (shownAt !== drawnAt) void draw(shownAt).catch(console.error);
    });

    return (
      <div
        ref={box}
        class="pdf-page"
        data-page={at}
        style={{
          width: `${sizeOf(at).width * scale()}px`,
          height: `${sizeOf(at).height * scale()}px`,
          "--scale-factor": scale(),
          "--total-scale-factor": scale(),
        }}
      >
        <canvas ref={canvas} aria-label={`Page ${at + 1}`} />
        <div ref={text} class="textLayer" />
      </div>
    );
  }

  /** A small picture of a page, drawn once it scrolls into the strip. */
  function Thumb(page: { at: number }) {
    let canvas!: HTMLCanvasElement;
    onMount(() => {
      const once = new IntersectionObserver(async ([seen]) => {
        if (!seen.isIntersecting) return;
        once.disconnect();
        const proxy = await doc()!.getPage(page.at + 1);
        if (gone) return;
        const viewport = proxy.getViewport({ scale: (THUMB_WIDTH * devicePixelRatio) / proxy.getViewport({ scale: 1 }).width });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        await proxy.render({ canvas, viewport }).promise.catch(() => {});
      });
      once.observe(canvas);
      onCleanup(() => once.disconnect());
    });
    return (
      <button class="pdf-thumb" role="option" aria-label={`Page ${page.at + 1}`} aria-selected={current() === page.at} onClick={() => go(page.at)}>
        <canvas ref={canvas} style={{ "aspect-ratio": `${sizeOf(page.at).width} / ${sizeOf(page.at).height}` }} />
        <span>{page.at + 1}</span>
      </button>
    );
  }

  let thumbs: HTMLDivElement | undefined;
  createEffect(on(current, (at) => side() === "pages" && thumbs?.children[at]?.scrollIntoView({ block: "nearest" })));

  /** Where an outline heading points: its page, and how far down it, in points. */
  async function openHeading(heading: Heading) {
    const opened = doc();
    if (!opened || !heading.dest) return;
    const dest = typeof heading.dest === "string" ? await opened.getDestination(heading.dest) : heading.dest;
    if (!dest?.length) return;
    const target = dest[0];
    const at = typeof target === "number" ? target : await opened.getPageIndex(target as Parameters<typeof opened.getPageIndex>[0]);
    // An "XYZ" place gives how high on the page, from its foot.
    const kind = (dest[1] as { name?: string } | undefined)?.name;
    const y = kind === "XYZ" || kind === "FitH" || kind === "FitBH" ? (kind === "XYZ" ? dest[3] : dest[2]) : null;
    go(at, typeof y === "number" ? Math.max(sizeOf(at).height - y, 0) : 0);
  }

  function Headings(list: { items: Heading[] }) {
    return (
      <ul>
        <For each={list.items}>
          {(heading) => (
            <li>
              <button class="pdf-heading" onClick={() => void openHeading(heading)}>
                {heading.title}
              </button>
              <Show when={heading.items.length}>
                <Headings items={heading.items} />
              </Show>
            </li>
          )}
        </For>
      </ul>
    );
  }

  // Find, across every page: each page's text is read once, the matches counted, and those on
  // the pages drawn are marked.
  const [finding, setFinding] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [matches, setMatches] = createSignal<{ page: number; nth: number }[]>([]);
  const [chosen, setChosen] = createSignal(-1);
  const [searched, setSearched] = createSignal(0);
  const texts = new Map<number, Promise<string>>();
  let search = 0;
  /** The match chosen is on a page not drawn yet, so it is scrolled to once that page is. */
  let scrollWanted = false;

  const pageText = (at: number) => {
    if (!texts.has(at))
      texts.set(
        at,
        doc()!
          .getPage(at + 1)
          .then((proxy) => proxy.getTextContent())
          .then((content) => content.items.map((item) => ("str" in item ? item.str : "")).join("")),
      );
    return texts.get(at)!;
  };

  async function runFind() {
    const mine = ++search;
    const wanted = query().toLowerCase();
    setMatches([]);
    setChosen(-1);
    setSearched(0);
    paintFound();
    if (!wanted || !doc()) return;
    const found: { page: number; nth: number }[] = [];
    for (let at = 0; at < count() && found.length < MOST_MATCHES; at++) {
      const text = (await pageText(at)).toLowerCase();
      if (mine !== search) return;
      for (let from = text.indexOf(wanted), nth = 0; from >= 0; from = text.indexOf(wanted, from + wanted.length), nth++) found.push({ page: at, nth });
      setSearched(at + 1);
      // The count grows as pages are read, and the first match shows as soon as it is found.
      if (found.length && (at % 20 === 0 || at === count() - 1 || chosen() < 0)) {
        setMatches([...found]);
        // The first match chosen is the first from the page being read on.
        if (chosen() < 0) pick(Math.max(found.findIndex((one) => one.page >= current()), 0));
      }
    }
    setMatches([...found]);
  }

  function pick(at: number) {
    const all = matches();
    if (!all.length) return;
    const next = (at + all.length) % all.length;
    setChosen(next);
    scrollWanted = true;
    if (textLayers.has(all[next].page)) paintFound();
    else go(all[next].page);
  }

  /** Marks the matches on the pages drawn, and scrolls to the one chosen once it is drawn. */
  function paintFound() {
    const wanted = query();
    if (!finding() || !wanted) {
      CSS.highlights.delete("find");
      CSS.highlights.delete("find-current");
      return;
    }
    const all: Range[] = [];
    const match = matches()[chosen()];
    let picked: Range | undefined;
    for (const [at, layer] of textLayers) {
      const ranges = findIn(layer, wanted);
      all.push(...ranges);
      if (match?.page === at) picked = ranges[match.nth];
    }
    if (all.length) CSS.highlights.set("find", new Highlight(...all));
    else CSS.highlights.delete("find");
    if (picked) CSS.highlights.set("find-current", new Highlight(picked));
    else CSS.highlights.delete("find-current");
    if (picked && scrollWanted) {
      scrollWanted = false;
      scrollToRange(scroller, picked);
    }
  }

  function openFind() {
    setFinding(true);
    requestAnimationFrame(() => {
      findInput?.focus();
      findInput?.select();
    });
  }

  function closeFind() {
    search++;
    setFinding(false);
    paintFound();
  }

  const findLabel = () => {
    if (!query()) return "";
    const all = matches().length;
    const still = searched() < count() ? "…" : "";
    if (!all) return still ? "Looking…" : "No matches";
    return `${chosen() + 1} of ${all.toLocaleString()}${all >= MOST_MATCHES ? "+" : still}`;
  };

  /** The page being read, drawn sharp, onto the clipboard. */
  async function copyPage() {
    const proxy = await doc()!.getPage(current() + 1);
    const viewport = proxy.getViewport({ scale: CSS_UNITS * COPY_SCALE });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const context = canvas.getContext("2d")!;
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await proxy.render({ canvas, viewport }).promise;
    const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/png"));
    if (!blob) return;
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    setCopied(true);
    setTimeout(() => setCopied(false), DONE_MS);
  }

  props.keys((event) => {
    const key = event.key;
    if (event.ctrlKey && key.toLowerCase() === "f") return openFind(), true;
    if (key === "F3" && finding()) return pick(chosen() + (event.shiftKey ? -1 : 1)), true;
    if (event.target === findInput) {
      if (key === "Enter") pick(chosen() + (event.shiftKey ? -1 : 1));
      else if (key === "Escape") closeFind();
      else return false;
      return true;
    }
    if (event.target === pageInput) return false;
    if (event.ctrlKey || event.altKey || event.target instanceof HTMLInputElement) return false;
    const lower = key.toLowerCase();
    if (key === "ArrowLeft") go(current() - (spread() ? 2 : 1));
    else if (key === "ArrowRight") go(current() + (spread() ? 2 : 1));
    else if (key === "Home") go(0);
    else if (key === "End") go(count() - 1);
    else if (key === "+" || key === "=") zoomTo((scale() / CSS_UNITS) * ZOOM_STEP);
    else if (key === "-") zoomTo(scale() / CSS_UNITS / ZOOM_STEP);
    else if (lower === "f") refit(fit() === "width" ? "page" : "width");
    else if (lower === "s") setSpread(!spread());
    else if (lower === "n") setNight(!night());
    else if (lower === "t") setSide(side() === "pages" ? "" : "pages");
    else if (lower === "o" && outline().length) setSide(side() === "outline" ? "" : "outline");
    else if (lower === "m") setMinimapShown(!minimapShown());
    else if (lower === "g") {
      pageInput?.focus();
      pageInput?.select();
    }
    else if (key === "Escape" && finding()) closeFind();
    else return false;
    return true;
  });

  // The map shows when the page is wider than the view, so a part of it is off to the side.
  const mapped = () => (moved(), minimapShown() && canvases.has(current()) && sizeOf(current()).width * scale() > stage().width + 1);
  const seen = (): ViewRect => {
    moved();
    const page = pageElement(current());
    if (!page) return { x: 0, y: 0, width: 1, height: 1 };
    const view = scroller.getBoundingClientRect();
    return seenPart({ left: view.left, top: view.top, width: scroller.clientWidth, height: scroller.clientHeight }, page.getBoundingClientRect());
  };
  function centerOn(center: { x: number; y: number }) {
    const page = pageElement(current())?.getBoundingClientRect();
    if (!page) return;
    const view = scroller.getBoundingClientRect();
    scroller.scrollBy({
      left: page.left + center.x * page.width - (view.left + scroller.clientWidth / 2),
      top: page.top + center.y * page.height - (view.top + scroller.clientHeight / 2),
    });
  }

  return (
    <div class="pdf-view" data-side={side() || undefined}>
      <Show when={side() && doc()}>
        <aside class="pdf-side" aria-label={side() === "pages" ? "Pages" : "Outline"}>
          <Show
            when={side() === "pages"}
            fallback={
              <nav class="pdf-outline">
                <Headings items={outline()} />
              </nav>
            }
          >
            <div ref={thumbs} class="pdf-thumbs" role="listbox" aria-label="Pages">
              <For each={Array.from({ length: count() }, (_, at) => at)}>{(at) => <Thumb at={at} />}</For>
            </div>
          </Show>
        </aside>
      </Show>
      <div class="pdf-main">
        <div class="preview-tools pdf-tools" role="toolbar" aria-label="PDF">
          <Show when={finding()}>
            <div class="find-bar" role="search">
              <input
                ref={findInput}
                aria-label="Find"
                placeholder="Find"
                spellcheck={false}
                value={query()}
                onInput={(event) => {
                  setQuery(event.currentTarget.value);
                  void runFind().catch(console.error);
                }}
              />
              <span class="find-count" aria-live="polite">
                {findLabel()}
              </span>
              <button class="strip-icon" aria-label="Previous match" aria-keyshortcuts="Shift+F3" onClick={() => pick(chosen() - 1)}>
                {ICON_UP}
              </button>
              <button class="strip-icon" aria-label="Next match" aria-keyshortcuts="F3" onClick={() => pick(chosen() + 1)}>
                {ICON_DOWN}
              </button>
              <button class="strip-icon" aria-label="Close find" aria-keyshortcuts="Escape" onClick={closeFind}>
                {ICON_CLOSE}
              </button>
            </div>
          </Show>
          <button class="strip-icon" aria-label="Find" aria-keyshortcuts="Control+F" aria-pressed={finding()} onClick={() => (finding() ? closeFind() : openFind())}>
            {ICON_FIND}
          </button>
          <label class="pdf-go">
            <input
              ref={pageInput}
              aria-label="Go to page"
              aria-keyshortcuts="G"
              inputmode="numeric"
              value={count() ? current() + 1 : ""}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                const wanted = Number.parseInt(event.currentTarget.value, 10);
                if (wanted) go(wanted - 1);
                scroller.focus({ preventScroll: true });
              }}
              onBlur={(event) => (event.currentTarget.value = String(current() + 1))}
            />
            <span>/ {count()}</span>
          </label>
          <button class="strip-icon" aria-label="Zoom out" aria-keyshortcuts="-" onClick={() => zoomTo(scale() / CSS_UNITS / ZOOM_STEP)}>
            {ICON_ZOOM_OUT}
          </button>
          <button class="zoom-chip" aria-label="Change the fit" aria-keyshortcuts="F" onClick={() => refit(fit() === "width" ? "page" : "width")}>
            {fit() === "width" ? "Fit width" : fit() === "page" ? "Fit page" : `${percent()}%`}
          </button>
          <button class="strip-icon" aria-label="Zoom in" aria-keyshortcuts="+" onClick={() => zoomTo((scale() / CSS_UNITS) * ZOOM_STEP)}>
            {ICON_ZOOM_IN}
          </button>
          <button class="strip-icon" aria-label="Two pages" aria-keyshortcuts="S" aria-pressed={spread()} onClick={() => setSpread(!spread())}>
            {ICON_SPREAD}
          </button>
          <button class="strip-icon" aria-label="Night pages" aria-keyshortcuts="N" aria-pressed={night()} onClick={() => setNight(!night())}>
            {ICON_NIGHT}
          </button>
          <button class="strip-icon" aria-label="Page strip" aria-keyshortcuts="T" aria-pressed={side() === "pages"} onClick={() => setSide(side() === "pages" ? "" : "pages")}>
            {ICON_STRIP}
          </button>
          <Show when={outline().length}>
            <button class="strip-icon" aria-label="Outline" aria-keyshortcuts="O" aria-pressed={side() === "outline"} onClick={() => setSide(side() === "outline" ? "" : "outline")}>
              {ICON_OUTLINE}
            </button>
          </Show>
          <button
            class="strip-icon"
            aria-label={copied() ? "Copied" : "Copy this page as a picture"}
            data-done={copied() || undefined}
            disabled={!doc()}
            onClick={() => void copyPage().catch(console.error)}
          >
            {ICON_COPY}
          </button>
        </div>
        <div ref={scroller} class="pdf-scroll" tabindex="-1" data-night={night() || undefined} onScroll={onScroll} onWheel={onWheel}>
          <Show when={facts().length}>
            <p class="pdf-facts">
              <For each={facts()}>{(fact) => <span>{fact}</span>}</For>
            </p>
          </Show>
          <div class="pdf-pages" style={{ "--pdf-gap": `${GAP}px`, padding: `${PAD}px` }}>
            <For each={rows()}>
              {(row) => (
                <div class="pdf-row">
                  <For each={row}>{(at) => <Page at={at} />}</For>
                </div>
              )}
            </For>
          </div>
          <Show when={!doc() && !problem() && !locked()}>
            <p class="preview-note">Reading…</p>
          </Show>
          <Show when={problem()}>
            <p class="preview-note" role="alert">
              {problem()}
            </p>
          </Show>
        </div>
        <Show when={locked()}>
          {(ask) => (
            <form
              class="pdf-password"
              onSubmit={(event) => {
                event.preventDefault();
                ask().answer((event.currentTarget.elements.namedItem("password") as HTMLInputElement).value);
              }}
            >
              <p>{ask().wrong ? "That password didn't open it. Try again." : "This PDF is locked with a password."}</p>
              <input name="password" type="password" aria-label="Password" ref={(input) => requestAnimationFrame(() => input.focus())} />
              <button class="details-button" type="submit">
                Open
              </button>
            </form>
          )}
        </Show>
        <Show when={offer()}>
          <button class="player-resume pdf-resume" onClick={() => go(offer())}>
            Resume at page {offer() + 1}
          </button>
        </Show>
        {/* A new page being read brings a new map. */}
        <Show when={mapped() ? current() + 1 : undefined} keyed>
          {(page) => (
            <Minimap source={() => canvases.get(page - 1)} aspect={() => sizeOf(page - 1).width / sizeOf(page - 1).height} view={seen} onMove={centerOn} />
          )}
        </Show>
      </div>
    </div>
  );
}
