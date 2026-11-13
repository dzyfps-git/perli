/** Rows that stay glide to their new places, new ones spring in and gone ones leave in their own
 *  way, when a folder's rows change under the user's eyes. */

import { BIN_PATH } from "../navigation/path";

const MOVE_MS = 300;
const ARRIVE_MS = 600;
const LEAVE_MS = 220;
const FOLD_MS = 260;
const DRIFT_MS = 280;
const DRIFT_PX = 24;
const WISP_MS = 520;
/** More wisps than this would be a swarm. */
const MOST_WISPS = 3;
/** A delete reloads its folder well inside this. */
const DELETE_WINDOW_MS = 3000;

/** How a row that is gone leaves: shrinking away, folding shut, or drifting off to the side. */
export type Leave = "shrink" | "fold" | "drift";

const LEAVES: Record<Leave, { frames: Keyframe[]; duration: number }> = {
  shrink: { frames: [{ scale: 1, opacity: 1 }, { scale: 0.85, opacity: 0 }], duration: LEAVE_MS },
  fold: {
    frames: [
      { clipPath: "inset(0 0 0 0)", opacity: 1 },
      { clipPath: "inset(50% 0 50% 0)", opacity: 0 },
    ],
    duration: FOLD_MS,
  },
  drift: { frames: [{ translate: "0 0", opacity: 1 }, { translate: `${DRIFT_PX}px 0`, opacity: 0 }], duration: DRIFT_MS },
};

let deletedAt = -Infinity;

/** A delete to the Recycle Bin has started, so the rows that go next fold shut and send a wisp. */
export function markDeleted() {
  deletedAt = performance.now();
}

interface Seen {
  top: number;
  left: number;
  /** A copy of the row as it looked, to play its leaving if it goes. */
  ghost?: HTMLElement;
}

/** A copy that looks like the row, pictures and all, but can't be found or clicked. */
function ghostOf(element: HTMLElement) {
  const ghost = element.cloneNode(true) as HTMLElement;
  for (const name of ["id", "role", "aria-rowindex", "aria-selected", "data-focused"]) ghost.removeAttribute(name);
  ghost.dataset.ghost = "";
  ghost.setAttribute("aria-hidden", "true");
  ghost.style.pointerEvents = "none";
  const pictures = element.querySelectorAll("canvas");
  ghost.querySelectorAll("canvas").forEach((copy, at) => {
    // Drawing a canvas with no size throws, and a picture not loaded yet has none.
    if (!pictures[at].width || !pictures[at].height) return;
    copy.width = pictures[at].width;
    copy.height = pictures[at].height;
    copy.getContext("2d")?.drawImage(pictures[at], 0, 0);
  });
  return ghost;
}

/** Where each row on screen is, by its key, before the rows change. Ghosts only when some will go. */
export function seen(rows: [string, HTMLElement][], someGo: boolean) {
  const places = new Map<string, Seen>();
  for (const [key, element] of rows) {
    const { top, left } = element.getBoundingClientRect();
    places.set(key, { top, left, ghost: someGo ? ghostOf(element) : undefined });
  }
  return places;
}

/** A small light that leaves a deleted row and arcs over to the Recycle Bin, which takes it in. */
function sendWisp(from: Seen, order: number) {
  const bin = document.querySelector<HTMLElement>(`.place[data-drop="${BIN_PATH}"] .place-icon`);
  if (!bin) return;
  const to = bin.getBoundingClientRect();
  // The bin may be cut away with the rail's labels, but its icon is always on show.
  if (to.width === 0) return;
  const start = { x: from.left + 28, y: from.top + 14 };
  const end = { x: to.left + to.width / 2, y: to.top + to.height / 2 };
  const middle = { x: (start.x + end.x) / 2, y: Math.min(start.y, end.y) - 40 };
  const wisp = document.createElement("span");
  wisp.className = "wisp";
  document.body.append(wisp);
  const at = ({ x, y }: { x: number; y: number }) => `${x}px ${y}px`;
  wisp
    .animate(
      [
        { translate: at(start), scale: 1, opacity: 0 },
        { translate: at(start), scale: 1, opacity: 1, offset: 0.12 },
        { translate: at(middle), scale: 0.9, opacity: 1, offset: 0.55 },
        { translate: at(end), scale: 0.3, opacity: 0.4 },
      ],
      { duration: WISP_MS, delay: order * 70, easing: "cubic-bezier(0.4, 0, 0.6, 1)", fill: "both" },
    )
    .finished.then(() => {
      // The bin takes the last one in with a small bow.
      if (order === 0) bin.animate({ scale: [1, 1.3, 1] }, { duration: 420, easing: "ease-out" });
    })
    .catch(() => undefined)
    .finally(() => wisp.remove());
}

/**
 * Plays every change from `before` to the rows on screen now. Ghosts go in `layer`. `leave` is
 * how gone rows go, unless a delete just started. `quiet` rows arrive without a spring, for a
 * list that fills as it is searched.
 */
export function playMoves(
  before: Map<string, Seen>,
  after: [string, HTMLElement][],
  layer: HTMLElement,
  leave: Leave = "shrink",
  quiet = false,
) {
  const spring = getComputedStyle(document.documentElement).getPropertyValue("--spring").trim() || "ease-out";
  const deleted = performance.now() - deletedAt < DELETE_WINDOW_MS;
  const { frames, duration } = LEAVES[deleted ? "fold" : leave];
  const here = new Set<string>();
  for (const [key, element] of after) {
    here.add(key);
    const was = before.get(key);
    if (!was) {
      if (!quiet) element.animate({ scale: [0.85, 1], opacity: [0, 1] }, { duration: ARRIVE_MS, easing: spring });
      continue;
    }
    const { top, left } = element.getBoundingClientRect();
    if (top === was.top && left === was.left) continue;
    element.animate(
      { translate: [`${was.left - left}px ${was.top - top}px`, "0 0"] },
      { duration: MOVE_MS, easing: "cubic-bezier(0.3, 1.1, 0.5, 1)" },
    );
  }
  let wisps = 0;
  for (const [key, gone] of before) {
    const { ghost } = gone;
    if (!ghost || here.has(key)) continue;
    layer.append(ghost);
    ghost
      .animate(frames, { duration, easing: "ease-in", fill: "forwards" })
      .finished.then(() => ghost.remove())
      .catch(() => ghost.remove());
    if (deleted && wisps < MOST_WISPS) sendWisp(gone, wisps++);
  }
  // One delete, one show: a reload that follows for another reason shrinks as usual.
  if (deleted && wisps > 0) deletedAt = -Infinity;
}
