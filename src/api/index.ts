// The only place the UI talks to Rust.
import { invoke } from "@tauri-apps/api/core";

export interface Opened {
  count: number;
  loadMs: number;
}

export interface Row {
  name: string;
  size: number;
  /** Milliseconds since 1970. */
  modified: number;
  isDir: boolean;
}

const HEADER_BYTES = 21;
const UINT32_RANGE = 2 ** 32;
const FILETIME_TICKS_PER_MS = 10_000;
const FILETIME_TO_UNIX_MS = 11_644_473_600_000;

const names = new TextDecoder("utf-16le");

export const startFolder = () => invoke<string>("start_folder");

export const openFolder = (path: string) => invoke<Opened>("open_folder", { path });

export async function fetchRows(start: number, count: number): Promise<Row[]> {
  return decodeRows(await invoke<ArrayBuffer>("rows", { start, count }));
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
    rows[i] = {
      name: names.decode(bytes.subarray(nameStart, nameStart + nameBytes)),
      size: readUint64(view, offset + 4),
      modified: readUint64(view, offset + 12) / FILETIME_TICKS_PER_MS - FILETIME_TO_UNIX_MS,
      isDir: view.getUint8(offset + 20) === 1,
    };
    offset = nameStart + nameBytes;
  }
  return rows;
}

function readUint64(view: DataView, offset: number) {
  return view.getUint32(offset, true) + view.getUint32(offset + 4, true) * UINT32_RANGE;
}
