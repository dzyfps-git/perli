import * as pdfjs from "pdfjs-dist";
import worker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { convertFileSrc } from "@tauri-apps/api/core";
import { batch, createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { fileSeen, openLink, savePdfCopy, stagePdf } from "../../api";
import { ConfirmDelete } from "../fileops/ConfirmDelete";
import { saved, stored } from "../filelist/prefs";
import { findIn, scrollToRange } from "./FindBar";
import { Minimap } from "./Minimap";
import { findScripts, hasScripts, runScripts, type Scripts } from "./pdfScripts";
import { minimapShown, pdfScripts, setMinimapShown, setPdfScripts } from "./viewerPrefs";
import { seenPart, type ViewRect } from "./zoomView";
import "./pdfFields.css";
import "./pdfXfa.css";

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

const ICON_CLEAR = "\uE75C";

/** pdf.js's own files: character maps for Asian text, the 14 standard fonts, and its WebAssembly:
 *  image decoders, colour profiles, and the engine a PDF's own scripts run in. */
const FILES = import.meta.env.DEV ? "/node_modules/pdfjs-dist/" : "/pdfjs/";
/** CSS pixels per PDF point, so 100% is the page's printed size. */
const CSS_UNITS = pdfjs.PixelsPerInch.PDF_TO_CSS_UNITS;
const GAP = 12;
/** How often an open PDF looks whether its file changed on disk. */
const FILE_LOOK_MS = 1500;
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
/** Places left by following links, kept to come back to. */
const MOST_BACKS = 50;
/** How long a word on a save or a link stays. */
const TOLD_MS = 6000;
/** Links that may open outside, once the user says so. */
const WEB = /^(https?:|mailto:)/i;
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

/** A place in the PDF: a name it gives, or the place itself. */
type Dest = string | unknown[] | null;

interface Heading {
  title: string;
  dest: Dest;
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
  /** Writes a filled-in PDF, staged by `stagePdf`, over the file as a job with an Undo. Says whether it went. */
  saveOver: (path: string, staged: number, seen: string | undefined) => Promise<boolean>;
}

/**
 * A PDF, page under page: a strip of the pages or the document's own outline beside it, find
 * across every page, text to select, fit to the width or the page, two pages side by side, night
 * pages, the place kept for next time, and a page copied as a picture. Its links work, and its
 * form fields fill in, saved as a copy beside it or over it.
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
  /** Fields filled in since the file was read or last saved, and since it was read at all. */
  const [changed, setChanged] = createSignal(false);
  const [edited, setEdited] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  /** A word on the last save or link. */
  const [told, setTold] = createSignal<string>();
  /** A web link waiting for the user to say it may open. */
  const [web, setWeb] = createSignal<string>();
  /** Places left by following links, to come back to with Alt+Left. */
  const [backs, setBacks] = createSignal<{ at: number; top: number }[]>([]);
  /** Bumped to draw every page's fields afresh. */
  const [fieldsRound, setFieldsRound] = createSignal(0);
  /** How the file stood when read, so a save over it asks if it changed since. */
  let readAs: string | undefined;
  /** Every field of the form, by name, for its own Reset buttons to know what they clear. */
  let fieldObjects: Promise<Map<string, object[]> | null> = Promise.resolve(null);
  /** The PDF's own scripts while they run, and whether it has any. */
  let scripts: Scripts | undefined;
  const [scripted, setScripted] = createSignal(false);
  let toldTimer: number | undefined;
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
    // How the file stood before it was read: a change while it reads shows at the next look.
    const stamp = await fileSeen(props.path).catch(() => null);
    const url = convertFileSrc(await props.open());
    if (gone) return;
    task = pdfjs.getDocument({
      url,
      cMapUrl: `${FILES}cmaps/`,
      standardFontDataUrl: `${FILES}standard_fonts/`,
      wasmUrl: `${FILES}wasm/`,
      // A form made only of XFA, which most readers but Acrobat show as a page saying so, shows
      // and fills in as it was laid out.
      enableXfa: true,
    });
    task.onPassword = (answer: (password: string) => void, reason: number) =>
      setLocked({ answer, wrong: reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD });
    const opened = await task.promise;
    if (gone) return void opened.loadingTask.destroy();
    setLocked(undefined);
    const first = (await opened.getPage(1)).getViewport({ scale: 1 });
    if (gone) return void opened.loadingTask.destroy();
    const before = doc();
    // Read again: fields filled in or a save begun meanwhile win over what was read, which goes.
    if (before && (changed() || saving())) {
      task = before.loadingTask;
      return void opened.loadingTask.destroy();
    }
    fieldObjects = opened.getFieldObjects().catch(() => null);
    (opened.annotationStorage as unknown as { onSetModified: () => void }).onSetModified = () => batch(() => (setChanged(true), setEdited(true)));
    // The stamp a save over it checks goes with the document it saves, never ahead of it.
    readAs = stamp ?? undefined;
    batch(() => {
      // Read again, the pages keep the sizes they have and the place stays.
      if (!before || sizes().length !== opened.numPages) setSizes(Array.from({ length: opened.numPages }, () => ({ width: first.width, height: first.height })));
      setDoc(opened);
      if (!before && savedPage > 0 && savedPage < opened.numPages) setOffer(savedPage);
    });
    void before?.loadingTask.destroy();
    void startScripts(opened).catch(console.error);
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

  // The file changed on disk, as an Undo of a save over it does when it puts the old one back:
  // with nothing filled in here since, it is read again, so the page shows what the file holds.
  let reloading = false;
  const looking = setInterval(() => {
    if (gone || !doc() || changed() || saving() || reloading || document.hidden) return;
    void fileSeen(props.path).then(
      (stamp) => {
        if (!stamp || !readAs || stamp === readAs || changed() || saving() || reloading) return;
        reloading = true;
        // One that fails, say while the file is still being written, is tried again next look.
        void load()
          .catch(console.error)
          .finally(() => (reloading = false));
      },
      () => {},
    );
  }, FILE_LOOK_MS);

  /** Runs the PDF's own scripts while the setting is on, and draws the fields again to match. */
  async function startScripts(opened: pdfjs.PDFDocumentProxy) {
    const found = await findScripts(opened);
    if (gone || doc() !== opened) return;
    const had = !!scripts;
    scripts?.stop();
    scripts = undefined;
    setScripted(hasScripts(found));
    if (pdfScripts() && hasScripts(found)) {
      const started = await runScripts(opened, found, scriptView, `${FILES}wasm/`).catch((reason) => void tell(`This PDF's scripts didn't start: ${reason instanceof Error ? reason.message : reason}`));
      if (gone || doc() !== opened) return void started?.stop();
      scripts = started;
      void scripts?.pageOpen(current() + 1);
    }
    if (had || scripts) setFieldsRound(fieldsRound() + 1);
  }

  const scriptView = {
    box: () => scroller,
    go: (page: number) => go(page),
    count,
    current,
    say: (text: string) => tell(text),
    name: props.path.split(/[\/]/).pop() ?? "",
  };

  createEffect(on(pdfScripts, () => doc() && void startScripts(doc()!).catch(console.error), { defer: true }));
  createEffect(
    on(
      current,
      (at, before) => {
        if (before !== undefined) scripts?.pageClose(before + 1);
        void scripts?.pageOpen(at + 1).catch(console.error);
      },
      { defer: true },
    ),
  );

  onCleanup(() => {
    gone = true;
    scripts?.stop();
    clearInterval(looking);
    watch.disconnect();
    props.keys(undefined);
    props.note(undefined);
    closeFind();
    clearTimeout(toldTimer);
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
    let fieldsBox!: HTMLDivElement;
    let fields: pdfjs.AnnotationLayer | undefined;
    let xfaBox!: HTMLDivElement;
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
      await drawFields(proxy, viewport, mine).catch(console.error);
      if (mine !== ticket) return;
      text.replaceChildren();
      layer = new pdfjs.TextLayer({ textContentSource: proxy.streamTextContent(), container: text, viewport });
      await layer.render().catch(() => {});
      if (!gone && close() && mine === ticket) {
        textLayers.set(at, text);
        paintFound();
      }
    }

    /** The page's links and form fields: made once while the page is near, then moved with each zoom. */
    async function drawFields(proxy: pdfjs.PDFPageProxy, viewport: pdfjs.PageViewport, mine: number) {
      const fitted = viewport.clone({ dontFlip: true });
      if (doc()!.isPureXfa) return drawXfa(proxy, fitted, mine);
      if (fields) return fields.update({ viewport: fitted } as Parameters<pdfjs.AnnotationLayer["update"]>[0]);
      const annotations = await proxy.getAnnotations({ intent: "display" });
      if (gone || !close() || mine !== ticket || fields || !annotations.length) return;
      const storage = doc()!.annotationStorage;
      fields = new pdfjs.AnnotationLayer({
        div: fieldsBox,
        page: proxy,
        viewport: fitted,
        linkService: links,
        annotationStorage: storage,
        accessibilityManager: null,
        annotationCanvasMap: null,
        annotationEditorUIManager: null,
        structTreeLayer: null,
        commentManager: null,
      });
      await fields.render({
        annotations,
        viewport: fitted,
        div: fieldsBox,
        page: proxy,
        linkService: links as never,
        annotationStorage: storage,
        imageResourcesPath: `${FILES}web/images/`,
        renderForms: true,
        // Fields drawn before the scripts started are drawn again once they have.
        enableScripting: !!scripts,
        // pdf.js wires a field's keys and focus to its scripts only when told the PDF has some.
        hasJSActions: !!scripts,
        // A Reset button in the form clears the fields it names.
        fieldObjects: await fieldObjects,
      });
      tidyFields(fieldsBox);
    }

    /** An XFA form's page: its fields laid out over the page, made once, then moved with each zoom. */
    async function drawXfa(proxy: pdfjs.PDFPageProxy, viewport: pdfjs.PageViewport, mine: number) {
      const parameters = { viewport, div: xfaBox, annotationStorage: doc()!.annotationStorage, linkService: links as never, intent: "display" };
      if (xfaBox.childElementCount) return pdfjs.XfaLayer.update({ ...parameters, xfaHtml: {} });
      const xfaHtml = await proxy.getXfa();
      if (gone || !close() || mine !== ticket || !xfaHtml || xfaBox.childElementCount) return;
      pdfjs.XfaLayer.render({ ...parameters, xfaHtml });
    }

    function forgetFields() {
      fields = undefined;
      fieldsBox.replaceChildren();
      xfaBox.replaceChildren();
    }

    function forget() {
      if (!drawnAt && !drawing) return;
      ticket++;
      drawing?.cancel();
      drawing = undefined;
      layer?.cancel();
      canvas.width = canvas.height = 0;
      text.replaceChildren();
      forgetFields();
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
    // Fields put back to what the file holds are drawn again from it.
    createEffect(
      on(
        fieldsRound,
        () => {
          forgetFields();
          const mine = ticket;
          if (drawnAt) void doc()!.getPage(at + 1).then((proxy) => drawFields(proxy, proxy.getViewport({ scale: drawnAt }), mine)).catch(console.error);
        },
        { defer: true },
      ),
    );

    return (
      <div
        ref={box}
        class="pdf-page"
        data-page={at}
        // A middle click on a link would open a window of its own.
        onAuxClick={(event) => (event.target as HTMLElement).closest("a") && event.preventDefault()}
        style={{
          width: `${sizeOf(at).width * scale()}px`,
          height: `${sizeOf(at).height * scale()}px`,
          "--scale-factor": scale(),
          "--total-scale-factor": scale(),
        }}
      >
        <canvas ref={canvas} aria-label={`Page ${at + 1}`} />
        <div ref={text} class="textLayer" />
        <div ref={fieldsBox} class="annotationLayer" />
        <div ref={xfaBox} class="xfaLayer" />
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

  /** Where a place in the PDF is: its page, and how far down it, in points. */
  async function placeOf(dest: Dest) {
    const opened = doc();
    if (!opened || !dest) return;
    const found = typeof dest === "string" ? await opened.getDestination(dest) : dest;
    if (!found?.length) return;
    const target = found[0];
    const at = typeof target === "number" ? target : await opened.getPageIndex(target as Parameters<typeof opened.getPageIndex>[0]);
    // An "XYZ" place gives how high on the page, from its foot.
    const kind = (found[1] as { name?: string } | undefined)?.name;
    const y = kind === "XYZ" || kind === "FitH" || kind === "FitBH" ? (kind === "XYZ" ? found[3] : found[2]) : null;
    return { at, top: typeof y === "number" ? Math.max(sizeOf(at).height - y, 0) : 0 };
  }

  async function openHeading(heading: Heading) {
    const place = await placeOf(heading.dest);
    if (place) go(place.at, place.top);
  }

  /** Where the view is, as `go` takes it: the page being read, and how far down it in points. */
  function here() {
    const page = pageElement(current());
    return { at: current(), top: page ? Math.max((scroller.scrollTop - page.offsetTop + PAD) / scale(), 0) : 0 };
  }

  /** Goes to a place a link leads to, keeping the place left for Alt+Left. */
  function leap(at: number, top = 0) {
    setBacks([...backs(), here()].slice(-MOST_BACKS));
    go(at, top);
  }

  function goBack() {
    const last = backs().at(-1);
    if (!last) return false;
    setBacks(backs().slice(0, -1));
    go(last.at, last.top);
    return true;
  }

  function tell(text: string) {
    clearTimeout(toldTimer);
    setTold(text);
    toldTimer = window.setTimeout(() => setTold(undefined), TOLD_MS);
  }

  /** What pdf.js's links do here: go to a place in this PDF, or open a web page once the user says so. */
  const links = {
    externalLinkEnabled: true,
    isInPresentationMode: false,
    rotation: 0,
    get pagesCount() {
      return count();
    },
    get page() {
      return current() + 1;
    },
    addLinkAttributes(link: HTMLAnchorElement, url: string) {
      link.href = "#";
      link.dataset.tip = WEB.test(url) ? url : `${url}\nThis kind of link doesn't open from a preview`;
      link.onclick = () => {
        if (WEB.test(url)) setWeb(url);
        else tell("This kind of link doesn't open from a preview");
        return false;
      };
    },
    // The place rides in the link, so its page can show on hover.
    getDestinationHash: (dest: Dest) => `#to:${encodeURIComponent(JSON.stringify(dest))}`,
    getAnchorUrl: () => "#",
    goToDestination: (dest: Dest) =>
      void placeOf(dest).then((place) => place && leap(place.at, place.top), console.error),
    goToPage: (page: number) => leap(page - 1),
    executeNamedAction(action: string) {
      const to = ({ NextPage: current() + 1, PrevPage: current() - 1, FirstPage: 0, LastPage: count() - 1 } as Record<string, number>)[action];
      if (to !== undefined) leap(to);
      else if (action === "GoBack") goBack();
    },
    executeSetOCGState() {},
    /** What a field tells its scripts: a key typed, a value left, a button pressed. */
    eventBus: {
      dispatch: (name: string, event: { detail?: unknown }) => name === "dispatcheventinsandbox" && scripts?.send(event.detail),
    },
  };

  /** pdf.js's own hover text moves to Perli's, and each link to a place in the PDF says its page. */
  function tidyFields(box: HTMLElement) {
    for (const tipped of box.querySelectorAll("[title]")) {
      tipped.setAttribute("data-tip", tipped.getAttribute("title")!);
      tipped.removeAttribute("title");
    }
    for (const link of box.querySelectorAll<HTMLAnchorElement>('a[href^="#to:"]')) {
      const dest = JSON.parse(decodeURIComponent(link.getAttribute("href")!.slice(4))) as Dest;
      void placeOf(dest).then(
        (place) => place && (link.dataset.tip = [link.dataset.tip, `Page ${place.at + 1}`].filter(Boolean).join("\n")),
        () => {},
      );
    }
  }

  /** A fingerprint of the fields as filled in right now, to tell whether one changed during a save. */
  const fieldsNow = (opened: pdfjs.PDFDocumentProxy) => opened.annotationStorage.serializable.hash;

  /** The fields as filled in, written as a copy beside the file: "name (filled).pdf". */
  async function saveCopy() {
    const opened = doc();
    if (!opened || saving()) return;
    setSaving(true);
    try {
      await scripts?.willSave();
      const written = fieldsNow(opened);
      const name = await savePdfCopy(props.path, await opened.saveDocument());
      scripts?.didSave();
      // A field filled in while the copy was written is not in it, so it stays unsaved.
      if (fieldsNow(opened) === written) (opened.annotationStorage.resetModified(), setChanged(false));
      tell(`Saved as ${name}`);
    } catch (reason) {
      tell(`Not saved: ${reason instanceof Error ? reason.message : reason}`);
    } finally {
      setSaving(false);
    }
  }

  /** The fields as filled in, written over the file itself, as a job with an Undo. */
  async function saveOver() {
    const opened = doc();
    if (!opened || saving()) return;
    setSaving(true);
    try {
      await scripts?.willSave();
      const written = fieldsNow(opened);
      if (!(await props.saveOver(props.path, await stagePdf(await opened.saveDocument()), readAs))) return;
      scripts?.didSave();
      if (fieldsNow(opened) === written) {
        opened.annotationStorage.resetModified();
        batch(() => (setChanged(false), setEdited(false)));
      }
      readAs = (await fileSeen(props.path).catch(() => null)) ?? undefined;
      tell("Saved over the original. Undo puts it back.");
    } catch (reason) {
      tell(`Not saved: ${reason instanceof Error ? reason.message : reason}`);
    } finally {
      setSaving(false);
    }
  }

  /** Every field back to what the file holds. */
  function clearChanges() {
    const storage = doc()?.annotationStorage;
    if (!storage) return;
    for (const [key] of [...storage]) storage.remove(key as string);
    storage.resetModified();
    batch(() => {
      setChanged(false);
      setEdited(false);
      setFieldsRound(fieldsRound() + 1);
    });
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
    if (event.altKey && !event.ctrlKey && key === "ArrowLeft") return goBack();
    if (event.ctrlKey && key.toLowerCase() === "s" && changed()) return void saveCopy(), true;
    if (event.target === findInput) {
      if (key === "Enter") pick(chosen() + (event.shiftKey ? -1 : 1));
      else if (key === "Escape") closeFind();
      else return false;
      return true;
    }
    if (event.target === pageInput) return false;
    if (event.ctrlKey || event.altKey || (event.target as HTMLElement).matches("input, textarea, select")) return false;
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
          <Show when={scripted()}>
            <button
              class="zoom-chip pdf-scripts"
              aria-pressed={pdfScripts()}
              data-tip={
                pdfScripts()
                  ? "This PDF runs scripts of its own, such as totals that add up. They run shut off from your files and the web. Click to stop them."
                  : "This PDF has scripts of its own, such as totals that add up. Click to run them, shut off from your files and the web."
              }
              onClick={() => setPdfScripts(!pdfScripts())}
            >
              {pdfScripts() ? "Scripts on" : "Scripts off"}
            </button>
          </Show>
          <Show when={changed()}>
            <button class="zoom-chip pdf-save" disabled={saving()} aria-keyshortcuts="Control+S" data-tip="Keeps the original as it was" onClick={() => void saveCopy()}>
              Save a filled copy
            </button>
            <button class="zoom-chip" disabled={saving()} data-tip="Undo puts the original back" onClick={() => void saveOver()}>
              Save over the original
            </button>
          </Show>
          <Show when={edited()}>
            <button class="strip-icon" aria-label="Clear changes" data-tip="Puts every field back to what the file holds" onClick={clearChanges}>
              {ICON_CLEAR}
            </button>
          </Show>
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
            {/* A file read again draws its pages afresh. */}
            <Show when={doc()} keyed>
              <For each={rows()}>
                {(row) => (
                  <div class="pdf-row">
                    <For each={row}>{(at) => <Page at={at} />}</For>
                  </div>
                )}
              </For>
            </Show>
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
        <Show when={!offer() && backs().at(-1)} keyed>
          {(last) => (
            <button class="player-resume pdf-resume" aria-keyshortcuts="Alt+ArrowLeft" onClick={goBack}>
              Back to page {last.at + 1}
            </button>
          )}
        </Show>
        <Show when={told()}>
          <p class="player-resume pdf-told" role="status">
            {told()}
          </p>
        </Show>
        <Show when={web()} keyed>
          {(url) => (
            <ConfirmDelete
              request={{
                title: "Open this link?",
                note: url,
                confirmLabel: "Open",
                safe: true,
                confirm: () => void openLink(url).catch((reason) => tell(String(reason))),
              }}
              onClose={() => setWeb(undefined)}
            />
          )}
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
