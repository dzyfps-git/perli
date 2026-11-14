import { convertFileSrc } from "@tauri-apps/api/core";
import { asyncBufferFromUrl, cachedAsyncBuffer, parquetMetadataAsync, parquetReadObjects, parquetSchema } from "hyparquet";
import { decompress as decompressZstd } from "fzstd";
import { decompressBrotli } from "hyparquet-compressors/src/brotli.js";
import { gunzip } from "hyparquet-compressors/src/gzip.js";
import { decompressLz4, decompressLz4Raw } from "hyparquet-compressors/src/lz4.js";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { DataGrid } from "./DataGrid";
import { createFind } from "./FindBar";
import { asDelimited, cellText, parquetType, type Cell } from "./table";

/**
 * hyparquet-compressors' decoders, taken one by one: its index builds a WebAssembly SNAPPY
 * decoder as it loads, which the CSP refuses. hyparquet reads SNAPPY itself.
 */
const compressors = {
  GZIP: (input: Uint8Array, length: number) => gunzip(input, new Uint8Array(length)),
  BROTLI: decompressBrotli,
  ZSTD: (input: Uint8Array) => decompressZstd(input),
  LZ4: decompressLz4,
  LZ4_RAW: decompressLz4Raw,
};

const ICON_FIND = "";
const ICON_FILTER = "";
const ICON_COPY = "";
/** As many rows as a CSV file shows. */
const MOST_ROWS = 5000;
const DONE_MS = 1400;

export interface ParquetViewProps {
  /** The file's path, opened for the window to read parts of. */
  open: () => Promise<string>;
  size: number;
  keys: (handler: ((event: KeyboardEvent) => boolean) | undefined) => void;
}

interface Read {
  columns: string[];
  types: string[];
  rows: Cell[][];
  total: number;
  /** Row groups, compression and the program that wrote it, in a line. */
  facts: string;
}

/**
 * A Parquet file as a table. Only the file's footer and the first rows' parts are read, so a
 * file of many gigabytes opens as quickly as a small one.
 */
export function ParquetView(live: ParquetViewProps) {
  const props = { ...live };
  let scroller!: HTMLDivElement;
  let tableBody: HTMLElement | undefined;
  let shownRows: (() => Cell[][]) | undefined;
  const [read, setRead] = createSignal<Read>();
  const [problem, setProblem] = createSignal<string>();
  const [filtering, setFiltering] = createSignal(false);
  const [copied, setCopied] = createSignal(false);
  let gone = false;

  onMount(() => {
    void (async () => {
      const file = cachedAsyncBuffer(await asyncBufferFromUrl({ url: convertFileSrc(await props.open()), byteLength: props.size }));
      const metadata = await parquetMetadataAsync(file);
      const schema = parquetSchema(metadata);
      const total = Number(metadata.num_rows);
      const objects = await parquetReadObjects({ file, metadata, compressors, rowStart: 0, rowEnd: Math.min(total, MOST_ROWS) });
      if (gone) return;
      const columns = schema.children.map((child) => child.element.name);
      const codec = metadata.row_groups[0]?.columns[0]?.meta_data?.codec;
      const groups = metadata.row_groups.length;
      setRead({
        columns,
        types: schema.children.map((child) => parquetType(child.element, child.children.length > 0)),
        rows: objects.map((object) => columns.map((column) => cellText(object[column]))),
        total,
        facts: [
          `${groups.toLocaleString()} row group${groups === 1 ? "" : "s"}`,
          codec && codec !== "UNCOMPRESSED" ? codec.toLowerCase().replace("_", " ") : undefined,
          metadata.created_by ? `made by ${metadata.created_by.replace(/\s*\(build.*$/, "")}` : undefined,
        ]
          .filter(Boolean)
          .join(" · "),
      });
    })().catch((reason) => !gone && setProblem(`This Parquet file can't be read: ${reason instanceof Error ? reason.message : reason}`));
    if (!scroller.closest(".preview-docked")) scroller.focus({ preventScroll: true });
  });

  async function copyShown() {
    await navigator.clipboard.writeText(asDelimited([read()?.columns ?? [], ...(shownRows?.() ?? [])], "\t"));
    setCopied(true);
    setTimeout(() => setCopied(false), DONE_MS);
  }

  const find = createFind(() => tableBody, () => scroller);

  props.keys((event) => {
    if (find.keys(event)) return true;
    if (event.ctrlKey || event.altKey || event.target instanceof HTMLInputElement) return false;
    if (event.key.toLowerCase() !== "f") return false;
    setFiltering(!filtering());
    return true;
  });

  onCleanup(() => {
    gone = true;
    props.keys(undefined);
    find.close();
  });

  const note = () => {
    const shown = read();
    if (!shown) return undefined;
    const rows = shown.rows.length < shown.total ? `The first ${shown.rows.length.toLocaleString()} of ${shown.total.toLocaleString()} rows` : `${shown.total.toLocaleString()} rows`;
    return `${rows} · ${shown.facts}`;
  };

  return (
    <div class="text-view">
      <div class="preview-tools text-tools" role="toolbar" aria-label="Parquet">
        {find.bar()}
        <button class="strip-icon" aria-label="Find" aria-keyshortcuts="Control+F" aria-pressed={find.open()} onClick={() => (find.open() ? find.close() : find.show())}>
          {ICON_FIND}
        </button>
        <button class="strip-icon" aria-label="Filter columns" aria-keyshortcuts="F" aria-pressed={filtering()} onClick={() => setFiltering(!filtering())}>
          {ICON_FILTER}
        </button>
        <button class="strip-icon" aria-label={copied() ? "Copied" : "Copy these rows"} data-done={copied() || undefined} onClick={() => void copyShown().catch(console.error)}>
          {ICON_COPY}
        </button>
      </div>
      <div ref={scroller} class="text-scroll" tabindex="-1">
        <Show when={problem()}>
          <p class="preview-note" role="alert">
            {problem()}
          </p>
        </Show>
        <Show when={!read() && !problem()}>
          <p class="preview-note">Reading…</p>
        </Show>
        <Show when={read()}>
          {(shown) => (
            <DataGrid
              head={shown().columns}
              types={shown().types}
              rows={shown().rows}
              note={note()}
              filtering={filtering()}
              body={(element) => (tableBody = element)}
              shown={(get) => (shownRows = get)}
            />
          )}
        </Show>
      </div>
    </div>
  );
}
