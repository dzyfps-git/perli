import type { MapCell } from "../../api";
import { saved, stored } from "../filelist/prefs";

/**
 * What Space last found in each folder it weighed, kept small: the biggest things on top, with no
 * deeper parts. It lets Space open at once on a folder it has seen, and lets This PC and the home
 * page show what fills each drive without weighing anything.
 */

type Kept = Record<string, { at: number; cells: MapCell[] }>;

/** The folders kept. The ones looked at longest ago go first. */
const MOST_FOLDERS = 12;
/** The biggest things kept of each. */
const MOST_CELLS = 24;

function keptOf(value: unknown): Kept {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, { at: number; cells: MapCell[] }] =>
        !!entry[1] && typeof (entry[1] as { at?: unknown }).at === "number" && Array.isArray((entry[1] as { cells?: unknown }).cells),
    ),
  );
}

const [kept, setKept] = stored<Kept>("space-weighed", keptOf(saved("space-weighed")));

/** The cells last found in each folder, by lowercase path. */
export function weighed(): Record<string, MapCell[]> {
  return Object.fromEntries(Object.entries(kept()).map(([id, entry]) => [id, entry.cells]));
}

export function keepWeighed(id: string, cells: MapCell[]) {
  const small = [...cells]
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, MOST_CELLS)
    .map(({ name, bytes, folder, newest, exts }) => ({ name, bytes, folder, newest, exts: exts.slice(0, 1) }));
  const next = { ...kept(), [id]: { at: Date.now(), cells: small } };
  const ids = Object.keys(next).sort((a, b) => next[b].at - next[a].at).slice(0, MOST_FOLDERS);
  setKept(Object.fromEntries(ids.map((one) => [one, next[one]])));
}
