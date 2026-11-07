import { dropChoices, onFileDrag, setDropTarget, startJob, type DropAction } from "../../api";
import type { MenuItem } from "../../ui/Menu";
import type { FolderView } from "../navigation/folderView";
import { join } from "../navigation/path";

/** A folder under the pointer, and what to mark while it is. */
interface Spot {
  element: HTMLElement;
  folder: string;
  view?: FolderView;
}

const OVER = "data-drop-over";

const ACTION_LABELS: Record<DropAction, string> = {
  move: "Move here",
  copy: "Copy here",
  link: "Create shortcuts here",
};

/** `x` and `y` are physical pixels inside the window. */
function spotAt(x: number, y: number, views: FolderView[]): Spot | undefined {
  const scale = window.devicePixelRatio;
  const under = document.elementFromPoint(x / scale, y / scale);
  const place = under?.closest<HTMLElement>("[data-drop]");
  if (place) return { element: place, folder: place.dataset.drop! };

  const pane = under?.closest<HTMLElement>(".pane");
  const view = views.find((item) => String(item.id) === pane?.dataset.view);
  const path = view?.folder()?.path;
  // A search's rows are from all over, so nothing there says where a drop would land.
  if (!pane || !view || !path || view.query()) return undefined;
  // A folder in the Recycle Bin is deleted, so the bin as a whole takes the drop.
  const row = view.isBin() ? null : under?.closest<HTMLElement>(".file-row[data-folder]");
  const name = row?.querySelector(".file-name")?.textContent;
  return row && name ? { element: row, folder: join(path, name), view } : { element: pane, folder: path, view };
}

/**
 * Follows files dragged over the window. Rust knows what is dragged and the page knows what is
 * under the pointer, so Rust asks here and the job starts from here once they land.
 */
export function followFileDrag(
  views: () => FolderView[],
  report: (failure: unknown) => void,
  showMenu: (x: number, y: number, items: MenuItem[]) => void,
) {
  let shown: Spot | undefined;

  const run = (spot: Spot, action?: DropAction) =>
    startJob({ kind: "drop", folder: spot.folder, action }, spot.view?.id).catch(report);

  /** A right drag asks what to do, in the window's own units. */
  async function ask(spot: Spot, x: number, y: number) {
    const choices = await dropChoices(spot.folder);
    const items: MenuItem[] = choices.map((action) => ({ label: ACTION_LABELS[action], action: () => run(spot, action) }));
    if (items.length === 0) return;
    const scale = window.devicePixelRatio;
    showMenu(x / scale, y / scale, [...items, { label: "Cancel", divider: true }]);
  }

  function aim(spot: Spot | undefined) {
    if (spot?.folder === shown?.folder) return;
    shown?.element.removeAttribute(OVER);
    spot?.element.setAttribute(OVER, "");
    shown = spot;
    setDropTarget(spot?.folder ?? null).catch(console.error);
  }

  return onFileDrag((event) => {
    if (event.kind === "over") return aim(spotAt(event.x, event.y, views()));
    aim(undefined);
    if (event.kind === "leave") return;
    const spot = spotAt(event.x, event.y, views());
    if (spot && event.right) ask(spot, event.x, event.y).catch(report);
    else if (spot) run(spot);
  });
}
