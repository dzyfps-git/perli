import { dropChoices, measureDrop, onFileDrag, setDropTarget, shelveDrop, spaceDown, startJob, type DropAction } from "../../api";
import { setDragging, SHELF, shelve } from "../reach/reach";
import type { MenuItem } from "../../ui/Menu";
import { iconKindOf } from "../filelist/fileKinds";
import { iconTheme } from "../filelist/prefs";
import type { FolderView } from "../navigation/folderView";
import { isBin, join } from "../navigation/path";
import type { DeleteRequest } from "./ConfirmDelete";

/** A folder under the pointer, and what to mark while it is. */
interface Spot {
  element: HTMLElement;
  folder: string;
  view?: FolderView;
  /** The pane a place inside it, such as a folder in column view, opens in when a drag rests there. */
  pane?: FolderView;
}

const OVER = "data-drop-over";
/** The most the deck leans, in degrees, however fast the pointer goes. */
const MOST_LEAN = 18;
/** Degrees of lean for each pixel the pointer moves in a millisecond. */
const LEAN_PER_SPEED = 14;
const LAND_MS = 220;
/** How long a drag rests on a folder row or a tab before it opens. */
export const OPEN_MS = 700;
const OPENING = "data-drop-opening";
/**
 * What a drag resting on it opens: folder rows, tabs, and the places that stand for a folder.
 * Crumbs in the path bar wait for the user's word.
 */
const SPRINGS = ".file-row, .tab:not(.tab-active), .place, .bookmark, .home-page [data-drop], .folder-column-list [data-drop]";
/** How often Space is asked about while a drag rests on something that opens. */
const SPACE_POLL_MS = 60;
/** How near an edge, in page pixels, a drag starts to scroll what it is over. */
const EDGE = 48;
/** The most a list scrolls in a frame, right at its edge. */
const MOST_STEP = 22;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

/**
 * The files being dragged, as a small tilted deck that follows the pointer over Perli: the first
 * file's icon on top, and how many there are. It leans the way it is pulled, by how fast.
 */
function createDeck() {
  let deck: HTMLElement | undefined;
  let last: { x: number; time: number } | undefined;
  let lean = 0;

  function show(count: number, name: string, folder: boolean) {
    hide();
    deck = document.createElement("div");
    deck.className = "drag-deck";
    deck.setAttribute("aria-hidden", "true");
    deck.hidden = true;
    for (const card of ["drag-card drag-card-3", "drag-card drag-card-2", "drag-card"].slice(count > 2 ? 0 : count > 1 ? 1 : 2)) {
      const element = document.createElement("span");
      element.className = card;
      deck.append(element);
    }
    const icon = document.createElement("span");
    icon.className = "file-icon";
    icon.dataset.kind = iconKindOf(name, folder, iconTheme().extensions);
    deck.lastElementChild!.append(icon);
    if (count > 1) {
      const badge = document.createElement("span");
      badge.className = "drag-count";
      badge.textContent = count > 999 ? "999+" : String(count);
      deck.append(badge);
    }
    document.body.append(deck);
    last = undefined;
    lean = 0;
  }

  /** `x` and `y` are in the page's own units. */
  function move(x: number, y: number) {
    if (!deck) return;
    const time = performance.now();
    if (last && time > last.time && !reducedMotion.matches) {
      const wanted = Math.max(-MOST_LEAN, Math.min(MOST_LEAN, ((x - last.x) / (time - last.time)) * LEAN_PER_SPEED));
      // Eased, so one quick jerk of the pointer does not snap the deck over.
      lean += (wanted - lean) * 0.25;
    }
    last = { x, time };
    deck.hidden = false;
    deck.style.translate = `${x}px ${y}px`;
    deck.style.rotate = `${lean}deg`;
  }

  function hide(landed = false) {
    const gone = deck;
    deck = undefined;
    if (!gone) return;
    if (!landed || gone.hidden || reducedMotion.matches) return gone.remove();
    // The deck drops onto where it was let go, and is gone.
    gone
      .animate({ scale: [1, 0.6], opacity: [1, 0], rotate: [gone.style.rotate, "0deg"] }, { duration: LAND_MS, easing: "ease-in" })
      .finished.catch(() => undefined)
      .finally(() => gone.remove());
  }

  /** What letting go would do, as a word under the deck. Nothing shows where nothing would happen. */
  function effect(action: DropAction | null | undefined, folder: string | undefined) {
    if (!deck) return;
    let badge = deck.querySelector<HTMLElement>(".drag-effect");
    // Perli's own places only keep the files, and they say so themselves.
    if (!action || !folder || folder.startsWith("perli:")) return badge?.remove();
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "drag-effect";
      deck.append(badge);
    }
    const shown = action === "delete" ? action : isBin(folder) ? "bin" : action;
    badge.dataset.effect = shown;
    badge.textContent = EFFECT_LABELS[shown];
  }

  return { show, move, hide, effect };
}

/** Scrolls the list, strip or panel a drag is over while the pointer is near its edge, faster nearer. */
function createEdgeScroll() {
  let at: { x: number; y: number } | undefined;
  let frame = 0;
  const speed = (into: number) => Math.round(MOST_STEP * Math.max(0, Math.min(1, (EDGE - into) / EDGE)) ** 2);
  const scrolls = (overflow: string, size: number, room: number) => /auto|scroll/.test(overflow) && size > room + 1;

  function step() {
    frame = 0;
    if (!at) return;
    // The nearest thing that scrolls, from what is under the pointer outward.
    for (let box = document.elementFromPoint(at.x, at.y); box; box = box.parentElement) {
      const style = getComputedStyle(box);
      const down = scrolls(style.overflowY, box.scrollHeight, box.clientHeight);
      const across = scrolls(style.overflowX, box.scrollWidth, box.clientWidth);
      if (!down && !across) continue;
      const edge = box.getBoundingClientRect();
      const dy = down ? speed(edge.bottom - at.y) - speed(at.y - edge.top) : 0;
      const dx = across ? speed(edge.right - at.x) - speed(at.x - edge.left) : 0;
      const before = [box.scrollLeft, box.scrollTop];
      box.scrollBy(dx, dy);
      // It goes on by itself, since a pointer resting by the edge sends nothing new.
      if (box.scrollLeft !== before[0] || box.scrollTop !== before[1]) frame = requestAnimationFrame(step);
      return;
    }
  }

  return {
    /** `x` and `y` are in the page's own units. */
    aim(x: number, y: number) {
      at = { x, y };
      if (!frame) frame = requestAnimationFrame(step);
    },
    stop() {
      at = undefined;
      cancelAnimationFrame(frame);
      frame = 0;
    },
  };
}

const EFFECT_LABELS: Record<DropAction | "bin", string> = {
  move: "Move",
  copy: "Copy",
  link: "Shortcut",
  bin: "Recycle",
  delete: "Delete for good",
};

const ACTION_LABELS: Record<DropAction, string> = {
  move: "Move here",
  copy: "Copy here",
  link: "Create shortcuts here",
  delete: "Delete for good",
};

/** `x` and `y` are physical pixels inside the window. */
function spotAt(x: number, y: number, views: FolderView[]): Spot | undefined {
  const scale = window.devicePixelRatio;
  const under = document.elementFromPoint(x / scale, y / scale);
  const pane = under?.closest<HTMLElement>(".pane");
  const view = views.find((item) => String(item.id) === pane?.dataset.view);
  const place = under?.closest<HTMLElement>("[data-drop]");
  if (place) return { element: place, folder: place.dataset.drop!, pane: pane?.contains(place) ? view : undefined };

  const path = view?.folder()?.path;
  // A search's rows are from all over, so nothing there says where a drop would land.
  if (!pane || !view || !path || view.query() || view.isZip()) return undefined;
  // A folder in the Recycle Bin is deleted, so the bin as a whole takes the drop.
  const row = view.isBin() ? null : under?.closest<HTMLElement>(".file-row[data-folder]");
  const name = row?.querySelector(".file-name")?.textContent;
  // A folder opened in place has its rows under it, and each says where it is.
  return row && name ? { element: row, folder: join(row.dataset.location || path, name), view } : { element: pane, folder: path, view };
}

/**
 * Follows files dragged over the window. Rust knows what is dragged and the page knows what is
 * under the pointer, so Rust asks here and the job starts from here once they land.
 */
export function followFileDrag(
  views: () => FolderView[],
  report: (failure: unknown) => void,
  showMenu: (x: number, y: number, items: MenuItem[]) => void,
  /** Files landed on `place`, one of Perli's own that is no folder. Nothing moved. */
  noted: (place: string, paths: string[]) => void,
  /** A drag rested on a place that stands for `folder`, such as one in the sidebar. */
  openPlace: (folder: string) => void,
  /** Shift on the Recycle Bin asks first, as Shift+Delete does. */
  confirmDelete: (request: DeleteRequest) => void,
) {
  let shown: Spot | undefined;
  let opening: { element: HTMLElement; folder: string; timer: number; poll: number } | undefined;
  /** Space opens at once, and must be let go before it opens the next one. */
  let spaceHeld = false;
  const deck = createDeck();
  const edges = createEdgeScroll();

  /** `id` names the drop, so an answer that comes late never takes a newer one. */
  const run = (spot: Spot, id: number, action?: DropAction) =>
    startJob({ kind: "drop", folder: spot.folder, action, id }, spot.view?.id).catch(report);

  /** A right drag asks what to do, in the window's own units. */
  async function ask(spot: Spot, id: number, x: number, y: number) {
    const choices = await dropChoices(spot.folder);
    const items: MenuItem[] = choices.map((action) => ({ label: ACTION_LABELS[action], action: () => run(spot, id, action) }));
    if (items.length === 0) return;
    const scale = window.devicePixelRatio;
    showMenu(x / scale, y / scale, [...items, { label: "Cancel", divider: true }]);
  }

  function aim(spot: Spot | undefined) {
    // A folder that opened under the pointer leaves the same folder on a new element.
    if (spot?.element !== shown?.element) {
      shown?.element.removeAttribute(OVER);
      spot?.element.setAttribute(OVER, "");
    }
    const moved = spot?.folder !== shown?.folder;
    shown = spot;
    if (moved) setDropTarget(spot?.folder ?? null).catch(console.error);
    rest(spot);
  }

  function stopOpening() {
    if (!opening) return;
    clearTimeout(opening.timer);
    clearInterval(opening.poll);
    opening.element.removeAttribute(OPENING);
    opening = undefined;
  }

  /**
   * A drag that rests on a folder row or a place opens it, and on a tab shows that tab, as
   * Explorer does. A ring fills while it waits, and Space opens it at once.
   */
  function rest(spot: Spot | undefined) {
    if (opening && opening.element === spot?.element && opening.folder === spot.folder) return;
    stopOpening();
    const element = spot?.element;
    if (!spot || !element || spot.folder.startsWith("perli:") || !element.matches(SPRINGS)) return;
    if (element.matches(".file-row") && !spot.view) return;
    const open = () => {
      stopOpening();
      if (element.matches(".tab")) element.click();
      else if (spot.view && element.matches(".file-row")) spot.view.open(spot.folder);
      else if (spot.pane) spot.pane.open(spot.folder);
      else openPlace(spot.folder);
    };
    element.setAttribute(OPENING, "");
    const poll = window.setInterval(() => {
      spaceDown()
        .then((down) => {
          if (down && !spaceHeld && opening?.element === element) open();
          spaceHeld = down;
        })
        .catch(() => undefined);
    }, SPACE_POLL_MS);
    opening = { element, folder: spot.folder, timer: window.setTimeout(open, OPEN_MS), poll };
  }

  /** The shelf and its like keep the files where they are, and only remember them. */
  const note = (place: string) =>
    shelveDrop()
      .then((paths) => (place === SHELF ? shelve(paths) : noted(place, paths)))
      .catch(report);

  return onFileDrag((event) => {
    // Found before the drag ends, which takes away the chips and bars that only show during one.
    const landed = event.kind === "drop" ? spotAt(event.x, event.y, views()) : undefined;
    setDragging(event.kind === "enter" || event.kind === "over");
    if (event.kind === "enter") return deck.show(event.count, event.name, event.folder);
    if (event.kind === "over") {
      deck.move(event.x / window.devicePixelRatio, event.y / window.devicePixelRatio);
      edges.aim(event.x / window.devicePixelRatio, event.y / window.devicePixelRatio);
      const spot = spotAt(event.x, event.y, views());
      aim(spot);
      return deck.effect(event.effect, spot?.folder);
    }
    aim(undefined);
    edges.stop();
    spaceHeld = false;
    deck.hide(event.kind === "drop");
    if (event.kind === "leave") return;
    const spot = landed;
    if (spot?.folder.startsWith("perli:")) note(spot.folder);
    else if (spot && event.right) ask(spot, event.id, event.x, event.y).catch(report);
    else if (spot && event.forGood)
      confirmDelete({
        title: "Delete permanently?",
        measure: () => measureDrop(event.id),
        confirm: () => void run(spot, event.id, "delete"),
      });
    else if (spot) run(spot, event.id);
  });
}
