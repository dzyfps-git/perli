import type { Kind } from "../filelist/fileKinds";

/** Kinds that read as text, line by line. */
const TEXTS = new Set<Kind>(["text", "markdown", "code", "web", "data", "script", "config", "log", "subtitle"]);
/** Tables that are only text underneath. */
const TEXT_TABLES = /\.(csv|tsv)$/i;

/** How two files of `kinds` compare: as pictures, as texts, or not at all (folders, or kinds that are neither). */
export function compareKind(names: string[], kinds: Kind[]) {
  if (names.length !== 2 || kinds.includes("folder")) return undefined;
  if (kinds.every((kind) => kind === "picture")) return "picture";
  if (names.every((name, at) => TEXTS.has(kinds[at]) || TEXT_TABLES.test(name))) return "text";
  return undefined;
}

/** A picture's zoom and pan, which both sides share. */
export interface Lens {
  scale: number;
  x: number;
  y: number;
}

export const WHOLE: Lens = { scale: 1, x: 0, y: 0 };
const LEAST_SCALE = 1;
const MOST_SCALE = 16;

/**
 * The lens after zooming by `factor` around the point `at`, measured from the stage's middle,
 * so the spot under the pointer stays under it.
 */
export function zoomed(lens: Lens, factor: number, at: { x: number; y: number }): Lens {
  const scale = Math.min(MOST_SCALE, Math.max(LEAST_SCALE, lens.scale * factor));
  if (scale === LEAST_SCALE) return WHOLE;
  const grow = scale / lens.scale;
  return { scale, x: at.x - (at.x - lens.x) * grow, y: at.y - (at.y - lens.y) * grow };
}

/** What one side says beside the other: how much smaller it is, and whether it is newer or bigger. */
export function sideChips(mine: { bytes: number; modified: number; pixels?: number }, other: { bytes: number; modified: number; pixels?: number }, size: (bytes: number) => string) {
  const chips: string[] = [];
  if (mine.bytes < other.bytes) chips.push(`${size(other.bytes - mine.bytes)} smaller`);
  if (mine.modified > other.modified) chips.push("Newer");
  if (mine.pixels !== undefined && other.pixels !== undefined && mine.pixels > other.pixels) chips.push("More pixels");
  return chips;
}
