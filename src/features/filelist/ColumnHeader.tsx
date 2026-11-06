import { createMemo, Index } from "solid-js";
import type { Sort, SortKey } from "../../api";
import { MIN_COLUMN_WIDTH, type Column } from "./columns";
import { columns, setColumnWidth } from "./prefs";

const ICON_ASCENDING = "";
const ICON_DESCENDING = "";

/** The name column flexes, so every other column resizes from its left edge. */
function startResize(event: PointerEvent, column: Column) {
  event.preventDefault();
  const handle = event.currentTarget as HTMLElement;
  const startX = event.clientX;
  const move = (moved: PointerEvent) =>
    setColumnWidth(column.id, Math.max(MIN_COLUMN_WIDTH, column.width + startX - moved.clientX));

  handle.setPointerCapture(event.pointerId);
  handle.addEventListener("pointermove", move);
  handle.addEventListener("lostpointercapture", () => handle.removeEventListener("pointermove", move), {
    once: true,
  });
}

export function ColumnHeader(props: {
  sort: Sort;
  onSort: (key: SortKey) => void;
  onMenu: (event: MouseEvent) => void;
}) {
  const visible = createMemo(() => columns().filter((column) => column.visible));

  return (
    <div class="column-header" role="group" aria-label="Columns" onContextMenu={props.onMenu}>
      {/* Index keeps each title in place during a resize, which would lose the drag otherwise. */}
      <Index each={visible()}>
        {(column) => (
          <div class="column-title" classList={{ "column-size": column().id === "size" }}>
            <button class="column-button" onClick={() => props.onSort(column().id)}>
              {column().label}
              <span class="column-arrow" hidden={props.sort.key !== column().id}>
                {props.sort.descending ? ICON_DESCENDING : ICON_ASCENDING}
              </span>
            </button>
            {column().id !== "name" && (
              <div
                class="column-resize"
                role="presentation"
                onPointerDown={(event) => startResize(event, column())}
              />
            )}
          </div>
        )}
      </Index>
    </div>
  );
}
