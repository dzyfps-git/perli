/** Reads `aria-keyshortcuts`, where a space separates keys that do the same thing. */
export function shortcutText(keys: string) {
  return keys.replaceAll("Control", "Ctrl").replaceAll("Arrow", "").split(" ").join(" or ");
}
