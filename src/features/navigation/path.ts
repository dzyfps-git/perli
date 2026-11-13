export interface Crumb {
  label: string;
  path: string;
}

/** Stands for the Recycle Bin, which has no folder of its own to open. */
export const BIN_PATH = "shell:RecycleBinFolder";

export const isBin = (path: string | undefined) => path === BIN_PATH;

export const isDriveRoot = (path: string) => /^[a-z]:\\$/i.test(path);

/** Splits `C:\Users\me` into one crumb per folder, starting at the drive or the `\\server`. */
export function toCrumbs(path: string): Crumb[] {
  if (isBin(path)) return [{ label: "Recycle Bin", path }];
  const parts = path.split("\\").filter(Boolean);
  const network = path.startsWith("\\\\");
  if (network) parts[0] = `\\\\${parts[0]}`;
  return parts.map((label, index) => ({
    label,
    path: index === 0 && !network ? `${label}\\` : parts.slice(0, index + 1).join("\\"),
  }));
}

export function parentOf(path: string): string | undefined {
  return toCrumbs(path).at(-2)?.path;
}

export function join(folder: string, name: string) {
  return folder.endsWith("\\") ? `${folder}${name}` : `${folder}\\${name}`;
}

export const baseName = (path: string) => path.slice(path.lastIndexOf("\\") + 1);

/**
 * Where `relative`, as a document in `folder` writes it, points: either slash, `.` and `..`,
 * and `%20` for spaces. `..` never climbs above the drive or share.
 */
export function resolveRelative(folder: string, relative: string) {
  let decoded = relative.replace(/[?#].*$/, "");
  try {
    decoded = decodeURI(decoded);
  } catch {
    // A stray % is part of the name.
  }
  const network = folder.startsWith("\\\\");
  const parts = folder.replace(/^\\\\/, "").replace(/\\+$/, "").split("\\");
  const root = network ? 2 : 1;
  for (const part of decoded.split(/[\\/]/)) {
    if (part === "..") {
      if (parts.length > root) parts.pop();
    } else if (part && part !== ".") parts.push(part);
  }
  const path = parts.join("\\");
  if (network) return `\\\\${path}`;
  return parts.length === 1 ? `${path}\\` : path;
}

/** What to open for text typed into the path bar. Text with no drive is read from `folder`. */
export function typedPath(folder: string, text: string) {
  const path = text.trim().replace(/^"|"$/g, "");
  if (/^[a-z]:$/i.test(path)) return `${path}\\`;
  return /^([a-z]:[\\/]|[\\/]{2}|shell:)/i.test(path) ? path : join(folder, path);
}

export function samePath(a: string | undefined, b: string) {
  return a?.toLowerCase() === b.toLowerCase();
}

function isInside(path: string, folder: string) {
  const a = path.toLowerCase();
  const b = folder.toLowerCase();
  return a === b || a.startsWith(b.endsWith("\\") ? b : `${b}\\`);
}

/** `path` as seen from `folder`. The folder itself is empty, and anywhere else stays whole. */
export function relativeTo(folder: string, path: string) {
  if (samePath(path, folder)) return "";
  return isInside(path, folder) ? path.slice(join(folder, "").length) : path;
}

/**
 * Where a linked pane showing `other` goes when its partner moved from `from` to `to`: as deep
 * into its own folder, or as many folders up. Undefined for any other move.
 */
export function followed(from: string, to: string, other: string) {
  if (samePath(from, to) || isBin(from) || isBin(to) || isBin(other)) return undefined;
  if (isInside(to, from)) return join(other, relativeTo(from, to));
  if (!isInside(from, to)) return undefined;
  const levels = toCrumbs(from).length - toCrumbs(to).length;
  return toCrumbs(other).at(-1 - levels)?.path;
}

/** The same folder, as Perli writes it once opened: either slash, and no slash at the end. */
export function sameFolder(a: string, b: string) {
  const plain = (path: string) => {
    const slashed = path.replaceAll("/", "\\").toLowerCase();
    const trimmed = slashed.replace(/\\+$/, "");
    return trimmed.endsWith(":") ? `${trimmed}\\` : trimmed;
  };
  return plain(a) === plain(b);
}

/**
 * Where a linked pane goes when the other arrives at `to` from `from`, or nowhere. `going` is
 * where the tab itself was taking the mover: arriving there is the tab's doing, not the user's,
 * so it leads nowhere. `other` is where the other pane is, or is on its way to.
 */
export function followTarget(from: string, to: string, going: string | undefined, linked: boolean, other: string | undefined) {
  if (going !== undefined && sameFolder(going, to)) return undefined;
  return linked && other ? followed(from, to, other) : undefined;
}

/**
 * The deepest path to show in the path bar. Going up keeps the folders you came
 * from, so you can jump back into them. Going anywhere else starts a new trail.
 */
export function nextTrail(trail: string, path: string) {
  return trail && isInside(trail, path) ? trail : path;
}
