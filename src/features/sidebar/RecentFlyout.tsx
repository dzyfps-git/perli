import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import type { Recent } from "../../api";
import { ago } from "../../ui/dates";
import { parentOf } from "../navigation/path";
import { byDay } from "./placeLists";

const ICON_FOLDER = "";
const ICON_FILE = "";
const ICON_SEARCH = "";
const ICON_FORGET = "";
/** Room kept to the window's edges. */
const EDGE = 8;

/**
 * Recent files and folders in a panel beside the sidebar, under the day each was opened. It
 * takes the room a long list would take in the sidebar only while it is asked for.
 */
export function RecentFlyout(props: {
  items: Recent[];
  /** Where the panel starts across, and the top of the row that opened it. */
  left: number;
  top: number;
  /** The row that opened it, which closes it again. */
  opener: Element;
  onOpen: (item: Recent) => void;
  onForget: (item: Recent) => void;
  onMenu: (event: MouseEvent, item: Recent) => void;
  onClose: () => void;
}) {
  let panel!: HTMLDivElement;
  let filterBox!: HTMLInputElement;
  const [filter, setFilter] = createSignal("");
  const [top, setTop] = createSignal(props.top);
  const focusedBefore = document.activeElement as HTMLElement | null;

  const days = createMemo(() => {
    const words = filter().trim().toLowerCase().split(/\s+/).filter(Boolean);
    const shown = props.items.filter((item) => words.every((word) => item.path.toLowerCase().includes(word)));
    return byDay(shown, new Date());
  });
  const buttons = () => [...panel.querySelectorAll<HTMLButtonElement>(".recent-open")];

  function close() {
    props.onClose();
    focusedBefore?.focus({ preventScroll: true });
  }

  function onKeyDown(event: KeyboardEvent) {
    const all = buttons();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") close();
    else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const step = event.key === "ArrowDown" ? 1 : -1;
      all[at < 0 ? (step > 0 ? 0 : all.length - 1) : Math.max(0, Math.min(all.length - 1, at + step))]?.focus();
    } else if (event.key === "Enter" && at < 0) all[0]?.click();
    else if (event.key === "Delete" && at >= 0) {
      all[at].closest("li")?.querySelector<HTMLButtonElement>(".recent-forget")?.click();
      queueMicrotask(() => (buttons()[at] ?? buttons().at(-1) ?? filterBox).focus());
    } else return;
    event.preventDefault();
    event.stopPropagation();
  }

  // Outside the panel closes it, except in the menu a right-click opened over it, and on the
  // row that opened it, whose click closes it.
  const onPointerDown = (event: PointerEvent) => {
    const target = event.target as Element;
    if (!panel.contains(target) && !props.opener.contains(target) && !target.closest(".menu")) close();
  };

  onMount(() => {
    // The panel stays beside its row, but never past the window's bottom.
    setTop(Math.max(EDGE, Math.min(props.top, window.innerHeight - panel.offsetHeight - EDGE)));
    filterBox.focus({ preventScroll: true });
    window.addEventListener("pointerdown", onPointerDown, true);
  });
  onCleanup(() => window.removeEventListener("pointerdown", onPointerDown, true));

  return (
    <Portal>
      <div
        ref={panel}
        class="recent-flyout"
        role="dialog"
        aria-label="Recent files"
        style={{ left: `${props.left}px`, top: `${top()}px` }}
        onKeyDown={onKeyDown}
      >
        <label class="recent-filter">
          <span class="recent-filter-icon" aria-hidden="true">
            {ICON_SEARCH}
          </span>
          <input
            ref={filterBox}
            type="search"
            placeholder="Filter recent"
            aria-label="Filter recent files"
            value={filter()}
            onInput={(event) => setFilter(event.currentTarget.value)}
          />
        </label>
        <div class="recent-scroll">
          <Show when={days().length} fallback={<p class="recent-empty">Nothing opened lately matches.</p>}>
            <For each={days()}>
              {(day) => (
                <section class="recent-day" aria-label={day.label}>
                  <h3>{day.label}</h3>
                  <ul>
                    <For each={day.items}>
                      {(item) => (
                        <li class="recent-item">
                          <button
                            class="recent-open"
                            aria-label={`${item.name}, in ${parentOf(item.path) ?? item.path}, opened ${ago(item.opened, Date.now())}`}
                            onClick={() => {
                              props.onOpen(item);
                              props.onClose();
                            }}
                            onContextMenu={(event) => {
                              event.preventDefault();
                              props.onMenu(event, item);
                            }}
                          >
                            <span class="recent-icon" aria-hidden="true">
                              {item.isDir ? ICON_FOLDER : ICON_FILE}
                            </span>
                            <span class="recent-text">
                              <span class="recent-name">{item.name}</span>
                              <span class="recent-where">{parentOf(item.path) ?? ""}</span>
                            </span>
                            <span class="recent-when">{ago(item.opened, Date.now())}</span>
                          </button>
                          <button
                            class="recent-forget"
                            tabindex="-1"
                            aria-label={`Take ${item.name} off the list`}
                            data-tip="Take off the list (Delete)"
                            onClick={() => props.onForget(item)}
                          >
                            {ICON_FORGET}
                          </button>
                        </li>
                      )}
                    </For>
                  </ul>
                </section>
              )}
            </For>
          </Show>
        </div>
      </div>
    </Portal>
  );
}
