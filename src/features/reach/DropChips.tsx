import { For, Show } from "solid-js";
import { baseName, samePath } from "../navigation/path";
import { pinned } from "../sidebar/saved";
import { dragging, recentFolders } from "./reach";
import "./reach.css";

const ICON_PANE = "";
const ICON_PIN = "";
const ICON_RECENT = "";
const MOST_CHIPS = 8;

interface Chip {
  path: string;
  icon: string;
  label: string;
}

/**
 * Places to drop on, shown only while files are dragged: the other pane, the pinned places, and
 * the folders seen lately. Each is a drop target like any folder.
 */
export function DropChips(props: { folder: () => string | undefined; other: () => string | undefined }) {
  const chips = () => {
    const found: Chip[] = [];
    const add = (path: string | undefined, icon: string, label?: string) => {
      if (!path || samePath(props.folder(), path) || found.some((chip) => samePath(chip.path, path))) return;
      found.push({ path, icon, label: label ?? (baseName(path) || path) });
    };
    add(props.other(), ICON_PANE, `Other pane: ${baseName(props.other() ?? "") || props.other()}`);
    for (const path of pinned()) add(path, ICON_PIN);
    for (const path of recentFolders()) add(path, ICON_RECENT);
    return found.slice(0, MOST_CHIPS);
  };
  return (
    <Show when={dragging() && chips().length > 0}>
      <ul class="drop-chips" aria-label="Places to drop on">
        <For each={chips()}>
          {(chip, at) => (
            <li class="drop-chip" data-drop={chip.path} style={{ "--at": at() }}>
              <span class="drop-chip-icon" aria-hidden="true">
                {chip.icon}
              </span>
              {chip.label}
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}
