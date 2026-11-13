import type { Sort } from "../../api";

// About 60 KB at most, which keeps writing it after a sort cheap.
const MAX_FOLDERS = 1000;

export type SortMemory = Record<string, Sort>;

/** Windows paths ignore case, and only drive roots need their trailing slash. */
export const folderKey = (path: string) => path.toLowerCase().replace(/(?<!:)\\+$/, "");

/** Adds what a folder keeps, such as its sort, as the newest entry, dropping the oldest once full. No value forgets it. */
export function remembered<T>(memory: Record<string, T>, path: string, value: T | undefined): Record<string, T> {
  const key = folderKey(path);
  const others = Object.entries(memory).filter(([folder]) => folder !== key);
  const kept = value === undefined ? others : [...others, [key, value] as const];
  return Object.fromEntries(kept.slice(-MAX_FOLDERS));
}
