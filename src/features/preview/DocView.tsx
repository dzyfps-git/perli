import { createEffect, createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js";
import type { BookHeading } from "../../api";
import { saved, stored } from "../filelist/prefs";
import { ToolCog } from "../../ui/Controls";
import { createFind, findIn } from "./FindBar";
import {
  asSource,
  BOOK_THEMES,
  BOOK_WIDTHS,
  bookPaged,
  bookSerif,
  bookTheme,
  bookWidth,
  contentsOpen,
  keepProgress,
  setAsSource,
  setBookPaged,
  setBookTheme,
  setBookWidth,
  setContentsOpen,
  VIEWER_SETTINGS,
  type BookWidth,
} from "./viewerPrefs";

const ICON_CONTENTS = "";
const ICON_FIND = "";
const ICON_SMALLER = "";
const ICON_BIGGER = "";

const ICON_SOURCE = "\uE943";
const ICON_COPY = "\uE8C8";
const DONE_MS = 1400;

const SIZES = [13, 14, 15, 16, 18, 20, 22, 24];
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
function Contents(props: { lines: Line[]; active: number; onPick: (at: number) => void; children?: JSX.Element }) {
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
      {props.children}
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
export function MarkdownView(live: { html: string; source: string; fill: (article: HTMLElement) => void; keys: Keys }) {
  const props = { ...live };
  let scroller!: HTMLDivElement;
  let article!: HTMLElement;
  let written!: HTMLPreElement;
  const [headings, setHeadings] = createSignal<HTMLElement[]>([]);
  const [active, setActive] = createSignal(0);
  const find = createFind(() => (asSource() ? written : article), () => scroller);

  /** Each block of code gets a button that copies it. */
  function addCopyButtons() {
    for (const block of article.querySelectorAll("pre")) {
      const button = document.createElement("button");
      button.className = "md-copy";
      button.setAttribute("aria-label", "Copy code");
      button.textContent = ICON_COPY;
      button.onclick = () =>
        navigator.clipboard.writeText(block.querySelector("code")?.textContent ?? "").then(() => {
          button.dataset.done = "";
          setTimeout(() => delete button.dataset.done, DONE_MS);
        }, console.error);
      block.append(button);
    }
  }

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
    if (!plainKey(event)) return false;
    const key = event.key.toLowerCase();
    if (key === "u") setAsSource(!asSource());
    else if (key === "c" && headings().length >= 2) setContentsOpen(!contentsOpen());
    else return false;
    return true;
  });

  onMount(() => {
    article.innerHTML = props.html;
    props.fill(article);
    addCopyButtons();
    setHeadings([...article.querySelectorAll<HTMLElement>("h1, h2, h3")]);
    // Page Down and the other scrolling keys move the document itself. Beside the list, the list keeps the keys.
    if (!scroller.closest(".preview-docked")) scroller.focus({ preventScroll: true });
  });

  onCleanup(() => {
    props.keys(undefined);
    find.close();
  });

  const lines = () => headings().map((heading) => ({ title: heading.textContent ?? "", depth: Number(heading.tagName[1]) - 1 }));

  return (
    <div class="doc-view" data-contents={(contentsOpen() && !asSource() && headings().length >= 2) || undefined}>
      <Show when={headings().length >= 2}>
        <Contents lines={lines()} active={active()} onPick={pick} />
      </Show>
      <div ref={scroller} class="doc-scroll" tabindex="-1" onScroll={spy}>
        <article ref={article} class="preview-markdown" hidden={asSource()} />
        <pre ref={written} class="preview-text md-source" hidden={!asSource()}>
          {props.source}
        </pre>
      </div>
      <div class="preview-tools doc-tools" role="toolbar" aria-label="Document">
        {find.bar()}
        <FindButton find={find} />
        <button class="strip-icon" aria-label="Show as written" aria-keyshortcuts="U" aria-pressed={asSource()} onClick={() => setAsSource(!asSource())}>
          {ICON_SOURCE}
        </button>
        <Show when={headings().length >= 2 && !asSource()}>
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

interface Mark extends Place {
  label: string;
}

interface Highlight {
  chapter: number;
  text: string;
}

/** A reader's own bookmarks and highlights, kept by Perli and never written into the book. */
interface Notes {
  marks: Mark[];
  highlights: Highlight[];
}

const notesOf = (path: string): Notes => ({ marks: [], highlights: [], ...(saved("book-notes") as Record<string, Notes> | null)?.[path] });

function keepNotes(path: string, notes: Notes) {
  const all = (saved("book-notes") as Record<string, Notes> | null) ?? {};
  delete all[path];
  if (notes.marks.length || notes.highlights.length) all[path] = notes;
  localStorage.setItem("perli-book-notes", JSON.stringify(Object.fromEntries(Object.entries(all).slice(-MOST_PLACES))));
}

/** How many words a minute someone reads, for the time left in a chapter. */
const WORDS_A_MINUTE = 230;
const MOST_HIGHLIGHT = 600;
const LABEL_CHARACTERS = 60;
const WIDTHS = Object.keys(BOOK_WIDTHS) as BookWidth[];
const WIDTH_NAMES: Record<BookWidth, string> = { narrow: "Narrow lines", medium: "Medium lines", wide: "Wide lines" };
const THEME_NAMES = { auto: "Theme: as Perli", paper: "Theme: paper", sepia: "Theme: sepia", night: "Theme: night" };
const ICON_THEME = "";
const ICON_WIDTH = "";
const ICON_PAGED = "";
const ICON_MARK = "";
const ICON_MARKED = "";
const ICON_HIGHLIGHT = "";
const ICON_REMOVE = "";

export const minutesLeft = (words: number, fraction: number) => Math.round((words * (1 - fraction)) / WORDS_A_MINUTE);

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
 * An EPUB a chapter at a time, picking up where it was left, in a scroll or page by page. Left
 * and Right turn pages or chapters. Bookmarks and highlights stay with Perli, never in the book.
 */
export function BookView(live: BookViewProps) {
  const props = { ...live };
  let scroller!: HTMLDivElement;
  let article!: HTMLElement;
  const start = places()[props.path];
  const [chapter, setChapter] = createSignal(Math.min(start?.chapter ?? 0, props.chapters.length - 1));
  const [fraction, setFraction] = createSignal(0);
  const [resumed, setResumed] = createSignal(!!start && (start.chapter > 0 || start.at > 0.02));
  const [words, setWords] = createSignal(0);
  const [notes, setNotes] = createSignal(notesOf(props.path));
  /** Text picked in the chapter, which can become a highlight. */
  const [picking, setPicking] = createSignal<{ text: string; x: number; y: number }>();
  const find = createFind(() => article, () => scroller);
  let restore = start?.at ?? 0;
  let turned = 0;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let wheelAt = 0;
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
  const left = () => minutesLeft(words(), fraction());
  const marked = () => notes().marks.some((mark) => mark.chapter === chapter() && Math.abs(mark.at - fraction()) < 0.01);

  /** Pages a chapter has, in page mode: one column the width of the window each. */
  const pageWidth = () => scroller.clientWidth;
  const pageCount = () => Math.max(1, Math.round(scroller.scrollWidth / pageWidth()));
  const pageAt = () => Math.round(scroller.scrollLeft / pageWidth());

  /** Lays out the chapter: lines of the chosen width, and columns a page wide in page mode. */
  function layout() {
    const room = scroller.clientWidth;
    const pad = Math.max(32, (room - BOOK_WIDTHS[bookWidth()]) / 2);
    article.style.maxWidth = `${BOOK_WIDTHS[bookWidth()]}px`;
    if (bookPaged()) {
      scroller.style.paddingInline = `${pad}px`;
      article.style.columnWidth = `${room - 2 * pad}px`;
      article.style.columnGap = `${2 * pad}px`;
    } else {
      scroller.style.paddingInline = "";
      article.style.columnWidth = article.style.columnGap = "";
    }
  }

  /** Goes to a place in the chapter, from 0 to 1. */
  function place(at: number) {
    if (bookPaged()) scroller.scrollLeft = Math.round(at * (pageCount() - 1)) * pageWidth();
    else scroller.scrollTop = at * (scroller.scrollHeight - scroller.clientHeight);
    measure();
  }

  function turn(by: number, to = 0) {
    const target = chapter() + by;
    if (target < 0 || target >= props.chapters.length) return;
    turned = by;
    restore = to;
    setChapter(target);
  }

  /** On a page, or on to the next chapter from the last page. */
  function turnPage(by: number) {
    if (!bookPaged()) return turn(by);
    const next = pageAt() + by;
    if (next < 0) return turn(-1, 1);
    if (next >= pageCount()) return turn(1);
    scroller.scrollTo({ left: next * pageWidth(), behavior: reducedMotion.matches ? "auto" : "smooth" });
  }

  function measure() {
    if (bookPaged()) setFraction(pageCount() > 1 ? Math.min(pageAt() / (pageCount() - 1), 1) : 1);
    else {
      const room = scroller.scrollHeight - scroller.clientHeight;
      setFraction(room > 0 ? Math.min(scroller.scrollTop / room, 1) : 1);
    }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, SAVE_MS);
  }

  function save() {
    const done = chapter() === props.chapters.length - 1 && fraction() > 0.98;
    keepPlace(props.path, chapter() || fraction() > 0.02 ? (done ? undefined : { chapter: chapter(), at: fraction() }) : undefined);
    keepProgress(props.path, done ? undefined : progress());
  }

  /** The reader's highlights in the chapter shown, painted over its text. */
  function paintHighlights() {
    if (!("highlights" in CSS)) return;
    const ranges = notes()
      .highlights.filter((one) => one.chapter === chapter())
      .flatMap((one) => findIn(article, one.text).slice(0, 1));
    if (ranges.length) CSS.highlights.set("book-highlight", new Highlight(...ranges));
    else CSS.highlights.delete("book-highlight");
  }

  function changeNotes(next: Notes) {
    setNotes(next);
    keepNotes(props.path, next);
    paintHighlights();
  }

  /** The words at the top of what is shown, to name a bookmark by. */
  function labelHere() {
    const box = scroller.getBoundingClientRect();
    const spot = document.elementFromPoint(box.left + scroller.clientWidth / 2, box.top + 48);
    const text = (spot && article.contains(spot) ? spot.textContent ?? "" : article.textContent ?? "").trim().replace(/\s+/g, " ");
    return text.slice(0, LABEL_CHARACTERS) + (text.length > LABEL_CHARACTERS ? "…" : "") || `Chapter ${chapter() + 1}`;
  }

  function toggleMark() {
    const all = notes();
    if (marked()) {
      changeNotes({ ...all, marks: all.marks.filter((mark) => !(mark.chapter === chapter() && Math.abs(mark.at - fraction()) < 0.01)) });
      return;
    }
    const mark = { chapter: chapter(), at: fraction(), label: labelHere() };
    changeNotes({ ...all, marks: [...all.marks, mark].sort((a, b) => a.chapter - b.chapter || a.at - b.at) });
  }

  function highlight() {
    const text = picking()?.text;
    if (!text) return;
    getSelection()?.removeAllRanges();
    setPicking(undefined);
    changeNotes({ ...notes(), highlights: [...notes().highlights, { chapter: chapter(), text }] });
  }

  function goTo(target: Place) {
    if (target.chapter === chapter()) return place(target.at);
    turn(target.chapter - chapter(), target.at);
  }

  /** Text picked inside the chapter offers to become a highlight, beside it. */
  function onPointerUp() {
    requestAnimationFrame(() => {
      const picked = getSelection();
      const text = picked?.toString().trim() ?? "";
      if (!picked?.rangeCount || !text || text.length > MOST_HIGHLIGHT || !article.contains(picked.anchorNode)) return setPicking(undefined);
      const box = picked.getRangeAt(0).getBoundingClientRect();
      const view = scroller.closest(".doc-view")!.getBoundingClientRect();
      setPicking({ text, x: box.left + box.width / 2 - view.left, y: box.top - view.top });
    });
  }

  /** In page mode, the wheel turns pages, one per push. */
  function onWheel(event: WheelEvent) {
    if (!bookPaged() || event.ctrlKey) return;
    event.preventDefault();
    if (Date.now() - wheelAt < 350 || Math.abs(event.deltaY) < 4) return;
    wheelAt = Date.now();
    turnPage(Math.sign(event.deltaY));
  }

  createEffect(() => {
    const at = chapter();
    const by = turned;
    turned = 0;
    find.close();
    setPicking(undefined);
    props
      .load(props.chapters[at])
      .then((html) => {
        if (gone || at !== chapter()) return;
        article.innerHTML = html;
        props.fill(article);
        setWords((article.textContent ?? "").split(/\s+/).filter(Boolean).length);
        layout();
        paintHighlights();
        requestAnimationFrame(() => {
          place(restore);
          restore = 0;
        });
        if (by && !reducedMotion.matches) {
          article.animate(
            { translate: [`${by * 40}px 0`, "0 0"], opacity: [0, 1] },
            { duration: 420, easing: getComputedStyle(article).getPropertyValue("--spring") || "ease-out" },
          );
        }
      })
      .catch((reason) => {
        // A chapter left behind, or a book closed, says nothing.
        if (!gone && at === chapter()) props.onFailure(String(reason));
      });
  });

  // A new width or mode keeps the place in the chapter.
  createEffect(() => {
    bookPaged();
    bookWidth();
    const at = fraction();
    if (!article.childElementCount) return;
    layout();
    requestAnimationFrame(() => place(at));
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
    if (key === "arrowleft") turnPage(-1);
    else if (key === "arrowright") turnPage(1);
    else if (key === "pagedown" && bookPaged()) turnPage(1);
    else if (key === "pageup" && bookPaged()) turnPage(-1);
    else if (key === "c") setContentsOpen(!contentsOpen());
    else if (key === "b") toggleMark();
    else if (key === "h" && picking()) highlight();
    else if (key === "p") setBookPaged(!bookPaged());
    else if (key === "+" || key === "=") size(1);
    else if (key === "-") size(-1);
    else return false;
    return true;
  });

  onMount(() => {
    if (!scroller.closest(".preview-docked")) scroller.focus({ preventScroll: true });
    if (resumed()) setTimeout(() => setResumed(false), RESUME_SHOWN_MS);
    const watcher = new ResizeObserver(() => {
      const at = fraction();
      layout();
      if (bookPaged()) place(at);
    });
    // The border box, since page mode changes the padding, which would wake it again.
    watcher.observe(scroller, { box: "border-box" });
    onCleanup(() => watcher.disconnect());
  });

  onCleanup(() => {
    gone = true;
    clearTimeout(saveTimer);
    save();
    if ("highlights" in CSS) CSS.highlights.delete("book-highlight");
    props.keys(undefined);
    props.note(undefined);
    find.close();
  });

  const chapterName = (at: number) => [...lines()].reverse().find((line) => line.chapter <= at)?.title ?? `Chapter ${at + 1}`;

  return (
    <div
      class="doc-view book-view"
      data-contents={contentsOpen() || undefined}
      data-theme={bookTheme()}
      data-serif={bookSerif() || undefined}
      onClick={onClick}
    >
      <div class="book-progress" style={{ scale: `${progress()} 1` }} />
      <Contents lines={lines()} active={active()} onPick={(at) => turn(lines()[at].chapter - chapter())}>
        <Show when={notes().marks.length}>
          <p class="book-notes-head">Bookmarks</p>
          <For each={notes().marks}>
            {(mark) => (
              <span class="book-note">
                <button class="contents-line" onClick={() => goTo(mark)}>
                  {mark.label}
                </button>
                <button
                  class="book-note-remove"
                  aria-label="Remove this bookmark"
                  onClick={() => changeNotes({ ...notes(), marks: notes().marks.filter((one) => one !== mark) })}
                >
                  {ICON_REMOVE}
                </button>
              </span>
            )}
          </For>
        </Show>
        <Show when={notes().highlights.length}>
          <p class="book-notes-head">Highlights</p>
          <For each={notes().highlights}>
            {(one) => (
              <span class="book-note">
                <button class="contents-line book-highlight-line" aria-description={chapterName(one.chapter)} onClick={() => goTo({ chapter: one.chapter, at: 0 })}>
                  {one.text}
                </button>
                <button
                  class="book-note-remove"
                  aria-label="Remove this highlight"
                  onClick={() => changeNotes({ ...notes(), highlights: notes().highlights.filter((other) => other !== one) })}
                >
                  {ICON_REMOVE}
                </button>
              </span>
            )}
          </For>
        </Show>
      </Contents>
      <div
        ref={scroller}
        class="doc-scroll"
        tabindex="-1"
        data-paged={bookPaged() || undefined}
        onScroll={measure}
        onWheel={onWheel}
        onPointerUp={onPointerUp}
      >
        <article ref={article} class="preview-markdown preview-book" style={{ "font-size": `${bookSize()}px` }} />
      </div>
      <Show when={words() > WORDS_A_MINUTE}>
        <p class="book-left" aria-live="off">
          {left() < 1 ? "Less than a minute left in this chapter" : `About ${left()} min left in this chapter`}
        </p>
      </Show>
      <Show when={picking()}>
        {(at) => (
          <button class="details-button book-pick" style={{ left: `${at().x}px`, top: `${at().y}px` }} aria-keyshortcuts="H" onClick={highlight}>
            <span aria-hidden="true">{ICON_HIGHLIGHT}</span> Highlight
          </button>
        )}
      </Show>
      <div class="preview-tools doc-tools" role="toolbar" aria-label="Book">
        {find.bar()}
        <FindButton find={find} />
        <ContentsButton />
        <button class="strip-icon" aria-label={marked() ? "Remove the bookmark here" : "Bookmark this place"} aria-keyshortcuts="B" aria-pressed={marked()} onClick={toggleMark}>
          {marked() ? ICON_MARKED : ICON_MARK}
        </button>
        <button class="strip-icon" aria-label="Smaller text" aria-keyshortcuts="-" disabled={bookSize() <= SIZES[0]} onClick={() => size(-1)}>
          {ICON_SMALLER}
        </button>
        <button class="strip-icon" aria-label="Bigger text" aria-keyshortcuts="+" disabled={bookSize() >= SIZES.at(-1)!} onClick={() => size(1)}>
          {ICON_BIGGER}
        </button>
        <button class="strip-icon" aria-label={WIDTH_NAMES[bookWidth()]} onClick={() => setBookWidth(WIDTHS[(WIDTHS.indexOf(bookWidth()) + 1) % WIDTHS.length])}>
          {ICON_WIDTH}
        </button>
        <button class="strip-icon" aria-label={THEME_NAMES[bookTheme()]} onClick={() => setBookTheme(BOOK_THEMES[(BOOK_THEMES.indexOf(bookTheme()) + 1) % BOOK_THEMES.length])}>
          {ICON_THEME}
        </button>
        <button class="strip-icon" aria-label="Page by page" aria-keyshortcuts="P" aria-pressed={bookPaged()} onClick={() => setBookPaged(!bookPaged())}>
          {ICON_PAGED}
        </button>
        <ToolCog label="Book settings" items={VIEWER_SETTINGS["Documents and books"]} />
      </div>
      <Show when={resumed()}>
        <div class="doc-resumed" role="status">
          Picked up where you left off
          <button
            class="details-button"
            onClick={() => {
              setResumed(false);
              turn(-chapter());
              requestAnimationFrame(() => place(0));
            }}
          >
            Start over
          </button>
        </div>
      </Show>
    </div>
  );
}
