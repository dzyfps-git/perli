import type { Order, Sort } from "../../api";
import type { Layout } from "../filelist/layout";

export interface SavedPane {
  path: string;
  sort: Sort;
  layout: Layout;
}

export interface SavedTab {
  panes: SavedPane[];
  active: number;
  swapped: boolean;
}

export interface Session {
  /** The folder on screen, which Rust starts reading before the window appears. */
  start: { path: string; order: Order };
  tabs: SavedTab[];
  active: number;
}

const SORT_KEYS = ["name", "modified", "created", "type", "size"];

function cleanPane(pane: Partial<SavedPane> | null): SavedPane[] {
  if (typeof pane?.path !== "string") return [];
  const sort: Sort = SORT_KEYS.includes(pane.sort?.key as string)
    ? { key: pane.sort!.key, descending: pane.sort!.descending === true }
    : { key: "name", descending: false };
  return [{ path: pane.path, sort, layout: pane.layout === "grid" ? "grid" : "list" }];
}

function inRange(index: unknown, count: number) {
  return typeof index === "number" && index >= 0 && index < count ? Math.floor(index) : 0;
}

/** Reads saved text, keeping what is usable. Returns undefined if no folder is left to open. */
export function parseSession(text: string | null | undefined): Omit<Session, "start"> | undefined {
  try {
    const saved = JSON.parse(text ?? "null");
    const tabs: SavedTab[] = [];
    for (const tab of saved.tabs) {
      const panes = tab.panes.flatMap(cleanPane).slice(0, 2);
      if (panes.length === 0) continue;
      tabs.push({ panes, active: inRange(tab.active, panes.length), swapped: tab.swapped === true });
    }
    return tabs.length > 0 ? { tabs, active: inRange(saved.active, tabs.length) } : undefined;
  } catch {
    return undefined;
  }
}
