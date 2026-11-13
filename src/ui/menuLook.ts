import type { MenuItem } from "./Menu";

/**
 * The icon and key hint of each menu item, by its label. Menus are built in many places, and one
 * table keeps an action looking the same in all of them. Icons are Segoe Fluent Icons glyphs.
 */
const LOOK: Record<string, [icon: string, keys?: string]> = {
  Open: ["", "Enter"],
  "Open to side": [""],
  "Open with": [""],
  "Open in terminal": [""],
  "Open templates folder": [""],
  "Quick preview": ["", "Space"],
  "Show in folder": [""],
  "Original location": [""],
  Cut: ["", "Ctrl+X"],
  Copy: ["", "Ctrl+C"],
  Paste: ["", "Ctrl+V"],
  Rename: ["", "F2"],
  Delete: ["", "Del"],
  "Delete permanently": ["", "Shift+Del"],
  Restore: [""],
  "Empty Recycle Bin": [""],
  Undo: ["", "Ctrl+Z"],
  Redo: ["", "Ctrl+Y"],
  New: [""],
  Folder: ["", "Ctrl+Shift+N"],
  File: ["", "Ctrl+N"],
  "New tag": [""],
  "New tab": ["", "Ctrl+T"],
  Tags: [""],
  "Send to": [""],
  "Compress to ZIP": [""],
  "Extract here": [""],
  "Extract to own folders": [""],
  "Save as template": [""],
  "What's using this?": [""],
  Properties: ["", "Alt+Enter"],
  "More from Windows": [""],
  "Classic Windows menu": [""],
  "Choose another app": [""],
  "Search here": ["", "Ctrl+F"],
  "Select by pattern": ["", "Ctrl+Shift+A"],
  Filter: ["", "Ctrl+Shift+F"],
  "Clear filter": [""],
  View: [""],
  "Sort by": [""],
  Grouping: [""],
  "Show hidden files": ["", "Ctrl+H"],
  "Flat view": [""],
  "Use this view for all folders": [""],
  List: ["", "Ctrl+Shift+1"],
  Grid: ["", "Ctrl+Shift+2"],
  "Compact rows": ["\uE14C"],
  "Cozy rows": ["\uE8FD"],
  "Roomy rows": ["\uE8C4"],
  "Windows icons": ["\uE782"],
  "Larger tiles": [""],
  "Smaller tiles": [""],
  "Details panel": ["", "Alt+Shift+P"],
  "Keep sidebar open": ["\uE8A0", "Ctrl+B"],
  "Split view": ["", "Ctrl+\\"],
  "Swap panes": [""],
  "Close pane": [""],
  "Copy to other pane": [""],
  "Move to other pane": [""],
  Duplicate: [""],
  Close: ["", "Ctrl+W"],
  "Close others": [""],
  "Reopen closed tab": ["", "Ctrl+Shift+T"],
  "Move left": [""],
  "Move right": [""],
  "Move up": [""],
  "Move down": [""],
  "Pin to sidebar": [""],
  "Unpin from sidebar": [""],
  "Add bookmark": [""],
  "Remove bookmark": [""],
  "Bookmarks bar": [""],
  "Folder look": [""],
  "Map network drive": [""],
  "Disconnect network drive": [""],
  Settings: ["", "Ctrl+,"],
};

/** Labels end with "…" when they ask for more before acting. The look is the same without it. */
const known = (label: string) => LOOK[label.replace(/…$/, "")];

export const iconFor = (label: string) => known(label)?.[0];

export const keysFor = (label: string) => known(label)?.[1];

export const opensSide = (item: MenuItem) => !!(item.items || item.load);

/** Only what runs right away can be starred. A side menu or an on-off item stays in its group. */
export const canStar = (item: MenuItem) => !!item.action && !opensSide(item) && item.checked === undefined;

/** Starred items first, in the order they have in the menu, then the rest under a line. */
export function starredFirst(items: MenuItem[], starred: (item: MenuItem) => boolean): MenuItem[] {
  const top = items.filter((item) => canStar(item) && starred(item));
  if (top.length === 0) return items;
  const rest = items.filter((item) => !top.includes(item));
  return [
    ...top.map((item) => ({ ...item, divider: false })),
    ...rest.map((item, index) => (index === 0 ? { ...item, divider: true } : item)),
  ];
}
