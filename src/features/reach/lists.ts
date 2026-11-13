/** Lists of paths the reach features keep. Windows paths differ by more than case only by name. */

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** `paths` added to `list`, each once, in the order they came. */
export function withPaths(list: string[], paths: string[]) {
  const added = paths.filter((path, at) => !list.some((kept) => same(kept, path)) && paths.findIndex((other) => same(other, path)) === at);
  return [...list, ...added];
}

/** `path` at the front of the folders seen lately, with no more than `most` kept. */
export function visited(list: string[], path: string, most: number) {
  return [path, ...list.filter((kept) => !same(kept, path))].slice(0, most);
}

/** What typing in the path bar means, before any folder is looked for. */
export type Typed =
  | { kind: "command"; text: string }
  | { kind: "terminal"; shell: "cmd" | "wt" | "powershell" | "pwsh" }
  | { kind: "nickname"; name: string; save: boolean }
  | { kind: "search"; text: string }
  | { kind: "path"; text: string };

const SHELLS = ["cmd", "wt", "powershell", "pwsh"] as const;

export function readTyped(typed: string): Typed {
  const text = typed.trim();
  const shell = SHELLS.find((name) => name === text.toLowerCase());
  if (shell) return { kind: "terminal", shell };
  if (text.startsWith(">")) return { kind: "command", text: text.slice(1).trim() };
  if (text.startsWith("?")) return { kind: "search", text: text.slice(1).trim() };
  if (text.startsWith("@")) {
    const save = text.endsWith("=");
    return { kind: "nickname", name: text.slice(1, save ? -1 : undefined).trim().toLowerCase(), save };
  }
  return { kind: "path", text };
}

/** Text with nothing of a path in it, which is searched for when no folder has that name. */
export const looksLikeName = (text: string) => !!text && !/[\\/:%~]/.test(text) && text !== "." && text !== "..";

/** The words for a step of the activity log that happened at `time`. */
export function dayOf(time: number, now: number) {
  if (time <= 0) return "Earlier";
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (time >= start.getTime()) return "Today";
  if (time >= start.getTime() - 86_400_000) return "Yesterday";
  return new Date(time).toLocaleDateString(undefined, { dateStyle: "medium" });
}
