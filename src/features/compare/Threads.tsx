import { createEffect, createSignal, For, Show } from "solid-js";
import type { Tab } from "../tabs/tabs";
import "./threads.css";

/** How far into each pane a thread starts, past the divider. */
const INSET = 56;
const MOST_THREADS = 60;
/** How long the threads stay before they are taken away; CSS fades them out before then. */
const SHOWN_MS = 1800;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

interface Thread {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  mark: string;
}

/** The rows of a pane in sight with a compare mark, by lowercase name, with their middles. */
function markedRows(pane: HTMLElement, top: number) {
  const found = new Map<string, { y: number; mark: string }>();
  const list = pane.querySelector(".file-grid")?.getBoundingClientRect();
  if (!list) return found;
  for (const row of pane.querySelectorAll<HTMLElement>(".file-row[data-compare]")) {
    if (row.dataset.ghost !== undefined) continue;
    const box = row.getBoundingClientRect();
    if (box.bottom < list.top || box.top > list.bottom) continue;
    const name = row.querySelector(".file-name")?.textContent?.trim().toLowerCase();
    if (name) found.set(name, { y: box.top + box.height / 2 - top, mark: row.dataset.compare! });
  }
  return found;
}

/**
 * When two folders are first compared, a thread runs across the divider from each row to the row
 * of the same name on the other side, tinted by how they differ, then they fade. Rows that sit
 * level give a straight thread, ones far apart a long curve.
 */
export function CompareThreads(props: { tab: Tab }) {
  const [threads, setThreads] = createSignal<Thread[]>();
  let layer!: HTMLDivElement;
  let shownFor = "";
  let timer: number | undefined;

  function measure(one: number, other: number): Thread[] {
    const pair = layer.parentElement!.getBoundingClientRect();
    const paneOf = (id: number) => layer.parentElement!.querySelector<HTMLElement>(`.pane[data-view="${id}"]`);
    const first = paneOf(one);
    const second = paneOf(other);
    if (!first || !second) return [];
    const [left, right] = first.getBoundingClientRect().left <= second.getBoundingClientRect().left ? [first, second] : [second, first];
    const x1 = left.getBoundingClientRect().right - pair.left - INSET;
    const x2 = right.getBoundingClientRect().left - pair.left + INSET;
    const there = markedRows(right, pair.top);
    const found: Thread[] = [];
    for (const [name, { y, mark }] of markedRows(left, pair.top)) {
      const match = there.get(name);
      if (match && found.length < MOST_THREADS) found.push({ x1, y1: y, x2, y2: match.y, mark });
    }
    return found;
  }

  createEffect(() => {
    const [one, other] = props.tab.panes();
    if (!one || !other || props.tab.stacked() || reducedMotion.matches) return;
    const ready = props.tab.marksOf(one) && props.tab.marksOf(other);
    const key = `${one.folder()?.path}|${other.folder()?.path}`;
    if (!ready || key === shownFor) return;
    shownFor = key;
    // The rows wear their marks from the next paint on.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        setThreads(measure(one.id, other.id));
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
              {(thread, at) => {
                const middle = (thread.x1 + thread.x2) / 2;
                return (
                  <path
                    d={`M ${thread.x1} ${thread.y1} C ${middle} ${thread.y1}, ${middle} ${thread.y2}, ${thread.x2} ${thread.y2}`}
                    pathLength="1"
                    data-compare={thread.mark}
                    style={{ "--at": at() }}
                  />
                );
              }}
            </For>
          </svg>
        )}
      </Show>
    </div>
  );
}
