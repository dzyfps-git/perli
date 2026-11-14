import { createEffect, createMemo, createSignal, For, Index, on, onCleanup, onMount, Show } from "solid-js";
import {
  fetchRows,
  fetchPictureFile,
  fetchThumb,
  findRow,
  folderPictures,
  rowProps,
  selectionSize,
  type Group,
  type Row,
  type Selection,
  type Sort,
  type SortKey,
  type Thumb,
} from "../../api";
import { ColumnHeader, SortStrip } from "./ColumnHeader";
import { formatSize } from "../../ui/format";
import { tagColor, tagNames, tags } from "../tags/tags";
import type { ListHandle, RowAt } from "../navigation/folderView";
import { isBin, join, parentOf, relativeTo, samePath } from "../navigation/path";
import { dayOf } from "../reach/lists";
import { allLooks, lookOf } from "../sidebar/saved";
import { EmptyState, type Empty } from "./EmptyState";
import { HoverCard, type CardAsk } from "./HoverCard";
import {
  columnsWidth,
  gridTemplate,
  isProp,
  MIN_COLUMN_WIDTH,
  PROP_NAMES,
  type Column,
  type ColumnId,
  type ColumnSet,
  type PropColumn,
} from "./columns";
import { clampTile, groupedMove, moveTarget, placesOf, TILE_STEP, type Layout } from "./layout";
import { ageShare, hasPicture, iconSheet, kindOf } from "./fileKinds";
import {
  dateForm,
  hoverCards,
  ROW_HEIGHTS,
  rowDensity,
  selectionBar,
  setColumnWidth,
  setTileSize,
  sizeBars,
  statusBar,
  tileSize,
  windowsIcons,
} from "./prefs";
import { ago, isoText } from "../../ui/dates";
import { SelectionBar, type BarItem } from "../reach/SelectionBar";
import { createSelection, runsOf } from "./selection";
import { cachedThumb, createThumbLoader } from "./thumbs";
import { matchSpans } from "./nameMatch";
import { readProgress } from "../preview/viewerPrefs";
import { playMoves, seen } from "./rowMotion";
import { createTypeJump, PAUSE_MS } from "./typeJump";
import { typesLearned, typeText } from "./typeNames";
import "./filelist.css";

const PAGE_SIZE = 256;
/** Pages of rows kept per list, the least lately painted going first: 8,192 rows, many screens. */
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
/** Past this many selected rows they go to be added up as runs, not one by one. */
const MOST_SIZED_ROWS = 20_000;
/** How far rows start from their place when a folder zooms in or out, as a share of their
 *  distance from the row that was opened. */
const ZOOM_IN_SHARE = -0.08;
const ZOOM_OUT_SHARE = 0.06;
const ZOOM_MS = 280;
/** How tall a group's header is, apart from the rows under it. */
const HEADER_HEIGHT = 34;
/** The extra columns are read a moment after the rows stop changing, a screenful at once. */
const PROPS_WAIT_MS = 80;
/** Marks Windows puts around some property text, such as a picture's dimensions. */
const DIRECTION_MARKS = /[‎‏‪-‮]/g;
/** How big a folder tile's stack of pictures is drawn, and the pictures in it. */
const STACK_EDGE = 160;
const STACK_CARD = 0.62;
/** Each card's lean in radians and its shift sideways in pixels. The first picture lies on top. */
const STACK_LEANS = [
  [0, 0],
  [-0.15, -11],
  [0.13, 10],
] as const;
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
  cells: { id: ColumnId; element: HTMLSpanElement }[];
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

const CELL_CLASS: Partial<Record<ColumnId, string>> = {
  name: "file-name",
  modified: "file-meta file-date",
  created: "file-meta file-date",
  size: "file-meta file-size",
  location: "file-meta file-clipped",
  artist: "file-meta file-clipped",
  album: "file-meta file-clipped",
};

/** A few pictures from inside a folder, fanned out like prints on a table. */
async function stackOf(folder: string): Promise<Thumb | null> {
  const paths = await folderPictures(folder);
  const read = await Promise.all(paths.map((path) => fetchPictureFile(path, STACK_EDGE).catch(() => null)));
  const pictures = read.filter((picture): picture is Thumb => picture !== null);
  if (pictures.length === 0) return null;
  const context = new OffscreenCanvas(STACK_EDGE, STACK_EDGE).getContext("2d")!;
  const card = STACK_EDGE * STACK_CARD;
  const border = 3;
  for (let at = pictures.length - 1; at >= 0; at--) {
    const { width, height, pixels } = pictures[at];
    const bitmap = await createImageBitmap(new ImageData(pixels, width, height));
    const [lean, shift] = STACK_LEANS[at];
    context.save();
    context.translate(STACK_EDGE / 2 + shift, STACK_EDGE / 2);
    context.rotate(lean);
    context.shadowColor = "rgb(0 0 0 / 0.3)";
    context.shadowBlur = 8;
    context.shadowOffsetY = 2;
    context.fillStyle = "#fff";
    context.beginPath();
    context.roundRect(-card / 2, -card / 2, card, card, 8);
    context.fill();
    context.shadowColor = "transparent";
    const inner = card - border * 2;
    context.beginPath();
    context.roundRect(-inner / 2, -inner / 2, inner, inner, 6);
    context.clip();
    const scale = Math.max(inner / width, inner / height);
    context.drawImage(bitmap, (-width * scale) / 2, (-height * scale) / 2, width * scale, height * scale);
    context.restore();
    bitmap.close();
  }
  return { width: STACK_EDGE, height: STACK_EDGE, pixels: context.getImageData(0, 0, STACK_EDGE, STACK_EDGE).data };
}

/** A tag on a row: a soft pill with its name in the list, a dot where room is short. */
function tagMark(id: number, pill: boolean) {
  const tag = tags().find((known) => known.id === id);
  if (!tag) return [];
  const mark = document.createElement("span");
  mark.className = pill ? "tag-pill" : "tag-dot";
  mark.dataset.tag = String(id);
  mark.style.setProperty("--tag", tagColor(tag.color));
  // Its name is drawn by CSS, so the cell's text stays the row's name (a drop target reads it).
  if (pill) mark.dataset.name = tag.name;
  return [mark];
}

/** The second line of a roomy row. */
const subText = (row: Row) =>
  [typeText(row.name, row.isDir), row.isDir && !row.size ? "" : formatSize(row.size)].filter(Boolean).join(" \u00b7 ");

function createCell(parent: HTMLElement, id: ColumnId) {
  const element = document.createElement("span");
  element.className = CELL_CLASS[id] ?? "file-meta";
  element.setAttribute("role", "gridcell");
  parent.append(element);
  return { id, element };
}

function createRow(cells: ColumnId[], withThumb: boolean, inGrid: boolean): PooledRow {
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

/** Windows refuses these in a name. */
const BAD_NAME_CHARACTERS = /[\\/:*?"<>|]/g;
const BAD_NAME_HINT = 'A name can\'t have any of \\ / : * ? " < > |';

/** The extension of a file's name, in lower case, or nothing. */
function extensionOf(name: string) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

/** How big a folder's cover picture is read, enough for the largest tile. */
const COVER_EDGE = 256;

/** Offered while a new file is named, narrowed by what follows the dot. */
const NEW_EXTENSIONS = [".txt", ".md", ".json", ".csv", ".html", ".css", ".js", ".ts", ".py", ".ps1", ".xml", ".yaml", ".log", ".ini"];
const MOST_EXTENSIONS = 8;

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
  /** Which kept set the columns are, which resizing them changes. */
  columnSet: ColumnSet;
  fixedColumns: boolean;
  /** The rows under each header, in order. Empty when the rows are not grouped. */
  groups: Group[];
  /** What a group's header says. */
  groupLabel: (key: string) => string;
  /** Folds a group away or opens it. `every` does all of them. */
  onFold: (key: string, every: boolean) => void;
  /** The biggest size a row shows, for the size bars. */
  largest: number;
  /** How many files the rows stand for. A file under two tags has two rows. */
  items: number;
  /** Rows show where each is, under their names, as a flat view does. */
  paths?: boolean;
  /** The grid is an even wall of pictures, edge to edge, with no names. */
  wall?: boolean;
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
  onSort: (key: ColumnId) => void;
  /** The pointer dragged the selected rows far enough to start a real file drag. */
  onDragOut: () => void;
  onOpen: (row: Row, toSide: boolean) => void;
  onMenu: (event: MouseEvent, row: Row) => void;
  /** A click on a tag pill, to show what else has that tag. */
  onTag?: (id: number) => void;
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
  /** Where to start scrolled to, on coming back to a folder. */
  scrollTo?: number;
  /** The list goes: what was selected, by name, and how far down it was. */
  onLeave?: (folder: string, names: string[], scrollTop: number) => void;
  /** A double click on no row. */
  onBackgroundDoubleClick?: () => void;
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
    /** It was just made, so its extension is still the user's to pick without a question. */
    fresh: boolean;
  }>();
  /** What the name editor holds now. */
  const [editValue, setEditValue] = createSignal("");
  const [editError, setEditError] = createSignal<string>();
  /** A gentle word under the name editor, rather than a dialog: a hint or a question. */
  const [editHint, setEditHint] = createSignal<string>();
  /** The new extension the user was asked about, which the next Enter accepts. */
  let extensionAsked: string | undefined;
  const [card, setCard] = createSignal<CardAsk>();
  /** How many rows are selected and their bytes, for the status line. */
  const [picked, setPicked] = createSignal({ count: 0, bytes: 0 });
  /** The status line has something new to say. */
  const [fresh, setFresh] = createSignal(true);
  let freshTimer: number | undefined;
  let sizeTimer: number | undefined;
  let sizeTicket = 0;
  let whisper: HTMLParagraphElement | undefined;
  /** What typing to jump looks for, shown in a bubble until the pause that starts it over. */
  const [jumpText, setJumpText] = createSignal("");
  const [jumpShown, setJumpShown] = createSignal(false);
  const [jumpMissed, setJumpMissed] = createSignal(false);
  let jumpTimer: number | undefined;
  let bubble: HTMLParagraphElement | undefined;
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
  /** A flat view's rows need a second line for where each one is. */
  const density = () => (props.paths && props.layout === "list" ? "roomy" : rowDensity());
  const rowHeight = () => ROW_HEIGHTS[density()];
  let itemHeight = 0;
  let perRow = 1;
  let places = placesOf([], 0, 1, 1, HEADER_HEIGHT);
  /** The headers in sight, and the one held at the top while its rows scroll under it. */
  const [heads, setHeads] = createSignal<{ group: Group; top: number }[]>([]);
  const [stuck, setStuck] = createSignal<{ group: Group; push: number }>();
  let headsShown = "";
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
    (): ColumnId[] =>
      props.layout === "grid"
        ? ["name"]
        : props.columns.filter((column) => column.visible).map((column) => column.id),
    [],
    { equals: (a, b) => a.join() === b.join() },
  );

  /** Books and comics whose cover Perli reads itself. */
  const COVERED = /\.(epub|cbz)$/i;

  const thumbKey = (row: Row) => `${row.location || props.folder}\\${row.name}|${row.modified}|${row.size}`;

  function rowShowing(index: number, key: string) {
    const pooled = pool[index % pool.length];
    return pooled?.index === index && pooled.thumbKey === key ? pooled : undefined;
  }

  /** The picture a folder row wears as its cover, if it was given one. */
  const coverOf = (row: Row | undefined) => (row?.isDir ? lookOf(join(row.location || props.folder, row.name))?.cover : undefined);

  const thumbs = createThumbLoader(
    (index, key) => {
      if (key.startsWith("stack|")) return stackOf(key.split("|")[1]);
      const cover = coverOf(rowAt(index));
      return cover ? fetchPictureFile(cover, COVER_EDGE) : fetchThumb(props.view, shown, index);
    },
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
        // The row just after this page could not tell its day from the one above it until now.
        const after = (page + 1) * PAGE_SIZE;
        const below = pool[after % pool.length];
        if (byDay() && below?.index === after) below.filled = false;
        paint();
      })
      .catch(console.error)
      .finally(() => loading.delete(page));
  }

  let newestPage = -1;
  function rowAt(index: number) {
    const page = Math.floor(index / PAGE_SIZE);
    const rows = pages.get(page);
    if (!rows) loadPage(page);
    // A page painted again moves to the back of the line, so the pages on screen never go.
    else if (page !== newestPage) {
      pages.delete(page);
      pages.set(page, rows);
      newestPage = page;
    }
    return rows?.[index % PAGE_SIZE];
  }

  // Percent moves by whole tiles, so a width change needs no JS at all.
  const placeOf = (index: number) => `translate(${places.column(index) * 100}%, ${places.top(index)}px)`;

  /** What the extra columns read for each row, by `thumbKey`, so a reload need not ask again. */
  const propsRead = new Map<string, Partial<Record<PropColumn, string>>>();
  const propsWaiting = new Set<number>();
  let propsTimer: number | undefined;

  function propText(row: Row, index: number, id: PropColumn) {
    const value = propsRead.get(thumbKey(row))?.[id];
    if (value === undefined) {
      propsWaiting.add(index);
      window.clearTimeout(propsTimer);
      propsTimer = window.setTimeout(readProps, PROPS_WAIT_MS);
      return "";
    }
    return id === "taken" ? dateText(Number(value)) : value;
  }

  /** Reads the extra columns of the rows still in sight, all at once. */
  function readProps() {
    const ids = cells().filter(isProp);
    const indexes = [...propsWaiting].filter((index) => pool[index % pool.length]?.index === index);
    propsWaiting.clear();
    const keys = indexes.map((index) => rowAt(index)).map((row) => row && thumbKey(row));
    if (ids.length === 0 || indexes.length === 0) return;
    rowProps(props.view, shown, indexes, ids.map((id) => PROP_NAMES[id]))
      .then((values) => {
        indexes.forEach((index, at) => {
          const key = keys[at];
          if (!key) return;
          const read = { ...propsRead.get(key) };
          ids.forEach((id, column) => (read[id] = (values[at][column] ?? "").replace(DIRECTION_MARKS, "")));
          propsRead.set(key, read);
          const pooled = pool[index % pool.length];
          if (pooled?.index === index) pooled.filled = false;
        });
        paint();
      })
      // A reload in between forgets the snapshot, and the rows ask again once they refill.
      .catch(() => undefined);
  }

  /** Makes a column as wide as the widest of its painted cells, or its title. */
  function fitColumn(id: ColumnId) {
    const measure = new Range();
    const natural = (element: Element) => {
      measure.selectNodeContents(element);
      const style = getComputedStyle(element);
      // A shortened name hides the part the pills after it would need room for.
      const label = element.querySelector(".file-label");
      const hidden = label ? label.scrollWidth - label.clientWidth : 0;
      return measure.getBoundingClientRect().width + hidden + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    };
    const widths = pool.flatMap((pooled) =>
      pooled.filled ? pooled.cells.filter((cell) => cell.id === id).map((cell) => natural(cell.element)) : [],
    );
    const at = props.columns.filter((column) => column.visible).findIndex((column) => column.id === id);
    const title = header?.children[at]?.querySelector(".column-button");
    // The title keeps room for its sort arrow.
    if (title) widths.push(natural(title) + 16);
    setColumnWidth(props.columnSet, id, Math.max(MIN_COLUMN_WIDTH, Math.ceil(Math.max(0, ...widths)) + 2));
  }

  function decorate(pooled: PooledRow) {
    const focused = pooled.index === selection.focused();
    pooled.element.setAttribute("aria-selected", String(selection.has(pooled.index)));
    pooled.element.toggleAttribute("data-focused", focused);
  }

  const byDay = () =>
    props.layout === "list" && props.groups.length === 0 && props.sort.key === "modified" && isBin(props.folder);

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
    pooled.element.toggleAttribute("data-system", row?.isSystem ?? false);
    pooled.element.toggleAttribute("data-cut", !!row && !row.location && !!props.cut?.has(row.name));
    // The bin by date deleted reads in days: a small label where one day gives way to the next.
    // A row whose neighbour above is not loaded yet gets its label once that page arrives.
    const day = row && byDay() ? dayOf(row.modified, Date.now()) : undefined;
    const above = day && index > 0 ? rowAt(index - 1) : undefined;
    if (day && (index === 0 || (above && dayOf(above.modified, Date.now()) !== day))) pooled.element.dataset.day = day;
    else delete pooled.element.dataset.day;
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
      const { id } = cell;
      cell.element.textContent = !row ? "" : isProp(id) ? propText(row, index, id) : CELL_TEXT[id](row, props.folder);
      if (id === "name") {
        const pills = row && inList ? row.tags.flatMap((id) => tagMark(id, true)) : [];
        // The name shortens on its own, so a long one never hides the pills after it.
        let line: HTMLElement | undefined;
        if (pills.length) {
          const label = document.createElement("span");
          label.className = "file-label";
          label.append(...cell.element.childNodes);
          line = document.createElement("span");
          line.className = "file-line";
          line.append(label, ...pills);
          cell.element.append(line);
        } else if (row && !inList) cell.element.prepend(...row.tags.flatMap((id) => tagMark(id, false)));
        if (inList) cell.element.prepend(pooled.icon);
        if (nests()) (line ?? cell.element).prepend(twistOf(pooled, row));
        // A flat view says where each row is, which matters more there than its kind and size.
        const where = row && props.paths ? relativeTo(props.folder, row.location) || "In this folder" : undefined;
        if (row && inList && density() === "roomy") cell.element.dataset.sub = where ?? subText(row);
        else delete cell.element.dataset.sub;
        cell.element.toggleAttribute("data-where", where !== undefined);
      } else if (row && (id === "modified" || id === "created")) {
        cell.element.style.setProperty("--age", String(ageShare(row[id], now)));
      } else if (id === "size") {
        // The square root keeps small files visible beside one huge one.
        const share = row && sizeBars() && props.largest > 0 && row.size > 0 ? Math.sqrt(row.size / props.largest) : 0;
        if (share > 0) cell.element.style.setProperty("--size-share", share.toFixed(3));
        else cell.element.style.removeProperty("--size-share");
      }
    }
    lightMatch(pooled, row);
    // Windows' picture of a folder would hide the look it was given. Other files show Perli's
    // own icon, unless a picture says more or Windows gave the folder an icon of its own.
    const pictured = row && !look && (windowsIcons() || row.isCustom || hasPicture(kind!) || COVERED.test(row.name));
    // A plain folder's tile shows a few of the pictures inside, if it has any.
    const stacked = !!row?.isDir && !inList && !look && !row.isCustom;
    pooled.element.toggleAttribute("data-stack", stacked);
    const path = row && join(row.location || props.folder, row.name);
    const key = look?.cover ? `cover|${look.cover}` : stacked ? `stack|${path}|${row!.modified}` : pictured ? thumbKey(row) : undefined;
    showThumb(pooled, key);
    // A book or comic part read shows how far, as a thin bar under its icon.
    const read = row && !row.isDir ? readProgress()[join(row.location || props.folder, row.name)] : undefined;
    if (read !== undefined) {
      pooled.icon.dataset.read = "";
      pooled.icon.style.setProperty("--read", String(read));
    } else {
      delete pooled.icon.dataset.read;
      pooled.icon.style.removeProperty("--read");
    }
  }

  /** A pool being thrown away takes its lit letters with it, since the highlight is shared. */
  function forgetMatches() {
    for (const pooled of pool) for (const range of pooled.matches ?? []) nameMatches.delete(range);
  }

  function lightMatch(pooled: PooledRow, row: Row | undefined) {
    for (const range of pooled.matches ?? []) nameMatches.delete(range);
    pooled.matches = undefined;
    const cell = pooled.cells.find((cell) => cell.id === "name")?.element;
    const holder = cell?.querySelector(".file-label") ?? cell;
    const text = holder && [...holder.childNodes].find((node) => node instanceof Text);
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

  /** Puts the headers in sight in their places, and holds the current one at the top. */
  function placeHeads() {
    const groups = props.groups;
    const scrolled = grid.scrollTop;
    const from = groups.length > 0 ? places.groupAt(scrolled) : 0;
    const to = groups.length > 0 ? places.groupAt(scrolled + grid.clientHeight) : -1;
    const inSight = groups.slice(from, to + 1).map((group, at) => ({ group, top: places.tops[from + at] }));
    const shownNow = inSight.map(({ group, top }) => `${group.key}:${group.count}:${group.total}:${top}`).join();
    if (shownNow !== headsShown) {
      headsShown = shownNow;
      setHeads(inSight);
    }
    const current = groups[from];
    const next = places.tops[from + 1] ?? Infinity;
    const push = Math.min(0, next - HEADER_HEIGHT - scrolled);
    const before = stuck();
    if (!current || scrolled <= places.tops[from]) setStuck(undefined);
    else if (before?.group !== current || before.push !== push) setStuck({ group: current, push });
  }

  function paint() {
    placeHeads();
    const first = places.firstAt(grid.scrollTop - OVERSCAN * itemHeight);
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
    // A wall's tiles are square and fill the width exactly.
    itemHeight = tile && props.wall ? grid.clientWidth / perRow : tile || rowHeight();
    grid.style.setProperty("--per-row", String(perRow));
    grid.style.setProperty("--item-height", `${itemHeight}px`);
    places = placesOf(props.groups, props.count, perRow, itemHeight, HEADER_HEIGHT);
    spacer.style.height = `${places.height}px`;

    const needed = (Math.ceil(grid.clientHeight / itemHeight) + OVERSCAN * 2) * perRow;
    const size = Math.min(props.count, needed);
    const shape = `${cells().join()} ${props.layout} ${perRow} ${itemHeight} ${!!props.wall}`;
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
    // Rows of the same file count once, which only the listing knows, so until it answers the
    // count stays as it was.
    const repeats = props.items < props.count;
    if (!repeats || count === 0) setPicked({ count, bytes: count === 0 ? 0 : picked().bytes });
    if (count === 0) return setPicked({ count, bytes: 0 });
    sizeTimer = window.setTimeout(() => {
      const rows = selection.rows();
      const asked = count > MOST_SIZED_ROWS ? { rows: [], ranges: runsOf(rows) } : { rows };
      selectionSize({ view: props.view, request: shown, ...asked })
        .then(([items, bytes]) => ticket === sizeTicket && setPicked({ count: items, bytes }))
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
      const of = count > 1 || props.items > 1 ? ` of ${props.items.toLocaleString()}` : "";
      return `${count.toLocaleString()}${of} selected${bytes > 0 ? ` · ${formatSize(bytes)}` : ""}`;
    }
    return props.match ? counted(props.items, "match", "matches") : counted(props.items, "item", "items");
  };
  /** An empty list says so itself, in its middle. */
  const barShown = () => selectionBar() && picked().count > 0 && !editor();
  /** The selection bar already says the count, and the whisper would sit under it. */
  const whisperShown = () => statusBar() || (!barShown() && (picked().count > 0 || (fresh() && props.count > 0)));

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
    const top = places.top(focused);
    // A header held at the top would cover the row.
    const covered = props.groups.length > 0 ? HEADER_HEIGHT : 0;
    if (top - covered < grid.scrollTop) grid.scrollTop = top - covered;
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
    // A tag on a row shows every item with that tag, unless the click picks rows.
    const tag = (event.target as HTMLElement).closest<HTMLElement>(".tag-pill");
    if (tag && props.onTag && !event.ctrlKey && !event.shiftKey) return props.onTag(Number(tag.dataset.tag));
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
    window.clearTimeout(jumpTimer);
    setJumpText(jump.prefix);
    setJumpShown(true);
    jumpTimer = window.setTimeout(() => setJumpShown(false), PAUSE_MS);
    findRow(props.view, props.snapshot, jump.prefix, start)
      .then((index) => {
        if (ticket !== latestJump) return;
        setJumpMissed(index === null);
        if (index === null) {
          if (!reducedMotion.matches) bubble?.animate({ translate: ["-4px 0", "4px 0", "-2px 0", "0 0"] }, 240);
          return;
        }
        selection.select(index);
        selectionChanged();
      })
      .catch(console.error);
  }

  /** New rows take over in one step, so nothing blinks and the scroll position stays. */
  async function swapRows(snapshot: number) {
    const selected = props.selected ?? [];
    const first = props.top ? 0 : places.firstAt(grid.scrollTop - OVERSCAN * itemHeight);
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
    const scrolled = grid.scrollTop;
    const still = props.match ? scrolled === 0 : !props.top;
    const moving = still && !props.rearranged && firstPaintDone && !reducedMotion.matches;
    const closing = props.count < lastCount;
    const before = moving ? seen(rowsShown(), closing) : undefined;
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
    // A reveal may have scrolled, which the moves take into account. One that jumps a screen or
    // more lands somewhere new, where there is nothing to follow.
    if (before && Math.abs(grid.scrollTop - scrolled) < grid.clientHeight) {
      // In a search, rows that no longer match drift off and the rest close ranks without a show.
      const edge = closing && !props.match ? grid.getBoundingClientRect().bottom : undefined;
      playMoves(before, rowsShown(), spacer, props.match ? "drift" : "shrink", !!props.match, grid.scrollTop - scrolled, edge);
    }
    const next = renameNext;
    renameNext = undefined;
    if (props.rename) startRename(selection.focused(), true);
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

  function startRename(index: number, fresh = false) {
    const row = index >= 0 ? rowAt(index) : undefined;
    const sample = pool[0];
    if (!row || !sample || editor()) return;
    const cell = sample.cells.find(({ id }) => id === "name")!.element;
    const { element } = sample;
    const inList = props.layout === "list";
    // In the list the icon shares the name's cell, and the editor starts after it.
    const twistRoom = nests() ? TWIST_ROOM + depthOf(row) * INDENT : 0;
    const iconRoom = inList ? sample.icon.offsetWidth + ICON_GAP + twistRoom : 0;
    const middle = inList && density() === "roomy" ? ROOMY_LINE / 2 : cell.offsetHeight / 2;
    setEditValue(row.name);
    setEditor({
      index,
      name: row.name,
      isDir: row.isDir,
      fresh,
      left: places.column(index) * element.offsetWidth + element.clientLeft + cell.offsetLeft + iconRoom,
      top: places.top(index) + element.clientTop + cell.offsetTop + middle,
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
    setEditHint(undefined);
    extensionAsked = undefined;
    if (props.active) grid.focus({ preventScroll: true });
    props.onEditEnd();
  }

  /** `step` moves the editor on to the row before or after once the name is saved. */
  /** `enter` is a press of Enter, the only way to say yes to a new extension. */
  async function commitRename(step = 0, enter = false) {
    const current = editor();
    if (!current || committing) return;
    const name = editInput.value;
    const target = step ? current.index + step : -1;
    if (name === current.name) {
      endRename();
      return moveRename(target);
    }
    // A new extension can leave a file no app opens, so the first Enter only asks.
    const [before, after] = [extensionOf(current.name), extensionOf(name)];
    if (!current.isDir && !current.fresh && before !== after && !(enter && extensionAsked === after)) {
      extensionAsked = after;
      setEditError(undefined);
      const change = after ? `to ${after}` : "off";
      const was = before ? `${before} ` : "";
      setEditHint(`Change the ${was}extension ${change}? The file may then open in another app, or none. Press Enter again to change it, or Esc to keep it.`);
      shake();
      editInput.focus();
      return;
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
      setEditHint(undefined);
      setEditError(String(failure));
      shake();
      editInput.focus();
    } finally {
      committing = false;
    }
  }

  /** A soft shake of the name editor, where a dialog would have been. */
  function shake() {
    if (reducedMotion.matches) return;
    editInput.animate({ translate: ["0 0", "-4px 0", "4px 0", "-2px 0", "0 0"] }, { duration: 260, easing: "ease-out", composite: "add" });
  }

  /** Characters Windows refuses never get in: they shake the editor and say why. */
  function onEditorInput() {
    const typed = editInput.value;
    setEditValue(typed);
    if (extensionAsked !== undefined && extensionOf(typed) !== extensionAsked) {
      extensionAsked = undefined;
      setEditHint(undefined);
    }
    if (typed.search(BAD_NAME_CHARACTERS) < 0) return;
    const caret = editInput.selectionStart ?? typed.length;
    const before = typed.slice(0, caret).replace(BAD_NAME_CHARACTERS, "");
    editInput.value = before + typed.slice(caret).replace(BAD_NAME_CHARACTERS, "");
    editInput.setSelectionRange(before.length, before.length);
    setEditValue(editInput.value);
    setEditError(undefined);
    setEditHint(BAD_NAME_HINT);
    shake();
  }

  /** The extensions to offer a new file, the one it has first, then those matching what is typed. */
  function extensionChoices() {
    const open = editor();
    if (!open?.fresh || open.isDir) return [];
    const typed = extensionOf(editValue());
    // A whole extension, such as the one a new file starts with, comes first with the others after.
    if (NEW_EXTENSIONS.includes(typed)) return [typed, ...NEW_EXTENSIONS.filter((other) => other !== typed)].slice(0, MOST_EXTENSIONS);
    const fitting = NEW_EXTENSIONS.filter((extension) => extension.startsWith(typed));
    return (fitting.length > 0 ? fitting : NEW_EXTENSIONS).slice(0, MOST_EXTENSIONS);
  }

  /** Puts `extension` on the name being typed, and leaves the rest of the name selected. */
  function useExtension(extension: string) {
    const name = editInput.value;
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    editInput.value = stem + extension;
    setEditValue(editInput.value);
    editInput.focus();
    editInput.setSelectionRange(0, stem.length);
  }

  function onEditorKey(event: KeyboardEvent) {
    if (event.key === "Enter") commitRename(0, true);
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
    // In a grid of groups, a line can end short and the next group starts a new one.
    const across = props.layout === "grid" ? groupedMove(event.key, focused, props.groups, perRow) : undefined;
    const target =
      props.count > 0
        ? ((plain ? treeTarget(event.key, focused) : undefined) ?? across ?? moveTarget(event.key, focused, shape))
        : undefined;

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
    if (props.scrollTo) {
      grid.scrollTop = props.scrollTo;
      paint();
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
      window.clearTimeout(jumpTimer);
      leftFrom.set(props.view, { folder, y: openedAt.get(props.view) });
      openedAt.delete(props.view);
      // Only rows already read have names to keep, at most the pages kept.
      const names = selection
        .rows()
        .flatMap((index) => pages.get(Math.floor(index / PAGE_SIZE))?.[index % PAGE_SIZE]?.name ?? []);
      props.onLeave?.(folder, names, grid.scrollTop);
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
      [cells, () => props.layout, tileSize, density, () => props.wall],
      () => {
        resize();
        selectionChanged(true);
      },
      { defer: true },
    ),
  );

  createEffect(
    on(
      [typesLearned, () => props.cut, () => props.match, () => props.synced, tags, allLooks, windowsIcons, dateForm, nests, readProgress, sizeBars],
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

  /** A group's header: a glass strip with its name and count, which folds the rows under it. */
  function GroupHead(head: { group: Group; top: number; held?: boolean }) {
    const open = () => head.group.count > 0;
    return (
      <div class="group-head" data-held={head.held ? "" : undefined} style={{ transform: `translateY(${head.top}px)` }}>
        <button
          class="group-fold"
          aria-expanded={open()}
          aria-description="Ctrl+click folds or opens every group"
          // The list keeps the keyboard, so arrows still move through the rows after a click.
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.stopPropagation();
            props.onFold(head.group.key, event.ctrlKey);
          }}
          onDblClick={(event) => event.stopPropagation()}
        >
          <span class="group-twist" aria-hidden="true" />
          <span class="group-label">{props.groupLabel(head.group.key)}</span>
          <span class="group-count">{head.group.total.toLocaleString()}</span>
        </button>
      </div>
    );
  }

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
            columns={props.columns.filter((column) => !isProp(column.id))}
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
          set={props.columnSet}
          fixed={props.fixedColumns}
          sort={props.sort}
          onSort={props.onSort}
          onMenu={props.onHeaderMenu}
          onGroup={props.onGroup}
          onFit={fitColumn}
        />
      </Show>
      <div
        ref={grid}
        class="file-grid"
        data-layout={props.layout}
        data-nests={nests() ? "" : undefined}
        data-density={density()}
        data-grouped={props.groups.length > 0 ? "" : undefined}
        data-wall={props.wall && props.layout === "grid" ? "" : undefined}
        style={{ "--row-height": `${rowHeight()}px`, "--group-head": `${HEADER_HEIGHT}px` }}
        role="grid"
        aria-multiselectable="true"
        aria-rowcount={props.count}
        tabindex="0"
        onScroll={onScroll}
        onClick={onClick}
        onDblClick={(event) => {
          if ((event.target as HTMLElement).closest(".file-twist, button")) return;
          const index = indexFromEvent(event);
          // A double click on the scroll bar is not one on empty space.
          if (index >= 0) openIndex(index, event.ctrlKey);
          else if (event.target === grid && event.offsetX < grid.clientWidth) props.onBackgroundDoubleClick?.();
        }}
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
        {/* Sticky and no height, so the browser holds it at the top while the rows scroll. */}
        <div class="group-stuck" role="presentation">
          <Show when={stuck()}>{(held) => <GroupHead group={held().group} top={held().push} held />}</Show>
        </div>
        <div ref={marker} class="file-marker" role="presentation" hidden />
        <div ref={spacer} class="file-spacer" role="presentation" />
        <div class="group-heads" role="presentation">
          <Index each={heads()}>{(head) => <GroupHead group={head().group} top={head().top} />}</Index>
        </div>
        {/* With every group folded, the headers stay and say what is there. */}
        {props.count === 0 && props.groups.length === 0 && <EmptyState empty={props.empty} />}
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
                onInput={onEditorInput}
                onBlur={onEditorBlur}
              />
              <Show when={extensionChoices().length > 0 && !editError() && !editHint()}>
                <p class="file-editor-extensions" role="group" aria-label="Extensions">
                  <For each={extensionChoices()}>
                    {(extension) => (
                      <button
                        class="file-editor-extension"
                        tabIndex={-1}
                        aria-current={extensionOf(editValue()) === extension}
                        onPointerDown={(event) => event.preventDefault()}
                        onClick={() => useExtension(extension)}
                      >
                        {extension}
                      </button>
                    )}
                  </For>
                </p>
              </Show>
              <Show when={editError() ?? editHint()}>
                <p class="file-editor-error" role="alert" data-hint={editError() ? undefined : ""}>
                  {editError() ?? editHint()}
                </p>
              </Show>
            </div>
          )}
        </Show>
      </div>
      <p
        ref={bubble}
        class="type-bubble"
        classList={{ "type-bubble-on": jumpShown() }}
        data-missed={jumpMissed() ? "" : undefined}
        aria-hidden="true"
      >
        {jumpText()}
      </p>
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
          of={props.items}
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
