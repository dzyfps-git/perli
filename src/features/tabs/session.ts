import type { Order, Sort } from "../../api";
import type { Layout } from "../filelist/layout";

export interface SavedPane {
  path: string;
  sort: Sort;
  layout: Layout;
  /** Folders opened in place, by full path. */
  expanded?: string[];
  /** A tab moved to another window takes its history, selection and scroll along. */
  back?: string[];
  forward?: string[];
  /** Names selected in the folder. */
  select?: string[];
  scrollTop?: number;
}

export interface SavedTab {
  panes: SavedPane[];
  active: number;
  swapped: boolean;
  pinned?: boolean;
  /** The first pane's share, when it is not half. */
  split?: number;
  /** One pane over the other. */
  stacked?: boolean;
  /** The panes follow each other. */
  linked?: boolean;
  /** The home page shows in place of the panes. */
  home?: boolean;
}

export interface Session {
  /** The folder on screen, which Rust starts reading before the window appears. */
  start: { path: string; order: Order };
  tabs: SavedTab[];
  active: number;
}

const SORT_KEYS = ["name", "modified", "created", "type", "size"];

/** Only the texts in `list`, or nothing when none is left. */
function texts(list: unknown): string[] | undefined {
  const kept = Array.isArray(list) ? list.filter((item) => typeof item === "string") : [];
  return kept.length > 0 ? kept : undefined;
}

function cleanPane(pane: Partial<SavedPane> | null): SavedPane[] {
  if (typeof pane?.path !== "string") return [];
  const sort: Sort = SORT_KEYS.includes(pane.sort?.key as string)
    ? { key: pane.sort!.key, descending: pane.sort!.descending === true }
    : { key: "name", descending: false };
  const lists = { expanded: texts(pane.expanded), back: texts(pane.back), forward: texts(pane.forward), select: texts(pane.select) };
  const scrollTop = typeof pane.scrollTop === "number" && pane.scrollTop > 0 ? pane.scrollTop : undefined;
  const kept = Object.entries({ ...lists, scrollTop }).filter(([, value]) => value !== undefined);
  return [{ path: pane.path, sort, layout: pane.layout === "grid" || pane.layout === "gallery" || pane.layout === "columns" ? pane.layout : "list", ...Object.fromEntries(kept) }];
}

function inRange(index: unknown, count: number) {
  return typeof index === "number" && index >= 0 && index < count ? Math.floor(index) : 0;
}

/** A saved tab as far as it is usable, or nothing when it has no folder to open. Throws on
 *  what is not a tab at all. */
function cleanTab(tab: SavedTab): SavedTab | undefined {
  const panes = tab.panes.flatMap(cleanPane).slice(0, 2);
  if (panes.length === 0) return undefined;
  return {
    panes,
    active: inRange(tab.active, panes.length),
    swapped: tab.swapped === true,
    ...(tab.pinned === true ? { pinned: true } : {}),
    ...(typeof tab.split === "number" && tab.split > 0 && tab.split < 1 ? { split: tab.split } : {}),
    ...(tab.stacked === true ? { stacked: true } : {}),
    ...(tab.linked === true ? { linked: true } : {}),
  };
}

/** Reads saved text, keeping what is usable. Returns undefined if no folder is left to open. */
export function parseSession(text: string | null | undefined): Omit<Session, "start"> | undefined {
  try {
    const saved = JSON.parse(text ?? "null");
    const tabs: SavedTab[] = saved.tabs.flatMap((tab: SavedTab) => cleanTab(tab) ?? []);
    return tabs.length > 0 ? { tabs, active: inRange(saved.active, tabs.length) } : undefined;
  } catch {
    return undefined;
  }
}

/** Where a window that takes a moved tab goes, in physical pixels. */
export interface Place {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized?: boolean;
}

/** A tab on its way from one window to another, and where a new window for it goes. */
export interface Moved {
  tab: SavedTab;
  place?: Place;
}

const whole = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Reads a moved tab's text, or nothing when it holds no folder to open. */
export function parseMoved(text: string | null | undefined): Moved | undefined {
  try {
    const moved = JSON.parse(text ?? "null");
    const tab = cleanTab(moved.tab);
    if (!tab) return undefined;
    const { x, y, width, height, maximized } = moved.place ?? {};
    const placed = [x, y, width, height].every(whole) && width > 0 && height > 0;
    return { tab, ...(placed ? { place: { x, y, width, height, ...(maximized === true ? { maximized } : {}) } } : {}) };
  } catch {
    return undefined;
  }
}
