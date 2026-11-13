import { createResource, For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { fetchRows } from "../../api";
import { toCrumbs } from "../navigation/path";
import type { Tab } from "../tabs/tabs";

/** How many of the folder's rows the look shows. */
const PEEK_ROWS = 6;
const ICON_FOLDER = "";
const ICON_FILE = "";

/**
 * A small look at a tab's folder while the pointer rests on the tab: where it is, how much is in
 * it and its first few rows. A tab not opened yet since the start shows only where it is.
 */
export function TabPeek(props: { tab: Tab; x: number; y: number }) {
  const view = () => props.tab.active();
  const [rows] = createResource(
    () => view().folder(),
    (shown) => fetchRows(view().id, shown.request, 0, PEEK_ROWS).catch(() => []),
  );
  const count = () => view().folder()?.count;
  const name = (path: string) => toCrumbs(path).at(-1)?.label ?? path;

  return (
    <Portal>
      <div class="tab-peek" style={{ left: `${props.x}px`, top: `${props.y}px` }} aria-hidden="true">
        <For each={props.tab.panes()}>
          {(pane) => <p class="tab-peek-name">{name(pane.path() ?? "")}</p>}
        </For>
        <p class="tab-peek-path">{view().path()}</p>
        <Show when={count() !== undefined}>
          <p class="tab-peek-count">{count() === 1 ? "1 item" : `${count()!.toLocaleString()} items`}</p>
        </Show>
        <Show when={(rows() ?? []).length > 0}>
          <ul class="tab-peek-rows">
            <For each={rows()}>
              {(row) => (
                <li>
                  <span class="tab-peek-icon">{row.isDir ? ICON_FOLDER : ICON_FILE}</span>
                  {row.name}
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </Portal>
  );
}
