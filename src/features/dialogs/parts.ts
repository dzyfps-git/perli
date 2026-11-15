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

/* The picker: Perli's own way to open and save files and choose folders. */

const two = (value: number) => String(value).padStart(2, "0");

/** `name` with the day before its extension, in place of a day it had: `Perli keys 2026-11-15.json`. */
export function datedName(name: string, now = new Date()) {
  const dot = name.lastIndexOf(".");
  const stem = (dot > 0 ? name.slice(0, dot) : name).replace(/\s+\d{4}-\d{2}-\d{2}$/, "");
  const day = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
  return `${stem} ${day}${dot > 0 ? name.slice(dot) : ""}`;
}

/** Where the name stops and its extension starts, to select only the name. */
export function stemEnd(name: string) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? dot : name.length;
}

/** `name` ending in `.extension`, which is added when it is missing. */
export const withExtension = (name: string, extension: string) =>
  name.toLowerCase().endsWith(`.${extension.toLowerCase()}`) ? name : `${name}.${extension}`;

/** Why Windows would refuse `name` for a file, or nothing when it would take it. */
export function nameProblem(name: string) {
  if (!name.trim()) return "Type a name";
  // eslint-disable-next-line no-control-regex
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(name)) return 'A name can\'t hold < > : " / \\ | ? or *';
  if (/[. ]$/.test(name)) return "A name can't end with a dot or a space";
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(name)) return "Windows keeps that name for itself";
  return undefined;
}

/** True when what was typed is a place to go, not only a name. */
export const isTypedPath = (text: string) => /[\\/]|^[a-z]:/i.test(text.trim());

/** Which way the list slides, going from `from` to `to`: into a folder, back out of one, or neither. */
export function slideOf(from: string | undefined, to: string): "in" | "out" | undefined {
  if (!from) return undefined;
  const inside = (path: string, folder: string) => {
    const below = folder.toLowerCase().endsWith("\\") ? folder.toLowerCase() : `${folder.toLowerCase()}\\`;
    return path.toLowerCase().startsWith(below) && path.length > below.length;
  };
  if (inside(to, from)) return "in";
  if (inside(from, to)) return "out";
  return undefined;
}

/** True when `name`'s extension is one of `types`, lowercase with no dots. No types takes any. */
export function fitsTypes(name: string, types: string[] | undefined) {
  if (!types?.length) return true;
  const dot = name.lastIndexOf(".");
  return dot > 0 && types.includes(name.slice(dot + 1).toLowerCase());
}
