import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { ToolCog } from "../../ui/Controls";
import { createFind, lineIn, scrollToRange } from "./FindBar";
import { asTable, numbers, setAsTable, setNumbers, setWrap, VIEWER_SETTINGS, wrap } from "./viewerPrefs";
import { highlight } from "./highlight";
import { guessDelimiter, parseTable } from "./table";

const ICON_FIND = "";
const ICON_WRAP = "";
const ICON_LINES = "";
const ICON_TABLE = "";
const ICON_GO = "";

/** How close to the end the next piece starts to load. */
const MORE_TEXT_PX = 800;
/** Find and Go to line load the rest of a file up to this much, then stop. */
const MOST_LOADED = 64 * 1024 * 1024;
/** A table this long is plenty to look through, and stays quick to draw. */
const MOST_ROWS = 5000;


export interface TextPiece {
  text: string;
  next: number | null;
}

export interface TextViewProps {
  first: TextPiece;
  more: (offset: number) => Promise<TextPiece | null>;
  /** The highlight.js language, if the name says what it is. */
  language?: string;
  /** For CSV and TSV: the delimiter, or null to guess it. */
  table?: string | null;
  keys: (handler: ((event: KeyboardEvent) => boolean) | undefined) => void;
  onFailure: (reason: string) => void;
}

/**
 * Text and code with find, wrap, line numbers and Go to line, loading a long file a piece at a
 * time as it scrolls. CSV and TSV files can show as a table instead.
 */
export function TextView(live: TextViewProps) {
  const props = { ...live };
  let scroller!: HTMLDivElement;
  let code!: HTMLElement;
  let tableBody: HTMLElement | undefined;
  let lineBox: HTMLInputElement | undefined;
  let next = props.first.next;
  let loading: Promise<boolean> | undefined;
  let loaded = props.first.text.length;
  let gone = false;
  /** Everything loaded so far, for the table and the line count. */
  const [text, setText] = createSignal(props.first.text);
  const [going, setGoing] = createSignal(false);
  const [missing, setMissing] = createSignal(false);
  const table = () => props.table !== undefined && asTable();
  const delimiter = createMemo(() => props.table ?? guessDelimiter(props.first.text));
  const rows = createMemo(() => (props.table === undefined ? [] : parseTable(text(), delimiter(), MOST_ROWS + 1, next === null)));
  const lines = createMemo(() => {
    let count = 1;
    for (let at = text().indexOf("\n"); at >= 0; at = text().indexOf("\n", at + 1)) count++;
    return count;
  });
  const gutter = createMemo(() => Array.from({ length: lines() }, (_, at) => at + 1).join("\n"));

  async function add(piece: string) {
    const html = props.language ? await highlight(piece, props.language).catch(() => undefined) : undefined;
    if (gone) return;
    if (html === undefined) code.append(piece);
    else code.insertAdjacentHTML("beforeend", html);
  }

  /** Loads the next piece, if there is one. True if it did. */
  function more(): Promise<boolean> {
    if (next === null || loaded >= MOST_LOADED) return Promise.resolve(false);
    loading ??= props
      .more(next)
      .then(async (piece) => {
        if (!piece || gone) return false;
        next = piece.next;
        loaded += piece.text.length;
        setText(text() + piece.text);
        await add(piece.text);
        return true;
      })
      .catch((reason) => {
        if (!gone) props.onFailure(String(reason));
        return false;
      })
      .finally(() => (loading = undefined));
    return loading;
  }

  const nearEnd = () => scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - MORE_TEXT_PX;

  /** Loads pieces while the end is in sight, so a first piece too short to scroll never stalls. */
  async function fill() {
    while (!gone && nearEnd() && (await more())) find.refresh();
  }

  const find = createFind(() => (table() ? tableBody : code), () => scroller, async () => {
    const added = await more();
    return added;
  });

  async function goToLine(line: number) {
    if (table()) {
      while (rows().length <= line && (await more()));
      const row = tableBody?.children[line - 1] as HTMLElement | undefined;
      setMissing(!row);
      if (!row) return;
      row.scrollIntoView({ block: "center" });
      row.animate({ backgroundColor: ["var(--surface-selected)", "transparent"] }, { duration: 1400, easing: "ease-out" });
      return;
    }
    let range = lineIn(code, line);
    while (!range && (await more())) range = lineIn(code, line);
    setMissing(!range);
    if (!range) return;
    scrollToRange(scroller, range);
    CSS.highlights.set("text-line", new Highlight(range));
    setTimeout(() => CSS.highlights.delete("text-line"), 1600);
  }

  function showGoTo() {
    find.close();
    setGoing(true);
    requestAnimationFrame(() => {
      lineBox?.focus();
      lineBox?.select();
    });
  }

  props.keys((event) => {
    const key = event.key.toLowerCase();
    if (event.altKey) return false;
    if (event.ctrlKey && key === "g") showGoTo();
    else if (key === "escape" && going()) setGoing(false);
    else if (find.keys(event)) setGoing(false);
    else if (event.ctrlKey || event.target instanceof HTMLInputElement) return false;
    else if (key === "w") setWrap(!wrap());
    else if (key === "n" && !table() && !wrap()) setNumbers(!numbers());
    else if (key === "t" && props.table !== undefined) setAsTable(!asTable());
    else return false;
    return true;
  });

  onMount(() => {
    void add(props.first.text).then(fill);
    scroller.focus({ preventScroll: true });
  });

  onCleanup(() => {
    gone = true;
    props.keys(undefined);
    find.close();
    CSS.highlights.delete("text-line");
  });

  return (
    <div class="text-view">
      <div class="preview-tools text-tools" role="toolbar" aria-label="Text">
        {find.bar()}
        <Show when={going()}>
          <form
            class="find-bar"
            onSubmit={(event) => {
              event.preventDefault();
              void goToLine(Number(lineBox?.value));
            }}
          >
            <input
              ref={lineBox}
              aria-label="Go to line"
              placeholder={table() ? `Row, 1 to ${Math.min(rows().length - 1, MOST_ROWS)}` : `Line, 1 to ${lines().toLocaleString()}`}
              inputmode="numeric"
              onInput={() => setMissing(false)}
            />
            <span class="find-count">{missing() ? "Past the end" : ""}</span>
            <button class="strip-icon" aria-label="Go" type="submit">
              {ICON_GO}
            </button>
          </form>
        </Show>
        <button class="strip-icon" aria-label="Find" aria-keyshortcuts="Control+F" aria-pressed={find.open()} onClick={() => (find.open() ? find.close() : find.show())}>
          {ICON_FIND}
        </button>
        <Show when={props.table !== undefined}>
          <button class="strip-icon" aria-label="Show as a table" aria-keyshortcuts="T" aria-pressed={asTable()} onClick={() => setAsTable(!asTable())}>
            {ICON_TABLE}
          </button>
        </Show>
        <Show when={!table()}>
          <button class="strip-icon" aria-label="Wrap lines" aria-keyshortcuts="W" aria-pressed={wrap()} onClick={() => setWrap(!wrap())}>
            {ICON_WRAP}
          </button>
          <button
            class="strip-icon"
            aria-label={wrap() ? "Line numbers, off while lines wrap" : "Line numbers"}
            aria-keyshortcuts="N"
            aria-pressed={numbers() && !wrap()}
            disabled={wrap()}
            onClick={() => setNumbers(!numbers())}
          >
            {ICON_LINES}
          </button>
        </Show>
        <ToolCog label="Text settings" items={VIEWER_SETTINGS.Text} />
      </div>
      <div ref={scroller} class="text-scroll" tabindex="-1" data-wrap={wrap() || undefined} onScroll={() => void fill()}>
        <div class="text-sheet" hidden={table()}>
          <Show when={numbers()}>
            <pre class="text-gutter" aria-hidden="true">
              {gutter()}
            </pre>
          </Show>
          <pre class="preview-text">
            <code ref={code} class="hljs" />
          </pre>
        </div>
        <Show when={table()}>
          <CsvTable rows={rows()} body={(element) => (tableBody = element)} />
        </Show>
      </div>
    </div>
  );
}

function CsvTable(props: { rows: string[][]; body: (element: HTMLElement) => void }) {
  const head = () => props.rows[0] ?? [];
  const body = () => props.rows.slice(1, MOST_ROWS + 1);
  return (
    <div class="preview-archive preview-table">
      <Show when={props.rows.length > MOST_ROWS + 1}>
        <p class="preview-archive-sum">The first {MOST_ROWS.toLocaleString()} rows.</p>
      </Show>
      <table>
        <thead>
          <tr>
            <th class="table-number">#</th>
            <For each={head()}>{(name) => <th>{name}</th>}</For>
          </tr>
        </thead>
        <tbody ref={props.body}>
          <For each={body()}>
            {(row, at) => (
              <tr>
                <td class="table-number">{at() + 1}</td>
                <For each={row}>{(field) => <td>{field}</td>}</For>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  );
}
