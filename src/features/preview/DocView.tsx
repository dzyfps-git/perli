import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { BookHeading } from "../../api";
import { saved, stored } from "../filelist/prefs";
import { createFind } from "./FindBar";

const ICON_CONTENTS = "";
const ICON_FIND = "";
const ICON_SMALLER = "";
const ICON_BIGGER = "";

const SIZES = [13, 14, 15, 16, 18, 20, 22, 24];
const [contentsOpen, setContentsOpen] = stored("doc-contents", saved("doc-contents") === true);
const [bookSize, setBookSize] = stored("book-size", (saved("book-size") as number | null) ?? 16);
/** A heading counts as reached once it is this close to the top. */
const REACHED_PX = 32;
const SAVE_MS = 500;
const MOST_PLACES = 200;
const RESUME_SHOWN_MS = 6000;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

type Keys = (handler: ((event: KeyboardEvent) => boolean) | undefined) => void;

interface Line {
  title: string;
  depth: number;
}

/** A side list of where things are, with a marker that travels to the part being read. */
function Contents(props: { lines: Line[]; active: number; onPick: (at: number) => void }) {
  let list!: HTMLElement;
  const [marker, setMarker] = createSignal({ top: 0, height: 0 });
  createEffect(() => {
    const item = list.children[props.active + 1] as HTMLElement | undefined;
    if (!item) return setMarker({ top: 0, height: 0 });
    setMarker({ top: item.offsetTop, height: item.offsetHeight });
    item.scrollIntoView({ block: "nearest" });
  });
  return (
    <nav ref={list} class="doc-contents" aria-label="Contents">
      <span class="contents-marker" style={{ translate: `0 ${marker().top}px`, height: `${marker().height}px` }} />
      <For each={props.lines}>
        {(line, at) => (
          <button
            class="contents-line"
            style={{ "padding-left": `${10 + line.depth * 14}px` }}
            aria-current={at() === props.active ? "true" : undefined}
            onClick={() => props.onPick(at())}
          >
            {line.title}
          </button>
        )}
      </For>
    </nav>
  );
}

function ContentsButton() {
  return (
    <button
      class="strip-icon"
      aria-label="Contents"
      aria-keyshortcuts="C"
      aria-pressed={contentsOpen()}
      onClick={() => setContentsOpen(!contentsOpen())}
    >
      {ICON_CONTENTS}
    </button>
  );
}

function FindButton(props: { find: ReturnType<typeof createFind> }) {
  return (
    <button
      class="strip-icon"
      aria-label="Find"
      aria-keyshortcuts="Control+F"
      aria-pressed={props.find.open()}
      onClick={() => (props.find.open() ? props.find.close() : props.find.show())}
    >
      {ICON_FIND}
    </button>
  );
}

const plainKey = (event: KeyboardEvent) => !event.ctrlKey && !event.altKey && !(event.target instanceof HTMLInputElement);

/** A Markdown file with its contents beside it and find. */
export function MarkdownView(live: { html: string; fill: (article: HTMLElement) => void; keys: Keys }) {
  const props = { ...live };
  let scroller!: HTMLDivElement;
  let article!: HTMLElement;
  const [headings, setHeadings] = createSignal<HTMLElement[]>([]);
  const [active, setActive] = createSignal(0);
  const find = createFind(() => article, () => scroller);

  function spy() {
    const top = scroller.scrollTop + REACHED_PX;
    const list = headings();
    let at = 0;
    while (at + 1 < list.length && list[at + 1].offsetTop <= top) at++;
    setActive(at);
  }

  const pick = (at: number) =>
    scroller.scrollTo({ top: headings()[at].offsetTop - 12, behavior: reducedMotion.matches ? "auto" : "smooth" });

  props.keys((event) => {
    if (find.keys(event)) return true;
    if (!plainKey(event) || event.key.toLowerCase() !== "c" || headings().length < 2) return false;
    setContentsOpen(!contentsOpen());
    return true;
  });

  onMount(() => {
    article.innerHTML = props.html;
    props.fill(article);
    setHeadings([...article.querySelectorAll<HTMLElement>("h1, h2, h3")]);
    // Page Down and the other scrolling keys move the document itself.
    scroller.focus({ preventScroll: true });
  });

  onCleanup(() => {
    props.keys(undefined);
    find.close();
  });

  const lines = () => headings().map((heading) => ({ title: heading.textContent ?? "", depth: Number(heading.tagName[1]) - 1 }));

  return (
    <div class="doc-view" data-contents={(contentsOpen() && headings().length >= 2) || undefined}>
      <Show when={headings().length >= 2}>
        <Contents lines={lines()} active={active()} onPick={pick} />
      </Show>
      <div ref={scroller} class="doc-scroll" tabindex="-1" onScroll={spy}>
        <article ref={article} class="preview-markdown" />
      </div>
      <div class="preview-tools doc-tools" role="toolbar" aria-label="Document">
        {find.bar()}
        <FindButton find={find} />
        <Show when={headings().length >= 2}>
          <ContentsButton />
        </Show>
      </div>
    </div>
  );
}

interface Place {
  chapter: number;
  /** How far down the chapter, from 0 to 1. */
  at: number;
}

const places = () => (saved("book-places") as Record<string, Place> | null) ?? {};

function keepPlace(path: string, place: Place | undefined) {
  const all = places();
  delete all[path];
  if (place) all[path] = place;
  // The newest go last, so the oldest are the ones let go.
  const kept = Object.entries(all).slice(-MOST_PLACES);
  localStorage.setItem("perli-book-places", JSON.stringify(Object.fromEntries(kept)));
}

export interface BookViewProps {
  path: string;
  title: string;
  chapters: string[];
  contents: BookHeading[];
  load: (chapter: string) => Promise<string>;
  fill: (article: HTMLElement) => void;
  keys: Keys;
  note: (text: string | undefined) => void;
  onFailure: (reason: string) => void;
}

/**
 * An EPUB a chapter at a time, picking up where it was left. Left and Right turn chapters, and
 * the contents, text size and find are a key away.
 */
export function BookView(live: BookViewProps) {
  const props = { ...live };
  let scroller!: HTMLDivElement;
  let article!: HTMLElement;
  const start = places()[props.path];
  const [chapter, setChapter] = createSignal(Math.min(start?.chapter ?? 0, props.chapters.length - 1));
  const [fraction, setFraction] = createSignal(0);
  const [resumed, setResumed] = createSignal(!!start && (start.chapter > 0 || start.at > 0.02));
  const find = createFind(() => article, () => scroller);
  let restore = start?.at ?? 0;
  let turned = 0;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let gone = false;

  const lines = (): (Line & { chapter: number })[] =>
    props.contents.length
      ? props.contents
      : props.chapters.map((_, at) => ({ title: `Chapter ${at + 1}`, chapter: at, depth: 0 }));
  const active = () => {
    const all = lines();
    let found = 0;
    all.forEach((line, at) => line.chapter <= chapter() && (found = at));
    return found;
  };
  const progress = () => (chapter() + fraction()) / props.chapters.length;

  function turn(by: number) {
    const target = chapter() + by;
    if (target < 0 || target >= props.chapters.length) return;
    turned = by;
    restore = 0;
    setChapter(target);
  }

  function measure() {
    const room = scroller.scrollHeight - scroller.clientHeight;
    setFraction(room > 0 ? Math.min(scroller.scrollTop / room, 1) : 1);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, SAVE_MS);
  }

  function save() {
    const done = chapter() === props.chapters.length - 1 && fraction() > 0.98;
    keepPlace(props.path, chapter() || fraction() > 0.02 ? (done ? undefined : { chapter: chapter(), at: fraction() }) : undefined);
  }

  createEffect(() => {
    const at = chapter();
    const by = turned;
    turned = 0;
    find.close();
    props
      .load(props.chapters[at])
      .then((html) => {
        if (gone || at !== chapter()) return;
        article.innerHTML = html;
        props.fill(article);
        requestAnimationFrame(() => {
          scroller.scrollTop = restore * (scroller.scrollHeight - scroller.clientHeight);
          restore = 0;
          measure();
        });
        if (by && !reducedMotion.matches) {
          article.animate(
            { translate: [`${by * 40}px 0`, "0 0"], opacity: [0, 1] },
            { duration: 420, easing: getComputedStyle(article).getPropertyValue("--spring") || "ease-out" },
          );
        }
      })
      .catch((reason) => props.onFailure(String(reason)));
  });

  createEffect(() =>
    props.note(
      [props.title, `Chapter ${chapter() + 1} of ${props.chapters.length}`, `${Math.round(progress() * 100)}%`]
        .filter(Boolean)
        .join("  ·  "),
    ),
  );

  function onClick(event: MouseEvent) {
    const link = (event.target as HTMLElement).closest<HTMLElement>("a[data-chapter]");
    if (!link) return;
    event.preventDefault();
    event.stopPropagation();
    const at = props.chapters.indexOf(link.dataset.chapter!);
    if (at >= 0) turn(at - chapter());
  }

  const size = (by: number) => {
    const at = SIZES.indexOf(bookSize());
    setBookSize(SIZES[Math.min(Math.max((at < 0 ? 3 : at) + by, 0), SIZES.length - 1)]);
  };

  props.keys((event) => {
    if (find.keys(event)) return true;
    if (!plainKey(event)) return false;
    const key = event.key.toLowerCase();
    if (key === "arrowleft") turn(-1);
    else if (key === "arrowright") turn(1);
    else if (key === "c") setContentsOpen(!contentsOpen());
    else if (key === "+" || key === "=") size(1);
    else if (key === "-") size(-1);
    else return false;
    return true;
  });

  onMount(() => {
    scroller.focus({ preventScroll: true });
    if (resumed()) setTimeout(() => setResumed(false), RESUME_SHOWN_MS);
  });

  onCleanup(() => {
    gone = true;
    clearTimeout(saveTimer);
    save();
    props.keys(undefined);
    props.note(undefined);
    find.close();
  });

  return (
    <div class="doc-view" data-contents={contentsOpen() || undefined} onClick={onClick}>
      <div class="book-progress" style={{ scale: `${progress()} 1` }} />
      <Contents lines={lines()} active={active()} onPick={(at) => turn(lines()[at].chapter - chapter())} />
      <div ref={scroller} class="doc-scroll" tabindex="-1" onScroll={measure}>
        <article ref={article} class="preview-markdown preview-book" style={{ "font-size": `${bookSize()}px` }} />
      </div>
      <div class="preview-tools doc-tools" role="toolbar" aria-label="Book">
        {find.bar()}
        <FindButton find={find} />
        <ContentsButton />
        <button class="strip-icon" aria-label="Smaller text" aria-keyshortcuts="-" disabled={bookSize() <= SIZES[0]} onClick={() => size(-1)}>
          {ICON_SMALLER}
        </button>
        <button class="strip-icon" aria-label="Bigger text" aria-keyshortcuts="+" disabled={bookSize() >= SIZES.at(-1)!} onClick={() => size(1)}>
          {ICON_BIGGER}
        </button>
      </div>
      <Show when={resumed()}>
        <div class="doc-resumed" role="status">
          Picked up where you left off
          <button
            class="details-button"
            onClick={() => {
              setResumed(false);
              turn(-chapter());
              requestAnimationFrame(() => (scroller.scrollTop = 0));
            }}
          >
            Start over
          </button>
        </div>
      </Show>
    </div>
  );
}
