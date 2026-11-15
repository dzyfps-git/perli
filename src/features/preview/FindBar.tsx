import { createSignal, Show } from "solid-js";

const ICON_UP = "";
const ICON_DOWN = "";
const ICON_CLOSE = "";
/** Past this many, the count stops and says so. */
const MOST_MATCHES = 5000;

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** What find looks for: the typed text anywhere, ignoring case. */
export const findPattern = (query: string) => new RegExp(escaped(query), "gi");

/** Where each match of `query` starts and ends in `text`, as find counts them. */
export const matchesOf = (text: string, query: string): [number, number][] =>
  query ? [...text.matchAll(findPattern(query))].slice(0, MOST_MATCHES).map((match) => [match.index, match.index + match[0].length]) : [];

/** The text nodes under `root` joined up, with where each one starts, so matches can span tags. */
function textOf(root: Node) {
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push(node as Text);
    starts.push(text.length);
    text += (node as Text).data;
  }
  /** The node and offset of a place in `text`. */
  const place = (at: number): [Text, number] => {
    let low = 0;
    let high = nodes.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle] <= at) low = middle;
      else high = middle - 1;
    }
    return [nodes[low], at - starts[low]];
  };
  const range = (start: number, end: number) => {
    const made = document.createRange();
    made.setStart(...place(start));
    made.setEnd(...place(end));
    return made;
  };
  return { text, range, empty: !nodes.length };
}

/** Every place `query` shows under `root`, ignoring case. */
export function findIn(root: Node, query: string): Range[] {
  const { text, range, empty } = textOf(root);
  if (!query || empty) return [];
  const found: Range[] = [];
  for (const match of text.matchAll(findPattern(query))) {
    found.push(range(match.index, match.index + match[0].length));
    if (found.length >= MOST_MATCHES) break;
  }
  return found;
}

/** Line `line` (from 1) of the text under `root`, or undefined past the end. */
export function lineIn(root: Node, line: number): Range | undefined {
  const { text, range, empty } = textOf(root);
  if (empty || line < 1) return undefined;
  let start = 0;
  for (let at = 1; at < line; at++) {
    start = text.indexOf("\n", start) + 1;
    if (start === 0) return undefined;
  }
  const end = text.indexOf("\n", start);
  return range(start, end < 0 ? text.length : end);
}

/** Scrolls so `range` sits a third of the way down, and into view sideways. */
export function scrollToRange(scroller: HTMLElement, range: Range) {
  const box = range.getBoundingClientRect();
  const view = scroller.getBoundingClientRect();
  scroller.scrollBy({
    top: box.top - view.top - view.height / 3,
    left: box.left < view.left || box.right > view.right ? box.left - view.left - view.width / 3 : 0,
    behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
  });
}

function paint(name: string, ranges: Range[]) {
  if (ranges.length) CSS.highlights.set(name, new Highlight(...ranges));
  else CSS.highlights.delete(name);
}

/** A text that find can also replace in. Match numbers count as `matchesOf` does. */
export interface FindEdits {
  /** Match `at` became the current one. */
  chose: (at: number, query: string) => void;
  /** Puts `by` in place of match `at`. Gives the match that comes next. */
  replace: (at: number, query: string, by: string) => number;
  /** Puts `by` in place of every match. Gives how many there were. */
  replaceAll: (query: string, by: string) => number;
}

/**
 * Find for a view's text, drawn with the CSS highlight API so the text itself never changes.
 * `more` loads the next piece of a long file, so Next can go past what has loaded. With `edits`,
 * Ctrl+H finds and replaces.
 */
export function createFind(root: () => HTMLElement | undefined, scroller: () => HTMLElement, more?: () => Promise<boolean>, edits?: FindEdits) {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [count, setCount] = createSignal(0);
  const [current, setCurrent] = createSignal(-1);
  const [replacing, setReplacing] = createSignal(false);
  const [by, setBy] = createSignal("");
  /** What the last Replace all did, until the next search. */
  const [said, setSaid] = createSignal<string>();
  let ranges: Range[] = [];
  let input: HTMLInputElement | undefined;
  let byInput: HTMLInputElement | undefined;
  /** A replace changed the text, so the next look at it goes to the match after. */
  let follow = false;

  function select(at: number) {
    setCurrent(at);
    paint("find-current", ranges[at] ? [ranges[at]] : []);
    if (!ranges[at]) return;
    scrollToRange(scroller(), ranges[at]);
    edits?.chose(at, query());
  }

  /** Finds again, from the match before or from the top. */
  function run(keep: boolean) {
    const where = root();
    ranges = where && open() ? findIn(where, query()) : [];
    setCount(ranges.length);
    paint("find", ranges);
    if (!keep) select(ranges.length ? 0 : -1);
    else if (follow) {
      follow = false;
      select(ranges.length ? Math.min(current(), ranges.length - 1) : -1);
    } else paint("find-current", ranges[current()] ? [ranges[current()]] : []);
  }

  /** A replace types into the text, so the focus goes back to where it was after. */
  function replace() {
    if (!edits || !query() || current() < 0) return;
    const back = document.activeElement as HTMLElement | null;
    follow = true;
    setCurrent(edits.replace(current(), query(), by()));
    back?.focus();
  }

  function replaceAll() {
    if (!edits || !query()) return;
    const back = document.activeElement as HTMLElement | null;
    const done = edits.replaceAll(query(), by());
    setSaid(done ? `Replaced ${done.toLocaleString()}` : undefined);
    back?.focus();
  }

  /** With nothing found yet, the rest of the file loads first, so a match far down is found too. */
  async function step(by: number) {
    if (!query()) return;
    const next = current() < 0 && by < 0 ? -1 : current() + by;
    while ((!ranges.length || next >= ranges.length) && more && (await more())) run(true);
    if (ranges.length) select((next + ranges.length) % ranges.length);
  }

  function show(withReplace = false) {
    setOpen(true);
    setReplacing(withReplace && !!edits);
    run(false);
    requestAnimationFrame(() => {
      input?.focus();
      input?.select();
    });
  }

  function close() {
    setOpen(false);
    setReplacing(false);
    setSaid(undefined);
    ranges = [];
    paint("find", []);
    paint("find-current", []);
  }

  /** Ctrl+F, Ctrl+H, F3 and Shift+F3, and Enter and Escape in the boxes. */
  function keys(event: KeyboardEvent) {
    const key = event.key;
    if (event.ctrlKey && key.toLowerCase() === "f") show(replacing());
    else if (event.ctrlKey && key.toLowerCase() === "h" && edits) show(true);
    else if (key === "F3" && open()) void step(event.shiftKey ? -1 : 1);
    else if (key === "Enter" && event.target === input) void step(event.shiftKey ? -1 : 1);
    else if (key === "Enter" && event.target === byInput) (event.ctrlKey ? replaceAll : replace)();
    else if (key === "Escape" && open()) close();
    else return false;
    return true;
  }

  const label = () => {
    if (said()) return said();
    if (!query()) return "";
    if (!count()) return "No matches";
    return `${current() + 1} of ${count().toLocaleString()}${count() >= MOST_MATCHES ? "+" : ""}`;
  };

  const bar = () => (
    <Show when={open()}>
      <div class="find-bar" role="search">
        <input
          ref={input}
          aria-label="Find"
          placeholder="Find"
          spellcheck={false}
          value={query()}
          onInput={(event) => {
            setQuery(event.currentTarget.value);
            setSaid(undefined);
            run(false);
          }}
        />
        <span class="find-count" aria-live="polite">
          {label()}
        </span>
        <button class="strip-icon" aria-label="Previous match" aria-keyshortcuts="Shift+F3" onClick={() => void step(-1)}>
          {ICON_UP}
        </button>
        <button class="strip-icon" aria-label="Next match" aria-keyshortcuts="F3" onClick={() => void step(1)}>
          {ICON_DOWN}
        </button>
        <Show when={replacing()}>
          <input
            ref={byInput}
            class="find-replace"
            aria-label="Replace with"
            placeholder="Replace with"
            spellcheck={false}
            value={by()}
            onInput={(event) => setBy(event.currentTarget.value)}
          />
          <button class="preview-chip" aria-keyshortcuts="Enter" disabled={current() < 0} onClick={replace}>
            Replace
          </button>
          <button class="preview-chip" aria-keyshortcuts="Control+Enter" disabled={!count()} onClick={replaceAll}>
            All
          </button>
        </Show>
        <button class="strip-icon" aria-label="Close find" aria-keyshortcuts="Escape" onClick={close}>
          {ICON_CLOSE}
        </button>
      </div>
    </Show>
  );

  return { open, show, close, keys, bar, refresh: () => open() && run(true) };
}
