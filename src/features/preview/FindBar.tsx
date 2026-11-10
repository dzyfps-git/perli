import { createSignal, Show } from "solid-js";

const ICON_UP = "";
const ICON_DOWN = "";
const ICON_CLOSE = "";
/** Past this many, the count stops and says so. */
const MOST_MATCHES = 5000;

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
  for (const match of text.matchAll(new RegExp(escaped(query), "gi"))) {
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

/**
 * Find for a view's text, drawn with the CSS highlight API so the text itself never changes.
 * `more` loads the next piece of a long file, so Next can go past what has loaded.
 */
export function createFind(root: () => HTMLElement | undefined, scroller: () => HTMLElement, more?: () => Promise<boolean>) {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [count, setCount] = createSignal(0);
  const [current, setCurrent] = createSignal(-1);
  let ranges: Range[] = [];
  let input: HTMLInputElement | undefined;

  function select(at: number) {
    setCurrent(at);
    paint("find-current", ranges[at] ? [ranges[at]] : []);
    if (ranges[at]) scrollToRange(scroller(), ranges[at]);
  }

  /** Finds again, from the match before or from the top. */
  function run(keep: boolean) {
    const where = root();
    ranges = where && open() ? findIn(where, query()) : [];
    setCount(ranges.length);
    paint("find", ranges);
    if (!keep) select(ranges.length ? 0 : -1);
    else paint("find-current", ranges[current()] ? [ranges[current()]] : []);
  }

  /** With nothing found yet, the rest of the file loads first, so a match far down is found too. */
  async function step(by: number) {
    if (!query()) return;
    const next = current() < 0 && by < 0 ? -1 : current() + by;
    while ((!ranges.length || next >= ranges.length) && more && (await more())) run(true);
    if (ranges.length) select((next + ranges.length) % ranges.length);
  }

  function show() {
    setOpen(true);
    run(false);
    requestAnimationFrame(() => {
      input?.focus();
      input?.select();
    });
  }

  function close() {
    setOpen(false);
    ranges = [];
    paint("find", []);
    paint("find-current", []);
  }

  /** Ctrl+F, F3 and Shift+F3, and Enter and Escape in the box. */
  function keys(event: KeyboardEvent) {
    const key = event.key;
    if (event.ctrlKey && key.toLowerCase() === "f") show();
    else if (key === "F3" && open()) void step(event.shiftKey ? -1 : 1);
    else if (key === "Enter" && event.target === input) void step(event.shiftKey ? -1 : 1);
    else if (key === "Escape" && open()) close();
    else return false;
    return true;
  }

  const label = () => {
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
        <button class="strip-icon" aria-label="Close find" aria-keyshortcuts="Escape" onClick={close}>
          {ICON_CLOSE}
        </button>
      </div>
    </Show>
  );

  return { open, show, close, keys, bar, refresh: () => open() && run(true) };
}
