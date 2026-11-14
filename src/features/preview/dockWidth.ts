/** The preview pane's width, as its share of the room beside the list. */

export const DOCK_MIN = 0.2;
export const DOCK_MAX = 0.7;
/** Where a dragged edge settles when it comes this near. */
export const DOCK_SNAPS = [1 / 3, 1 / 2];
const SNAP_REACH = 0.025;
/** How far an arrow key moves the edge. */
export const DOCK_STEP = 0.05;
/** Narrower than this when let go, the pane folds shut. */
export const FOLD_PX = 160;

/** The share for an edge left at `share`: kept in bounds, and drawn to a snap. */
export function dockShare(share: number) {
  const kept = Math.min(DOCK_MAX, Math.max(DOCK_MIN, share));
  return DOCK_SNAPS.find((snap) => Math.abs(snap - kept) < SNAP_REACH) ?? kept;
}

/** The share for an edge dragged to `x`, in a room from `left` to `right`, and whether it would fold. */
export function dragged(x: number, left: number, right: number) {
  const width = right - x;
  return { share: dockShare(width / Math.max(1, right - left)), folds: width < FOLD_PX };
}
