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
