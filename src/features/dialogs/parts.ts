/** Small pieces of Perli's own versions of Windows' dialogs, kept apart so they can be tested. */

/** The last part of a path. A drive is its own name. */
export function nameOf(path: string) {
  const trimmed = path.replace(/\\+$/, "");
  return trimmed.includes("\\") ? trimmed.slice(trimmed.lastIndexOf("\\") + 1) : path;
}

/** The folder a path is in, or nothing for a drive or a share, which are in no folder. */
export function parentOf(path: string) {
  const trimmed = path.replace(/\\+$/, "");
  const cut = trimmed.lastIndexOf("\\");
  if (cut < 0) return undefined;
  const parent = trimmed.slice(0, cut);
  if (parent === "\\" || /^\\\\[^\\]*$/.test(parent)) return undefined;
  return /^[a-z]:$/i.test(parent) ? `${parent}\\` : parent;
}

export const counted = (count: number, one: string, many: string) =>
  `${count.toLocaleString()} ${count === 1 ? one : many}`;

/** "2 files, 1 folder", leaving out the kind there is none of. */
export function contents(files: number, folders: number) {
  const parts = [files > 0 && counted(files, "file", "files"), folders > 0 && counted(folders, "folder", "folders")];
  return parts.filter(Boolean).join(", ");
}

/**
 * A share as Windows wants it, from the ways people write one: `//server/share`,
 * `smb://server/share`, or with the slashes missing at the front.
 */
export function shareText(typed: string) {
  const plain = typed
    .trim()
    .replace(/^smb:/i, "")
    .replaceAll("/", "\\")
    .replace(/^\\+/, "")
    .replace(/\\+$/, "");
  return plain ? `\\\\${plain}` : "";
}

/** True for `\\server\share`, with or without folders after it. */
export const isShare = (text: string) => /^\\\\[^\\/"<>|]+\\[^\\/"<>|]+(\\.*)?$/.test(text);

/** Shares mapped before, newest first, without `added` twice. */
export const withShare = (known: string[], added: string, most = 5) =>
  [added, ...known.filter((share) => share.toLowerCase() !== added.toLowerCase())].slice(0, most);

/** Label and value lines as text to paste somewhere, skipping the empty ones. */
export const detailsText = (lines: [label: string, value: string | undefined | false][]) =>
  lines.flatMap(([label, value]) => (value ? `${label}: ${value}` : [])).join("\n");

/** Apps whose name has every word of `query`, in the order given. */
export function matching<T extends { name: string }>(apps: T[], query: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return apps.filter((app) => words.every((word) => app.name.toLowerCase().includes(word)));
}
