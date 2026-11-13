import { createSignal } from "solid-js";
import { pathsExist } from "../../api";
import { saved, stored } from "../filelist/prefs";
import { isBin } from "../navigation/path";
import { serverOf, visited, withPaths } from "./lists";

/** What the shelf, the drop chips and the path bar remember between folders, tabs and runs. */

const strings = (value: unknown) => (Array.isArray(value) ? value.filter((one): one is string => typeof one === "string") : []);

/** What a drop on the shelf lands on. It is no folder, so no job can start there. */
export const SHELF = "perli:shelf";
const RECENT_FOLDERS = 6;

/** Files are being dragged over the window. */
export const [dragging, setDragging] = createSignal(false);
export const [shelf, setShelf] = stored<string[]>("shelf", strings(saved("shelf")));
/** The shelf was asked for, so it shows with nothing on it and no drag going. */
export const [shelfOpen, setShelfOpen] = createSignal(false);

export function shelve(paths: string[]) {
  setShelf(withPaths(shelf(), paths));
}

/** Takes off what is no longer where it was, because it was moved or deleted. */
export async function pruneShelf() {
  const paths = shelf();
  if (paths.length === 0) return;
  const there = await pathsExist(paths);
  // Only what was asked about is dropped, as files may have been added while Windows looked.
  const gone = new Set(paths.filter((_, at) => !there[at]));
  if (gone.size > 0) setShelf(shelf().filter((path) => !gone.has(path)));
}

export const [recentFolders, setRecentFolders] = stored<string[]>("recent-folders", strings(saved("recent-folders")));

/** Off, the sidebar reads no Recent list and Perli notes no folders or servers it opens. */
export const [rememberRecent, keepRecent] = stored("remember-recent", saved("remember-recent") !== false);

/** Turning it off forgets Perli's own list of folders too. Windows' list stays as it is. */
export function setRememberRecent(on: boolean) {
  keepRecent(on);
  if (!on) setRecentFolders([]);
}

const SERVERS = 8;
/** Servers that folders were opened on, newest first, for the sidebar's Network section. */
export const [servers, setServers] = stored<string[]>("servers", strings(saved("servers")));
export const forgetServer = (server: string) =>
  setServers(servers().filter((kept) => kept.toLowerCase() !== server.toLowerCase()));

export function noteFolder(path: string | undefined) {
  if (!path || isBin(path) || !rememberRecent()) return;
  if (recentFolders()[0] !== path) setRecentFolders(visited(recentFolders(), path, RECENT_FOLDERS));
  const server = serverOf(path);
  if (server && servers()[0]?.toLowerCase() !== server.toLowerCase()) setServers(visited(servers(), server, SERVERS));
}

function savedNicknames(): Record<string, string> {
  const value = saved("nicknames");
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, path]) => typeof path === "string")) as Record<string, string>;
}

/** Short names for folders, typed in the path bar as `@name`. */
export const [nicknames, setNicknames] = stored<Record<string, string>>("nicknames", savedNicknames());
export const setNickname = (name: string, path: string) => setNicknames({ ...nicknames(), [name]: path });
export function forgetNickname(name: string) {
  const { [name]: _gone, ...rest } = nicknames();
  setNicknames(rest);
}
