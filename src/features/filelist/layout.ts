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
