import { createEffect, createSignal, For, Show } from "solid-js";
import type { Tab } from "../tabs/tabs";
import "./threads.css";

/** How far into each pane a thread starts, past the divider. */
const INSET = 56;
const MOST_THREADS = 60;
/** How long the threads stay before they are taken away; CSS fades them out before then. */
const SHOWN_MS = 1800;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

/** The gap between a name and the thread that starts after it, in stacked panes. */
const AFTER_NAME = 8;

interface Thread {
  /** The SVG path. */
  d: string;
  mark: string;
}

/** The rows of a pane in sight with a compare mark, by lowercase name, with their middles and
 *  where their names end. */
function markedRows(pane: HTMLElement, pair: DOMRect) {
  const found = new Map<string, { x: number; y: number; mark: string }>();
  const list = pane.querySelector(".file-grid")?.getBoundingClientRect();
  if (!list) return found;
  for (const row of pane.querySelectorAll<HTMLElement>(".file-row[data-compare]")) {
    if (row.dataset.ghost !== undefined) continue;
    const box = row.getBoundingClientRect();
    if (box.bottom < list.top || box.top > list.bottom) continue;
    const label = row.querySelector<HTMLElement>(".file-name");
    const name = label?.textContent?.trim().toLowerCase();
    if (!label || !name) continue;
    const end = label.getBoundingClientRect().left + Math.min(label.scrollWidth, label.clientWidth) + AFTER_NAME;
    found.set(name, { x: end - pair.left, y: box.top + box.height / 2 - pair.top, mark: row.dataset.compare! });
  }
  return found;
}

/**
 * When two folders are first compared, a thread runs across the divider from each row to the row
 * of the same name on the other side, tinted by how they differ, then they fade. Rows that sit
 * level give a straight thread, ones far apart a long curve. In stacked panes the threads fall
 * from the end of each name down to its match.
 */
export function CompareThreads(props: { tab: Tab }) {
  const [threads, setThreads] = createSignal<Thread[]>();
  let layer!: HTMLDivElement;
  let shownFor = "";
  let timer: number | undefined;

  function measure(one: number, other: number, stacked: boolean): Thread[] {
    const pair = layer.parentElement!.getBoundingClientRect();
    const paneOf = (id: number) => layer.parentElement!.querySelector<HTMLElement>(`.pane[data-view="${id}"]`);
    const first = paneOf(one);
    const second = paneOf(other);
    if (!first || !second) return [];
    const place = (pane: HTMLElement) => (stacked ? pane.getBoundingClientRect().top : pane.getBoundingClientRect().left);
    const [near, far] = place(first) <= place(second) ? [first, second] : [second, first];
    const x1 = near.getBoundingClientRect().right - pair.left - INSET;
    const x2 = far.getBoundingClientRect().left - pair.left + INSET;
    const there = markedRows(far, pair);
    const found: Thread[] = [];
    for (const [name, from] of markedRows(near, pair)) {
      const to = there.get(name);
      if (!to || found.length >= MOST_THREADS) continue;
      const middle = stacked ? (from.y + to.y) / 2 : (x1 + x2) / 2;
      const d = stacked
        ? `M ${from.x} ${from.y} C ${from.x} ${middle}, ${to.x} ${middle}, ${to.x} ${to.y}`
        : `M ${x1} ${from.y} C ${middle} ${from.y}, ${middle} ${to.y}, ${x2} ${to.y}`;
      found.push({ d, mark: from.mark });
    }
    return found;
  }

  createEffect(() => {
    const [one, other] = props.tab.panes();
    if (!one || !other || reducedMotion.matches) return;
    const stacked = props.tab.stacked();
    const ready = props.tab.marksOf(one) && props.tab.marksOf(other);
    const key = `${one.folder()?.path}|${other.folder()?.path}`;
    if (!ready || key === shownFor) return;
    shownFor = key;
    // The rows wear their marks from the next paint on.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        setThreads(measure(one.id, other.id, stacked));
        window.clearTimeout(timer);
        timer = window.setTimeout(() => setThreads(undefined), SHOWN_MS);
      }),
    );
  });

  return (
    <div ref={layer} class="compare-threads-layer" aria-hidden="true">
      <Show when={threads()?.length ? threads() : undefined} keyed>
        {(shown) => (
          <svg class="compare-threads">
            <For each={shown}>
              {(thread, at) => <path d={thread.d} pathLength="1" data-compare={thread.mark} style={{ "--at": at() }} />}
            </For>
          </svg>
        )}
      </Show>
    </div>
  );
}
