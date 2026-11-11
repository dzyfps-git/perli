import { createMemo } from "solid-js";
import { saved, stored } from "../filelist/prefs";
import { bound, KEYS, keysOf, rebound, type Overrides } from "./keys";

/** The user's own keys, kept between runs, and what every part of Perli asks about them. */

function savedOverrides(): Overrides {
  const value = saved("keybinds");
  if (!value || typeof value !== "object") return {};
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([id, keys]) => KEYS.some((command) => command.id === id) && Array.isArray(keys) && keys.every((key) => typeof key === "string"),
  );
  return Object.fromEntries(entries) as Overrides;
}

export const [overrides, setOverrides] = stored<Overrides>("keybinds", savedOverrides());
const table = createMemo(() => bound(KEYS, overrides()));

export const commandFor = (combo: string) => table().get(combo);
const command = (id: string) => KEYS.find((one) => one.id === id);
/** The first key of a command, for a menu or the palette. Empty when it has none. */
export const keyText = (id: string) => {
  const found = command(id);
  return found ? (keysOf(found, overrides())[0] ?? "") : "";
};
/** A command's keys in the form `aria-keyshortcuts` takes, which the hover text reads. */
export const ariaKeys = (id: string) => {
  const found = command(id);
  const keys = found ? keysOf(found, overrides()) : [];
  const spelled = keys.map((key) => key.replace("Ctrl", "Control").replace(/\b(Left|Right|Up|Down)$/, "Arrow$1"));
  return spelled.join(" ") || undefined;
};
/** The command behind a menu label that is not that command's own name. */
const MENU_IDS: Record<string, string> = {
  Folder: "newFolder",
  File: "newFile",
  List: "list",
  Grid: "grid",
  "Search here": "search",
  "Delete permanently": "deleteForGood",
};
/** A label with the same words as a command that it does not run. */
const NOT_COMMANDS = ["Duplicate"];
/** The keys of the command a menu item runs, or `fallback` for a label that is no command. */
export function labelKeys(label: string, fallback?: string) {
  const plain = label.replace(/…$/, "");
  const id = MENU_IDS[plain] ?? (NOT_COMMANDS.includes(plain) ? undefined : KEYS.find((one) => one.label === plain)?.id);
  const found = id && command(id);
  return found && !found.fixed ? keyText(found.id) || undefined : fallback;
}
export const rebind = (id: string, combo: string) => setOverrides(rebound(KEYS, overrides(), id, combo));
export const unbind = (id: string) => setOverrides({ ...overrides(), [id]: [] });
export function resetKey(id: string) {
  const { [id]: _gone, ...rest } = overrides();
  setOverrides(rest);
}
export const resetKeys = () => setOverrides({});
