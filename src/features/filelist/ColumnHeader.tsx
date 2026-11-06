import { createMemo, Index } from "solid-js";
import type { Sort, SortKey } from "../../api";
import { dragTarget, MIN_COLUMN_WIDTH, type Column } from "./columns";
import { columns, moveColumn, setColumnWidth } from "./prefs";

const ICON_ASCENDING = "";
const ICON_DESCENDING = "";

const DRAG_START_PX = 5;

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
  ref: (element: HTMLDivElement) => void;
  sort: Sort;
  onSort: (key: SortKey) => void;
  onMenu: (event: MouseEvent) => void;
}) {
  const visible = createMemo(() => columns().filter((column) => column.visible));
  let header!: HTMLDivElement;
  let dragged = false;

  function dragTo(id: SortKey, x: number) {
    const middles = [...header.children].map((title) => {
      const { left, width } = title.getBoundingClientRect();
      return left + width / 2;
    });
    const titles = visible();
    const target = titles[dragTarget(middles, titles.findIndex((column) => column.id === id), x)];
    if (target) moveColumn(id, target.id);
  }

  function startDrag(event: PointerEvent, id: SortKey) {
    dragged = false;
    if (id === "name" || event.button !== 0) return;
    const button = event.currentTarget as HTMLElement;
    const startX = event.clientX;
    const move = (moved: PointerEvent) => {
      dragged ||= Math.abs(moved.clientX - startX) >= DRAG_START_PX;
      header.toggleAttribute("data-dragging", dragged);
      if (dragged) dragTo(id, moved.clientX);
    };

    button.setPointerCapture(event.pointerId);
    button.addEventListener("pointermove", move);
    button.addEventListener(
      "lostpointercapture",
      () => {
        button.removeEventListener("pointermove", move);
        header.removeAttribute("data-dragging");
      },
      { once: true },
    );
  }

  return (
    <div
      ref={(element) => {
        header = element;
        props.ref(element);
      }}
      class="column-header"
      role="group"
      aria-label="Columns"
      onContextMenu={props.onMenu}
    >
      {/* Index keeps each title in place during a resize, which would lose the drag otherwise. */}
      <Index each={visible()}>
        {(column) => (
          <div class="column-title" classList={{ "column-size": column().id === "size" }}>
            <button
              class="column-button"
              onPointerDown={(event) => startDrag(event, column().id)}
              onClick={() => dragged || props.onSort(column().id)}
            >
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
