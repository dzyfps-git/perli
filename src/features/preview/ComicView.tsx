import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import type { Thumb } from "../../api";
import { saved, stored } from "../filelist/prefs";
import { ToolCog } from "../../ui/Controls";
import { edgeColor } from "./pictureFacts";
import { draw } from "./QuickPreview";
import {
  comicLong,
  keepProgress,
  manga,
  setComicLong,
  setManga,
  setSpread,
  setStrip,
  spread,
  strip,
  VIEWER_SETTINGS,
} from "./viewerPrefs";

const ICON_SPREAD = "";
const ICON_MANGA = "";
const ICON_STRIP = "";
const ICON_LONG = "";
const ICON_NEXT = "";

type Fit = "page" | "width" | "height";
const FITS: Fit[] = ["page", "width", "height"];
const FIT_NAMES: Record<Fit, string> = { page: "Fit page", width: "Fit width", height: "Fit height" };
const [fit, setFit] = stored<Fit>("comic-fit", FITS.includes(saved("comic-fit") as Fit) ? (saved("comic-fit") as Fit) : "page");

const THUMB_EDGE = 160;
const MOST_EDGE = 4096;
const MOST_PLACES = 200;
/** How much closer a double-click brings the part under the pointer. */
const ZOOM = 2.5;
/** A second click this soon is a double-click, so the first one waits before it turns the page. */
const CLICK_MS = 240;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

const places = () => (saved("comic-pages") as Record<string, number> | null) ?? {};

function keepPage(path: string, page: number | undefined) {
  const all = places();
  delete all[path];
  if (page) all[path] = page;
  localStorage.setItem("perli-comic-pages", JSON.stringify(Object.fromEntries(Object.entries(all).slice(-MOST_PLACES))));
}

export interface ComicViewProps {
  path: string;
  pages: string[];
  load: (page: string, edge: number) => Promise<Thumb | null>;
  keys: (handler: ((event: KeyboardEvent) => boolean) | undefined) => void;
  note: (text: string | undefined) => void;
  /** Opens the next comic of the folder. False when there is none. */
  onNextVolume?: () => Promise<boolean | undefined>;
}

/**
 * A comic a page or two at a time, in either reading direction, or as one long strip, with its
 * pages in a strip below. Each comic keeps its page for next time, and offers to go back there.
 */
export function ComicView(live: ComicViewProps) {
  const props = { ...live };
  const count = props.pages.length;
  let stage!: HTMLDivElement;
  let sheet: HTMLDivElement | undefined;
  let stripList: HTMLDivElement | undefined;
  const savedPage = Math.min(places()[props.path] ?? 0, count - 1);
  /** The first page shown. In a spread, the cover is alone and the rest come in pairs. */
  const [page, setPage] = createSignal(0);
  const [offer, setOffer] = createSignal(savedPage > 0 ? savedPage : 0);
  /** Pages wider than tall, which a spread shows alone. */
  const [wide, setWide] = createSignal(new Set<number>());
  const [backdrop, setBackdrop] = createSignal<string>();
  const [zoom, setZoom] = createSignal<{ x: number; y: number }>();
  /** The last page was turned past, so the next comic is offered. */
  const [atEnd, setAtEnd] = createSignal(false);
  const [noNext, setNoNext] = createSignal(false);
  let turned = 0;
  let gone = false;
  let clickTimer: ReturnType<typeof setTimeout> | undefined;
  /** The first showing must not forget the page saved last time. */
  let first = true;

  /**
   * The first page of each spread: the cover alone, then pages in pairs, except that a wide page
   * stands alone and the pairs after it start one later. Undefined when each page is on its own.
   */
  const starts = createMemo(() => {
    if (comicLong() || !spread()) return undefined;
    const found: number[] = [];
    for (let at = 0; at < count; ) {
      found.push(at);
      at += at > 0 && at + 1 < count && !wide().has(at) && !wide().has(at + 1) ? 2 : 1;
    }
    return found;
  });
  const shown = () => {
    const at = page();
    const all = starts();
    // A page that stopped being a start, when a wide one was found, shows on its own.
    const next = all?.[all.indexOf(at) + 1];
    return all?.includes(at) && next === at + 2 ? [at, at + 1] : [at];
  };
  /** Where the spread holding `at` starts. */
  const startOf = (at: number) => starts()?.filter((start) => start <= at).at(-1) ?? at;

  function go(target: number, by = Math.sign(target - page())) {
    let start = startOf(Math.min(Math.max(target, 0), count - 1));
    // Forward always moves on, even where a wide page found late has shifted the spreads.
    if (by > 0 && start <= page()) start = starts()?.find((other) => other > page()) ?? start;
    setAtEnd(false);
    if (start === page()) return;
    turned = by;
    setOffer(0);
    setZoom(undefined);
    setPage(start);
    if (comicLong()) longPage(start)?.scrollIntoView({ block: "start", behavior: reducedMotion.matches ? "auto" : "smooth" });
  }

  /** Forward or back in reading order. Past the last page waits for one more turn, then opens the next comic. */
  const turn = (by: number) => {
    const last = page() + shown().length >= count;
    if (by > 0 && last) {
      if (atEnd()) void nextVolume();
      else setAtEnd(true);
      return;
    }
    // Back lands on the start of the spread before, whatever its size.
    go(by > 0 ? page() + shown().length : page() - 1, by);
  };
  /** Left and right on screen, which swap in manga. */
  const side = (right: boolean) => turn(right !== manga() ? 1 : -1);

  async function nextVolume() {
    const went = await props.onNextVolume?.();
    if (!gone && !went) setNoNext(true);
  }

  function edge() {
    const box = Math.max(stage.clientWidth, stage.clientHeight) * devicePixelRatio;
    return Math.ceil(Math.min(fit() === "page" ? box : box * 2, MOST_EDGE));
  }

  /** Learns from a page drawn whether it is wide, and takes the backdrop from the first page shown. */
  function learn(at: number, picture: Thumb, place: number) {
    if (picture.width > picture.height && !wide().has(at)) setWide(new Set([...wide(), at]));
    if (place === 0) setBackdrop(edgeColor(picture.pixels, picture.width));
  }

  createEffect(
    on([page, spread, fit, comicLong, wide], () => {
      const at = shown();
      const by = turned;
      turned = 0;
      if (!first) keepPage(props.path, at[0] || undefined);
      keepProgress(props.path, (at.at(-1)! + 1) / count);
      first = false;
      const thumb = stripList?.children[at[0]] as HTMLElement | undefined;
      thumb?.scrollIntoView({ inline: "center", block: "nearest", behavior: reducedMotion.matches ? "auto" : "smooth" });
      if (comicLong() || !sheet) return;
      const canvases = [...sheet.querySelectorAll("canvas")];
      at.forEach((one, place) =>
        props
          .load(props.pages[one], edge())
          .then((picture) => {
            if (gone || !picture || page() !== at[0] || !canvases[place]?.isConnected) return;
            draw(canvases[place], picture);
            learn(one, picture, place);
          })
          .catch(console.error),
      );
      stage.scrollTo(0, 0);
      if (by && !reducedMotion.matches) {
        // The new page slides in from the side it was turned to, tipping a little like paper.
        const from = by * (manga() ? -1 : 1);
        sheet.animate(
          { translate: [`${from * 18}% 0`, "0 0"], rotate: [`y ${from * -14}deg`, "y 0deg"], opacity: [0, 1] },
          { duration: 520, easing: getComputedStyle(sheet).getPropertyValue("--spring") || "ease-out" },
        );
      }
    }),
  );

  createEffect(() => {
    const at = shown();
    const where = at.length > 1 ? `Pages ${at[0] + 1}–${at[1] + 1}` : `Page ${at[0] + 1}`;
    props.note(`${where} of ${count}`);
  });

  /** In the long strip, the page that crosses the middle of the stage is the one being read. */
  const longPage = (at: number) => stage?.querySelector<HTMLElement>(`[data-page="${at}"]`);
  function onScroll() {
    if (!comicLong()) return;
    const middle = stage.scrollTop + stage.clientHeight / 2;
    for (const element of stage.querySelectorAll<HTMLElement>("[data-page]")) {
      if (element.offsetTop <= middle && element.offsetTop + element.offsetHeight > middle) {
        const at = Number(element.dataset.page);
        if (at !== page()) setPage(at);
        return;
      }
    }
  }

  function onStageClick(event: MouseEvent) {
    if (comicLong()) return;
    clearTimeout(clickTimer);
    if (zoom()) return;
    const right = event.clientX > stage.getBoundingClientRect().left + stage.clientWidth / 2;
    clickTimer = setTimeout(() => side(right), CLICK_MS);
  }

  /** A double-click brings the part under the pointer closer, and another goes back. */
  function onStageDoubleClick(event: MouseEvent) {
    clearTimeout(clickTimer);
    if (comicLong() || !sheet) return;
    if (zoom()) return setZoom(undefined);
    const box = sheet.getBoundingClientRect();
    setZoom({ x: ((event.clientX - box.left) / box.width) * 100, y: ((event.clientY - box.top) / box.height) * 100 });
  }

  props.keys((event) => {
    if (event.ctrlKey || event.altKey) return false;
    const key = event.key.toLowerCase();
    if (key === "arrowleft") side(false);
    else if (key === "arrowright") side(true);
    else if (key === "home") go(0);
    else if (key === "end") go(count - 1);
    else if (key === "s") setSpread(!spread());
    else if (key === "m") setManga(!manga());
    else if (key === "f") setFit(FITS[(FITS.indexOf(fit()) + 1) % FITS.length]);
    else if (key === "t") setStrip(!strip());
    else if (key === "l") setComicLong(!comicLong());
    else if (key === "escape" && zoom()) setZoom(undefined);
    else return false;
    return true;
  });

  onMount(() => {
    // Turning on the spread can land mid-pair.
    createEffect(on(spread, () => setPage(startOf(page())), { defer: true }));
    // Into the long strip, the page being read comes along.
    createEffect(on(comicLong, (long) => long && requestAnimationFrame(() => longPage(page())?.scrollIntoView({ block: "start" })), { defer: true }));
  });

  onCleanup(() => {
    gone = true;
    clearTimeout(clickTimer);
    props.keys(undefined);
    props.note(undefined);
  });

  /** A picture loads once it scrolls into sight. */
  function lazy(canvas: HTMLCanvasElement, at: number, size: () => number, root?: HTMLElement) {
    const watch = new IntersectionObserver(
      (seen) => {
        if (!seen[0].isIntersecting) return;
        watch.disconnect();
        props
          .load(props.pages[at], size())
          .then((picture) => !gone && picture && draw(canvas, picture))
          .catch(console.error);
      },
      { root, rootMargin: "100% 0px" },
    );
    watch.observe(canvas);
    onCleanup(() => watch.disconnect());
  }

  const longEdge = () => Math.ceil(Math.min(stage.clientWidth * devicePixelRatio, MOST_EDGE));

  return (
    <div class="comic-view" data-strip={strip() || undefined} style={{ "--comic-backdrop": backdrop() }}>
      <div
        ref={stage}
        class="comic-stage"
        data-fit={fit()}
        data-long={comicLong() || undefined}
        onClick={onStageClick}
        onDblClick={onStageDoubleClick}
        onScroll={onScroll}
      >
        <Show
          when={!comicLong()}
          fallback={
            <div class="comic-long">
              <For each={props.pages}>
                {(_, at) => (
                  <div class="comic-long-page" data-page={at()}>
                    <canvas class="preview-picture" aria-label={`Page ${at() + 1}`} ref={(canvas) => lazy(canvas, at(), longEdge, stage)} />
                  </div>
                )}
              </For>
            </div>
          }
        >
          <div
            ref={sheet}
            class="comic-sheet"
            data-manga={manga() || undefined}
            data-zoom={zoom() ? "" : undefined}
            style={zoom() ? { "transform-origin": `${zoom()!.x}% ${zoom()!.y}%`, scale: String(ZOOM) } : undefined}
          >
            <For each={shown()}>{() => <canvas class="preview-picture comic-page" />}</For>
          </div>
        </Show>
      </div>
      <div class="preview-tools comic-tools" role="toolbar" aria-label="Comic">
        <button class="strip-icon" aria-label="Two pages" aria-keyshortcuts="S" aria-pressed={spread()} disabled={comicLong()} onClick={() => setSpread(!spread())}>
          {ICON_SPREAD}
        </button>
        <button class="strip-icon" aria-label="Right to left, for manga" aria-keyshortcuts="M" aria-pressed={manga()} onClick={() => setManga(!manga())}>
          {ICON_MANGA}
        </button>
        <button class="strip-icon" aria-label="Long strip" aria-keyshortcuts="L" aria-pressed={comicLong()} onClick={() => setComicLong(!comicLong())}>
          {ICON_LONG}
        </button>
        <button class="zoom-chip comic-fit" aria-label="Change the fit" aria-keyshortcuts="F" disabled={comicLong()} onClick={() => setFit(FITS[(FITS.indexOf(fit()) + 1) % FITS.length])}>
          {FIT_NAMES[fit()]}
        </button>
        <button class="strip-icon" aria-label="Page strip" aria-keyshortcuts="T" aria-pressed={strip()} onClick={() => setStrip(!strip())}>
          {ICON_STRIP}
        </button>
        <ToolCog label="Comic settings" items={VIEWER_SETTINGS.Comics} />
      </div>
      <Show when={offer()}>
        <button class="player-resume comic-resume" onClick={() => go(offer())}>
          Resume at page {offer() + 1}
        </button>
      </Show>
      <Show when={atEnd()}>
        <div class="comic-end" role="status">
          <span>{noNext() ? "That was the last comic here." : "The end."}</span>
          <Show when={props.onNextVolume && !noNext()}>
            <button class="details-button archive-take" onClick={() => void nextVolume()}>
              <span aria-hidden="true">{ICON_NEXT}</span> Next comic
            </button>
          </Show>
        </div>
      </Show>
      <Show when={strip()}>
        <div ref={stripList} class="comic-strip" role="listbox" aria-label="Pages" data-manga={manga() || undefined}>
          <For each={props.pages}>
            {(_, at) => (
              <button
                class="comic-thumb"
                role="option"
                aria-label={`Page ${at() + 1}`}
                aria-selected={shown().includes(at())}
                onClick={() => go(at())}
              >
                <canvas ref={(canvas) => lazy(canvas, at(), () => THUMB_EDGE)} />
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
