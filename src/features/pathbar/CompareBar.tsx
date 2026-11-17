import { createMemo, For, Show } from "solid-js";
import { MARKS, type Mark, type Marks } from "../../api";
import { compareByContent, compareHideSame, compareScroll, setCompareByContent, setCompareHideSame, setCompareScroll } from "../filelist/prefs";
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
 * the other pane lacks, to copy it over. A count shows only the rows it counts; the switches hide
 * what matches, read files by their bytes and scroll the panes together.
 */
export function CompareBar(props: {
  view: FolderView;
  marks: Marks | undefined;
  /** The one mark this pane's rows are cut down to, if any. */
  only: Mark | undefined;
  onOnly: (mark: Mark | undefined) => void;
  onCopyOver: () => void;
  onStop: () => void;
}) {
  // Counted over every row the pane could show, so rows left out still count.
  const counts = createMemo(() => {
    const counts = new Map<Mark, number>();
    const summary = props.marks?.summary;
    if (summary) summary.counts.forEach((count, at) => counts.set(MARKS[at], count));
    else for (const mark of props.marks?.marks ?? []) counts.set(MARKS[mark], (counts.get(MARKS[mark]) ?? 0) + 1);
    return counts;
  });
  const count = (mark: Mark) => counts().get(mark) ?? 0;
  const matching = () => count("only") + count("newer") + count("older") + count("differs") + count("pending") === 0;

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
                <button
                  class="compare-count"
                  data-compare={mark}
                  aria-pressed={props.only === mark}
                  data-tip={props.only === mark ? "Show every row again" : `Show only what is ${word}`}
                  onClick={() => props.onOnly(props.only === mark ? undefined : mark)}
                >
                  {count(mark)} {word}
                </button>
              )}
            </For>
            <Show when={count("pending")}>
              <span class="compare-pending">
                <span class="compare-ring" aria-hidden="true" />
                {count("pending") === 1 ? "1 to compare" : `${count("pending")} to compare`}
              </span>
            </Show>
          </Show>
        </Show>
      </span>
      <span class="zip-bar-gap" />
      <Show when={count("same") || compareHideSame()}>
        <button
          class="chip zip-bar-button"
          aria-pressed={compareHideSame()}
          data-tip={compareHideSame() ? "Show the rows that match on both sides" : "Leave out the rows that match on both sides"}
          onClick={() => setCompareHideSame(!compareHideSame())}
        >
          {compareHideSame() ? `Show ${count("same")} same` : "Hide same"}
        </button>
      </Show>
      <button
        class="chip zip-bar-button"
        aria-pressed={compareByContent()}
        data-tip="Read files alike in size, so only their bytes decide"
        onClick={() => setCompareByContent(!compareByContent())}
      >
        By content
      </button>
      <button
        class="chip zip-bar-button"
        aria-pressed={compareScroll()}
        data-tip="Line the panes up by name as either one scrolls"
        onClick={() => setCompareScroll(!compareScroll())}
      >
        Scroll together
      </button>
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
