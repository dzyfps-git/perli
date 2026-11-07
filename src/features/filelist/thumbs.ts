import type { Thumb } from "../../api";

// Shared by all lists, because a tab or a split pane often shows the same files.
const MAX_BYTES = 64 * 1024 * 1024;
/** What a file with no picture costs, which is only its place in the cache. */
const NO_PICTURE_BYTES = 64;
const AT_ONCE = 4;

const cache = new Map<string, Thumb | null>();
let bytes = 0;

const weight = (thumb: Thumb | null) => thumb?.pixels.length ?? NO_PICTURE_BYTES;

/** The file's picture, null if it has none, or undefined if that is not known yet. */
export function cachedThumb(key: string) {
  const thumb = cache.get(key);
  if (thumb === undefined) return undefined;
  cache.delete(key);
  cache.set(key, thumb);
  return thumb;
}

function remember(key: string, thumb: Thumb | null) {
  const before = cache.get(key);
  if (before !== undefined) bytes -= weight(before);
  cache.set(key, thumb);
  bytes += weight(thumb);
  for (const [oldest, old] of cache) {
    if (bytes <= MAX_BYTES) break;
    cache.delete(oldest);
    bytes -= weight(old);
  }
}

/**
 * Fetches pictures a few at a time, newest request first, so the rows the user scrolled to come
 * before the ones they scrolled past. Rows no longer `wanted` are never fetched.
 */
export function createThumbLoader(
  fetch: (index: number) => Promise<Thumb | null>,
  wanted: (index: number, key: string) => boolean,
  ready: (index: number, key: string) => void,
) {
  /** Where each key asked for sits now, since a new order can move it while it waits. */
  const asked = new Map<string, number>();
  const waiting: string[] = [];
  let running = 0;

  function fetchNext() {
    while (running < AT_ONCE && waiting.length > 0) {
      const key = waiting.pop()!;
      const index = asked.get(key)!;
      if (!wanted(index, key)) {
        asked.delete(key);
        continue;
      }
      running++;
      fetch(index)
        .then((thumb) => {
          remember(key, thumb);
          const now = asked.get(key)!;
          if (wanted(now, key)) ready(now, key);
        })
        .catch(console.error)
        .finally(() => {
          asked.delete(key);
          running--;
          fetchNext();
        });
    }
  }

  return {
    ask(index: number, key: string) {
      if (!asked.has(key)) waiting.push(key);
      asked.set(key, index);
      fetchNext();
    },
  };
}
