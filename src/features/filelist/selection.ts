/** Which rows are selected, by row index. */
export function createSelection() {
  let selected = new Set<number>();
  let focused = -1;
  let anchor = -1;

  function range(from: number, to: number) {
    const low = Math.min(from, to);
    return Array.from({ length: Math.abs(to - from) + 1 }, (_, offset) => low + offset);
  }

  return {
    has: (index: number) => selected.has(index),
    focused: () => focused,
    size: () => selected.size,
    /** Every selected row, with the focused one first. */
    rows: () => [...selected].sort((a, b) => Number(b === focused) - Number(a === focused)),

    /** Selects `rows` and focuses the first one. */
    restore(rows: number[]) {
      selected = new Set(rows);
      focused = anchor = rows[0] ?? -1;
    },

    clear() {
      selected = new Set();
      focused = anchor = -1;
    },

    select(index: number) {
      selected = new Set([index]);
      focused = anchor = index;
    },

    toggle(index: number) {
      if (!selected.delete(index)) selected.add(index);
      focused = anchor = index;
    },

    /** Selects from the anchor to `index`. `keep` also keeps what was already selected. */
    extendTo(index: number, keep: boolean) {
      const start = anchor < 0 ? index : anchor;
      selected = new Set([...(keep ? selected : []), ...range(start, index)]);
      anchor = start;
      focused = index;
    },

    selectAll(count: number) {
      selected = new Set(Array.from({ length: count }, (_, index) => index));
    },
  };
}
