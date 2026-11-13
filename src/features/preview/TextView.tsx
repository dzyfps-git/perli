import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { ToolCog } from "../../ui/Controls";
import { formatSize } from "../../ui/format";
import { createFind, lineIn, scrollToRange } from "./FindBar";
import { asTable, asTree, numbers, setAsTable, setAsTree, setNumbers, setWrap, VIEWER_SETTINGS, wrap } from "./viewerPrefs";
import { highlight } from "./highlight";
import { arrange, guessDelimiter, lineEnding, parseTable, type TableOrder } from "./table";

const ICON_FIND = "";
const ICON_WRAP = "";
const ICON_LINES = "";
const ICON_TABLE = "";
const ICON_GO = "";

const ICON_COPY = "\uE8C8";
const ICON_FOLLOW = "\uE74B";
const ICON_TREE = "\uE8FD";
const ICON_FILTER = "\uE71C";
/** How often a file that is followed is looked at for more. */
const FOLLOW_MS = 1000;
/** A JSON file bigger than this stays text: the tree would be too much to draw. */
const MOST_TREE = 2 * 1024 * 1024;
/** A part of the tree shows this many of its items, and counts the rest. */
const MOST_ITEMS = 500;
/** The second level starts open only while all of it stays under this many rows. */
const MOST_OPEN_ROWS = 2000;
const DONE_MS = 1400;

/** How close to the end the next piece starts to load. */
const MORE_TEXT_PX = 800;
/** Find and Go to line load the rest of a file up to this much, then stop. */
const MOST_LOADED = 64 * 1024 * 1024;
/** A table this long is plenty to look through, and stays quick to draw. */
const MOST_ROWS = 5000;


export interface TextPiece {
  text: string;
  next: number | null;
  /** Where the piece stops in the file, for reading on when the file grows. */
  end?: number;
  /** The file starts with a byte order mark. */
  bom?: boolean;
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
  /** Where the text loaded so far stops in the file. Follow reads on from here. */
  let end = props.first.end;
  /** Everything is loaded, so the whole file can be looked at as one thing. */
  const [whole, setWhole] = createSignal(props.first.next === null);
  const [following, setFollowing] = createSignal(false);
  /** What the last copy says it did. */
  const [copied, setCopied] = createSignal<string>();
  const [order, setOrder] = createSignal<TableOrder>();
  const [filters, setFilters] = createSignal<string[]>([]);
  const [filtering, setFiltering] = createSignal(false);
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
  const shownRows = createMemo(() => arrange(rows().slice(1, MOST_ROWS + 1), order(), filtering() ? filters() : []));
  const canTree = () => props.language === "json" && whole() && text().length <= MOST_TREE;
  const tree = () => !table() && canTree() && asTree();
  /** The file as JSON, or why it is not. */
  const json = createMemo(() => {
    if (!tree()) return undefined;
    try {
      return { value: JSON.parse(text()) as unknown };
    } catch (reason) {
      return { failure: String(reason instanceof Error ? reason.message : reason) };
    }
  });
  const kind = () => `UTF-8${props.first.bom ? " with BOM" : ""} · ${lineEnding(props.first.text)}`;

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
        end = piece.end;
        setWhole(next === null);
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

  async function copyAll() {
    while (await more());
    await navigator.clipboard.writeText(text());
    // Reading stops at a size limit or a failed read, so the copy may not be all of the file.
    setCopied(whole() ? "Copied" : `Copied the first ${formatSize(text().length)} only`);
    setTimeout(() => setCopied(undefined), DONE_MS);
  }

  /** What was added to the file since the last look, shown at once and scrolled to. */
  async function follow() {
    while (await more());
    if (gone || next !== null || end === undefined) return;
    const piece = await props.more(end).catch(() => null);
    if (gone || !piece || !piece.text) return;
    end = piece.end ?? end;
    setText(text() + piece.text);
    await add(piece.text);
    scroller.scrollTop = scroller.scrollHeight;
  }
  createEffect(() => {
    if (!following()) return;
    scroller.scrollTop = scroller.scrollHeight;
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      follow().finally(() => (busy = false));
    }, FOLLOW_MS);
    onCleanup(() => clearInterval(timer));
  });

  function sortBy(column: number) {
    const now = order();
    // Up, then down, then as the file has them.
    setOrder(now?.column !== column ? { column, down: false } : now.down ? undefined : { column, down: true });
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
    else if (key === "j" && canTree()) setAsTree(!asTree());
    else if (key === "l" && end !== undefined && !table() && !tree()) setFollowing(!following());
    else return false;
    return true;
  });

  onMount(() => {
    void add(props.first.text).then(fill);
    // Beside the list, the list keeps the keys.
    if (!scroller.closest(".preview-docked")) scroller.focus({ preventScroll: true });
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
        <Show when={table()}>
          <button class="strip-icon" aria-label="Filter columns" aria-pressed={filtering()} onClick={() => setFiltering(!filtering())}>
            {ICON_FILTER}
          </button>
        </Show>
        <Show when={canTree()}>
          <button class="strip-icon" aria-label="Show as a tree" aria-keyshortcuts="J" aria-pressed={asTree()} onClick={() => setAsTree(!asTree())}>
            {ICON_TREE}
          </button>
        </Show>
        <Show when={end !== undefined && !table() && !tree()}>
          <button
            class="strip-icon"
            aria-label="Follow the end as the file grows"
            aria-keyshortcuts="L"
            aria-pressed={following()}
            onClick={() => setFollowing(!following())}
          >
            {ICON_FOLLOW}
          </button>
        </Show>
        <button class="strip-icon" aria-label={copied() ?? "Copy all"} data-done={copied() === "Copied" || undefined} onClick={() => void copyAll().catch(console.error)}>
          {ICON_COPY}
        </button>
        <span class="zoom-chip text-kind">{kind()}</span>
        <Show when={!table() && !tree()}>
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
        <div class="text-sheet" hidden={table() || tree()}>
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
          <CsvTable
            head={rows()[0] ?? []}
            rows={shownRows()}
            cut={rows().length > MOST_ROWS + 1}
            order={order()}
            onSort={sortBy}
            filters={filtering() ? filters() : undefined}
            onFilter={(column, value) => setFilters(Object.assign([...filters()], { [column]: value }))}
            body={(element) => (tableBody = element)}
          />
        </Show>
        <Show when={json()}>
          {(parsed) => (
            <div class="json-tree">
              <Show when={"value" in parsed()} fallback={<p class="preview-note">This is not whole JSON: {(parsed() as { failure: string }).failure}</p>}>
                <JsonNode value={(parsed() as { value: unknown }).value} depth={0} />
              </Show>
            </div>
          )}
        </Show>
      </div>
    </div>
  );
}

/** One value of a JSON file. An object or a list folds, and draws what it holds only once open. */
function JsonNode(props: { name?: string; value: unknown; depth: number; roomy?: boolean }) {
  const holds = () => props.value !== null && typeof props.value === "object";
  const items = () => (Array.isArray(props.value) ? props.value.map((value, at) => [String(at), value] as const) : Object.entries(props.value as object));
  const size = (value: unknown) => (value !== null && typeof value === "object" ? Object.keys(value).length : 0);
  // The top starts open, and the level under it too while that stays small: 500 lists of 500
  // would otherwise draw a quarter of a million rows at once.
  const rowsOneDown = () => items().slice(0, MOST_ITEMS).reduce((sum, [, value]) => sum + Math.min(size(value), MOST_ITEMS), 0);
  const [open, setOpen] = createSignal(props.depth === 0 || (props.depth === 1 && !!props.roomy));
  const roomy = () => props.depth === 0 && rowsOneDown() <= MOST_OPEN_ROWS;
  const name = () => (props.name === undefined ? null : <span class="json-name">{props.name}</span>);
  return (
    <Show
      when={holds()}
      fallback={
        <div class="json-leaf">
          {name()}
          <span class="json-value" data-kind={props.value === null ? "null" : typeof props.value}>
            {typeof props.value === "string" ? JSON.stringify(props.value) : String(props.value)}
          </span>
        </div>
      }
    >
      <details class="json-fold" open={open()} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>
          {name()}
          <span class="json-count">
            {Array.isArray(props.value) ? `[${items().length}]` : `{${items().length}}`}
          </span>
        </summary>
        <Show when={open()}>
          <For each={items().slice(0, MOST_ITEMS)}>{([key, value]) => <JsonNode name={key} value={value} depth={props.depth + 1} roomy={roomy()} />}</For>
          <Show when={items().length > MOST_ITEMS}>
            <div class="json-leaf json-count">and {(items().length - MOST_ITEMS).toLocaleString()} more</div>
          </Show>
        </Show>
      </details>
    </Show>
  );
}

function CsvTable(props: {
  head: string[];
  rows: { row: string[]; number: number }[];
  /** The file has more rows than are shown. */
  cut: boolean;
  order: TableOrder | undefined;
  onSort: (column: number) => void;
  /** What each column is filtered by, when the filter row shows. */
  filters: string[] | undefined;
  onFilter: (column: number, value: string) => void;
  body: (element: HTMLElement) => void;
}) {
  const head = () => props.head;
  const way = (column: number) => (props.order?.column !== column ? "none" : props.order.down ? "descending" : "ascending");
  return (
    <div class="preview-archive preview-table">
      <Show when={props.cut}>
        <p class="preview-archive-sum">The first {MOST_ROWS.toLocaleString()} rows.</p>
      </Show>
      <table>
        <thead>
          <tr>
            <th class="table-number">#</th>
            <For each={head()}>
              {(name, column) => (
                <th aria-sort={way(column())}>
                  <button class="table-sort" onClick={() => props.onSort(column())}>
                    {name}
                  </button>
                </th>
              )}
            </For>
          </tr>
          <Show when={props.filters}>
            <tr class="table-filters">
              <th class="table-number">{props.rows.length.toLocaleString()}</th>
              <For each={head()}>
                {(name, column) => (
                  <th>
                    <input
                      aria-label={`Filter ${name}`}
                      placeholder="Filter"
                      value={props.filters![column()] ?? ""}
                      onInput={(event) => props.onFilter(column(), event.currentTarget.value)}
                    />
                  </th>
                )}
              </For>
            </tr>
          </Show>
        </thead>
        <tbody ref={props.body}>
          <For each={props.rows}>
            {(item) => (
              <tr>
                <td class="table-number">{item.number}</td>
                <For each={item.row}>{(field) => <td>{field}</td>}</For>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  );
}
