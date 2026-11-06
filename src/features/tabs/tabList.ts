/** Pure tab order rules, kept apart from Solid so they can be tested alone. */

/** Which tab becomes active when `closing` closes: the next one, otherwise the previous. */
export function nextActive<T>(tabs: T[], closing: T, active: T) {
  if (closing !== active) return active;
  const index = tabs.indexOf(closing);
  return tabs[index + 1] ?? tabs[index - 1];
}

/** Moves `tab` by `offset` places and stops at the ends. */
export function moved<T>(tabs: T[], tab: T, offset: number) {
  const from = tabs.indexOf(tab);
  const to = Math.min(tabs.length - 1, Math.max(0, from + offset));
  const result = tabs.filter((other) => other !== tab);
  result.splice(to, 0, tab);
  return result;
}

/** The pane beside `pane`, if the tab has two. */
export function otherPane<T>(panes: T[], pane: T) {
  return panes.find((other) => other !== pane);
}

/** The tab `offset` places away, wrapping around the ends. */
export function cycled<T>(tabs: T[], active: T, offset: number) {
  const index = tabs.indexOf(active);
  return tabs[(index + offset + tabs.length) % tabs.length];
}
