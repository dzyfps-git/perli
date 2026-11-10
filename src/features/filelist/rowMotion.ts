/** Rows that stay glide to their new places, new ones spring in and gone ones fold away, when a
 *  folder's rows change under the user's eyes. */

const MOVE_MS = 300;
const ARRIVE_MS = 600;
const LEAVE_MS = 220;

interface Seen {
  top: number;
  left: number;
  /** A copy of the row as it looked, to fold away if it leaves. */
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

/** Plays every change from `before` to the rows on screen now. Ghosts go in `layer`. */
export function playMoves(before: Map<string, Seen>, after: [string, HTMLElement][], layer: HTMLElement) {
  const spring = getComputedStyle(document.documentElement).getPropertyValue("--spring").trim() || "ease-out";
  const here = new Set<string>();
  for (const [key, element] of after) {
    here.add(key);
    const was = before.get(key);
    if (!was) {
      element.animate({ scale: [0.85, 1], opacity: [0, 1] }, { duration: ARRIVE_MS, easing: spring });
      continue;
    }
    const { top, left } = element.getBoundingClientRect();
    if (top === was.top && left === was.left) continue;
    element.animate(
      { translate: [`${was.left - left}px ${was.top - top}px`, "0 0"] },
      { duration: MOVE_MS, easing: "cubic-bezier(0.3, 1.1, 0.5, 1)" },
    );
  }
  for (const [key, { ghost }] of before) {
    if (!ghost || here.has(key)) continue;
    layer.append(ghost);
    ghost
      .animate({ scale: [1, 0.85], opacity: [1, 0] }, { duration: LEAVE_MS, easing: "ease-in", fill: "forwards" })
      .finished.then(() => ghost.remove())
      .catch(() => ghost.remove());
  }
}
