import { cutShort, diffLines, spacesAside, type Line, type Open } from "./diff";

/** What the window asks: two texts' lines, whether spaces count, and which end open. */
export interface DiffAsk {
  a: string[];
  b: string[];
  spaces: boolean;
  open: Open;
}

/** What the worker answers: the lines, and whether a fuller answer is still to come. */
export interface DiffAnswer {
  lines: Line[];
  last: boolean;
}

const scope = self as unknown as { onmessage: (event: MessageEvent<DiffAsk>) => void; postMessage: (answer: DiffAnswer) => void };
scope.onmessage = ({ data }) => {
  const key = data.spaces ? spacesAside : undefined;
  const lines = diffLines(data.a, data.b, key, data.open);
  const more = cutShort;
  scope.postMessage({ lines, last: !more });
  // Out of time: shown as it is, then the shortest way, with no clock, takes its place.
  if (more) scope.postMessage({ lines: diffLines(data.a, data.b, key, data.open, Infinity), last: true });
};
