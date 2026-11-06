import { createEffect, onCleanup, onMount } from "solid-js";
import { fetchRows, type Row } from "../../api";
import { createSelection } from "./selection";
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

export function FileList(props: {
  view: number;
  count: number;
  active: boolean;
  onOpen: (row: Row) => void;
  onFirstPaint: () => void;
}) {
  const pages = new Map<number, Row[]>();
  const loading = new Set<number>();
  const selection = createSelection();
  let pool: PooledRow[] = [];
  let rowHeight = 0;
  let firstPaintDone = false;
  let grid!: HTMLDivElement;
  let spacer!: HTMLDivElement;

  function loadPage(page: number) {
    if (loading.has(page)) return;
    loading.add(page);
    fetchRows(props.view, page * PAGE_SIZE, PAGE_SIZE)
      .then((rows) => {
        pages.set(page, rows);
        if (pages.size > MAX_PAGES) pages.delete(pages.keys().next().value!);
        paint();
      })
      .catch(console.error)
      .finally(() => loading.delete(page));
  }

  function rowAt(index: number) {
    const page = Math.floor(index / PAGE_SIZE);
    const rows = pages.get(page);
    if (!rows) loadPage(page);
    return rows?.[index % PAGE_SIZE];
  }

  function decorate(pooled: PooledRow) {
    const focused = pooled.index === selection.focused();
    pooled.element.setAttribute("aria-selected", String(selection.has(pooled.index)));
    pooled.element.toggleAttribute("data-focused", focused);
  }

  function fill(pooled: PooledRow, index: number, row: Row | undefined) {
    if (pooled.index !== index) {
      pooled.index = index;
      pooled.element.id = `file-row-${props.view}-${index}`;
      pooled.element.style.transform = `translateY(${index * rowHeight}px)`;
      pooled.element.setAttribute("aria-rowindex", String(index + 1));
      decorate(pooled);
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
    // Inactive tabs are hidden and keep their rows until they come back.
    if (grid.clientHeight === 0) return;
    const needed = Math.ceil(grid.clientHeight / rowHeight) + OVERSCAN * 2;
    const size = Math.min(props.count, needed);
    if (size === pool.length) return paint();

    pool = Array.from({ length: size }, createRow);
    spacer.replaceChildren(...pool.map((pooled) => pooled.element));
    paint();
  }

  function selectionChanged() {
    pool.forEach(decorate);
    const focused = selection.focused();
    if (focused < 0) return grid.removeAttribute("aria-activedescendant");

    grid.setAttribute("aria-activedescendant", `file-row-${props.view}-${focused}`);
    const top = focused * rowHeight;
    if (top < grid.scrollTop) grid.scrollTop = top;
    else if (top + rowHeight > grid.scrollTop + grid.clientHeight) {
      grid.scrollTop = top + rowHeight - grid.clientHeight;
    }
  }

  function indexFromEvent(event: MouseEvent) {
    const element = (event.target as HTMLElement).closest(".file-row");
    return element ? Number(element.getAttribute("aria-rowindex")) - 1 : -1;
  }

  function onClick(event: MouseEvent) {
    const index = indexFromEvent(event);
    if (index < 0) selection.clear();
    else if (event.shiftKey) selection.extendTo(index, event.ctrlKey);
    else if (event.ctrlKey) selection.toggle(index);
    else selection.select(index);
    selectionChanged();
  }

  function openIndex(index: number) {
    const row = index >= 0 ? rowAt(index) : undefined;
    if (row) props.onOpen(row);
  }

  function onKeyDown(event: KeyboardEvent) {
    const pageRows = Math.max(1, Math.floor(grid.clientHeight / rowHeight) - 1);
    const focused = selection.focused();
    const targets: Record<string, number> = {
      ArrowDown: focused + 1,
      ArrowUp: focused - 1,
      PageDown: focused + pageRows,
      PageUp: focused - pageRows,
      Home: 0,
      End: props.count - 1,
    };

    if (event.key in targets) {
      if (props.count === 0) return;
      const target = Math.min(props.count - 1, Math.max(0, targets[event.key]));
      if (event.shiftKey) selection.extendTo(target, false);
      else selection.select(target);
    } else if (event.key === "Enter" && focused >= 0) {
      openIndex(focused);
    } else if (event.ctrlKey && event.key.toLowerCase() === "a") {
      selection.selectAll(props.count);
    } else {
      return;
    }
    event.preventDefault();
    selectionChanged();
  }

  onMount(() => {
    rowHeight = parseFloat(getComputedStyle(grid).getPropertyValue("--row-height"));
    spacer.style.height = `${props.count * rowHeight}px`;
    resize();

    const observer = new ResizeObserver(resize);
    observer.observe(grid);
    onCleanup(() => observer.disconnect());
  });

  createEffect(() => {
    if (props.active) grid.focus({ preventScroll: true });
  });

  return (
    <div
      ref={grid}
      class="file-grid"
      role="grid"
      aria-multiselectable="true"
      aria-rowcount={props.count}
      tabindex="0"
      onScroll={paint}
      onClick={onClick}
      onDblClick={(event) => openIndex(indexFromEvent(event))}
      onKeyDown={onKeyDown}
    >
      <div ref={spacer} class="file-spacer" role="presentation" />
      {props.count === 0 && <p class="message">This folder is empty.</p>}
    </div>
  );
}
