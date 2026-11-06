import { createSignal } from "solid-js";
import { cancelCut, clipboardSequence } from "../../api";
import { samePath } from "../navigation/path";

/** Files waiting to move on the next paste, which fade until then. */
const [mark, setMark] = createSignal<{ folder: string; names: Set<string>; sequence: number }>();

export const markCut = (folder: string, names: string[], sequence: number) =>
  setMark({ folder, names: new Set(names), sequence });

export const forgetCut = () => setMark(undefined);

export function cutNames(folder: string) {
  const current = mark();
  return current && samePath(current.folder, folder) ? current.names : undefined;
}

/** Without this, a later paste would move files that no longer look marked. */
export function takeBackCut() {
  const current = mark();
  if (!current) return;
  setMark(undefined);
  cancelCut(current.sequence).catch(console.error);
}

/** Another app may have copied something while Perli was in the background. */
export async function checkCut() {
  const current = mark();
  if (current && (await clipboardSequence()) !== current.sequence) setMark(undefined);
}
