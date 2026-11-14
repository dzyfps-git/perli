/** Pure tab order rules, kept apart from Solid so they can be tested alone. */

/** Which tab becomes active when `closing` closes: the next one, otherwise the previous. */
export function nextActive<T>(tabs: T[], closing: T, active: T) {
  if (closing !== active) return active;
  const index = tabs.indexOf(closing);
  return tabs[index + 1] ?? tabs[index - 1];
}

/** Moves `tab` by `offset` places and stops at the ends. */
export function moved<T>(tabs: T[], tab: T, offset: number) {
  const from = tabs.indexOf(tab);
  const to = Math.min(tabs.length - 1, Math.max(0, from + offset));
  const result = tabs.filter((other) => other !== tab);
  result.splice(to, 0, tab);
  return result;
}

/** Pinned tabs first. Each group keeps its own order. */
export function pinnedFirst<T>(tabs: T[], pinned: (tab: T) => boolean) {
  return [...tabs.filter(pinned), ...tabs.filter((tab) => !pinned(tab))];
}

/** The pane beside `pane`, if the tab has two. */
export function otherPane<T>(panes: T[], pane: T) {
  return panes.find((other) => other !== pane);
}

/** The tab `offset` places away, wrapping around the ends. */
export function cycled<T>(tabs: T[], active: T, offset: number) {
  const index = tabs.indexOf(active);
  return tabs[(index + offset + tabs.length) % tabs.length];
}

/** A new split's first pane takes half. */
export const EVEN_SPLIT = 0.5;
/** Neither pane gets less than a fifth. */
export const SPLIT_MIN = 0.2;
export const SPLIT_MAX = 0.8;
/** Where a dragged divider settles when it comes this near. */
export const SPLIT_SNAPS = [1 / 3, EVEN_SPLIT, 2 / 3];
const SNAP_REACH = 0.025;

/** The first pane's share for a divider let go at `share`: kept in bounds, and drawn to a snap. */
export function snapped(share: number) {
  const kept = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, share));
  return SPLIT_SNAPS.find((snap) => Math.abs(snap - kept) < SNAP_REACH) ?? kept;
}

/** A point, a size and a box on the screens, in physical pixels. */
export interface Point {
  x: number;
  y: number;
}
export interface Size {
  width: number;
  height: number;
}
export type Box = Point & Size;

/** A tab let go this near a screen's side takes that half of it, and near its top, all of it. */
const SNAP_EDGE = 8;
/** How much of a new window stays on its screen, so its tabs can still be reached. */
const KEEP_SEEN = 120;

/**
 * Where a window for a tab let go at `at` goes, on a screen whose work area is `work`, at
 * `scale`. It keeps `size`, and puts the tab under the pointer where `grab` held it.
 */
export function placeFor(at: Point, work: Box, size: Size, grab: Point, scale: number): Box & { maximized?: boolean } {
  const edge = SNAP_EDGE * scale;
  const half = Math.round(work.width / 2);
  if (at.x <= work.x + edge) return { x: work.x, y: work.y, width: half, height: work.height };
  if (at.x >= work.x + work.width - edge) return { x: work.x + work.width - half, y: work.y, width: half, height: work.height };
  const keep = KEEP_SEEN * scale;
  const within = (value: number, low: number, high: number) => Math.round(Math.min(Math.max(value, low), high));
  return {
    x: within(at.x - grab.x, work.x + keep - size.width, work.x + work.width - keep),
    y: within(at.y - grab.y, work.y, work.y + work.height - keep),
    ...size,
    ...(at.y <= work.y + edge ? { maximized: true } : {}),
  };
}
