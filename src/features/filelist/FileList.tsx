import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import {
  fetchRows,
  fetchThumb,
  findRow,
  selectionSize,
  type Row,
  type Selection,
  type Sort,
  type SortKey,
} from "../../api";
import { ColumnHeader, SortStrip } from "./ColumnHeader";
import { formatSize } from "../../ui/format";
import { tagColor, tagNames, tags } from "../tags/tags";
import type { ListHandle, RowAt } from "../navigation/folderView";
import { join, parentOf, relativeTo, samePath } from "../navigation/path";
import { allLooks, lookOf } from "../sidebar/saved";
import { EmptyState, type Empty } from "./EmptyState";
import { HoverCard, type CardAsk } from "./HoverCard";
import { columnsWidth, gridTemplate, type Column } from "./columns";
import { clampTile, moveTarget, TILE_STEP, type Layout } from "./layout";
import { ageShare, hasPicture, iconSheet, kindOf } from "./fileKinds";
import { dateForm, hoverCards, ROW_HEIGHTS, rowDensity, selectionBar, setTileSize, statusBar, tileSize, windowsIcons } from "./prefs";
import { ago, isoText } from "../../ui/dates";
import { SelectionBar, type BarItem } from "../reach/SelectionBar";
import { createSelection } from "./selection";
import { cachedThumb, createThumbLoader } from "./thumbs";
import { matchSpans } from "./nameMatch";
import { playMoves, seen } from "./rowMotion";
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
const CARD_SWITCH_MS = 40;
/** What one notch of a mouse wheel reports. */
const WHEEL_NOTCH = 100;
/** Between a row's icon and its name, as `.file-icon` in filelist.css sets it. */
const ICON_GAP = 8;
/** The height of the name's own line in a roomy row, as filelist.css sets it. */
const ROOMY_LINE = 18;
/** How long the quiet status line stays after it has something new to say. */
const WHISPER_MS = 2400;
/** A burst of selection changes is added up once, this long after the last one. */
const WHISPER_WAIT_MS = 120;
// ponytail: past this many selected rows the status line names no size, since sending the rows
// alone would cost more than the answer is worth. Add up on the Rust side from ranges if asked for.
const MOST_SIZED_ROWS = 20_000;
/** How far rows start from their place when a folder zooms in or out, as a share of their
 *  distance from the row that was opened. */
const ZOOM_IN_SHARE = -0.08;
const ZOOM_OUT_SHARE = 0.06;
const ZOOM_MS = 280;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

/** Each view's last folder, and where on screen the row that left it was, for the zoom. */
const leftFrom = new Map<number, { folder: string; y?: number }>();
const openedAt = new Map<number, number>();

const counted = (count: number, one: string, many: string) => `${count.toLocaleString()} ${count === 1 ? one : many}`;

const kindStyles = document.createElement("style");
kindStyles.textContent = iconSheet();
document.head.append(kindStyles);
let lastFolderOpen = 0;

interface PooledRow {
  element: HTMLDivElement;
  cells: { id: SortKey; element: HTMLSpanElement }[];
  index: number;
  filled: boolean;
  /** Lives in the name cell in the list, and above the name in the grid. */
  icon: HTMLSpanElement;
  /** Inside `icon`, for rows that may show a picture in its place. */
  thumb?: HTMLCanvasElement;
  /** What `thumb` is for. */
  thumbKey?: string;
  /** The lit letters of a search in its name. */
  matches?: Range[];
  /** The arrow that opens a folder in place, made when the list first needs one. */
  twist?: HTMLSpanElement;
}

/** How far a row moves in for each folder it is inside of, and the room its arrow takes. */
const INDENT = 16;
const TWIST_ROOM = 18;

/** Every list's lit search letters, drawn by CSS without touching the rows' text. */
const nameMatches = new Highlight();
CSS.highlights.set("name-match", nameMatches);

const dates = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" });

/** A server's shares have no dates. */
const dateText = (time: number) => {
  if (time <= 0) return "";
  const form = dateForm();
  return form === "ago" ? ago(time, Date.now()) : form === "iso" ? isoText(time) : dates.format(time);
};
/** "2 min ago" is wrong a minute later, so the rows are told again this often. */
const AGO_REFRESH_MS = 30_000;
/** The corner of a tile that picks it, in pixels. */
const PICK_CORNER = 26;

const syncText = (row: Row | undefined, synced: boolean) => {
  if (row?.isCloud) return "In the cloud";
  if (row?.isPinned) return "Always on this device";
  return row && synced ? "On this device" : undefined;
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
  modified: "file-meta file-date",
  created: "file-meta file-date",
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

/** The second line of a roomy row. */
const subText = (row: Row) =>
  [typeText(row.name, row.isDir), row.isDir && !row.size ? "" : formatSize(row.size)].filter(Boolean).join(" \u00b7 ");

function createCell(parent: HTMLElement, id: SortKey) {
  const element = document.createElement("span");
  element.className = CELL_CLASS[id] ?? "file-meta";
  element.setAttribute("role", "gridcell");
  parent.append(element);
  return { id, element };
}

function createRow(cells: SortKey[], withThumb: boolean, inGrid: boolean): PooledRow {
  const element = document.createElement("div");
  element.className = "file-row";
  element.setAttribute("role", "row");
  // Drawn by CSS, so the name's text stays only the name.
  const icon = document.createElement("span");
  icon.className = "file-icon";
  icon.setAttribute("aria-hidden", "true");
  const thumb = withThumb ? document.createElement("canvas") : undefined;
  if (thumb) {
    thumb.className = "file-thumb";
    icon.append(thumb);
  }
  if (inGrid) element.append(icon);
  return {
    element,
    cells: cells.map((id) => createCell(element, id)),
    index: -1,
    filled: false,
    icon,
    thumb,
  };
}

/** What F2 selects in the name editor, in turn. */
type NamePart = "stem" | "whole" | "extension";
const NEXT_PART: Record<NamePart, NamePart> = { stem: "whole", whole: "extension", extension: "stem" };

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
  /** Folders opened in place, by full path. */
  expanded?: string[];
  /** Opens a folder in place or closes it. Left out where rows cannot nest: a search, the Recycle Bin. */
  onExpand?: (path: string) => void;
  /** The folder is kept by a sync app, so a row with no cloud mark is here in full. */
  synced?: boolean;
  /** What stands in for the rows when there are none. */
  empty: Empty;
  /** What a search typed, whose letters light up in each name. */
  match?: string;
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
  /** Space on a row, outside a type-to-find. */
  onPreview: (at: RowAt) => void;
  /** The one row selected, or nothing when none or many are. */
  onCursor: (at: RowAt | undefined) => void;
  /** A middle click on a row. */
  onOpenBehind: (row: Row) => void;
  /** What the bar over a selection offers. */
  barItems: () => BarItem[];
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
  /** How many rows are selected and their bytes, for the status line. */
  const [picked, setPicked] = createSignal({ count: 0, bytes: 0 });
  /** The status line has something new to say. */
  const [fresh, setFresh] = createSignal(true);
  let freshTimer: number | undefined;
  let sizeTimer: number | undefined;
  let sizeTicket = 0;
  let whisper: HTMLParagraphElement | undefined;
  let cardTimer: ReturnType<typeof setTimeout> | undefined;
  /** The row under the pointer, so resting on one row asks for its card only once. */
  let hovered = -1;
  let pointer = { x: 0, y: 0 };
  let editInput!: HTMLInputElement;
  let committing = false;
  let namePart: NamePart = "stem";
  /** The row Tab moves the name editor to once the list shows the new name. */
  let renameNext: { name: string; location: string } | undefined;
  /** The snapshot whose rows are on screen, which a reload changes once its rows are in. */
  let shown = props.snapshot;
  /** How many rows the last snapshot had, to tell when some are gone. */
  let lastCount = props.count;
  let pool: PooledRow[] = [];
  const rowHeight = () => ROW_HEIGHTS[rowDensity()];
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

  /** Whether folders open in place here. */
  const nests = () => props.layout === "list" && props.onExpand !== undefined;
  /** How many folders opened in place a row sits inside. */
  const depthOf = (row: Row) => (nests() && row.location ? relativeTo(props.folder, row.location).split("\\").length : 0);
  const isOpen = (row: Row) => {
    const path = join(row.location || props.folder, row.name);
    return row.isDir && !!props.expanded?.some((folder) => samePath(folder, path));
  };

  /** The arrow of a row, in front of its icon. A file has an empty one, so the icons line up. */
  function twistOf(pooled: PooledRow, row: Row | undefined) {
    const twist = (pooled.twist ??= Object.assign(document.createElement("span"), { className: "file-twist" }));
    twist.setAttribute("aria-hidden", "true");
    twist.toggleAttribute("data-none", !row?.isDir);
    twist.toggleAttribute("data-open", !!row && isOpen(row));
    return twist;
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
    pooled.element.toggleAttribute("data-cut", !!row && !row.location && !!props.cut?.has(row.name));
    // A drop on a folder row has to know where that folder is.
    if (row?.location) pooled.element.dataset.location = row.location;
    else delete pooled.element.dataset.location;
    pooled.element.style.setProperty("--depth", String(row ? depthOf(row) : 0));
    if (row?.isDir && nests()) pooled.element.setAttribute("aria-expanded", String(isOpen(row)));
    else pooled.element.removeAttribute("aria-expanded");
    pooled.element.toggleAttribute("data-cloud", row?.isCloud ?? false);
    pooled.element.toggleAttribute("data-pinned", row?.isPinned ?? false);
    const synced = !!props.synced && !!row && !row.isCloud && !row.isPinned;
    pooled.element.toggleAttribute("data-synced", synced);
    const about = [syncText(row, synced), tagNames(row?.tags ?? [])].filter(Boolean).join(". ");
    if (about) pooled.element.setAttribute("aria-description", about);
    else pooled.element.removeAttribute("aria-description");
    const look = row?.isDir ? lookOf(join(row.location || props.folder, row.name)) : undefined;
    const kind = row && kindOf(row.name, row.isDir);
    if (kind) pooled.icon.dataset.kind = kind;
    else delete pooled.icon.dataset.kind;
    if (look?.icon) pooled.icon.dataset.glyph = look.icon;
    else delete pooled.icon.dataset.glyph;
    if (look?.color !== undefined) pooled.element.style.setProperty("--look-color", tagColor(look.color));
    else pooled.element.style.removeProperty("--look-color");
    pooled.element.toggleAttribute("data-look", look !== undefined);
    const now = Date.now();
    const inList = props.layout === "list";
    for (const cell of pooled.cells) {
      cell.element.textContent = row ? CELL_TEXT[cell.id](row, props.folder) : "";
      if (cell.id === "name") {
        if (row) cell.element.prepend(...row.tags.flatMap(tagDot));
        if (inList) cell.element.prepend(pooled.icon);
        if (nests()) cell.element.prepend(twistOf(pooled, row));
        if (row && inList && rowDensity() === "roomy") cell.element.dataset.sub = subText(row);
        else delete cell.element.dataset.sub;
      } else if (row && (cell.id === "modified" || cell.id === "created")) {
        cell.element.style.setProperty("--age", String(ageShare(row[cell.id], now)));
      }
    }
    lightMatch(pooled, row);
    // Windows' picture of a folder would hide the look it was given. Other files show Perli's
    // own icon, unless a picture says more or Windows gave the folder an icon of its own.
    const pictured = row && !look && (windowsIcons() || row.isCustom || hasPicture(kind!));
    showThumb(pooled, pictured ? thumbKey(row) : undefined);
  }

  /** A pool being thrown away takes its lit letters with it, since the highlight is shared. */
  function forgetMatches() {
    for (const pooled of pool) for (const range of pooled.matches ?? []) nameMatches.delete(range);
  }

  function lightMatch(pooled: PooledRow, row: Row | undefined) {
    for (const range of pooled.matches ?? []) nameMatches.delete(range);
    pooled.matches = undefined;
    const text = pooled.cells.find((cell) => cell.id === "name")?.element.lastChild;
    if (!row || !props.match || !(text instanceof Text)) return;
    pooled.matches = matchSpans(row.name, props.match).map(([start, end]) => {
      const range = new Range();
      range.setStart(text, start);
      range.setEnd(text, end);
      nameMatches.add(range);
      return range;
    });
  }

  /** Shift pinned the card, so it stays until it is let go. */
  let cardPinned = false;

  function hideCard(forget = false) {
    if (cardPinned) return;
    clearTimeout(cardTimer);
    if (forget) hovered = -1;
    setCard(undefined);
  }

  function pinCard(on: boolean) {
    cardPinned = on;
    if (!on) hideCard(true);
  }

  /** A card waits for the pointer to rest on a row, and never shows while a button is held. */
  function onHover(event: PointerEvent) {
    pointer = { x: event.clientX, y: event.clientY };
    if (!hoverCards() || event.buttons !== 0 || editor() || cardPinned) return;
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

  /**
   * Which way this folder was reached from the last one: into one of its rows, or back up out of
   * it. Anything else, such as a jump from the sidebar, is neither.
   */
  function zoom() {
    const from = leftFrom.get(props.view);
    if (!from || props.rearranged) return undefined;
    if (samePath(parentOf(props.folder), from.folder)) return { share: ZOOM_IN_SHARE, scale: 0.96, y: from.y };
    if (samePath(parentOf(from.folder), props.folder)) return { share: ZOOM_OUT_SHARE, scale: 1.04, y: undefined };
    return undefined;
  }

  function playRowsIn() {
    const now = performance.now();
    // A new order is the user's own request, so it plays however soon it follows the last one.
    const earned = props.rearranged || now - lastFolderOpen > ROWS_IN_PAUSE_MS;
    lastFolderOpen = now;
    const zoomed = zoom();
    if (!earned || reducedMotion.matches) return;

    if (zoomed) {
      // Rows spread out from the row that was opened, or close in from further out. Each row
      // moves on its own, because the spacer they sit in can be far taller than the screen.
      const box = grid.getBoundingClientRect();
      const origin = zoomed.y ?? box.top + box.height / 2;
      for (const { element } of pool) {
        const { top } = element.getBoundingClientRect();
        if (top > box.bottom) continue;
        element.animate(
          { translate: [`0 ${(top - origin) * zoomed.share}px`, "0 0"], scale: [zoomed.scale, 1], opacity: [0, 1] },
          { duration: ZOOM_MS, easing: "cubic-bezier(0.2, 0.9, 0.3, 1)", fill: "backwards" },
        );
      }
      return;
    }

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
    itemHeight = tile || rowHeight();
    grid.style.setProperty("--per-row", String(perRow));
    grid.style.setProperty("--item-height", `${itemHeight}px`);
    spacer.style.height = `${Math.ceil(props.count / perRow) * itemHeight}px`;

    const needed = (Math.ceil(grid.clientHeight / itemHeight) + OVERSCAN * 2) * perRow;
    const size = Math.min(props.count, needed);
    const shape = `${cells().join()} ${props.layout} ${perRow} ${itemHeight}`;
    if (size === pool.length && shape === builtFor) return paint();

    builtFor = shape;
    forgetMatches();
    pool = Array.from({ length: size }, () => createRow(cells(), props.thumbs, props.layout === "grid"));
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

  /** Tells the status line what is selected. The bytes come a moment later, from the listing. */
  function noteSelection() {
    const count = selection.size();
    window.clearTimeout(sizeTimer);
    const ticket = ++sizeTicket;
    if (count === picked().count && count === 0) return;
    setPicked({ count, bytes: count === 0 ? 0 : picked().bytes });
    if (count === 0 || count > MOST_SIZED_ROWS) return setPicked({ count, bytes: 0 });
    sizeTimer = window.setTimeout(() => {
      selectionSize({ view: props.view, request: shown, rows: selection.rows() })
        .then((bytes) => ticket === sizeTicket && setPicked({ count, bytes }))
        // A reload in between forgets the snapshot, and the next change asks again.
        .catch(() => undefined);
    }, WHISPER_WAIT_MS);
  }

  /** The status line shows for a moment. */
  function speak() {
    setFresh(true);
    window.clearTimeout(freshTimer);
    freshTimer = window.setTimeout(() => setFresh(false), WHISPER_MS);
  }

  const whisperText = () => {
    const { count, bytes } = picked();
    if (count > 0) {
      const of = count > 1 || props.count > 1 ? ` of ${props.count.toLocaleString()}` : "";
      return `${count.toLocaleString()}${of} selected${bytes > 0 ? ` · ${formatSize(bytes)}` : ""}`;
    }
    return props.match ? counted(props.count, "match", "matches") : counted(props.count, "item", "items");
  };
  /** An empty list says so itself, in its middle. */
  const barShown = () => selectionBar() && picked().count > 0 && !editor();
  const whisperShown = () => statusBar() || (picked().count > 0 && !barShown()) || (fresh() && props.count > 0);

  function selectionChanged(instant = false, reveal = true) {
    pool.forEach(decorate);
    moveMarker(instant);
    noteSelection();
    const focused = selection.focused();
    const lone = selection.size() === 1 && selection.has(focused);
    props.onCursor(lone ? { snapshot: shown, index: focused } : undefined);
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

  /** A click on a row's icon, or on the corner of a tile, adds the row to the selection. */
  function onPicker(event: MouseEvent) {
    const target = event.target as HTMLElement;
    if (props.layout === "list") return !!target.closest(".file-icon");
    const box = target.closest(".file-row")?.getBoundingClientRect();
    return !!box && event.clientX - box.left < PICK_CORNER && event.clientY - box.top < PICK_CORNER;
  }

  /** Opens the folder at `index` in place, or closes it. */
  function toggleFolder(index: number) {
    const row = rowAt(index);
    if (row?.isDir) props.onExpand?.(join(row.location || props.folder, row.name));
  }

  /** The row of the folder that the row at `index` sits inside, if it is loaded. */
  function parentIndex(index: number) {
    const row = rowAt(index);
    if (!row?.location) return -1;
    for (let at = index - 1; at >= 0; at--) {
      const other = rowAt(at);
      if (!other) return -1;
      if (other.isDir && samePath(join(other.location || props.folder, other.name), row.location)) return at;
    }
    return -1;
  }

  /** Right opens a folder or steps into it. Left closes it or goes to the folder it is in. */
  function treeTarget(key: string, focused: number) {
    const row = nests() && focused >= 0 ? rowAt(focused) : undefined;
    if (!row) return undefined;
    if (key === "ArrowRight" && row.isDir) {
      if (isOpen(row)) return Math.min(focused + 1, props.count - 1);
      toggleFolder(focused);
      return focused;
    }
    if (key === "ArrowLeft") {
      if (isOpen(row)) {
        toggleFolder(focused);
        return focused;
      }
      const parent = parentIndex(focused);
      return parent >= 0 ? parent : undefined;
    }
    return undefined;
  }

  function onClick(event: MouseEvent) {
    const index = indexFromEvent(event);
    if (index >= 0 && (event.target as HTMLElement).closest(".file-twist")) return toggleFolder(index);
    if (index < 0) selection.clear();
    else if (event.shiftKey) selection.extendTo(index, event.ctrlKey);
    else if (event.ctrlKey || onPicker(event)) selection.toggle(index);
    else selection.select(index);
    selectionChanged();
  }

  function onMiddleClick(event: MouseEvent) {
    const row = event.button === 1 ? rowAt(indexFromEvent(event)) : undefined;
    if (row) props.onOpenBehind(row);
  }

  function onPointerDown(event: PointerEvent) {
    hideCard();
    const index = indexFromEvent(event);
    const onRow = event.button === 0 && index >= 0 && !(event.target as HTMLElement).closest("input, .file-twist");
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
    if (!row) return;
    // Where the folder zooms out from, if this opens one here.
    const element = pool[index % pool.length]?.element.getBoundingClientRect();
    if (row.isDir && !toSide && element) openedAt.set(props.view, element.top + element.height / 2);
    props.onOpen(row, toSide);
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
    props.onMenu(new MouseEvent("contextmenu", { clientX: left + rowHeight(), clientY: bottom }), row);
  }

  function onScroll() {
    hideCard(true);
    paint();
    if (header) header.scrollLeft = grid.scrollLeft;
  }

  function jumpTo(key: string, repeat: boolean) {
    const jump = typed(key);
    if (!jump) {
      const focused = selection.focused();
      // A held Space would open and close the preview over and over.
      if (key === " " && !repeat && focused >= 0 && focused < props.count) {
        props.onPreview({ snapshot: shown, index: focused });
      }
      return;
    }
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

    // Rows changing in place play their change. Opening, sorting and scrolling don't. A search
    // plays only from the top of the list, where the rows that stop matching can be seen to go.
    // ponytail: rows past the screen's edge just appear, and a reveal that scrolls plays nothing.
    const scrolled = grid.scrollTop;
    const still = props.match ? scrolled === 0 : !props.top;
    const moving = still && !props.rearranged && firstPaintDone && !reducedMotion.matches;
    const before = moving ? seen(rowsShown(), props.count < lastCount) : undefined;
    lastCount = props.count;

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
    if (before && grid.scrollTop === scrolled) {
      // In a search, rows that no longer match drift off and the rest close ranks without a show.
      playMoves(before, rowsShown(), spacer, props.match ? "drift" : "shrink", !!props.match);
    }
    const next = renameNext;
    renameNext = undefined;
    if (props.rename) startRename(selection.focused());
    else if (next) moveRename(loadedIndex(next));
  }

  /** Each filled row element by what it shows, so the same file is found again after a reload. */
  function rowsShown(): [string, HTMLElement][] {
    return pool.flatMap((pooled) => {
      const row = pooled.filled ? rowAt(pooled.index) : undefined;
      // A row is the same file in the folder's own list and in a search of it.
      const key = `${row?.location || props.folder}|${row?.name}`;
      return row ? [[key, pooled.element] as [string, HTMLElement]] : [];
    });
  }

  function loadedIndex({ name, location }: { name: string; location: string }) {
    for (const [page, rows] of pages) {
      const at = rows.findIndex((row) => row.name === name && row.location === location);
      if (at >= 0) return page * PAGE_SIZE + at;
    }
    return -1;
  }

  /** Tab in the name editor goes on to the next row's name, the way Explorer does. */
  function moveRename(index: number) {
    if (index < 0 || index >= props.count) return;
    selection.select(index);
    selectionChanged(true);
    startRename(index);
  }

  function startRename(index: number) {
    const row = index >= 0 ? rowAt(index) : undefined;
    const sample = pool[0];
    if (!row || !sample || editor()) return;
    const cell = sample.cells.find(({ id }) => id === "name")!.element;
    const { element } = sample;
    const inList = props.layout === "list";
    // In the list the icon shares the name's cell, and the editor starts after it.
    const twistRoom = nests() ? TWIST_ROOM + depthOf(row) * INDENT : 0;
    const iconRoom = inList ? sample.icon.offsetWidth + ICON_GAP + twistRoom : 0;
    const middle = inList && rowDensity() === "roomy" ? ROOMY_LINE / 2 : cell.offsetHeight / 2;
    setEditor({
      index,
      name: row.name,
      isDir: row.isDir,
      left: (index % perRow) * element.offsetWidth + element.clientLeft + cell.offsetLeft + iconRoom,
      top: Math.floor(index / perRow) * itemHeight + element.clientTop + cell.offsetTop + middle,
      width: Math.max(cell.offsetWidth - iconRoom, MIN_EDITOR_WIDTH),
    });
  }

  function focusEditor(input: HTMLInputElement) {
    editInput = input;
    namePart = "stem";
    queueMicrotask(() => {
      input.focus();
      selectPart();
    });
  }

  function selectPart() {
    const name = editInput.value;
    const dot = name.lastIndexOf(".");
    const extension = !editor()!.isDir && dot > 0;
    if (!extension || namePart === "whole") editInput.setSelectionRange(0, name.length);
    else if (namePart === "stem") editInput.setSelectionRange(0, dot);
    else editInput.setSelectionRange(dot + 1, name.length);
  }

  function endRename() {
    setEditor(undefined);
    setEditError(undefined);
    if (props.active) grid.focus({ preventScroll: true });
    props.onEditEnd();
  }

  /** `step` moves the editor on to the row before or after once the name is saved. */
  async function commitRename(step = 0) {
    const current = editor();
    if (!current || committing) return;
    const name = editInput.value;
    const target = step ? current.index + step : -1;
    if (name === current.name) {
      endRename();
      return moveRename(target);
    }
    committing = true;
    // The new name can move rows around, so the next row is found again by its name.
    const next = target >= 0 && target < props.count ? rowAt(target) : undefined;
    renameNext = next && { name: next.name, location: next.location };
    try {
      await props.onRename({ view: props.view, request: shown, rows: [current.index] }, name);
      endRename();
    } catch (failure) {
      renameNext = undefined;
      setEditError(String(failure));
      editInput.focus();
    } finally {
      committing = false;
    }
  }

  function onEditorKey(event: KeyboardEvent) {
    if (event.key === "Enter") commitRename();
    else if (event.key === "Escape") endRename();
    else if (event.key === "Tab") commitRename(event.shiftKey ? -1 : 1);
    else if (event.key === "F2") {
      namePart = NEXT_PART[namePart];
      selectPart();
    } else return;
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
    const plain = !event.shiftKey && !event.ctrlKey;
    const target = props.count > 0 ? ((plain ? treeTarget(event.key, focused) : undefined) ?? moveTarget(event.key, focused, shape)) : undefined;

    if (target !== undefined) {
      if (event.shiftKey) selection.extendTo(target, false);
      else selection.select(target);
    } else if (event.key === "Enter" && !event.ctrlKey && focused >= 0) {
      openIndex(focused, false);
    } else if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === "a") {
      selection.selectAll(props.count);
    } else if (event.key === "Escape") {
      selection.clear();
      props.onEscape();
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      return jumpTo(event.key, event.repeat);
    } else {
      return;
    }
    event.preventDefault();
    // Held keys repeat faster than the slide, so the bar would trail behind.
    selectionChanged(event.repeat);
  }

  /** A touchpad pinch sends many small wheel events, so they add up to one wheel notch a step. */
  let pinch = 0;
  function onWheel(event: WheelEvent) {
    if (!event.ctrlKey || props.layout !== "grid") return;
    pinch -= event.deltaY;
    if (Math.abs(pinch) < WHEEL_NOTCH / 2) return;
    setTileSize(clampTile(tileSize() + Math.sign(pinch) * TILE_STEP));
    pinch = 0;
  }

  onMount(() => {
    itemHeight = rowHeight();
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
    speak();
    // By the time this list goes, the folder it is told about is already the next one.
    const folder = props.folder;
    const agoTimer = window.setInterval(() => {
      if (dateForm() !== "ago") return;
      for (const pooled of pool) pooled.filled = false;
      paint();
    }, AGO_REFRESH_MS);
    onCleanup(() => {
      window.clearInterval(agoTimer);
      forgetMatches();
      observer.disconnect();
      props.onCursor(undefined);
      window.clearTimeout(freshTimer);
      window.clearTimeout(sizeTimer);
      leftFrom.set(props.view, { folder, y: openedAt.get(props.view) });
      openedAt.delete(props.view);
    });
  });

  createEffect(on(() => props.count, speak, { defer: true }));

  // The words change with a small step up, so a new count is seen without being read.
  createEffect(
    on(
      whisperText,
      () =>
        !reducedMotion.matches &&
        whisper?.animate({ translate: ["0 4px", "0 0"], opacity: [0.4, 1] }, { duration: 180, easing: "ease-out" }),
      { defer: true },
    ),
  );

  createEffect(
    on(
      [cells, () => props.layout, tileSize, rowDensity],
      () => {
        resize();
        selectionChanged(true);
      },
      { defer: true },
    ),
  );

  createEffect(
    on(
      [typesLearned, () => props.cut, () => props.match, () => props.synced, tags, allLooks, windowsIcons, dateForm, nests],
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
        data-nests={nests() ? "" : undefined}
        data-density={rowDensity()}
        style={{ "--row-height": `${rowHeight()}px` }}
        role="grid"
        aria-multiselectable="true"
        aria-rowcount={props.count}
        tabindex="0"
        onScroll={onScroll}
        onClick={onClick}
        onDblClick={(event) =>
          (event.target as HTMLElement).closest(".file-twist") || openIndex(indexFromEvent(event), event.ctrlKey)
        }
        onAuxClick={onMiddleClick}
        // Left alone, the middle button starts the browser's own scrolling.
        onMouseDown={(event) => event.button === 1 && event.preventDefault()}
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
        {props.count === 0 && <EmptyState empty={props.empty} />}
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
      <p
        ref={whisper}
        class="whisper"
        classList={{ "whisper-bar": statusBar(), "whisper-on": whisperShown() }}
        role="status"
      >
        {whisperText()}
      </p>
      <Show when={barShown()}>
        <SelectionBar
          count={picked().count}
          of={props.count}
          bytes={picked().bytes}
          items={props.barItems()}
          onClear={() => {
            selection.clear();
            selectionChanged();
          }}
        />
      </Show>
      <Show when={card()} keyed>
        {(ask) => <HoverCard ask={ask} view={props.view} folder={props.folder} onPin={pinCard} sync={syncText(ask.row, !!props.synced && !ask.row.isCloud && !ask.row.isPinned)} />}
      </Show>
    </div>
  );
}
