// The only place the UI talks to Rust.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface Opened {
  /** Names this folder's rows in later `fetchRows` calls. */
  request: number;
  /** The resolved full path. */
  path: string;
  count: number;
  /** Hidden entries in the folder, shown or not. */
  hiddenCount: number;
  loadMs: number;
  /** Rows to select straight away, when this is a new order of the same folder. */
  selected?: number[];
}

export interface Row {
  name: string;
  size: number;
  /** Milliseconds since 1970. */
  modified: number;
  /** Milliseconds since 1970. */
  created: number;
  isDir: boolean;
  isHidden: boolean;
  /** Where a deleted item came from. Empty outside the Recycle Bin. */
  location: string;
}

export type SortKey = "name" | "modified" | "created" | "type" | "size" | "location";

export interface Sort {
  key: SortKey;
  descending: boolean;
}

export type Grouping = "foldersFirst" | "filesFirst" | "mixed";

/** Which rows a view shows and in what order. */
export interface Order extends Sort {
  group: Grouping;
  showHidden: boolean;
}

export interface Start {
  /** The folder from the command line. It replaces the saved session for this run. */
  folder: string | null;
  session: string | null;
  home: string | null;
}

export interface DriveSpace {
  free: number;
  total: number;
}

export interface Places {
  folders: { kind: string; path: string }[];
  drives: { name: string; path: string }[];
}

/** Rows of one snapshot. */
export interface Selection {
  view: number;
  request: number;
  rows: number[];
}

/** What the UI can ask of the file engine. Folders are paths, and files are always rows. */
export type Task =
  | { kind: "copy" | "move"; selection: Selection; folder: string }
  | { kind: "rename"; selection: Selection; name: string }
  | { kind: "new"; folder: string; directory: boolean }
  | { kind: "paste"; folder: string }
  | { kind: "recycle" | "delete" | "restore" | "purge"; selection: Selection }
  | { kind: "empty" };

export interface Progress {
  bytes: number;
  totalBytes: number;
  items: number;
  totalItems: number;
  current: string;
}

export type Answer = "replace" | "keepBoth" | "merge" | "skip" | "retry" | "elevate" | "permanent" | "cancel";

export interface Facts {
  size: number;
  /** FILETIME ticks. */
  modified: number;
  folder: boolean;
}

export type Question =
  | { kind: "conflict"; name: string; source: Facts; target: Facts; choices: Answer[] }
  | { kind: "problem"; path: string; message: string; choices: Answer[] }
  | { kind: "noBin"; path: string; choices: Answer[] };

export type JobEvent = { id: number } & (
  | { kind: "started"; title: string; origin: number | null; newItem: boolean; recycle: boolean }
  | ({ kind: "progress" } & Progress)
  | { kind: "asked"; question: Question }
  | ({
      kind: "finished";
      /** Folders whose contents changed. */
      touched: string[];
      /** Full paths of what the job made. */
      created: string[];
      /** Sources a move left alone because they changed while it ran. */
      kept: string[];
      cancelled: boolean;
      /** The undo step this job added. */
      step: number | null;
    } & Undoable)
);

/** What Undo and Redo can do now. */
export interface Undoable {
  /** The step Undo would reverse next. */
  latestStep: number | null;
  redo: boolean;
}

export interface Measured {
  items: number;
  bytes: number;
}

const HEADER_BYTES = 33;
const FLAG_FOLDER = 1;
const FLAG_HIDDEN = 2;
const UINT32_RANGE = 2 ** 32;
const FILETIME_TICKS_PER_MS = 10_000;
const FILETIME_TO_UNIX_MS = 11_644_473_600_000;

const names = new TextDecoder("utf-16le");

export const startState = () => invoke<Start>("start_state");

export const saveSession = (text: string) => invoke<void>("save_session", { text });

export const listPlaces = () => invoke<Places>("list_places");

export const driveSpace = (path: string) => invoke<DriveSpace>("drive_space", { path });

export const typeNames = (extensions: string[]) =>
  invoke<Record<string, string>>("type_names", { extensions });

/** Turns `~` and `%NAME%` in typed text into a real path. */
export const expandPath = (text: string) => invoke<string>("expand_path", { text });

export const isFile = (path: string) => invoke<boolean>("is_file", { path });

/** `shown` is the request of the folder on screen, whose rows must outlive this open. */
export const openFolder = (view: number, request: number, shown: number, path: string, order: Order) =>
  invoke<Opened>("open_folder", { view, request, shown, path, order });

/** Puts the shown folder in a new order as a new snapshot. `selected` rows follow their files. */
export const arrangeView = (
  view: number,
  request: number,
  shown: number,
  order: Order,
  selected: number[],
) =>
  invoke<{ count: number; selected: number[] }>("arrange_view", { view, request, shown, order, selected });

/** Reads the shown folder again. `select` names the new selection, or `selected` rows keep theirs. */
export const reloadView = (
  view: number,
  request: number,
  shown: number,
  path: string,
  order: Order,
  selected: number[],
  select: string[],
) =>
  invoke<{ count: number; hiddenCount: number; selected: number[] }>("reload_view", {
    view,
    request,
    shown,
    path,
    order,
    selected,
    select,
  });

/** `origin` is the view that asked, which selects what the job makes. */
export const startJob = (task: Task, origin?: number) => invoke<void>("start_job", { task, origin });

/** With `step`, this only undoes that step, and only while it is the newest. */
export const undoJob = (origin?: number, step?: number) => invoke<void>("undo_job", { origin, step });
export const redoJob = (origin?: number) => invoke<void>("redo_job", { origin });
export const undoState = () => invoke<Undoable>("undo_state");
/** With jobs running, this keeps the window open past the close limit. True if it did. */
export const holdClose = () => invoke<boolean>("hold_close");
export const cancelJobsAndClose = () => invoke<void>("cancel_jobs_and_close");
export const pauseJob = (id: number) => invoke<void>("pause_job", { id });
export const resumeJob = (id: number) => invoke<void>("resume_job", { id });
export const cancelJob = (id: number) => invoke<void>("cancel_job", { id });

/** `all` uses the same answer for every later case of this kind. */
export const answerJob = (id: number, answer: Answer, all: boolean) =>
  invoke<void>("answer_job", { id, reply: { answer, all } });

export const onJobEvent = (handler: (event: JobEvent) => void) =>
  listen<JobEvent>("job", (event) => handler(event.payload));

export const measureSelection = (selection: Selection) => invoke<Measured>("measure_selection", { selection });

export const binSummary = () => invoke<Measured>("bin_summary");

export const setClipboard = (selection: Selection, cut: boolean) =>
  invoke<{ names: string[]; sequence: number }>("set_clipboard", { selection, cut });

export const cancelCut = (sequence: number) => invoke<void>("cancel_cut", { sequence });

export const clipboardSequence = () => invoke<number>("clipboard_sequence");

export const clipboardHasFiles = () => invoke<boolean>("clipboard_has_files");

/** The first row at or after `start` whose name starts with `prefix`, wrapping around. */
export const findRow = (view: number, request: number, prefix: string, start: number) =>
  invoke<number | null>("find_row", { view, request, prefix, start });

export const closeView = (view: number) => invoke<void>("close_view", { view });

/** Physical pixels, relative to the window. */
export const placeSnapArea = (x: number, y: number, width: number, height: number) =>
  invoke<void>("place_snap_area", { x, y, width, height });

export const openFile = (path: string) => invoke<void>("open_file", { path });

export const clipboardText = () => invoke<string>("clipboard_text");

export async function fetchRows(
  view: number,
  request: number,
  start: number,
  count: number,
): Promise<Row[]> {
  return decodeRows(await invoke<ArrayBuffer>("rows", { view, request, start, count }));
}

/** Decodes the format written by `encode_rows` in `src-tauri/src/folder.rs`. */
function decodeRows(buffer: ArrayBuffer): Row[] {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const rows = new Array<Row>(view.getUint32(0, true));

  let offset = 4;
  for (let i = 0; i < rows.length; i++) {
    const nameBytes = view.getUint32(offset, true);
    const locationBytes = view.getUint32(offset + 29, true);
    const nameStart = offset + HEADER_BYTES;
    const locationStart = nameStart + nameBytes;
    const flags = view.getUint8(offset + 28);
    rows[i] = {
      name: names.decode(bytes.subarray(nameStart, locationStart)),
      location: names.decode(bytes.subarray(locationStart, locationStart + locationBytes)),
      size: readUint64(view, offset + 4),
      modified: readFiletime(view, offset + 12),
      created: readFiletime(view, offset + 20),
      isDir: (flags & FLAG_FOLDER) !== 0,
      isHidden: (flags & FLAG_HIDDEN) !== 0,
    };
    offset = locationStart + locationBytes;
  }
  return rows;
}

/** Milliseconds since 1970. */
export const filetimeToMs = (ticks: number) => ticks / FILETIME_TICKS_PER_MS - FILETIME_TO_UNIX_MS;

function readFiletime(view: DataView, offset: number) {
  return filetimeToMs(readUint64(view, offset));
}

function readUint64(view: DataView, offset: number) {
  return view.getUint32(offset, true) + view.getUint32(offset + 4, true) * UINT32_RANGE;
}
