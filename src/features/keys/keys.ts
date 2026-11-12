/** One thing a key can do. What it does lives in `App.tsx`, under the same id. */
export interface KeyCommand {
  id: string;
  label: string;
  group: "Files" | "Go" | "View" | "Tabs and panes" | "Perli";
  /** The keys it starts with, like `Ctrl+Shift+C`. Any of them will do. */
  keys: string[];
  /** `list`: only with the file list in focus, and once per press. `free`: not while typing. */
  where?: "list" | "free";
  /** Shown in the key sheet, but it lives with the part that uses it and can't be changed. */
  fixed?: true;
  /** Left out of the command palette, where a row of nine would only be noise. */
  quiet?: true;
}

const nine = [1, 2, 3, 4, 5, 6, 7, 8, 9];

export const KEYS: KeyCommand[] = [
  { id: "copy", label: "Copy", group: "Files", keys: ["Ctrl+C"], where: "list" },
  { id: "cut", label: "Cut", group: "Files", keys: ["Ctrl+X"], where: "list" },
  { id: "paste", label: "Paste", group: "Files", keys: ["Ctrl+V"], where: "list" },
  { id: "duplicate", label: "Duplicate", group: "Files", keys: ["Ctrl+D"], where: "list" },
  { id: "copyPath", label: "Copy path", group: "Files", keys: ["Ctrl+Shift+C"], where: "list" },
  { id: "rename", label: "Rename", group: "Files", keys: ["F2"], where: "list" },
  { id: "delete", label: "Delete", group: "Files", keys: ["Delete"], where: "list" },
  { id: "deleteForGood", label: "Delete permanently", group: "Files", keys: ["Shift+Delete"], where: "list" },
  { id: "newFolder", label: "New folder", group: "Files", keys: ["Ctrl+Shift+N"], where: "list" },
  { id: "newFolderWith", label: "New folder with selection", group: "Files", keys: ["Ctrl+Shift+G"], where: "list" },
  { id: "newFile", label: "New file", group: "Files", keys: ["Ctrl+N"], where: "list" },
  { id: "properties", label: "Properties", group: "Files", keys: ["Alt+Enter"], where: "list" },
  { id: "shelve", label: "Put on the shelf", group: "Files", keys: ["Ctrl+Shift+S"], where: "list" },
  { id: "copyToOther", label: "Copy to other pane", group: "Files", keys: ["F7"], where: "list" },
  { id: "moveToOther", label: "Move to other pane", group: "Files", keys: ["F8"], where: "list" },
  { id: "undo", label: "Undo", group: "Files", keys: ["Ctrl+Z"], where: "list" },
  { id: "redo", label: "Redo", group: "Files", keys: ["Ctrl+Y"], where: "list" },
  { id: "activity", label: "Activity log", group: "Files", keys: ["Ctrl+Shift+H"] },
  { id: "diskMap", label: "Disk map", group: "View", keys: ["Ctrl+Shift+M"] },
  { id: "toFileDialog", label: "Send folder to file dialog (experimental)", group: "Go", keys: ["Ctrl+Shift+O"] },
  { id: "open", label: "Open", group: "Files", keys: ["Enter"], fixed: true },
  { id: "preview", label: "Quick preview", group: "Files", keys: ["Space"], fixed: true },
  { id: "selectAll", label: "Select all", group: "Files", keys: ["Ctrl+A"], fixed: true },

  { id: "back", label: "Back", group: "Go", keys: ["Alt+Left"] },
  { id: "forward", label: "Forward", group: "Go", keys: ["Alt+Right"] },
  { id: "up", label: "Up", group: "Go", keys: ["Alt+Up", "Backspace"], where: "free" },
  { id: "path", label: "Go to path", group: "Go", keys: ["Ctrl+L", "Alt+D"] },
  { id: "search", label: "Search", group: "Go", keys: ["Ctrl+F"] },
  { id: "refresh", label: "Refresh", group: "Go", keys: ["F5"] },
  { id: "terminal", label: "Open in terminal", group: "Go", keys: ["Ctrl+`"] },
  ...nine.map(
    (place): KeyCommand => ({ id: `pinned-${place}`, label: `Go to pinned place ${place}`, group: "Go", keys: [`Ctrl+Shift+${place}`], quiet: true }),
  ),

  { id: "list", label: "List view", group: "View", keys: ["Alt+1"] },
  { id: "grid", label: "Grid view", group: "View", keys: ["Alt+2"] },
  { id: "largerTiles", label: "Larger tiles", group: "View", keys: ["Ctrl+=", "Ctrl+Shift+="] },
  { id: "smallerTiles", label: "Smaller tiles", group: "View", keys: ["Ctrl+-"] },
  { id: "hidden", label: "Show hidden files", group: "View", keys: ["Ctrl+H"] },
  { id: "filter", label: "Filter", group: "View", keys: ["Ctrl+Shift+F"] },
  { id: "selectPattern", label: "Select by pattern", group: "View", keys: ["Ctrl+Shift+A"] },
  { id: "details", label: "Details panel", group: "View", keys: ["Alt+Shift+P"] },
  { id: "previewPane", label: "Preview pane", group: "View", keys: ["Alt+P"] },
  { id: "sidebar", label: "Keep sidebar open", group: "View", keys: ["Ctrl+B"], where: "free" },
  { id: "fullScreen", label: "Full screen", group: "View", keys: ["F11"] },
  { id: "shelf", label: "Show the shelf", group: "View", keys: ["Ctrl+Shift+E"] },

  { id: "newTab", label: "New tab", group: "Tabs and panes", keys: ["Ctrl+T"] },
  { id: "backgroundTab", label: "Open in background tab", group: "Tabs and panes", keys: ["Ctrl+Enter"], where: "list" },
  { id: "openToSide", label: "Open to side", group: "Tabs and panes", keys: ["Ctrl+Shift+Enter"], where: "list" },
  { id: "close", label: "Close", group: "Tabs and panes", keys: ["Ctrl+W"] },
  { id: "reopen", label: "Reopen closed tab", group: "Tabs and panes", keys: ["Ctrl+Shift+T"] },
  { id: "duplicateTab", label: "Duplicate tab", group: "Tabs and panes", keys: ["Ctrl+Shift+K"] },
  { id: "pinTab", label: "Pin tab", group: "Tabs and panes", keys: [] },
  { id: "tabToWindow", label: "Move to new window", group: "Tabs and panes", keys: [] },
  { id: "split", label: "Split view", group: "Tabs and panes", keys: ["Ctrl+\\"] },
  { id: "otherPane", label: "Go to the other pane", group: "Tabs and panes", keys: ["F6"] },
  { id: "nextTab", label: "Next tab", group: "Tabs and panes", keys: ["Ctrl+Tab", "Ctrl+PageDown"] },
  { id: "previousTab", label: "Previous tab", group: "Tabs and panes", keys: ["Ctrl+Shift+Tab", "Ctrl+PageUp"] },
  ...nine.map(
    (tab): KeyCommand => ({ id: `tab-${tab}`, label: `Go to tab ${tab}`, group: "Tabs and panes", keys: [`Ctrl+${tab}`], quiet: true }),
  ),

  { id: "palette", label: "Command palette", group: "Perli", keys: ["Ctrl+P"], fixed: true },
  { id: "settings", label: "Settings", group: "Perli", keys: ["Ctrl+,"] },
  { id: "keys", label: "Keyboard shortcuts", group: "Perli", keys: ["F1"] },
];

const NAMES: Record<string, string> = {
  " ": "Space",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  "+": "=",
  Escape: "Esc",
};
const MODIFIERS = ["Control", "Shift", "Alt", "Meta", "AltGraph"];

/**
 * The keys held, as text like `Ctrl+Shift+C`. Empty for a modifier alone. Digits and the key
 * left of 1 are read by where they sit, because Shift and the keyboard's language change what
 * they type.
 */
export function comboOf(event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "altKey" | "shiftKey">) {
  if (MODIFIERS.includes(event.key)) return "";
  const digit = /^Digit(\d)$/.exec(event.code)?.[1];
  const key = digit ?? (event.code === "Backquote" ? "`" : (NAMES[event.key] ?? (event.key.length === 1 ? event.key.toUpperCase() : event.key)));
  return [event.ctrlKey && "Ctrl", event.altKey && "Alt", event.shiftKey && "Shift", key].filter(Boolean).join("+");
}

/** The user's own keys, by command id. A command not in here keeps the keys it started with. */
export type Overrides = Record<string, string[]>;

export const keysOf = (command: KeyCommand, overrides: Overrides) => overrides[command.id] ?? command.keys;

/** Which command each combo starts. A fixed command's keys are not in here. */
export function bound(table: KeyCommand[], overrides: Overrides) {
  const found = new Map<string, KeyCommand>();
  for (const command of table) {
    if (command.fixed) continue;
    for (const combo of keysOf(command, overrides)) if (!found.has(combo)) found.set(combo, command);
  }
  return found;
}

/** `combo` becomes the only key of `id`, and is taken from whatever had it. */
export function rebound(table: KeyCommand[], overrides: Overrides, id: string, combo: string): Overrides {
  const next: Overrides = { ...overrides };
  for (const command of table) {
    const keys = keysOf(command, overrides);
    if (command.id !== id && !command.fixed && keys.includes(combo)) next[command.id] = keys.filter((key) => key !== combo);
  }
  next[id] = [combo];
  return next;
}

/** Keys Perli keeps for itself, so no command can take them. */
export const taken = (table: KeyCommand[], combo: string) => table.find((command) => command.fixed && command.keys.includes(combo));
