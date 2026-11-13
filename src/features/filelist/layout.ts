export type Layout = "list" | "grid";

export const TILE_STEP = 16;
export const MIN_TILE = 80;
export const MAX_TILE = 240;

export const clampTile = (size: number) => Math.min(MAX_TILE, Math.max(MIN_TILE, size));
export const isSmallestTile = (size: number) => size <= MIN_TILE;
export const isLargestTile = (size: number) => size >= MAX_TILE;

export interface Shape {
  count: number;
  perRow: number;
  pageRows: number;
}

/** Where a movement key lands from `focused`, or undefined when it is not a move. */
export function moveTarget(key: string, focused: number, { count, perRow, pageRows }: Shape) {
  const last = count - 1;
  const clamp = (index: number) => Math.min(last, Math.max(0, index));
  const rowOf = (index: number) => Math.floor(index / perRow);
  const sideways = key === "ArrowLeft" || key === "ArrowRight";

  if (key === "Home") return 0;
  if (key === "End") return last;
  if (sideways && perRow === 1) return undefined;
  if (focused < 0) return key.startsWith("Arrow") || key.startsWith("Page") ? 0 : undefined;

  switch (key) {
    case "ArrowLeft":
      return clamp(focused - 1);
    case "ArrowRight":
      return clamp(focused + 1);
    case "ArrowUp":
      return focused >= perRow ? focused - perRow : focused;
    case "ArrowDown":
      return rowOf(focused) < rowOf(last) ? clamp(focused + perRow) : focused;
    case "PageUp":
      return clamp(focused - pageRows * perRow);
    case "PageDown":
      return clamp(focused + pageRows * perRow);
  }
  return undefined;
}

/**
 * Where a box of `width` by `height` goes beside the point (`x`, `y`): below and to the right,
 * flipped to the other side of the point at a window edge, and never off the window.
 */
export function besidePoint(x: number, y: number, width: number, height: number, window: { width: number; height: number }) {
  const GAP = 16;
  const EDGE = 4;
  const side = (at: number, size: number, room: number) => {
    const after = at + GAP;
    const spot = after + size + EDGE <= room ? after : at - GAP - size;
    return Math.max(EDGE, Math.min(spot, room - size - EDGE));
  };
  return { left: side(x, width, window.width), top: side(y, height, window.height) };
}

/** Rows under one header. Only what the layout needs of `Group` in the API. */
interface Gathered {
  start: number;
  count: number;
}

/**
 * Where rows and headers sit. Each group starts on a line of its own, under a header `header`
 * pixels tall. With no groups, rows simply follow each other in lines of `perRow`.
 */
export function placesOf(groups: Gathered[], count: number, perRow: number, item: number, header: number) {
  const tops: number[] = [];
  let bottom = 0;
  for (const group of groups) {
    tops.push(bottom);
    bottom += header + Math.ceil(group.count / perRow) * item;
  }
  /** The last group whose first line is at or before `at`, by `edge`. A folded group starts where
   *  the next one does, so the one with rows always comes last. */
  const lastAtOrBefore = (at: number, edge: (index: number) => number) => {
    let [low, high] = [0, groups.length - 1];
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (edge(middle) <= at) low = middle;
      else high = middle - 1;
    }
    return low;
  };
  const groupOf = (index: number) => lastAtOrBefore(index, (at) => groups[at].start);
  const groupAt = (y: number) => lastAtOrBefore(y, (at) => tops[at]);

  return {
    height: groups.length > 0 ? bottom : Math.ceil(count / perRow) * item,
    tops,
    groupOf,
    groupAt,
    /** How far down the row's line is. */
    top(index: number) {
      if (groups.length === 0) return Math.floor(index / perRow) * item;
      const at = groupOf(index);
      return tops[at] + header + Math.floor((index - groups[at].start) / perRow) * item;
    },
    /** Which tile of its line the row is. */
    column(index: number) {
      return groups.length === 0 ? index % perRow : (index - groups[groupOf(index)].start) % perRow;
    },
    /** The first row whose line ends below `y`. */
    firstAt(y: number) {
      const line = (from: number) => Math.max(0, Math.floor(from / item));
      if (groups.length === 0) return Math.min(count, line(y) * perRow);
      const at = groupAt(y);
      const { start, count: rows } = groups[at];
      return Math.min(count, start + Math.min(rows, line(y - tops[at] - header) * perRow));
    },
    /** Where a group's header shows: in its place, or held at the top of the view while its rows
     *  scroll under it, until the next header pushes it off. */
    headerTop(at: number, scrolled: number) {
      const next = at + 1 < tops.length ? tops[at + 1] - header : Infinity;
      return Math.max(tops[at], Math.min(scrolled, next));
    },
  };
}

export type Places = ReturnType<typeof placesOf>;

/** Up and Down in a grid of groups, where a line can be short and the next group starts a new
 *  one. Keeps to the same tile of the line where it can. Undefined for any other key. */
export function groupedMove(key: string, focused: number, groups: Gathered[], perRow: number) {
  if ((key !== "ArrowUp" && key !== "ArrowDown") || focused < 0 || groups.length === 0) return undefined;
  let at = -1;
  groups.forEach((group, index) => group.count > 0 && group.start <= focused && (at = index));
  if (at < 0) return undefined;
  const { start, count } = groups[at];
  const column = (focused - start) % perRow;
  const line = Math.floor((focused - start) / perRow);
  const lastLine = Math.floor((count - 1) / perRow);
  if (key === "ArrowUp" && line > 0) return focused - perRow;
  if (key === "ArrowDown" && line < lastLine) return Math.min(focused + perRow, start + count - 1);
  const step = key === "ArrowUp" ? -1 : 1;
  for (let next = at + step; next >= 0 && next < groups.length; next += step) {
    const other = groups[next];
    if (other.count === 0) continue;
    const first = step < 0 ? other.start + Math.floor((other.count - 1) / perRow) * perRow : other.start;
    return Math.min(first + column, other.start + other.count - 1);
  }
  return focused;
}
