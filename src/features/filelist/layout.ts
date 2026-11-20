export type Layout = "list" | "grid" | "gallery" | "columns";

export const TILE_STEP = 16;
export const MIN_TILE = 80;
export const MAX_TILE = 400;

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

/** The last of `length` things whose `edge` is at or before `at`, for edges that only grow. */
function lastAtOrBefore(length: number, at: number, edge: (index: number) => number) {
  let [low, high] = [0, length - 1];
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (edge(middle) <= at) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** Which group a row or a height is in, and where a group's header shows. A folded group starts
 *  where the next one does, so the one with rows always comes last. */
function headed(groups: Gathered[], tops: number[], header: number) {
  return {
    tops,
    groupOf: (index: number) => lastAtOrBefore(groups.length, index, (at) => groups[at].start),
    groupAt: (y: number) => lastAtOrBefore(groups.length, y, (at) => tops[at]),
    /** Where a group's header shows: in its place, or held at the top of the view while its rows
     *  scroll under it, until the next header pushes it off. */
    headerTop(at: number, scrolled: number) {
      const next = at + 1 < tops.length ? tops[at + 1] - header : Infinity;
      return Math.max(tops[at], Math.min(scrolled, next));
    },
  };
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
  const { groupOf, groupAt, headerTop } = headed(groups, tops, header);

  return {
    height: groups.length > 0 ? bottom : Math.ceil(count / perRow) * item,
    tops,
    groupOf,
    groupAt,
    headerTop,
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
  };
}

export type Places = ReturnType<typeof placesOf>;

/** The room between pictures in the gallery, across and down. */
export const GALLERY_GAP = 4;
/** How much wider than tall, or taller than wide, a gallery picture shows at most. Past it, it
 *  crops, so one panorama never makes a line too thin to see. */
const MOST_ASPECT = 3;

/**
 * Where pictures sit in a gallery: lines as wide as `width`, each picture keeping its shape, the
 * lines about `target` tall. A line takes pictures until it would be shorter than `target`, or
 * stops one early when that comes closer. The last line of a group keeps `target` and stays
 * short. `aspectOf` is how wide a row shows for its height.
 */
export function justifiedPlaces(
  groups: Gathered[],
  count: number,
  aspectOf: (index: number) => number,
  width: number,
  target: number,
  gap: number,
  header: number,
) {
  const room = Math.max(width, 1);
  const aspect = (index: number) => Math.min(MOST_ASPECT, Math.max(1 / MOST_ASPECT, aspectOf(index) || 1));
  const xs = new Float64Array(count);
  const widths = new Float64Array(count);
  const lineOf = new Int32Array(count);
  const lines: { start: number; end: number; top: number; height: number }[] = [];
  const tops: number[] = [];
  let bottom = 0;

  function lay(from: number, to: number) {
    let start = from;
    while (start < to) {
      let [end, sum, height] = [start, 0, target];
      while (end < to) {
        const before = sum > 0 ? (room - gap * (end - start - 1)) / sum : Infinity;
        sum += aspect(end++);
        const fit = (room - gap * (end - start - 1)) / sum;
        if (fit > target) continue;
        // One picture fewer leaves a line taller than `target`, and that may be closer.
        const fewer = end - start > 1 && target / fit > before / target;
        if (fewer) sum -= aspect(--end);
        height = fewer ? before : fit;
        break;
      }
      let x = 0;
      for (let index = start; index < end; index++) {
        xs[index] = x;
        widths[index] = aspect(index) * height;
        lineOf[index] = lines.length;
        x += widths[index] + gap;
      }
      lines.push({ start, end, top: bottom, height });
      bottom += height + gap;
      start = end;
    }
  }

  if (groups.length === 0) lay(0, count);
  for (const group of groups) {
    tops.push(bottom);
    bottom += header;
    lay(group.start, group.start + group.count);
  }
  const lineAt = (y: number) => lastAtOrBefore(lines.length, y, (at) => lines[at].top);

  return {
    height: Math.max(0, bottom - (lines.length > 0 ? gap : 0)),
    ...headed(groups, tops, header),
    top: (index: number) => lines[lineOf[index]]?.top ?? 0,
    column: (_index: number) => 0,
    x: (index: number) => xs[index] ?? 0,
    width: (index: number) => widths[index] ?? target,
    lineHeight: (index: number) => lines[lineOf[index]]?.height ?? target,
    /** The first row whose line ends below `y`. */
    firstAt(y: number) {
      if (lines.length === 0) return 0;
      const at = lineAt(y);
      const line = lines[at];
      return line.top + line.height > y ? line.start : (lines[at + 1]?.start ?? count);
    },
    /** The row `by` lines up or down from `index` whose middle is nearest across, for Up and
     *  Down and the page keys. Stays put on the first or last line. */
    nearest(index: number, by: number) {
      const line = lines[Math.min(lines.length - 1, Math.max(0, lineOf[index] + by))];
      if (!line || index < 0) return index;
      const middle = xs[index] + widths[index] / 2;
      const off = (other: number) => Math.abs(xs[other] + widths[other] / 2 - middle);
      let best = line.start;
      for (let other = line.start; other < line.end; other++) if (off(other) < off(best)) best = other;
      return best;
    },
    /** The most rows that can be in sight at once in a view `span` tall, for the pool of rows. */
    most(span: number) {
      let [most, last] = [0, 0];
      for (let first = 0; first < lines.length; first++) {
        const reach = lines[first].top + lines[first].height + span;
        last = Math.max(last, first);
        while (last + 1 < lines.length && lines[last + 1].top < reach) last++;
        most = Math.max(most, lines[last].end - lines[first].start);
      }
      return most;
    },
  };
}

export type Gallery = ReturnType<typeof justifiedPlaces>;

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
