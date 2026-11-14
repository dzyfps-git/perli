import { createEffect, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { DbRows, DbTable } from "../../api";
import { DataGrid } from "./DataGrid";
import { createFind } from "./FindBar";
import { coloredLines } from "./highlight";
import { asDelimited, type Cell, type TableOrder } from "./table";

const ICON_FIND = "";
const ICON_FILTER = "";
const ICON_COPY = "";
const ICON_QUERY = "";
const ICON_SCHEMA = "";
const ICON_RUN = "";
const ICON_TABLE = "";
const ICON_VIEW = "";
const DONE_MS = 1400;

export interface DatabaseViewProps {
  tables: DbTable[];
  failure: string | null;
  count: (table: string) => Promise<number>;
  rows: (table: string, order: TableOrder | null, filters: string[]) => Promise<DbRows>;
  query: (sql: string) => Promise<DbRows>;
  keys: (handler: ((event: KeyboardEvent) => boolean) | undefined) => void;
}

/** `"name"`, as SQL names a table whatever it holds. */
const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;

/**
 * A SQLite database, read only: its tables and views down the side with their row counts, the
 * picked one as a table that the database itself sorts and filters, its schema, and a box for
 * a statement of the user's own.
 */
export function DatabaseView(live: DatabaseViewProps) {
  const props = { ...live };
  let scroller!: HTMLDivElement;
  let tableBody: HTMLElement | undefined;
  let queryBox: HTMLTextAreaElement | undefined;
  let shownRows: (() => Cell[][]) | undefined;
  const [picked, setPicked] = createSignal(props.tables[0]?.name);
  const [counts, setCounts] = createSignal<Record<string, number | null>>({});
  const [found, setFound] = createSignal<DbRows>();
  const [reading, setReading] = createSignal(false);
  const [problem, setProblem] = createSignal<string>();
  const [filtering, setFiltering] = createSignal(false);
  const [schema, setSchema] = createSignal(false);
  const [asking, setAsking] = createSignal(false);
  /** The statement shown in the box, and whether its rows are the ones on show. */
  const [statement, setStatement] = createSignal("");
  const [answered, setAnswered] = createSignal(false);
  const [copied, setCopied] = createSignal(false);
  let gone = false;
  let asked = 0;

  const table = () => props.tables.find((one) => one.name === picked());
  const [schemaHtml] = createResource(
    () => schema() && table()?.sql,
    async (sql) => (await coloredLines("sql", sql)).join("\n"),
  );

  /** Reads rows, keeping only the answer to the last thing asked. */
  async function read(work: () => Promise<DbRows>, fromQuery: boolean) {
    const ticket = ++asked;
    setReading(true);
    try {
      const rows = await work();
      if (gone || ticket !== asked) return;
      setFound(rows);
      setProblem(undefined);
      setAnswered(fromQuery);
    } catch (reason) {
      if (gone || ticket !== asked) return;
      setProblem(String(reason));
    } finally {
      if (ticket === asked) setReading(false);
    }
  }

  const readTable = (order: TableOrder | undefined, filters: string[]) => {
    const name = picked();
    if (name) void read(() => props.rows(name, order ?? null, filters), false);
  };

  createEffect(() => {
    const name = picked();
    if (!name) return;
    setFound(undefined);
    setAnswered(false);
    setFiltering(false);
    setStatement(`SELECT * FROM ${quoted(name)} LIMIT 100`);
    readTable(undefined, []);
  });

  onMount(() => {
    // Counts come one table at a time, so a slow big table doesn't hold up the others.
    void (async () => {
      for (const one of props.tables) {
        const counted = await props.count(one.name).catch(() => null);
        if (gone) return;
        setCounts({ ...counts(), [one.name]: counted });
      }
    })();
    if (!scroller.closest(".preview-docked")) scroller.focus({ preventScroll: true });
  });

  const run = () => {
    if (statement().trim()) void read(() => props.query(statement()), true);
  };

  function showQuery() {
    setAsking(true);
    requestAnimationFrame(() => queryBox?.focus());
  }

  async function copyShown() {
    const shown = shownRows?.() ?? [];
    await navigator.clipboard.writeText(asDelimited([found()?.columns ?? [], ...shown], "\t"));
    setCopied(true);
    setTimeout(() => setCopied(false), DONE_MS);
  }

  const find = createFind(() => tableBody, () => scroller);

  /** Steps through the tables and views with `[` and `]`. */
  function pickNext(by: number) {
    const at = props.tables.findIndex((one) => one.name === picked());
    const next = props.tables[(at + by + props.tables.length) % props.tables.length];
    if (next) setPicked(next.name);
  }

  props.keys((event) => {
    if (event.target instanceof HTMLTextAreaElement) {
      if (event.key === "Enter" && event.ctrlKey) run();
      else if (event.key === "Escape") scroller.focus({ preventScroll: true });
      else return false;
      return true;
    }
    if (find.keys(event)) return true;
    if (event.ctrlKey || event.altKey || event.target instanceof HTMLInputElement) return false;
    const key = event.key.toLowerCase();
    if (key === "q") showQuery();
    else if (key === "s") setSchema(!schema());
    else if (key === "f") setFiltering(!filtering());
    else if (event.key === "[" || event.key === "]") pickNext(event.key === "]" ? 1 : -1);
    else return false;
    return true;
  });

  onCleanup(() => {
    gone = true;
    props.keys(undefined);
    find.close();
  });

  const note = () => {
    const rows = found();
    if (!rows) return undefined;
    const total = answered() ? null : counts()[picked() ?? ""];
    if (rows.more) return total ? `The first 5,000 of ${total.toLocaleString()} rows.` : "The first 5,000 rows.";
    return answered() ? `${rows.rows.length.toLocaleString()} rows found.` : undefined;
  };

  return (
    <div class="db-view">
      <Show when={props.failure}>
        <p class="preview-note" role="alert">
          {props.failure}
        </p>
      </Show>
      <Show when={!props.failure && !props.tables.length}>
        <p class="preview-note">This database has no tables yet.</p>
      </Show>
      <Show when={props.tables.length}>
        <nav class="db-tables" aria-label="Tables">
          <For each={props.tables}>
            {(one) => (
              <button class="db-table" aria-current={one.name === picked() || undefined} onClick={() => setPicked(one.name)}>
                <span class="db-table-icon" aria-hidden="true">
                  {one.view ? ICON_VIEW : ICON_TABLE}
                </span>
                <span class="db-table-name">{one.name}</span>
                <span class="db-table-count">
                  {one.name in counts() ? (counts()[one.name]?.toLocaleString() ?? "?") : ""}
                </span>
              </button>
            )}
          </For>
        </nav>
        <div class="db-main">
          <div class="preview-tools text-tools" role="toolbar" aria-label="Database">
            {find.bar()}
            <button class="strip-icon" aria-label="Find" aria-keyshortcuts="Control+F" aria-pressed={find.open()} onClick={() => (find.open() ? find.close() : find.show())}>
              {ICON_FIND}
            </button>
            <button class="strip-icon" aria-label="Filter columns" aria-keyshortcuts="F" aria-pressed={filtering()} disabled={answered()} onClick={() => setFiltering(!filtering())}>
              {ICON_FILTER}
            </button>
            <button class="strip-icon" aria-label="How it is made" aria-keyshortcuts="S" aria-pressed={schema()} onClick={() => setSchema(!schema())}>
              {ICON_SCHEMA}
            </button>
            <button class="strip-icon" aria-label="Ask with SQL" aria-keyshortcuts="Q" aria-pressed={asking()} onClick={() => (asking() ? setAsking(false) : showQuery())}>
              {ICON_QUERY}
            </button>
            <button class="strip-icon" aria-label={copied() ? "Copied" : "Copy these rows"} data-done={copied() || undefined} onClick={() => void copyShown().catch(console.error)}>
              {ICON_COPY}
            </button>
            <span class="zoom-chip text-kind">Read-only</span>
          </div>
          <Show when={asking()}>
            <form
              class="db-query"
              onSubmit={(event) => {
                event.preventDefault();
                run();
              }}
            >
              <textarea
                ref={queryBox}
                aria-label="SQL statement"
                spellcheck={false}
                value={statement()}
                onInput={(event) => setStatement(event.currentTarget.value)}
              />
              <div class="db-query-actions">
                <span class="db-query-hint">Ctrl+Enter runs it. Perli only reads, so nothing changes.</span>
                <Show when={answered()}>
                  <button type="button" class="preview-chip" onClick={() => readTable(undefined, [])}>
                    Back to the table
                  </button>
                </Show>
                <button class="preview-chip db-run" type="submit" disabled={reading()}>
                  <span aria-hidden="true">{ICON_RUN}</span> Run
                </button>
              </div>
            </form>
          </Show>
          <Show when={schema() && schemaHtml()}>
            {/* highlight.js escapes the statement itself, so the HTML is safe. */}
            <pre class="db-schema hljs" innerHTML={schemaHtml()} />
          </Show>
          <div ref={scroller} class="text-scroll db-scroll" tabindex="-1" data-reading={reading() || undefined}>
            <Show when={problem()}>
              <p class="preview-note" role="alert">
                {problem()}
              </p>
            </Show>
            {/* A new table or a query starts the grid afresh; new rows of the same keep its sort and filters. */}
            <Show when={found() && `${picked()}\n${answered()}`} keyed>
              {(_shown) => (
                <DataGrid
                  head={found()!.columns}
                  types={found()!.types}
                  rows={found()!.rows}
                  note={note()}
                  filtering={filtering() && !answered()}
                  onArrange={answered() ? undefined : readTable}
                  body={(element) => (tableBody = element)}
                  shown={(get) => (shownRows = get)}
                />
              )}
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}
