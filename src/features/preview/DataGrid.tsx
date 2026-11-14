import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { arrange, columnFacts, numberColumns, type Cell, type TableOrder } from "./table";

/** Typing in a filter waits this long before a source that filters itself is asked again. */
const FILTER_WAIT_MS = 250;

export interface GridProps {
  head: string[];
  /** Each column's type, as the file names it. */
  types?: string[];
  rows: Cell[][];
  /** What part of the table shows, when it isn't all of it. */
  note?: string;
  /** The filter row shows. */
  filtering: boolean;
  /**
   * For a source that sorts and filters the whole table itself, such as a database. Without it,
   * the grid arranges the rows it was given.
   */
  onArrange?: (order: TableOrder | undefined, filters: string[]) => void;
  body?: (element: HTMLElement) => void;
  /** The rows as they show now, sorted and filtered, for copying. */
  shown?: (rows: () => Cell[][]) => void;
}

/**
 * A table of CSV, TSV, a database or Parquet: a sticky head that sorts on a click, a filter per
 * column, numbers set right, and each column's facts on hover over its name.
 */
export function DataGrid(props: GridProps) {
  const [order, setOrder] = createSignal<TableOrder>();
  const [filters, setFilters] = createSignal<string[]>([]);
  const own = () => !props.onArrange;
  const shownRows = createMemo(() =>
    own() ? arrange(props.rows, order(), props.filtering ? filters() : []) : props.rows.map((row, at) => ({ row, number: at + 1 })),
  );
  const numbers = createMemo(() => numberColumns(props.rows, props.head.length));
  props.shown?.(() => shownRows().map((item) => item.row));

  createEffect(
    on(
      [order, filters, () => props.filtering],
      ([sorted, typed, filtering]) => {
        if (own()) return;
        const timer = setTimeout(() => props.onArrange!(sorted, filtering ? typed : []), FILTER_WAIT_MS);
        onCleanup(() => clearTimeout(timer));
      },
      { defer: true },
    ),
  );

  function sortBy(column: number) {
    const now = order();
    // Up, then down, then as the source has them.
    setOrder(now?.column !== column ? { column, down: false } : now.down ? undefined : { column, down: true });
  }

  const way = (column: number) => (order()?.column !== column ? "none" : order()!.down ? "descending" : "ascending");

  return (
    <div class="preview-archive preview-table">
      <Show when={props.note}>
        <p class="preview-archive-sum">{props.note}</p>
      </Show>
      <table>
        <thead>
          <tr>
            <th class="table-number">#</th>
            <For each={props.head}>
              {(name, column) => (
                <th aria-sort={way(column())} data-number={numbers()[column()] || undefined}>
                  <button
                    class="table-sort"
                    // The facts are worked out when the pointer comes, for the rows loaded then.
                    onPointerEnter={(event) => event.currentTarget.setAttribute("data-tip", `${name}: ${columnFacts(props.rows, column())}`)}
                    onClick={() => sortBy(column())}
                  >
                    <span class="table-name">{name}</span>
                    <Show when={props.types?.[column()]}>
                      <span class="table-type">{props.types![column()]}</span>
                    </Show>
                  </button>
                </th>
              )}
            </For>
          </tr>
          <Show when={props.filtering}>
            <tr class="table-filters">
              <th class="table-number">{shownRows().length.toLocaleString()}</th>
              <For each={props.head}>
                {(name, column) => (
                  <th>
                    <input
                      aria-label={`Filter ${name}`}
                      placeholder="Filter"
                      value={filters()[column()] ?? ""}
                      // One string per column, never a hole: a database is sent the whole list.
                      onInput={(event) => {
                        const typed = event.currentTarget.value;
                        setFilters(props.head.map((_, at) => (at === column() ? typed : (filters()[at] ?? ""))));
                      }}
                    />
                  </th>
                )}
              </For>
            </tr>
          </Show>
        </thead>
        <tbody ref={props.body}>
          <For each={shownRows()}>
            {(item) => (
              <tr>
                <td class="table-number">{item.number}</td>
                <For each={item.row}>
                  {(field, column) => (
                    <td data-number={numbers()[column()] || undefined} data-null={field === null || undefined}>
                      {field ?? "NULL"}
                    </td>
                  )}
                </For>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  );
}
