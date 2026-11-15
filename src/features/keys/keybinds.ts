import { createMemo, createSignal } from "solid-js";
import { saved, stored } from "../filelist/prefs";
import { coveringEntry, folderKey, remembered } from "../filelist/sortMemory";
import { bound, changedFrom, cleanOverrides, KEYS, keysOf, rebound, reset, type Overrides } from "./keys";

/**
 * The user's own keys, kept between runs, and what every part of Perli asks about them. Keys can
 * be set everywhere, for one workspace, or for a folder and the folders inside it. The folder's
 * win over the workspace's, which win over the ones set everywhere.
 */

/** A folder's own keys, which hold in the folders inside it too. `path` is as it was shown. */
export interface FolderKeys {
  keys: Overrides;
  below: true;
  path: string;
}

export type KeyScope = "all" | "workspace" | "folder";

/** Each entry of a saved map of scopes as far as usable. */
function cleanMap<T>(value: unknown, clean: (one: unknown) => T | undefined): Record<string, T> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([key, one]) => {
    const kept = clean(one);
    return kept === undefined ? [] : [[key, kept] as const];
  }));
}
const cleanFolder = (one: unknown): FolderKeys | undefined => {
  const entry = one as Partial<FolderKeys> | null;
  return typeof entry?.path === "string" ? { keys: cleanOverrides(KEYS, entry.keys), below: true, path: entry.path } : undefined;
};
export const cleanFolderKeys = (value: unknown) => cleanMap(value, cleanFolder);
export const cleanWorkspaceKeys = (value: unknown) => cleanMap(value, (one) => cleanOverrides(KEYS, one));

export const [overrides, setOverrides] = stored<Overrides>("keybinds", cleanOverrides(KEYS, saved("keybinds")));
export const [folderKeys, setFolderKeys] = stored<Record<string, FolderKeys>>("folder-keys", cleanFolderKeys(saved("folder-keys")));
export const [workspaceKeys, setWorkspaceKeys] = stored<Record<string, Overrides>>("workspace-keys", cleanWorkspaceKeys(saved("workspace-keys")));

/** Where keys are looked up: the folder on screen and the workspace, which the app keeps told. */
const [place, setPlace] = createSignal<{ folder?: string; workspace?: string }>({});
export const keysFor = setPlace;

/** The folder whose keys hold here: its own, or the nearest one above that set them. */
const folderEntry = () => {
  const folder = place().folder;
  return folder ? coveringEntry(folderKeys(), folder) : undefined;
};

/** The keys each scope sets itself, on screen now. */
const layer = (scope: KeyScope): Overrides => {
  if (scope === "all") return overrides();
  if (scope === "workspace") {
    const name = place().workspace;
    return (name !== undefined && workspaceKeys()[name]) || {};
  }
  return folderEntry()?.value.keys ?? {};
};
const ORDER: KeyScope[] = ["all", "workspace", "folder"];
/** The keys as they hold in `scope`, with every scope under it beneath. */
const upTo = (scope: KeyScope, own = true) => {
  const layers = ORDER.slice(0, ORDER.indexOf(scope) + (own ? 1 : 0)).map(layer);
  return Object.assign({}, ...layers) as Overrides;
};

/** What a scope is called, or nothing when there is none here. */
export function scopeName(scope: KeyScope) {
  if (scope === "all") return "Everywhere";
  if (scope === "workspace") {
    const name = place().workspace;
    return name === undefined ? undefined : `Workspace "${name}"`;
  }
  const folder = place().folder;
  if (!folder) return undefined;
  const path = folderEntry()?.value.path ?? folder;
  const name = path.split("\\").filter(Boolean).at(-1) ?? path;
  return `Folder "${name}" and inside`;
}

const effective = createMemo(() => upTo("folder"));
const table = createMemo(() => bound(KEYS, effective()));

export const commandFor = (combo: string) => table().get(combo);
const command = (id: string) => KEYS.find((one) => one.id === id);
/** The first key of a command, for a menu or the palette. Empty when it has none. */
export const keyText = (id: string) => {
  const found = command(id);
  return found ? (keysOf(found, effective())[0] ?? "") : "";
};
/** A command's keys in the form `aria-keyshortcuts` takes, which the hover text reads. */
export const ariaKeys = (id: string) => {
  const found = command(id);
  const keys = found ? keysOf(found, effective()) : [];
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

/** `scope`'s own keys become `next`. A scope left with none is forgotten. */
function setLayer(scope: KeyScope, next: Overrides) {
  const empty = Object.keys(next).length === 0;
  if (scope === "all") return setOverrides(next);
  if (scope === "workspace") {
    const name = place().workspace;
    if (name === undefined) return;
    const { [name]: _gone, ...rest } = workspaceKeys();
    return setWorkspaceKeys(empty ? rest : { ...rest, [name]: next });
  }
  const folder = place().folder;
  if (!folder) return;
  const entry = folderEntry();
  const key = entry?.key ?? folderKey(folder);
  setFolderKeys(remembered(folderKeys(), key, empty ? undefined : { keys: next, below: true, path: entry?.value.path ?? folder }));
}

/** The keys as they hold in `scope` now, for the key sheet. */
export const scopeKeys = (scope: KeyScope) => upTo(scope);
/** The commands `scope` sets keys for itself. */
export const scopeOwn = (scope: KeyScope) => layer(scope);

/** Everywhere, a scope's keys are all its own; elsewhere only what differs from beneath. */
const own = (scope: KeyScope, next: Overrides) => (scope === "all" ? next : changedFrom(KEYS, upTo(scope, false), next));

export const rebind = (scope: KeyScope, id: string, combo: string) => setLayer(scope, own(scope, rebound(KEYS, upTo(scope), id, combo)));
export const unbind = (scope: KeyScope, id: string) => setLayer(scope, own(scope, { ...upTo(scope), [id]: [] }));
export function resetKey(scope: KeyScope, id: string) {
  if (scope === "all") return setOverrides(reset(KEYS, overrides(), id));
  const { [id]: _gone, ...rest } = layer(scope);
  setLayer(scope, rest);
}
export const resetKeys = (scope: KeyScope) => setLayer(scope, {});

/** A workspace's keys follow it to its new name, or go with it. */
export function moveWorkspaceKeys(from: string, to: string | undefined) {
  const { [from]: kept, ...rest } = workspaceKeys();
  if (kept) setWorkspaceKeys(to === undefined ? rest : { ...rest, [to]: kept });
}
