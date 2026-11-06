// The only place the UI talks to Rust.
import { invoke } from "@tauri-apps/api/core";

export interface Opened {
  /** Names this folder's rows in later `fetchRows` calls. */
  request: number;
  /** The resolved full path. */
  path: string;
  count: number;
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
}

export type SortKey = "name" | "modified" | "created" | "type" | "size";

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

const HEADER_BYTES = 29;
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

/** The first row at or after `start` whose name starts with `prefix`, wrapping around. */
export const findRow = (view: number, request: number, prefix: string, start: number) =>
  invoke<number | null>("find_row", { view, request, prefix, start });

export const closeView = (view: number) => invoke<void>("close_view", { view });

export const showSnapLayouts = () => invoke<void>("show_snap_layouts");

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
    const nameStart = offset + HEADER_BYTES;
    const flags = view.getUint8(offset + 28);
    rows[i] = {
      name: names.decode(bytes.subarray(nameStart, nameStart + nameBytes)),
      size: readUint64(view, offset + 4),
      modified: readFiletime(view, offset + 12),
      created: readFiletime(view, offset + 20),
      isDir: (flags & FLAG_FOLDER) !== 0,
      isHidden: (flags & FLAG_HIDDEN) !== 0,
    };
    offset = nameStart + nameBytes;
  }
  return rows;
}

function readFiletime(view: DataView, offset: number) {
  return readUint64(view, offset) / FILETIME_TICKS_PER_MS - FILETIME_TO_UNIX_MS;
}

function readUint64(view: DataView, offset: number) {
  return view.getUint32(offset, true) + view.getUint32(offset + 4, true) * UINT32_RANGE;
}
