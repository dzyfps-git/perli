import { createSignal } from "solid-js";
import { typeNames } from "../../api";
import { typeLabel } from "./columns";

const known = new Map<string, string>();
let wanted = new Set<string>();

/** Changes whenever new names arrive, so lists know to repaint their type cells. */
export const [typesLearned, setTypesLearned] = createSignal(0);

async function askWindows() {
  const asked = [...wanted];
  wanted = new Set();
  const names = await typeNames(asked).catch((error) => {
    console.error(error);
    return {} as Record<string, string>;
  });
  for (const extension of asked) known.set(extension, names[extension] ?? `${extension.toUpperCase()} file`);
  setTypesLearned(typesLearned() + 1);
}

/** Windows' name for this file's type. Shows a plain one until Windows answers. */
export function typeText(name: string, isDir: boolean) {
  const dot = name.lastIndexOf(".");
  if (isDir || dot < 0) return typeLabel(name, isDir);

  const extension = name.slice(dot + 1).toLowerCase();
  const found = known.get(extension);
  if (found !== undefined) return found;
  if (wanted.size === 0) queueMicrotask(askWindows);
  wanted.add(extension);
  return typeLabel(name, isDir);
}
