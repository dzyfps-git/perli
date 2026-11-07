export interface Crumb {
  label: string;
  path: string;
}

/** Stands for the Recycle Bin, which has no folder of its own to open. */
export const BIN_PATH = "shell:RecycleBinFolder";

export const isBin = (path: string | undefined) => path === BIN_PATH;

/** Splits `C:\Users\me` into one crumb per folder, starting at the drive. */
export function toCrumbs(path: string): Crumb[] {
  if (isBin(path)) return [{ label: "Recycle Bin", path }];
  const parts = path.split("\\").filter(Boolean);
  return parts.map((label, index) => ({
    label,
    path: index === 0 ? `${label}\\` : parts.slice(0, index + 1).join("\\"),
  }));
}

export function parentOf(path: string): string | undefined {
  return toCrumbs(path).at(-2)?.path;
}

export function join(folder: string, name: string) {
  return folder.endsWith("\\") ? `${folder}${name}` : `${folder}\\${name}`;
}

export const baseName = (path: string) => path.slice(path.lastIndexOf("\\") + 1);

/** What to open for text typed into the path bar. Text with no drive is read from `folder`. */
export function typedPath(folder: string, text: string) {
  const path = text.trim().replace(/^"|"$/g, "");
  if (/^[a-z]:$/i.test(path)) return `${path}\\`;
  return /^([a-z]:[\\/]|\\\\|shell:)/i.test(path) ? path : join(folder, path);
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
 * The deepest path to show in the path bar. Going up keeps the folders you came
 * from, so you can jump back into them. Going anywhere else starts a new trail.
 */
export function nextTrail(trail: string, path: string) {
  return trail && isInside(trail, path) ? trail : path;
}
