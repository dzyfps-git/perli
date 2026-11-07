import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import { fetchRows, fetchThumb, findRow, type Row, type Selection, type Sort, type SortKey } from "../../api";
import { ColumnHeader, SortStrip } from "./ColumnHeader";
import { formatSize } from "../../ui/format";
import { tagColor, tagNames, tags } from "../tags/tags";
import type { ListHandle } from "../navigation/folderView";
import { join, relativeTo } from "../navigation/path";
import { allLooks, lookOf } from "../sidebar/saved";
import { HoverCard, type CardAsk } from "./HoverCard";
import { columnsWidth, gridTemplate, type Column } from "./columns";
import { clampTile, moveTarget, TILE_STEP, type Layout } from "./layout";
import { hoverCards, setTileSize, tileSize } from "./prefs";
import { createSelection } from "./selection";
import { cachedThumb, createThumbLoader } from "./thumbs";
import { createTypeJump } from "./typeJump";
import { typesLearned, typeText } from "./typeNames";
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
const MIN_EDITOR_WIDTH = 120;
/** How far a press moves before it is a drag. Windows uses about this much. */
const DRAG_DISTANCE = 6;
/** How long the pointer rests on a row before its card shows. */
const CARD_DELAY_MS = 700;
/** With a card already up, the next row's comes quicker. */
const CARD_SWITCH_MS = 150;
const ICON_FOLDER = "\uE8B7";
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
let lastFolderOpen = 0;

interface PooledRow {
  element: HTMLDivElement;
  cells: { id: SortKey; element: HTMLSpanElement }[];
  index: number;
  filled: boolean;
  /** Only rows in the grid have a picture. */
  thumb?: HTMLCanvasElement;
  /** What `thumb` is for. */
  thumbKey?: string;
}

const dates = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" });

/** A server's shares have no dates. */
const dateText = (time: number) => (time > 0 ? dates.format(time) : "");

const syncText = (row: Row | undefined) => {
  if (row?.isCloud) return "In the cloud";
  return row?.isPinned ? "Always on this device" : undefined;
};

const CELL_TEXT: Record<SortKey, (row: Row, folder: string) => string> = {
  name: (row) => row.name,
  modified: (row) => dateText(row.modified),
  created: (row) => dateText(row.created),
  type: (row) => typeText(row.name, row.isDir),
  size: (row) => (row.isDir && !row.size ? "" : formatSize(row.size)),
  // A deep path would be clipped just where it starts to differ.
  location: (row, folder) => relativeTo(folder, row.location),
};

const CELL_CLASS: Partial<Record<SortKey, string>> = {
  name: "file-name",
  size: "file-meta file-size",
  location: "file-meta file-clipped",
};

function tagDot(id: number) {
  const tag = tags().find((known) => known.id === id);
  if (!tag) return [];
  const dot = document.createElement("span");
  dot.className = "tag-dot";
  dot.style.background = tagColor(tag.color);
  return [dot];
}

/** The glyph a folder wears in the list, which only folders with a look of their own have. */
function lookMark(icon: string | undefined, color: number | undefined) {
  const mark = document.createElement("span");
  mark.className = "file-look";
  // Drawn by CSS, so the name's text stays only the name.
  mark.dataset.glyph = icon ?? ICON_FOLDER;
  mark.setAttribute("aria-hidden", "true");
  if (color !== undefined) mark.style.color = tagColor(color);
  return mark;
}

function createCell(parent: HTMLElement, id: SortKey) {
  const element = document.createElement("span");
  element.className = CELL_CLASS[id] ?? "file-meta";
  element.setAttribute("role", "gridcell");
  parent.append(element);
  return { id, element };
}

function createRow(cells: SortKey[], withThumb: boolean): PooledRow {
  const element = document.createElement("div");
  element.className = "file-row";
  element.setAttribute("role", "row");
  const thumb = withThumb ? document.createElement("canvas") : undefined;
  if (thumb) {
    thumb.className = "file-thumb";
    element.append(thumb);
  }
  return {
    element,
    cells: cells.map((id) => createCell(element, id)),
    index: -1,
    filled: false,
    thumb,
  };
}

export function FileList(props: {
  view: number;
  /** The folder shown, where rows with no location of their own are. */
  folder: string;
  snapshot: number;
  count: number;
  /** Rows to select on arrival. */
  selected?: number[];
  /** Scroll to the selected rows when a new snapshot arrives. */
  reveal?: boolean;
  /** Open the first selected row's name for editing when a new snapshot arrives. */
  rename?: boolean;
  /** Start from the top with nothing selected when a new snapshot arrives. */
  top?: boolean;
  /** Show pictures of files in the grid. */
  thumbs: boolean;
  columns: Column[];
  fixedColumns: boolean;
  /** Names waiting to move, which fade. */
  cut?: Set<string>;
  emptyText: string;
  active: boolean;
  layout: Layout;
  sort: Sort;
  onSort: (key: SortKey) => void;
  /** The pointer dragged the selected rows far enough to start a real file drag. */
  onDragOut: () => void;
  onOpen: (row: Row, toSide: boolean) => void;
  onMenu: (event: MouseEvent, row: Row) => void;
  onBackgroundMenu: (event: MouseEvent) => void;
  onHeaderMenu: (event: MouseEvent) => void;
  onGroup: () => void;
  /** Rejects with the reason a name can't be used, which keeps the editor open. */
  onRename: (selection: Selection, name: string) => Promise<void>;
  onEditEnd: () => void;
  onInputMenu: (event: MouseEvent) => void;
  /** The rows are a new order of the folder already shown. */
  rearranged?: boolean;
  onFirstPaint: () => void;
  onSwapped: (snapshot: number) => void;
  onEscape: () => void;
  connect: (list: ListHandle) => void;
}) {
  const pages = new Map<number, Row[]>();
  const loading = new Set<number>();
  const selection = createSelection();
  const typed = createTypeJump();
  const [editor, setEditor] = createSignal<{
    index: number;
    name: string;
    isDir: boolean;
    left: number;
    top: number;
    width: number;
  }>();
  const [editError, setEditError] = createSignal<string>();
  const [card, setCard] = createSignal<CardAsk>();
  let cardTimer: ReturnType<typeof setTimeout> | undefined;
  /** The row under the pointer, so resting on one row asks for its card only once. */
  let hovered = -1;
  let pointer = { x: 0, y: 0 };
  let editInput!: HTMLInputElement;
  let committing = false;
  /** The snapshot whose rows are on screen, which a reload changes once its rows are in. */
  let shown = props.snapshot;
  let pool: PooledRow[] = [];
  let rowHeight = 0;
  let itemHeight = 0;
  let perRow = 1;
  let builtFor = "";
  let latestJump = 0;
  let press: { x: number; y: number; index: number } | undefined;
  let firstPaintDone = false;
  let grid!: HTMLDivElement;
  let spacer!: HTMLDivElement;
  let marker!: HTMLDivElement;
  let header: HTMLDivElement | undefined;

  /** What the row elements depend on, so a column resize does not rebuild them. */
  const cells = createMemo(
    (): SortKey[] =>
      props.layout === "grid"
        ? ["name"]
        : props.columns.filter((column) => column.visible).map((column) => column.id),
    [],
    { equals: (a, b) => a.join() === b.join() },
  );

  const thumbKey = (row: Row) => `${row.location || props.folder}\\${row.name}|${row.modified}|${row.size}`;

  function rowShowing(index: number, key: string) {
    const pooled = pool[index % pool.length];
    return pooled?.index === index && pooled.thumbKey === key ? pooled : undefined;
  }

  const thumbs = createThumbLoader(
    (index) => fetchThumb(props.view, shown, index),
    (index, key) => rowShowing(index, key) !== undefined,
    (index, key) => {
      const pooled = rowShowing(index, key);
      if (pooled) showThumb(pooled, key);
    },
  );

  function showThumb(pooled: PooledRow, key: string | undefined) {
    const { thumb: canvas } = pooled;
    if (!canvas) return;
    pooled.thumbKey = key;
    const thumb = key ? cachedThumb(key) : null;
    pooled.element.toggleAttribute("data-thumb", !!thumb);
    if (thumb) {
      canvas.width = thumb.width;
      canvas.height = thumb.height;
      canvas.getContext("2d")!.putImageData(new ImageData(thumb.pixels, thumb.width, thumb.height), 0, 0);
    } else if (key && thumb === undefined) {
      thumbs.ask(pooled.index, key);
    }
  }

  function loadPage(page: number) {
    if (loading.has(page)) return;
    loading.add(page);
    const snapshot = props.snapshot;
    fetchRows(props.view, snapshot, page * PAGE_SIZE, PAGE_SIZE)
      .then((rows) => {
        if (snapshot !== props.snapshot) return;
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
    pooled.element.toggleAttribute("data-cut", !!row && !!props.cut?.has(row.name));
    pooled.element.toggleAttribute("data-cloud", row?.isCloud ?? false);
    pooled.element.toggleAttribute("data-pinned", row?.isPinned ?? false);
    const about = [syncText(row), tagNames(row?.tags ?? [])].filter(Boolean).join(". ");
    if (about) pooled.element.setAttribute("aria-description", about);
    else pooled.element.removeAttribute("aria-description");
    const look = row?.isDir ? lookOf(join(row.location || props.folder, row.name)) : undefined;
    if (look?.icon) pooled.element.dataset.glyph = look.icon;
    else delete pooled.element.dataset.glyph;
    if (look?.color !== undefined) pooled.element.style.setProperty("--look-color", tagColor(look.color));
    else pooled.element.style.removeProperty("--look-color");
    pooled.element.toggleAttribute("data-look", look !== undefined);
    for (const cell of pooled.cells) {
      cell.element.textContent = row ? CELL_TEXT[cell.id](row, props.folder) : "";
      if (cell.id === "name" && row) cell.element.prepend(...row.tags.flatMap(tagDot));
      if (cell.id === "name" && look && props.layout === "list") cell.element.prepend(lookMark(look.icon, look.color));
    }
    // Windows' picture of a folder would hide the look it was given.
    showThumb(pooled, row && !look ? thumbKey(row) : undefined);
  }

  function hideCard(forget = false) {
    clearTimeout(cardTimer);
    if (forget) hovered = -1;
    setCard(undefined);
  }

  /** A card waits for the pointer to rest on a row, and never shows while a button is held. */
  function onHover(event: PointerEvent) {
    pointer = { x: event.clientX, y: event.clientY };
    if (!hoverCards() || event.buttons !== 0 || editor()) return;
    const index = indexFromEvent(event);
    if (index === hovered) return;
    hovered = index;
    const switching = card() !== undefined;
    hideCard();
    if (index < 0) return;
    cardTimer = setTimeout(
      () => {
        const row = rowAt(index);
        if (row && hovered === index) setCard({ row, index, snapshot: shown, thumbKey: thumbKey(row), ...pointer });
      },
      switching ? CARD_SWITCH_MS : CARD_DELAY_MS,
    );
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
    // A new order is the user's own request, so it plays however soon it follows the last one.
    const earned = props.rearranged || now - lastFolderOpen > ROWS_IN_PAUSE_MS;
    lastFolderOpen = now;
    if (!earned || reducedMotion.matches) return;

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
    const withThumb = props.thumbs && props.layout === "grid";
    pool = Array.from({ length: size }, () => createRow(cells(), withThumb));
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

  function selectionChanged(instant = false, reveal = true) {
    pool.forEach(decorate);
    moveMarker(instant);
    const focused = selection.focused();
    if (focused < 0) return grid.removeAttribute("aria-activedescendant");

    grid.setAttribute("aria-activedescendant", `file-row-${props.view}-${focused}`);
    if (!reveal) return;
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

  function onPointerDown(event: PointerEvent) {
    hideCard();
    const index = indexFromEvent(event);
    const onRow = event.button === 0 && index >= 0 && !(event.target as HTMLElement).closest("input");
    press = onRow ? { x: event.clientX, y: event.clientY, index } : undefined;
  }

  function onPointerMove(event: PointerEvent) {
    if (!press) return;
    if ((event.buttons & 1) === 0) press = undefined;
    else if (Math.hypot(event.clientX - press.x, event.clientY - press.y) >= DRAG_DISTANCE) {
      const { index } = press;
      press = undefined;
      if (!selection.has(index)) {
        selection.select(index);
        selectionChanged();
      }
      props.onDragOut();
    }
  }

  function openIndex(index: number, toSide: boolean) {
    const row = index >= 0 ? rowAt(index) : undefined;
    if (row) props.onOpen(row, toSide);
  }

  function onContextMenu(event: MouseEvent) {
    event.preventDefault();
    hideCard();
    // The Menu key and Shift+F10 report the list itself, not a row, and no right button.
    const fromKeyboard = event.button !== 2;
    const index = fromKeyboard ? selection.focused() : indexFromEvent(event);
    if (index < 0) return props.onBackgroundMenu(event);
    const row = rowAt(index);
    if (!row) return;
    if (!selection.has(index)) {
      selection.select(index);
      selectionChanged();
    }
    if (!fromKeyboard) return props.onMenu(event, row);

    const element = grid.querySelector(".file-row[data-focused]") ?? grid;
    const { left, bottom } = element.getBoundingClientRect();
    props.onMenu(new MouseEvent("contextmenu", { clientX: left + rowHeight, clientY: bottom }), row);
  }

  function onScroll() {
    hideCard(true);
    paint();
    if (header) header.scrollLeft = grid.scrollLeft;
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

  /** New rows take over in one step, so nothing blinks and the scroll position stays. */
  async function swapRows(snapshot: number) {
    const selected = props.selected ?? [];
    const first = props.top ? 0 : Math.max(0, Math.floor(grid.scrollTop / itemHeight) - OVERSCAN) * perRow;
    const onScreen = (Math.ceil(grid.clientHeight / itemHeight) + OVERSCAN * 2) * perRow;
    const wanted = new Set<number>();
    for (let index = first; index < first + onScreen + PAGE_SIZE; index += PAGE_SIZE) {
      wanted.add(Math.floor(index / PAGE_SIZE));
    }
    if (props.reveal && selected.length > 0) wanted.add(Math.floor(selected[0] / PAGE_SIZE));
    const fresh = await Promise.all(
      [...wanted].map(async (page) => {
        const rows = await fetchRows(props.view, snapshot, page * PAGE_SIZE, PAGE_SIZE);
        return [page, rows] as const;
      }),
    );
    if (snapshot !== props.snapshot) return;

    pages.clear();
    for (const [page, rows] of fresh) pages.set(page, rows);
    shown = snapshot;
    hideCard(true);
    if (props.top) {
      grid.scrollTop = 0;
      selection.clear();
    }

    // With its rows gone, the next one takes over, so Delete can be pressed again and again.
    const focused = selection.focused();
    if (selected.length === 0 && focused >= 0 && props.count > 0) {
      selection.select(Math.min(focused, props.count - 1));
    } else {
      selection.restore(selected);
    }
    builtFor = "";
    resize();
    selectionChanged(true, props.reveal);
    if (props.rename) startRename(selection.focused());
  }

  function startRename(index: number) {
    const row = index >= 0 ? rowAt(index) : undefined;
    const sample = pool[0];
    if (!row || !sample || editor()) return;
    const cell = sample.cells.find(({ id }) => id === "name")!.element;
    const { element } = sample;
    setEditor({
      index,
      name: row.name,
      isDir: row.isDir,
      left: (index % perRow) * element.offsetWidth + element.clientLeft + cell.offsetLeft,
      top: Math.floor(index / perRow) * itemHeight + element.clientTop + cell.offsetTop + cell.offsetHeight / 2,
      width: Math.max(cell.offsetWidth, MIN_EDITOR_WIDTH),
    });
  }

  function focusEditor(input: HTMLInputElement) {
    editInput = input;
    queueMicrotask(() => {
      const { name, isDir } = editor()!;
      const dot = name.lastIndexOf(".");
      input.focus();
      input.setSelectionRange(0, !isDir && dot > 0 ? dot : name.length);
    });
  }

  function endRename() {
    setEditor(undefined);
    setEditError(undefined);
    if (props.active) grid.focus({ preventScroll: true });
    props.onEditEnd();
  }

  async function commitRename() {
    const current = editor();
    if (!current || committing) return;
    const name = editInput.value;
    if (name === current.name) return endRename();
    committing = true;
    try {
      await props.onRename({ view: props.view, request: shown, rows: [current.index] }, name);
      endRename();
    } catch (failure) {
      setEditError(String(failure));
      editInput.focus();
    } finally {
      committing = false;
    }
  }

  function onEditorKey(event: KeyboardEvent) {
    if (event.key === "Enter") commitRename();
    else if (event.key === "Escape") endRename();
    else return;
    event.preventDefault();
    event.stopPropagation();
  }

  // Switching to another app or opening the paste menu must not end the edit.
  function onEditorBlur(event: FocusEvent) {
    const movedToMenu = (event.relatedTarget as HTMLElement | null)?.closest(".menu");
    if (document.hasFocus() && !movedToMenu) commitRename();
  }

  function onEditorMenu(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    props.onInputMenu(event);
  }

  function onKeyDown(event: KeyboardEvent) {
    hideCard();
    // The name editor sits inside the list, and its keys are its own.
    if (event.altKey || event.target !== grid) return;
    const focused = selection.focused();
    const pageRows = Math.max(1, Math.floor(grid.clientHeight / itemHeight) - 1);
    const shape = { count: props.count, perRow, pageRows };
    const target = props.count > 0 ? moveTarget(event.key, focused, shape) : undefined;

    if (target !== undefined) {
      if (event.shiftKey) selection.extendTo(target, false);
      else selection.select(target);
    } else if (event.key === "Enter" && focused >= 0) {
      openIndex(focused, event.ctrlKey);
    } else if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === "a") {
      selection.selectAll(props.count);
    } else if (event.key === "Escape") {
      selection.clear();
      props.onEscape();
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
    props.connect({
      selection: () => ({ view: props.view, request: shown, rows: selection.rows() }),
      rename: () => startRename(selection.focused()),
      isEditing: () => editor() !== undefined,
      focus: () => grid.focus({ preventScroll: true }),
      select(rows) {
        selection.restore(rows);
        selectionChanged(true);
      },
    });
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

  createEffect(
    on(
      [typesLearned, () => props.cut, tags, allLooks],
      () => {
        for (const pooled of pool) pooled.filled = false;
        paint();
      },
      { defer: true },
    ),
  );

  createEffect(
    on(
      () => props.snapshot,
      (snapshot) => {
        swapRows(snapshot)
          .catch(console.error)
          .finally(() => props.onSwapped(snapshot));
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
        "--file-columns": gridTemplate(props.columns),
        "--tile-size": `${tileSize()}px`,
        // Columns wider than the pane scroll sideways instead of being cut off.
        "--columns-min":
          props.layout === "list"
            ? `calc(${columnsWidth(props.columns)}px + ${cells().length - 1} * var(--space-3) + 2 * var(--space-4))`
            : undefined,
      }}
    >
      <Show
        when={props.layout === "list"}
        fallback={
          <SortStrip
            columns={props.columns}
            fixed={props.fixedColumns}
            sort={props.sort}
            onSort={props.onSort}
            onGroup={props.onGroup}
          />
        }
      >
        <ColumnHeader
          ref={(element) => (header = element)}
          columns={props.columns}
          fixed={props.fixedColumns}
          sort={props.sort}
          onSort={props.onSort}
          onMenu={props.onHeaderMenu}
          onGroup={props.onGroup}
        />
      </Show>
      <div
        ref={grid}
        class="file-grid"
        data-layout={props.layout}
        role="grid"
        aria-multiselectable="true"
        aria-rowcount={props.count}
        tabindex="0"
        onScroll={onScroll}
        onClick={onClick}
        onDblClick={(event) => openIndex(indexFromEvent(event), event.ctrlKey)}
        onContextMenu={onContextMenu}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={(event) => {
          onPointerMove(event);
          onHover(event);
        }}
        onPointerLeave={() => hideCard(true)}
        onWheel={onWheel}
      >
        <div ref={marker} class="file-marker" role="presentation" hidden />
        <div ref={spacer} class="file-spacer" role="presentation" />
        {props.count === 0 && <p class="message">{props.emptyText}</p>}
        <Show when={editor()} keyed>
          {(open) => (
            <div
              class="file-editor"
              style={{ left: `${open.left}px`, top: `${open.top}px`, width: `${open.width}px` }}
              onClick={(event) => event.stopPropagation()}
              onDblClick={(event) => event.stopPropagation()}
              onContextMenu={onEditorMenu}
            >
              <input
                ref={focusEditor}
                class="file-editor-input"
                aria-label="Name"
                spellcheck={false}
                value={open.name}
                onKeyDown={onEditorKey}
                onBlur={onEditorBlur}
              />
              <Show when={editError()}>
                <p class="file-editor-error" role="alert">
                  {editError()}
                </p>
              </Show>
            </div>
          )}
        </Show>
      </div>
      <Show when={card()} keyed>
        {(ask) => <HoverCard ask={ask} view={props.view} folder={props.folder} sync={syncText(ask.row)} />}
      </Show>
    </div>
  );
}
