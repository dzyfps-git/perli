import { onFileDrag, setDropTarget, startJob } from "../../api";
import type { FolderView } from "../navigation/folderView";
import { join } from "../navigation/path";

/** A folder under the pointer, and what to mark while it is. */
interface Spot {
  element: HTMLElement;
  folder: string;
  view?: FolderView;
}

const OVER = "data-drop-over";

/** `x` and `y` are physical pixels inside the window. */
function spotAt(x: number, y: number, views: FolderView[]): Spot | undefined {
  const scale = window.devicePixelRatio;
  const under = document.elementFromPoint(x / scale, y / scale);
  const place = under?.closest<HTMLElement>("[data-drop]");
  if (place) return { element: place, folder: place.dataset.drop! };

  const pane = under?.closest<HTMLElement>(".pane");
  const view = views.find((item) => String(item.id) === pane?.dataset.view);
  const path = view?.folder()?.path;
  if (!pane || !view || !path || view.isBin()) return undefined;
  const row = under?.closest<HTMLElement>(".file-row[data-folder]");
  const name = row?.querySelector(".file-name")?.textContent;
  return row && name ? { element: row, folder: join(path, name), view } : { element: pane, folder: path, view };
}

/**
 * Follows files dragged over the window. Rust knows what is dragged and the page knows what is
 * under the pointer, so Rust asks here and the job starts from here once they land.
 */
export function followFileDrag(views: () => FolderView[], report: (failure: unknown) => void) {
  let shown: Spot | undefined;

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
    const spot = event.kind === "drop" ? spotAt(event.x, event.y, views()) : undefined;
    if (spot) startJob({ kind: "drop", folder: spot.folder }, spot.view?.id).catch(report);
  });
}
