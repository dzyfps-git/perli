import { createMemo, createSignal, For, Index, Show } from "solid-js";
import type { Grouping, Sort } from "../../api";
import { dragTarget, MIN_COLUMN_WIDTH, type Column, type ColumnId, type ColumnSet } from "./columns";
import { MAX_TILE, MIN_TILE, TILE_STEP } from "./layout";
import { grouping, moveColumn, setColumnWidth, setTileSize, tileSize, toggleColumn } from "./prefs";

const ICON_ASCENDING = "";
const ICON_DESCENDING = "";

const ICON_ADD = "\uE710";
const ICON_DONE = "\uE73E";
const ICON_REMOVE = "\uE711";

const GROUPING: Record<Grouping, { icon: string; label: string }> = {
  foldersFirst: { icon: "\uE8B7", label: "Folders first" },
  filesFirst: { icon: "\uE8A5", label: "Files first" },
  mixed: { icon: "\uE8CB", label: "Mixed" },
};

const DRAG_START_PX = 5;

/** Stays out of the way until the pointer is near, unless it is showing a changed setting. */
function GroupToggle(props: { onChange: () => void }) {
  const current = () => GROUPING[grouping()];
  return (
    <button
      class="strip-extra strip-icon"
      data-on={grouping() === "foldersFirst" ? undefined : ""}
      aria-label={`Grouping: ${current().label}`}
      onClick={props.onChange}
    >
      {current().icon}
    </button>
  );
}

/** The name column flexes, so every other column resizes from its left edge. */
function startResize(event: PointerEvent, column: Column, set: ColumnSet) {
  event.preventDefault();
  const handle = event.currentTarget as HTMLElement;
  const startX = event.clientX;
  const move = (moved: PointerEvent) =>
    setColumnWidth(set, column.id, Math.max(MIN_COLUMN_WIDTH, column.width + startX - moved.clientX));

  handle.setPointerCapture(event.pointerId);
  handle.addEventListener("pointermove", move);
  handle.addEventListener("lostpointercapture", () => handle.removeEventListener("pointermove", move), {
    once: true,
  });
}

export function ColumnHeader(props: {
  ref: (element: HTMLDivElement) => void;
  columns: Column[];
  /** Which kept set of columns these are, which moves and widths change. */
  set: ColumnSet;
  /** The columns can't be moved, resized, added or removed, and grouping doesn't apply. */
  fixed: boolean;
  sort: Sort;
  onSort: (key: ColumnId) => void;
  onMenu: (event: MouseEvent) => void;
  onGroup: () => void;
  /** A double click on a column's edge, to make it as wide as what it shows. */
  onFit: (id: ColumnId) => void;
}) {
  const visible = createMemo(() => props.columns.filter((column) => column.visible));
  const addable = createMemo(() => props.columns.filter((column) => !column.visible));
  const [editing, setEditing] = createSignal(false);
  let header!: HTMLDivElement;
  let dragged = false;

  function dragTo(id: ColumnId, x: number) {
    const middles = [...header.children].map((title) => {
      const { left, width } = title.getBoundingClientRect();
      return left + width / 2;
    });
    const titles = visible();
    const target = titles[dragTarget(middles, titles.findIndex((column) => column.id === id), x)];
    if (target) moveColumn(props.set, id, target.id);
  }

  function startDrag(event: PointerEvent, id: ColumnId) {
    dragged = false;
    if (props.fixed || id === "name" || event.button !== 0) return;
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

  const removable = (id: ColumnId) => editing() && id !== "name";

  function clickTitle(id: ColumnId) {
    if (dragged) return;
    if (removable(id)) toggleColumn(props.set, id);
    else props.onSort(id);
  }

  return (
    <div class="column-strip" onPointerLeave={() => setEditing(false)}>
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
            <div
              class="column-title"
              classList={{ "column-size": column().id === "size" }}
            >
              <button
                class="column-button"
                aria-label={removable(column().id) ? `Remove ${column().label} column` : undefined}
                onPointerDown={(event) => startDrag(event, column().id)}
                onClick={() => clickTitle(column().id)}
              >
                {column().label}
                <span class="column-arrow" hidden={!removable(column().id) && props.sort.key !== column().id}>
                  {removable(column().id) ? ICON_REMOVE : props.sort.descending ? ICON_DESCENDING : ICON_ASCENDING}
                </span>
              </button>
              {column().id === "name" && (
                <>
                  {!props.fixed && <GroupToggle onChange={props.onGroup} />}
                  <For each={editing() ? addable() : []}>
                    {(extra) => (
                      <button class="column-ghost" onClick={() => toggleColumn(props.set, extra.id)}>
                        {extra.label}
                      </button>
                    )}
                  </For>
                </>
              )}
              {column().id !== "name" && !props.fixed && (
                <div
                  class="column-resize"
                  role="presentation"
                  onPointerDown={(event) => startResize(event, column(), props.set)}
                  onDblClick={() => props.onFit(column().id)}
                />
              )}
            </div>
          )}
        </Index>
      </div>
      <Show when={!props.fixed}>
        <button
          class="strip-extra strip-icon column-edit"
          data-on={editing() ? "" : undefined}
          aria-label={editing() ? "Finish editing columns" : "Edit columns"}
          onClick={() => setEditing(!editing())}
        >
          {editing() ? ICON_DONE : ICON_ADD}
        </button>
      </Show>
    </div>
  );
}

/** Grid has no columns to click, so it keeps the same titles as a plain row. */
export function SortStrip(props: {
  columns: Column[];
  fixed: boolean;
  sort: Sort;
  onSort: (key: ColumnId) => void;
  onGroup: () => void;
}) {
  return (
    <div class="column-strip sort-strip" role="group" aria-label="Sort">
      <For each={props.columns}>
        {(column) => (
          <button class="column-button" onClick={() => props.onSort(column.id)}>
            {column.label}
            <span class="column-arrow" hidden={props.sort.key !== column.id}>
              {props.sort.descending ? ICON_DESCENDING : ICON_ASCENDING}
            </span>
          </button>
        )}
      </For>
      {!props.fixed && <GroupToggle onChange={props.onGroup} />}
      <input
        class="strip-extra tile-size"
        type="range"
        aria-label="Tile size"
        aria-keyshortcuts="Control+= Control+-"
        min={MIN_TILE}
        max={MAX_TILE}
        step={TILE_STEP}
        value={tileSize()}
        style={{ "--fill": (tileSize() - MIN_TILE) / (MAX_TILE - MIN_TILE) }}
        onInput={(event) => setTileSize(event.currentTarget.valueAsNumber)}
      />
    </div>
  );
}
