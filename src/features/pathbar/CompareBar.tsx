import { createMemo, For, Show } from "solid-js";
import { MARKS, type Mark, type Marks } from "../../api";
import type { FolderView } from "../navigation/folderView";

const ICON_COMPARE = "";
const ICON_COPY = "";
const ICON_STOP = "";

/** The marks the summary counts, in the order it names them. */
const COUNTED: [Mark, string][] = [
  ["only", "only here"],
  ["newer", "newer"],
  ["older", "older"],
  ["differs", "differ"],
  ["same", "same"],
];

/**
 * Sums up how this pane stands against the other while the two are compared, and picks out what
 * the other pane lacks, to copy it over.
 */
export function CompareBar(props: { view: FolderView; marks: Marks | undefined; onCopyOver: () => void; onStop: () => void }) {
  const counts = createMemo(() => {
    const counts = new Map<Mark, number>();
    for (const mark of props.marks?.marks ?? []) counts.set(MARKS[mark], (counts.get(MARKS[mark]) ?? 0) + 1);
    return counts;
  });
  const count = (mark: Mark) => counts().get(mark) ?? 0;
  const matching = () => count("only") + count("newer") + count("older") + count("differs") === 0;

  /** Selects the rows with any of `wanted`, if those marks are for the rows on screen. */
  function select(wanted: Mark[]) {
    const list = props.view.list();
    const marks = props.marks;
    if (!list || !marks || list.selection().request !== marks.snapshot) return false;
    const rows: number[] = [];
    marks.marks.forEach((mark, row) => wanted.includes(MARKS[mark]) && rows.push(row));
    list.select(rows);
    list.focus();
    return rows.length > 0;
  }

  return (
    <div class="zip-bar compare-bar" role="toolbar" aria-label="Comparing with the other pane">
      <span class="zip-bar-icon" aria-hidden="true">
        {ICON_COMPARE}
      </span>
      <span class="zip-bar-name" aria-live="polite">
        <Show when={props.marks} fallback="Comparing…">
          <Show when={!matching()} fallback={count("same") ? "Matches the other pane" : "Nothing to compare"}>
            <For each={COUNTED.filter(([mark]) => count(mark) > 0)}>
              {([mark, word]) => (
                <span class="compare-count" data-compare={mark}>
                  {count(mark)} {word}
                </span>
              )}
            </For>
          </Show>
        </Show>
      </span>
      <span class="zip-bar-gap" />
      <Show when={count("only")}>
        <button class="chip zip-bar-button" onClick={() => select(["only"])}>
          Select only here
        </button>
      </Show>
      <Show when={count("newer")}>
        <button class="chip zip-bar-button" onClick={() => select(["newer"])}>
          Select newer
        </button>
      </Show>
      <Show when={count("only") + count("newer")}>
        <button
          class="chip zip-bar-button zip-bar-extract"
          aria-label="Copy what is only here or newer here to the other pane"
          onClick={() => select(["only", "newer"]) && props.onCopyOver()}
        >
          <span class="zip-bar-glyph" aria-hidden="true">
            {ICON_COPY}
          </span>
          Copy over
        </button>
      </Show>
      <button class="chip zip-bar-button" aria-label="Stop comparing" onClick={() => props.onStop()}>
        <span class="zip-bar-glyph" aria-hidden="true">
          {ICON_STOP}
        </span>
      </button>
    </div>
  );
}
