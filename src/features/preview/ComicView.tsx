import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import type { Thumb } from "../../api";
import { saved, stored } from "../filelist/prefs";
import { draw } from "./QuickPreview";

const ICON_SPREAD = "";
const ICON_MANGA = "";
const ICON_STRIP = "";

type Fit = "page" | "width" | "height";
const FITS: Fit[] = ["page", "width", "height"];
const FIT_NAMES: Record<Fit, string> = { page: "Fit page", width: "Fit width", height: "Fit height" };
const [spread, setSpread] = stored("comic-spread", saved("comic-spread") === true);
const [manga, setManga] = stored("comic-manga", saved("comic-manga") === true);
const [fit, setFit] = stored<Fit>("comic-fit", FITS.includes(saved("comic-fit") as Fit) ? (saved("comic-fit") as Fit) : "page");
const [strip, setStrip] = stored("comic-strip", saved("comic-strip") !== false);

const THUMB_EDGE = 160;
const MOST_EDGE = 4096;
const MOST_PLACES = 200;
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
}

/**
 * A comic a page or two at a time, in either reading direction, with its pages in a strip below.
 * Each comic keeps its page for next time, and offers to go back there.
 */
export function ComicView(live: ComicViewProps) {
  const props = { ...live };
  const count = props.pages.length;
  let stage!: HTMLDivElement;
  let sheet!: HTMLDivElement;
  let stripList: HTMLDivElement | undefined;
  const savedPage = Math.min(places()[props.path] ?? 0, count - 1);
  /** The first page shown. In a spread, the cover is alone and the rest come in pairs. */
  const [page, setPage] = createSignal(0);
  const [offer, setOffer] = createSignal(savedPage > 0 ? savedPage : 0);
  let turned = 0;
  let gone = false;
  /** The first showing must not forget the page saved last time. */
  let first = true;

  const shown = () => {
    const at = page();
    if (!spread() || at === 0 || at + 1 >= count) return [at];
    return [at, at + 1];
  };
  /** Where a spread starts for any page: the cover alone, then odd pages first. */
  const startOf = (at: number) => (spread() && at > 0 ? at - ((at - 1) % 2) : at);

  function go(target: number, by = Math.sign(target - page())) {
    const start = startOf(Math.min(Math.max(target, 0), count - 1));
    if (start === page()) return;
    turned = by;
    setOffer(0);
    setPage(start);
  }

  /** Forward or back in reading order. */
  const turn = (by: number) => {
    const step = by > 0 ? shown().length : spread() && page() > 1 ? 2 : 1;
    go(page() + by * step, by);
  };
  /** Left and right on screen, which swap in manga. */
  const side = (right: boolean) => turn(right !== manga() ? 1 : -1);

  function edge() {
    const box = Math.max(stage.clientWidth, stage.clientHeight) * devicePixelRatio;
    return Math.ceil(Math.min(fit() === "page" ? box : box * 2, MOST_EDGE));
  }

  createEffect(
    on([page, spread, fit], () => {
      const at = shown();
      const by = turned;
      turned = 0;
      const canvases = [...sheet.querySelectorAll("canvas")];
      at.forEach((one, place) =>
        props
          .load(props.pages[one], edge())
          .then((picture) => {
            if (!gone && picture && page() === at[0] && canvases[place]?.isConnected) draw(canvases[place], picture);
          })
          .catch(console.error),
      );
      stage.scrollTo(0, 0);
      if (by && !reducedMotion.matches) {
        const from = by * (manga() ? -1 : 1) * 48;
        sheet.animate(
          { translate: [`${from}px 0`, "0 0"], opacity: [0.2, 1] },
          { duration: 460, easing: getComputedStyle(sheet).getPropertyValue("--spring") || "ease-out" },
        );
      }
      const thumb = stripList?.children[at[0]] as HTMLElement | undefined;
      thumb?.scrollIntoView({ inline: "center", block: "nearest", behavior: reducedMotion.matches ? "auto" : "smooth" });
      if (!first) keepPage(props.path, at[0] || undefined);
      first = false;
    }),
  );

  createEffect(() => {
    const at = shown();
    const where = at.length > 1 ? `Pages ${at[0] + 1}–${at[1] + 1}` : `Page ${at[0] + 1}`;
    props.note(`${where} of ${count}`);
  });

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
    else return false;
    return true;
  });

  onMount(() => {
    // Turning on the spread can land mid-pair.
    createEffect(on(spread, () => setPage(startOf(page())), { defer: true }));
  });

  onCleanup(() => {
    gone = true;
    props.keys(undefined);
    props.note(undefined);
  });

  /** A strip picture loads once it scrolls into sight. */
  function lazyThumb(canvas: HTMLCanvasElement, at: number) {
    const watch = new IntersectionObserver((seen) => {
      if (!seen[0].isIntersecting) return;
      watch.disconnect();
      props
        .load(props.pages[at], THUMB_EDGE)
        .then((picture) => !gone && picture && draw(canvas, picture))
        .catch(console.error);
    });
    watch.observe(canvas);
    onCleanup(() => watch.disconnect());
  }

  return (
    <div class="comic-view" data-strip={strip() || undefined}>
      <div ref={stage} class="comic-stage" data-fit={fit()} onClick={(event) => side(event.clientX > stage.getBoundingClientRect().left + stage.clientWidth / 2)}>
        <div ref={sheet} class="comic-sheet" data-manga={manga() || undefined}>
          <For each={shown()}>{() => <canvas class="preview-picture comic-page" />}</For>
        </div>
      </div>
      <div class="preview-tools comic-tools" role="toolbar" aria-label="Comic">
        <button class="strip-icon" aria-label="Two pages" aria-keyshortcuts="S" aria-pressed={spread()} onClick={() => setSpread(!spread())}>
          {ICON_SPREAD}
        </button>
        <button class="strip-icon" aria-label="Right to left, for manga" aria-keyshortcuts="M" aria-pressed={manga()} onClick={() => setManga(!manga())}>
          {ICON_MANGA}
        </button>
        <button class="zoom-chip comic-fit" aria-label="Change the fit" aria-keyshortcuts="F" onClick={() => setFit(FITS[(FITS.indexOf(fit()) + 1) % FITS.length])}>
          {FIT_NAMES[fit()]}
        </button>
        <button class="strip-icon" aria-label="Page strip" aria-keyshortcuts="T" aria-pressed={strip()} onClick={() => setStrip(!strip())}>
          {ICON_STRIP}
        </button>
      </div>
      <Show when={offer()}>
        <button class="player-resume comic-resume" onClick={() => go(offer())}>
          Resume at page {offer() + 1}
        </button>
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
                <canvas ref={(canvas) => lazyThumb(canvas, at())} />
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
