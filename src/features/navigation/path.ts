export interface Crumb {
  label: string;
  path: string;
}

/** Splits `C:\Users\me` into one crumb per folder, starting at the drive. */
export function toCrumbs(path: string): Crumb[] {
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

function isInside(path: string, folder: string) {
  const a = path.toLowerCase();
  const b = folder.toLowerCase();
  return a === b || a.startsWith(b.endsWith("\\") ? b : `${b}\\`);
}

/**
 * The deepest path to show in the path bar. Going up keeps the folders you came
 * from, so you can jump back into them. Going anywhere else starts a new trail.
 */
export function nextTrail(trail: string, path: string) {
  return trail && isInside(trail, path) ? trail : path;
}
