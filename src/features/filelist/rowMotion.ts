/** Rows that stay glide to their new places, new ones spring in and gone ones leave in their own
 *  way, when a folder's rows change under the user's eyes. */

import { baseName, BIN_PATH, parentOf } from "../navigation/path";

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
let backAt = -Infinity;

/** A delete to the Recycle Bin has started, so the rows that go next fold shut and send a wisp. */
export function markDeleted() {
  deletedAt = performance.now();
}

/** An undo has started, so the rows that come next glide back into place rather than spring in. */
export function markBack() {
  backAt = performance.now();
}

/** Archives whose files are being taken out, by row key, with when their show ends. */
const unpacking = new Map<string, number>();
const FAN_MS = 620;
const FAN_TURN_DEG = 4;
/** After this many, the rest of the files fan out together. */
const MOST_FANNED = 12;

/**
 * Files are being taken out of `archives`, so rows that come next fan out from the archive's row
 * while the job runs. The answer ends the show a little after the job.
 */
export function markUnpacking(archives: string[]) {
  // The key a row goes by: the folder it is listed in and its name. Case tells none apart on Windows.
  const keys = archives.map((path) => `${parentOf(path) ?? ""}|${baseName(path)}`.toLowerCase());
  for (const key of keys) unpacking.set(key, Infinity);
  return () => {
    for (const key of keys) unpacking.set(key, performance.now() + DELETE_WINDOW_MS);
  };
}

/** The row on screen of an archive being taken apart, if any. */
function unpackingRow(rows: [string, HTMLElement][]) {
  const now = performance.now();
  for (const [key, until] of unpacking) if (until < now) unpacking.delete(key);
  if (unpacking.size === 0) return undefined;
  return rows.find(([key]) => unpacking.has(key.toLowerCase()))?.[1];
}

/** A file just taken out flies from its archive's row to its own place, turning a little as it goes, like a dealt card. */
function fanOut(element: HTMLElement, from: DOMRect, order: number, spring: string) {
  const { top, left } = element.getBoundingClientRect();
  const turn = `${order % 2 === 0 ? -FAN_TURN_DEG : FAN_TURN_DEG}deg`;
  const delay = Math.min(order, MOST_FANNED) * 45;
  element.animate(
    [
      { translate: `${from.left - left}px ${from.top - top}px`, scale: 0.7, rotate: turn, opacity: 0 },
      { opacity: 1, offset: 0.2 },
      { translate: "0 0", scale: 1, rotate: "0deg", opacity: 1 },
    ],
    { duration: FAN_MS, delay, easing: spring, fill: "backwards" },
  );
  // Landed, it glows softly for a moment, so the eye finds what came out.
  element.animate(
    { backgroundColor: ["color-mix(in srgb, var(--accent) 22%, transparent)", "transparent"] },
    { duration: 900, delay: delay + FAN_MS * 0.6, easing: "ease-out" },
  );
}

/** A row coming back from an undo slides in from the side it left by, fading up. */
const BACK_FRAMES: Keyframe[] = [
  { translate: `${-DRIFT_PX * 2}px 0`, opacity: 0 },
  { translate: "0 0", opacity: 1 },
];

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
  /** How far the list scrolled in between, so a row that kept its place in the list stays put. */
  scrolled = 0,
  /** The list's bottom edge on screen, when rows went: rows new to the screen came from past it. */
  edge?: number,
) {
  const spring = getComputedStyle(document.documentElement).getPropertyValue("--spring").trim() || "ease-out";
  const deleted = performance.now() - deletedAt < DELETE_WINDOW_MS;
  const back = performance.now() - backAt < DELETE_WINDOW_MS;
  const { frames, duration } = LEAVES[deleted ? "fold" : back ? "drift" : leave];
  let arrived = 0;
  const here = new Set<string>();
  const archive = unpackingRow(after);
  const from = archive?.getBoundingClientRect();
  let fanned = 0;
  for (const [key, element] of after) {
    here.add(key);
    const seenBefore = before.get(key);
    const was = seenBefore && { top: seenBefore.top - scrolled, left: seenBefore.left };
    if (!was && from) {
      fanOut(element, from, fanned++, spring);
      continue;
    }
    if (!was && edge !== undefined && !back) {
      // Closing ranks after rows went, so it was there all along, just out of sight below.
      const { top } = element.getBoundingClientRect();
      element.animate({ translate: [`0 ${Math.max(edge - top, 0)}px`, "0 0"] }, { duration: MOVE_MS, easing: "cubic-bezier(0.3, 1.1, 0.5, 1)" });
      continue;
    }
    if (!was) {
      // Back rows come one after another, so the eye can follow them home.
      if (back) element.animate(BACK_FRAMES, { duration: ARRIVE_MS, delay: Math.min(arrived++, 8) * 40, easing: spring, fill: "backwards" });
      else if (!quiet) element.animate({ scale: [0.85, 1], opacity: [0, 1] }, { duration: ARRIVE_MS, easing: spring });
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
  // The archive gives a small puff as its files leave it.
  if (archive && fanned > 0) archive.animate({ scale: [1, 1.05, 0.98, 1] }, { duration: 420, easing: "ease-out" });
  // One delete, one show: a reload that follows for another reason shrinks as usual.
  if (deleted && wisps > 0) deletedAt = -Infinity;
  if (back && arrived > 0) backAt = -Infinity;
}
