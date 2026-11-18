import { diffLines, spacesAside, type Line, type Open } from "./diff";

/** What the window asks: two texts' lines, whether spaces count, and which end open. */
export interface DiffAsk {
  a: string[];
  b: string[];
  spaces: boolean;
  open: Open;
}

const scope = self as unknown as { onmessage: (event: MessageEvent<DiffAsk>) => void; postMessage: (lines: Line[]) => void };
scope.onmessage = ({ data }) => scope.postMessage(diffLines(data.a, data.b, data.spaces ? spacesAside : undefined, data.open));
