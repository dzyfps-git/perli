import { createSignal } from "solid-js";
import { cancelCut, clipboardSequence } from "../../api";
import { samePath } from "../navigation/path";

/** Files waiting to move on the next paste, which fade until then. */
/** `names` fade in `folder`. `paths` are what is really cut, which for a search is more. */
const [mark, setMark] = createSignal<{ folder: string; names: Set<string>; paths: string[]; sequence: number }>();

/** What is cut now, for the chip on the sidebar. */
export const cutMark = mark;

export const markCut = (folder: string, names: string[], paths: string[], sequence: number) =>
  setMark({ folder, names: new Set(names), paths, sequence });

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
