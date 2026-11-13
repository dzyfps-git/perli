import { createSignal, onMount } from "solid-js";
import { rowsMatching } from "../../api";
import type { FolderView } from "../navigation/folderView";

const ICON_CLOSE = "";

/**
 * A bar under the path bar that selects the rows whose names fit a pattern, such as
 * `*.jpg;*.png`, as it is typed, so the list behind lights up. Enter keeps the selection and
 * Escape puts the old one back. Invert takes the rows that don't fit, or with no pattern, the
 * rows that weren't selected.
 */
export function SelectPattern(props: { view: FolderView; onClose: () => void }) {
  const [count, setCount] = createSignal(0);
  const [failure, setFailure] = createSignal<string>();
  const [invert, setInvert] = createSignal(false);
  const before = props.view.list()?.selection();
  let input!: HTMLInputElement;
  let latest = 0;

  /** The folder may have reloaded since the bar opened, and then the old rows mean nothing. */
  const request = () => props.view.folder()?.request;
  const beforeRows = () => (before && before.request === request() ? before.rows : []);

  function others(rows: number[]) {
    const kept = new Set(rows);
    const all = props.view.folder()?.count ?? 0;
    return Array.from({ length: all }, (_, row) => row).filter((row) => !kept.has(row));
  }

  /** The newest match in flight, which Done waits for. */
  let lighting: Promise<void> = Promise.resolve();
  const light = () => (lighting = match());

  // An older answer must not cover a newer one, so each one knows its turn.
  async function match() {
    const turn = ++latest;
    const text = input.value;
    const shown = request();
    try {
      const fit = text.trim() && shown !== undefined ? await rowsMatching(props.view.id, shown, text) : beforeRows();
      if (turn !== latest) return;
      const rows = invert() ? others(fit) : fit;
      props.view.list()?.select(rows);
      setCount(rows.length);
      setFailure(undefined);
    } catch (reason) {
      if (turn === latest) setFailure(String(reason));
    }
  }

  let closing = false;
  async function close(keep: boolean) {
    if (closing) return;
    closing = true;
    // Done keeps what the last words typed select, even if their answer is still on its way.
    if (keep) await lighting;
    latest++;
    if (!keep) props.view.list()?.select(beforeRows());
    props.onClose();
    props.view.list()?.focus();
  }

  onMount(() => {
    setCount(beforeRows().length);
    input.focus();
  });

  return (
    <div
      class="filter-chips pattern-bar"
      role="search"
      aria-label="Select by pattern"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          close(false);
        } else if (event.key === "Enter" && event.target === input) {
          event.preventDefault();
          close(true);
        }
      }}
    >
      <span class="pattern-label">Select</span>
      <input
        ref={input}
        class="pattern-input"
        aria-label="Names to select, such as *.jpg;*.png"
        placeholder="*.jpg;*.png"
        spellcheck={false}
        onInput={light}
      />
      <button
        class="chip"
        aria-label="Select the rows that don't fit instead"
        aria-pressed={invert()}
        onClick={() => {
          setInvert(!invert());
          light();
        }}
      >
        Invert
      </button>
      <span class="chip-count" aria-live="polite">
        {failure() ?? `${count().toLocaleString()} selected`}
      </span>
      <span class="pattern-end" />
      <button class="chip" aria-label="Keep this selection" onClick={() => close(true)}>
        Done
      </button>
      <button class="chip chip-icon" aria-label="Put the old selection back" onClick={() => close(false)}>
        <span aria-hidden="true">{ICON_CLOSE}</span>
      </button>
    </div>
  );
}
