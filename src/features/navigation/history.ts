/** Pure history moves, kept apart from Solid so they can be tested alone. */

/** Folders behind and ahead of the shown one. The last of each is the nearest. */
export interface History {
  back: string[];
  forward: string[];
}

/**
 * Where `steps` moves from `here` lead, and the history after them: back for a negative count,
 * forward for a positive one. Undefined when the history is not that long. The folders passed on
 * the way stay in the history, on the other side.
 */
export function jumped(history: History, here: string, steps: number) {
  const behind = steps < 0;
  const from = behind ? history.back : history.forward;
  const at = from.length - Math.abs(steps);
  if (steps === 0 || at < 0) return undefined;
  const passed = [here, ...from.slice(at + 1).reverse()];
  const kept = from.slice(0, at);
  const other = [...(behind ? history.forward : history.back), ...passed];
  return {
    target: from[at],
    back: behind ? kept : other,
    forward: behind ? other : kept,
  };
}

/** One folder of a history list, nearest first, with the steps that reach it. */
export function historyList(history: History, behind: boolean) {
  const from = behind ? history.back : history.forward;
  return from.map((path, index) => ({ path, steps: (from.length - index) * (behind ? -1 : 1) })).reverse();
}
