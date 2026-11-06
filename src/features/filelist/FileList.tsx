import { createEffect, createMemo, on, onCleanup, onMount, Show } from "solid-js";
import { fetchRows, findRow, type Row, type Sort, type SortKey } from "../../api";
import { ColumnHeader } from "./ColumnHeader";
import { gridTemplate, typeLabel } from "./columns";
import { clampTile, moveTarget, TILE_STEP, type Layout } from "./layout";
import { columns, setTileSize, tileSize } from "./prefs";
import { createSelection } from "./selection";
import { createTypeJump } from "./typeJump";
import "./filelist.css";

const PAGE_SIZE = 256;
// ponytail: fixed page cache, plenty for one list, revisit if many tabs stay open.
const MAX_PAGES = 32;
const OVERSCAN = 8;
const ROWS_IN_MS = 220;
const ROWS_IN_STAGGER_MS = 12;
const ROWS_IN_STAGGERED = 12;
// Moving through folders quickly should feel instant, so only a pause earns the animation.
const ROWS_IN_PAUSE_MS = 1000;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
let lastFolderOpen = 0;

interface PooledRow {
  element: HTMLDivElement;
  cells: { id: SortKey; element: HTMLSpanElement }[];
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

const CELL_TEXT: Record<SortKey, (row: Row) => string> = {
  name: (row) => row.name,
  modified: (row) => dates.format(row.modified),
  created: (row) => dates.format(row.created),
  type: (row) => typeLabel(row.name, row.isDir),
  size: (row) => (row.isDir ? "" : formatSize(row.size)),
};

const CELL_CLASS: Partial<Record<SortKey, string>> = {
  name: "file-name",
  size: "file-meta file-size",
};

function createCell(parent: HTMLElement, id: SortKey) {
  const element = document.createElement("span");
  element.className = CELL_CLASS[id] ?? "file-meta";
  element.setAttribute("role", "gridcell");
  parent.append(element);
  return { id, element };
}

function createRow(cells: SortKey[]): PooledRow {
  const element = document.createElement("div");
  element.className = "file-row";
  element.setAttribute("role", "row");
  return {
    element,
    cells: cells.map((id) => createCell(element, id)),
    index: -1,
    filled: false,
  };
}

export function FileList(props: {
  view: number;
  snapshot: number;
  count: number;
  /** Rows to select on arrival. */
  selected?: number[];
  active: boolean;
  layout: Layout;
  sort: Sort;
  onSort: (key: SortKey) => void;
  onOpen: (row: Row, toSide: boolean) => void;
  onMenu: (event: MouseEvent, row: Row) => void;
  onBackgroundMenu: (event: MouseEvent) => void;
  onHeaderMenu: (event: MouseEvent) => void;
  onFirstPaint: () => void;
  shareSelection: (read: () => number[]) => void;
}) {
  const pages = new Map<number, Row[]>();
  const loading = new Set<number>();
  const selection = createSelection();
  const typed = createTypeJump();
  let pool: PooledRow[] = [];
  let rowHeight = 0;
  let itemHeight = 0;
  let perRow = 1;
  let builtFor = "";
  let latestJump = 0;
  let firstPaintDone = false;
  let grid!: HTMLDivElement;
  let spacer!: HTMLDivElement;
  let marker!: HTMLDivElement;

  /** What the row elements depend on, so a column resize does not rebuild them. */
  const cells = createMemo(
    (): SortKey[] =>
      props.layout === "grid"
        ? ["name"]
        : columns().filter((column) => column.visible).map((column) => column.id),
    [],
    { equals: (a, b) => a.join() === b.join() },
  );

  function loadPage(page: number) {
    if (loading.has(page)) return;
    loading.add(page);
    fetchRows(props.view, props.snapshot, page * PAGE_SIZE, PAGE_SIZE)
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

  // Percent moves by whole tiles, so a width change needs no JS at all.
  const placeOf = (index: number) =>
    `translate(${(index % perRow) * 100}%, ${Math.floor(index / perRow) * itemHeight}px)`;

  function decorate(pooled: PooledRow) {
    const focused = pooled.index === selection.focused();
    pooled.element.setAttribute("aria-selected", String(selection.has(pooled.index)));
    pooled.element.toggleAttribute("data-focused", focused);
  }

  function fill(pooled: PooledRow, index: number, row: Row | undefined) {
    if (pooled.index !== index) {
      pooled.index = index;
      pooled.element.id = `file-row-${props.view}-${index}`;
      pooled.element.style.transform = placeOf(index);
      pooled.element.setAttribute("aria-rowindex", String(index + 1));
      decorate(pooled);
    }
    pooled.filled = row !== undefined;
    pooled.element.toggleAttribute("data-empty", !row);
    pooled.element.toggleAttribute("data-folder", row?.isDir ?? false);
    pooled.element.toggleAttribute("data-hidden", row?.isHidden ?? false);
    for (const cell of pooled.cells) cell.element.textContent = row ? CELL_TEXT[cell.id](row) : "";
  }

  function paint() {
    const first = Math.max(0, Math.floor(grid.scrollTop / itemHeight) - OVERSCAN) * perRow;
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
      playRowsIn();
    }
  }

  function playRowsIn() {
    const now = performance.now();
    const paused = now - lastFolderOpen > ROWS_IN_PAUSE_MS;
    lastFolderOpen = now;
    if (!paused || reducedMotion.matches) return;

    for (const { element, index } of pool) {
      element.animate(
        { translate: ["0 10px", "0 0"], opacity: [0, 1] },
        {
          duration: ROWS_IN_MS,
          delay: Math.min(index, ROWS_IN_STAGGERED) * ROWS_IN_STAGGER_MS,
          easing: "cubic-bezier(0.3, 1.25, 0.5, 1)",
          fill: "backwards",
        },
      );
    }
  }

  function resize() {
    // Inactive tabs are hidden and keep their rows until they come back.
    if (grid.clientHeight === 0) return;

    const tile = props.layout === "grid" ? tileSize() : 0;
    perRow = tile ? Math.max(1, Math.floor(grid.clientWidth / tile)) : 1;
    itemHeight = tile || rowHeight;
    grid.style.setProperty("--per-row", String(perRow));
    grid.style.setProperty("--item-height", `${itemHeight}px`);
    spacer.style.height = `${Math.ceil(props.count / perRow) * itemHeight}px`;

    const needed = (Math.ceil(grid.clientHeight / itemHeight) + OVERSCAN * 2) * perRow;
    const size = Math.min(props.count, needed);
    const shape = `${cells().join()} ${perRow} ${itemHeight}`;
    if (size === pool.length && shape === builtFor) return paint();

    builtFor = shape;
    pool = Array.from({ length: size }, () => createRow(cells()));
    spacer.replaceChildren(...pool.map((pooled) => pooled.element));
    paint();
    moveMarker(true);
  }

  function moveMarker(instant: boolean) {
    const focused = selection.focused();
    const lone = selection.size() === 1 && selection.has(focused);
    grid.toggleAttribute("data-slide", lone);
    marker.hidden = !lone;
    marker.style.transition = instant ? "none" : "";
    if (lone) marker.style.transform = placeOf(focused);
  }

  function selectionChanged(instant = false) {
    pool.forEach(decorate);
    moveMarker(instant);
    const focused = selection.focused();
    if (focused < 0) return grid.removeAttribute("aria-activedescendant");

    grid.setAttribute("aria-activedescendant", `file-row-${props.view}-${focused}`);
    const top = Math.floor(focused / perRow) * itemHeight;
    if (top < grid.scrollTop) grid.scrollTop = top;
    else if (top + itemHeight > grid.scrollTop + grid.clientHeight) {
      grid.scrollTop = top + itemHeight - grid.clientHeight;
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

  function openIndex(index: number, toSide: boolean) {
    const row = index >= 0 ? rowAt(index) : undefined;
    if (row) props.onOpen(row, toSide);
  }

  function onContextMenu(event: MouseEvent) {
    event.preventDefault();
    const index = indexFromEvent(event);
    if (index < 0) return props.onBackgroundMenu(event);
    const row = rowAt(index);
    if (!row) return;
    if (!selection.has(index)) {
      selection.select(index);
      selectionChanged();
    }
    props.onMenu(event, row);
  }

  function jumpTo(key: string) {
    const jump = typed(key);
    if (!jump) return;
    const ticket = ++latestJump;
    const start = Math.max(0, selection.focused() + jump.offset);
    findRow(props.view, props.snapshot, jump.prefix, start)
      .then((index) => {
        if (ticket !== latestJump || index === null) return;
        selection.select(index);
        selectionChanged();
      })
      .catch(console.error);
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.altKey) return;
    const focused = selection.focused();
    const pageRows = Math.max(1, Math.floor(grid.clientHeight / itemHeight) - 1);
    const shape = { count: props.count, perRow, pageRows };
    const target = props.count > 0 ? moveTarget(event.key, focused, shape) : undefined;

    if (target !== undefined) {
      if (event.shiftKey) selection.extendTo(target, false);
      else selection.select(target);
    } else if (event.key === "Enter" && focused >= 0) {
      openIndex(focused, event.ctrlKey);
    } else if (event.ctrlKey && event.key.toLowerCase() === "a") {
      selection.selectAll(props.count);
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      return jumpTo(event.key);
    } else {
      return;
    }
    event.preventDefault();
    // Held keys repeat faster than the slide, so the bar would trail behind.
    selectionChanged(event.repeat);
  }

  function onWheel(event: WheelEvent) {
    if (!event.ctrlKey || props.layout !== "grid") return;
    setTileSize(clampTile(tileSize() + Math.sign(-event.deltaY) * TILE_STEP));
  }

  onMount(() => {
    rowHeight = parseFloat(getComputedStyle(grid).getPropertyValue("--row-height"));
    itemHeight = rowHeight;
    resize();
    props.shareSelection(selection.rows);
    if (props.selected?.length) {
      selection.restore(props.selected);
      selectionChanged(true);
    }

    const observer = new ResizeObserver(resize);
    observer.observe(grid);
    onCleanup(() => observer.disconnect());
  });

  createEffect(
    on(
      [cells, () => props.layout, tileSize],
      () => {
        resize();
        selectionChanged(true);
      },
      { defer: true },
    ),
  );

  createEffect(() => {
    if (props.active) grid.focus({ preventScroll: true });
  });

  return (
    <div
      class="file-list"
      style={{
        "--file-columns": gridTemplate(columns()),
        "--tile-size": `${tileSize()}px`,
      }}
    >
      <Show when={props.layout === "list"}>
        <ColumnHeader sort={props.sort} onSort={props.onSort} onMenu={props.onHeaderMenu} />
      </Show>
      <div
        ref={grid}
        class="file-grid"
        data-layout={props.layout}
        role="grid"
        aria-multiselectable="true"
        aria-rowcount={props.count}
        tabindex="0"
        onScroll={paint}
        onClick={onClick}
        onDblClick={(event) => openIndex(indexFromEvent(event), event.ctrlKey)}
        onContextMenu={onContextMenu}
        onKeyDown={onKeyDown}
        onWheel={onWheel}
      >
        <div ref={marker} class="file-marker" role="presentation" hidden />
        <div ref={spacer} class="file-spacer" role="presentation" />
        {props.count === 0 && <p class="message">This folder is empty.</p>}
      </div>
    </div>
  );
}
