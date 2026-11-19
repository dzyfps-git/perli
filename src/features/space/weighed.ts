import { listedParts, type MapCell } from "../../api";
import { saved, stored } from "../filelist/prefs";

/**
 * What Space last found in each folder it weighed, kept small: the biggest things on top, with no
 * deeper parts. It lets Space open at once on a folder it has seen, and lets This PC and the home
 * page show what fills each drive without weighing anything.
 */

type Kept = Record<string, { at: number; cells: MapCell[]; years?: [number, number][] }>;

/** The folders kept. The ones looked at longest ago go first. */
const MOST_FOLDERS = 12;
/** The biggest things kept of each. */
const MOST_CELLS = 24;
/** A drive the search index answers for is asked again once what is kept of it is this old. */
const LISTED_AGAIN = 10 * 60_000;

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

/** The bytes by year of all that was in each folder, by lowercase path, oldest first. */
export function weighedYears(): Record<string, [number, number][]> {
  return Object.fromEntries(Object.entries(kept()).map(([id, entry]) => [id, entry.years ?? []]));
}

/** The bytes of all the cells by year, oldest first. */
export function yearsOf(cells: MapCell[]): [number, number][] {
  const byYear = new Map<number, number>();
  for (const cell of cells) for (const [year, bytes] of cell.years ?? []) byYear.set(year, (byYear.get(year) ?? 0) + bytes);
  return [...byYear].sort((a, b) => a[0] - b[0]);
}

export function keepWeighed(id: string, cells: MapCell[]) {
  const small = [...cells]
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, MOST_CELLS)
    .map(({ name, bytes, folder, newest, exts }) => ({ name, bytes, folder, newest, exts: exts.slice(0, 1) }));
  const next = { ...kept(), [id]: { at: Date.now(), cells: small, years: yearsOf(cells) } };
  const ids = Object.keys(next).sort((a, b) => next[b].at - next[a].at).slice(0, MOST_FOLDERS);
  setKept(Object.fromEntries(ids.map((one) => [one, next[one]])));
}

/** Drives the search index answers for show what fills them at once, with nothing weighed. */
export function listDrives(drives: { path: string; id: string }[]) {
  for (const drive of drives) {
    if (Date.now() - (kept()[drive.id]?.at ?? 0) < LISTED_AGAIN) continue;
    listedParts(drive.path)
      .then((cells) => cells && keepWeighed(drive.id, cells))
      .catch(() => {});
  }
}
