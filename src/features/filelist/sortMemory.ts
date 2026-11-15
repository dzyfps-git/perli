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

/**
 * What applies to a folder from a memory where some entries also cover the folders inside:
 * its own entry first, then the nearest folder above it whose entry has `below` set.
 */
export function coveringEntry<T extends { below?: boolean }>(memory: Record<string, T>, path: string) {
  let key = folderKey(path);
  if (memory[key]) return { key, value: memory[key] };
  for (let at = key.lastIndexOf("\\"); at > 0; at = key.lastIndexOf("\\")) {
    key = key.slice(0, at);
    // A drive root keeps its trailing slash.
    const found = [key, `${key}\\`].find((candidate) => memory[candidate]?.below);
    if (found) return { key: found, value: memory[found] };
  }
  return undefined;
}
