import { onCleanup, onMount } from "solid-js";
import { fetchRows, type Row } from "../../api";
import "./filelist.css";

const PAGE_SIZE = 256;
// ponytail: fixed page cache, plenty for one list, revisit if many tabs stay open.
const MAX_PAGES = 32;
const OVERSCAN = 8;

interface PooledRow {
  element: HTMLDivElement;
  name: HTMLSpanElement;
  modified: HTMLSpanElement;
  size: HTMLSpanElement;
  index: number;
  filled: boolean;
}

const dates = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" });

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = -1;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function createCell(parent: HTMLElement, className: string) {
  const cell = document.createElement("span");
  cell.className = className;
  cell.setAttribute("role", "gridcell");
  parent.append(cell);
  return cell;
}

function createRow(): PooledRow {
  const element = document.createElement("div");
  element.className = "file-row";
  element.setAttribute("role", "row");
  return {
    element,
    name: createCell(element, "file-name"),
    modified: createCell(element, "file-meta"),
    size: createCell(element, "file-meta file-size"),
    index: -1,
    filled: false,
  };
}

export function FileList(props: { count: number; onFirstPaint: () => void }) {
  const pages = new Map<number, Row[]>();
  const loading = new Set<number>();
  let pool: PooledRow[] = [];
  let rowHeight = 0;
  let firstPaintDone = false;
  let grid!: HTMLDivElement;
  let spacer!: HTMLDivElement;

  function loadPage(page: number) {
    if (loading.has(page)) return;
    loading.add(page);
    fetchRows(page * PAGE_SIZE, PAGE_SIZE)
      .then((rows) => {
        pages.set(page, rows);
        if (pages.size > MAX_PAGES) pages.delete(pages.keys().next().value!);
        paint();
      })
      .finally(() => loading.delete(page));
  }

  function rowAt(index: number) {
    const page = Math.floor(index / PAGE_SIZE);
    const rows = pages.get(page);
    if (!rows) loadPage(page);
    return rows?.[index % PAGE_SIZE];
  }

  function fill(pooled: PooledRow, index: number, row: Row | undefined) {
    if (pooled.index !== index) {
      pooled.index = index;
      pooled.element.style.transform = `translateY(${index * rowHeight}px)`;
      pooled.element.setAttribute("aria-rowindex", String(index + 1));
    }
    pooled.filled = row !== undefined;
    pooled.element.toggleAttribute("data-empty", !row);
    pooled.element.toggleAttribute("data-folder", row?.isDir ?? false);
    pooled.name.textContent = row?.name ?? "";
    pooled.modified.textContent = row ? dates.format(row.modified) : "";
    pooled.size.textContent = row && !row.isDir ? formatSize(row.size) : "";
  }

  function paint() {
    const first = Math.max(0, Math.floor(grid.scrollTop / rowHeight) - OVERSCAN);
    const last = Math.min(props.count, first + pool.length);

    for (let index = first; index < last; index++) {
      const pooled = pool[index % pool.length];
      const row = rowAt(index);
      if (pooled.index !== index || pooled.filled !== (row !== undefined)) fill(pooled, index, row);
    }
    // Having the next rows ready keeps scrolling free of blank frames.
    if (last < props.count) rowAt(Math.min(last + PAGE_SIZE / 2, props.count - 1));

    if (!firstPaintDone && pool.every((pooled) => pooled.filled)) {
      firstPaintDone = true;
      props.onFirstPaint();
    }
  }

  function resize() {
    const needed = Math.ceil(grid.clientHeight / rowHeight) + OVERSCAN * 2;
    const size = Math.min(props.count, needed);
    if (size === pool.length) return paint();

    pool = Array.from({ length: size }, createRow);
    spacer.replaceChildren(...pool.map((pooled) => pooled.element));
    paint();
  }

  onMount(() => {
    rowHeight = parseFloat(getComputedStyle(grid).getPropertyValue("--row-height"));
    spacer.style.height = `${props.count * rowHeight}px`;
    resize();

    const observer = new ResizeObserver(resize);
    observer.observe(grid);
    onCleanup(() => observer.disconnect());
  });

  return (
    <div ref={grid} class="file-grid" role="grid" aria-rowcount={props.count} tabindex="0" onScroll={paint}>
      <div ref={spacer} class="file-spacer" role="presentation" />
    </div>
  );
}
