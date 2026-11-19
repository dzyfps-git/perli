import type { Twin } from "../../api";

/**
 * Twins: files with the same content, or pictures that look alike, drawn as small clusters joined
 * by threads. This file holds which one of each set stays and where each set sits.
 */

export interface TwinSet {
  files: Twin[];
  /** Which of `files` stays when the set is cleaned. */
  keep: number;
}

/** The one to keep: the sharpest of pictures that look alike, else the oldest copy, as the original. */
export function keeperOf(files: Twin[]): number {
  let best = 0;
  files.forEach((file, at) => {
    const held = files[best];
    const better = file.sharp !== null && held.sharp !== null ? file.sharp > held.sharp : file.modified < held.modified;
    if (better) best = at;
  });
  return best;
}

export const setsOf = (found: Twin[][]): TwinSet[] => found.filter((files) => files.length > 1).map((files) => ({ files, keep: keeperOf(files) }));

/** The files of a set that go when it is cleaned. */
export const goers = (set: TwinSet) => set.files.filter((_, at) => at !== set.keep);

/** The room cleaning would free. */
export const wasted = (sets: TwinSet[]) => sets.reduce((sum, set) => sum + goers(set).reduce((bytes, file) => bytes + file.bytes, 0), 0);

export const idOf = (path: string) => path.toLowerCase();

/** The sets once the files in `gone` are away. A set left with one file is no longer a set. */
export const without = (sets: TwinSet[], gone: ReadonlySet<string>): TwinSet[] =>
  sets
    .map((set) => {
      const files = set.files.filter((file, at) => at === set.keep || !gone.has(idOf(file.path)));
      return { files, keep: files.indexOf(set.files[set.keep]) };
    })
    .filter((set) => set.files.length > 1);

/** Where a set's files sit: the keeper in the middle-left, the rest around it. */
export interface TwinSpot {
  x: number;
  y: number;
  r: number;
}

/** Each set's room on the stage. */
export const CELL = { width: 190, height: 160 };

/**
 * The sets that fit the stage from `first` on, a cell each in rows, with each file's spot. Copies
 * are as big as their bytes; pictures all show at one size, big enough to tell them apart.
 */
export function twinsLayout(sets: TwinSet[], first: number, width: number, height: number, photos: boolean) {
  const across = Math.max(1, Math.floor(width / CELL.width));
  const down = Math.max(1, Math.floor(height / CELL.height));
  const shown = sets.slice(first, first + across * down);
  const most = Math.max(1, ...shown.flatMap((set) => set.files.map((file) => file.bytes)));
  const spots = new Map<string, TwinSpot>();
  const gapX = (width - across * CELL.width) / 2;
  const gapY = (height - Math.ceil(shown.length / across) * CELL.height) / 2;
  shown.forEach((set, at) => {
    const middle = { x: gapX + (at % across + 0.5) * CELL.width, y: Math.max(0, gapY) + (Math.floor(at / across) + 0.42) * CELL.height };
    const count = set.files.length;
    const size = (file: Twin) => (photos ? (count > 4 ? 18 : 24) : 5 + 13 * Math.sqrt(file.bytes / most));
    // The keeper sits in the middle and the rest on a ring around it, or side by side for a pair.
    const order = [set.keep, ...set.files.map((_, index) => index).filter((index) => index !== set.keep)];
    order.forEach((index, place) => {
      const file = set.files[index];
      let x = middle.x;
      let y = middle.y;
      if (count === 2) {
        x += place === 0 ? -30 : 30;
      } else if (place > 0) {
        const angle = -Math.PI / 2 + ((place - 1) / (count - 1)) * Math.PI * 2;
        const ring = photos ? 50 : 40;
        x += Math.cos(angle) * ring;
        y += Math.sin(angle) * ring * 0.78;
      }
      spots.set(idOf(file.path), { x, y, r: size(file) });
    });
  });
  return { shown, spots, across, down, left: Math.max(0, sets.length - first - shown.length) };
}
