/** What changed between two texts, line by line and word by word. */

/** One line of a compare: in both texts, only in the first (gone), or only in the second (new). */
export interface Line {
  kind: "same" | "gone" | "new";
  /** Its number in the first text, from 0, when it is there. */
  a?: number;
  /** Its number in the second text, from 0, when it is there. */
  b?: number;
}

/** Past this many changes, the middle that differs is shown as all gone, then all new. */
const MOST_EDITS = 4000;

/** The shortest way from `a` to `b` (Myers), as lines kept, gone and new, in order. */
function edits<T>(a: T[], b: T[], from: number, to: number, lines: Line[], offA: number, offB: number) {
  const n = from;
  const m = to;
  const middle = n + m;
  const zero = middle + 1;
  const v = new Int32Array(2 * middle + 3);
  /** Where each line of changes reached, by diagonal, for walking back. */
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= Math.min(middle, MOST_EDITS) && found < 0; d++) {
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && v[zero + k - 1] < v[zero + k + 1]);
      let x = down ? v[zero + k + 1] : v[zero + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[offA + x] === b[offB + y]) {
        x++;
        y++;
      }
      v[zero + k] = x;
      if (x >= n && y >= m) found = d;
    }
    trace.push(v.slice(zero - d, zero + d + 1));
  }
  const out: Line[] = [];
  if (found < 0) {
    // ponytail: past MOST_EDITS changes the middle shows as one block; a linear-space Myers would split it finely.
    for (let x = 0; x < n; x++) out.push({ kind: "gone", a: offA + x });
    for (let y = 0; y < m; y++) out.push({ kind: "new", b: offB + y });
    lines.push(...out);
    return;
  }
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const before = trace[d - 1];
    const at = (k: number) => before[k + d - 1];
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const backK = down ? k + 1 : k - 1;
    const backX = at(backK);
    const backY = backX - backK;
    const startX = down ? backX : backX + 1;
    while (x > startX) out.push({ kind: "same", a: offA + --x, b: offB + --y });
    if (down) out.push({ kind: "new", b: offB + --y });
    else out.push({ kind: "gone", a: offA + --x });
  }
  while (x > 0) out.push({ kind: "same", a: offA + --x, b: offB + --y });
  lines.push(...out.reverse());
}

/** Lines of `a` and `b` in order, each marked same, gone or new. `key` says when two lines count as one. */
export function diffLines(a: string[], b: string[], key: (line: string) => string = (line) => line) {
  const keysA = a.map(key);
  const keysB = b.map(key);
  let start = 0;
  while (start < a.length && start < b.length && keysA[start] === keysB[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && keysA[a.length - 1 - end] === keysB[b.length - 1 - end]) end++;
  const lines: Line[] = [];
  for (let at = 0; at < start; at++) lines.push({ kind: "same", a: at, b: at });
  edits(keysA, keysB, a.length - start - end, b.length - start - end, lines, start, start);
  for (let at = end; at > 0; at--) lines.push({ kind: "same", a: a.length - at, b: b.length - at });
  return lines;
}

/** Runs of spaces count as one, and spaces at the ends not at all. */
export const spacesAside = (line: string) => line.replace(/\s+/g, " ").trim();

/** A text's lines, whatever ends them. */
export function linesOf(text: string) {
  const lines = text.split(/\r\n|\n|\r/);
  // The ending of the last line starts no line of its own.
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** The parts of two changed lines that differ, as [start, end) character spans in each. */
export function changedSpans(a: string, b: string) {
  const words = (text: string) => text.match(/\w+|\s+|[^\w\s]/gu) ?? [];
  const wordsA = words(a);
  const wordsB = words(b);
  const spans = { a: [] as [number, number][], b: [] as [number, number][] };
  const startsA = starts(wordsA);
  const startsB = starts(wordsB);
  for (const line of diffLines(wordsA, wordsB)) {
    if (line.kind === "gone") grow(spans.a, startsA[line.a!], startsA[line.a! + 1]);
    if (line.kind === "new") grow(spans.b, startsB[line.b!], startsB[line.b! + 1]);
  }
  return spans;
}

function starts(words: string[]) {
  const at = [0];
  for (const word of words) at.push(at[at.length - 1] + word.length);
  return at;
}

/** Adds a span, joined to the last one when they touch. */
function grow(spans: [number, number][], start: number, end: number) {
  const last = spans[spans.length - 1];
  if (last && last[1] === start) last[1] = end;
  else spans.push([start, end]);
}

/** A row of the side-by-side compare: lines in both, a change, or a run of same lines folded away. */
export type Row =
  | { kind: "same"; a: number; b: number }
  | { kind: "change"; a?: number; b?: number }
  | { kind: "fold"; lines: Line[] };

/** Same lines kept on show around each change. */
export const CONTEXT = 3;

/**
 * The lines as rows side by side: gone lines meet the new lines that took their place, and same
 * lines more than `context` away from a change fold into one row.
 */
export function rowsOf(lines: Line[], context = CONTEXT) {
  const rows: Row[] = [];
  let at = 0;
  while (at < lines.length) {
    if (lines[at].kind === "same") {
      let end = at;
      while (end < lines.length && lines[end].kind === "same") end++;
      const run = lines.slice(at, end);
      const keepTop = at === 0 ? 0 : context;
      const keepEnd = end === lines.length ? 0 : context;
      const same = (line: Line): Row => ({ kind: "same", a: line.a!, b: line.b! });
      if (run.length > keepTop + keepEnd + 1) {
        rows.push(...run.slice(0, keepTop).map(same));
        rows.push({ kind: "fold", lines: run.slice(keepTop, run.length - keepEnd) });
        rows.push(...run.slice(run.length - keepEnd).map(same));
      } else rows.push(...run.map(same));
      at = end;
      continue;
    }
    const gone: number[] = [];
    const fresh: number[] = [];
    while (at < lines.length && lines[at].kind !== "same") {
      if (lines[at].kind === "gone") gone.push(lines[at].a!);
      else fresh.push(lines[at].b!);
      at++;
    }
    for (let pair = 0; pair < Math.max(gone.length, fresh.length); pair++) rows.push({ kind: "change", a: gone[pair], b: fresh[pair] });
  }
  return rows;
}

/** The changes as a unified patch, the way `diff -u` writes one. */
export function patchOf(nameA: string, nameB: string, a: string[], b: string[], lines: Line[], context = CONTEXT) {
  const out = [`--- ${nameA}`, `+++ ${nameB}`];
  let at = 0;
  while (at < lines.length) {
    while (at < lines.length && lines[at].kind === "same") at++;
    if (at === lines.length) break;
    const start = Math.max(0, at - context);
    // A hunk runs on while the next change is near enough to share its context.
    let end = at;
    for (;;) {
      while (end < lines.length && lines[end].kind !== "same") end++;
      let next = end;
      while (next < lines.length && lines[next].kind === "same") next++;
      if (next < lines.length && next - end <= context * 2) end = next;
      else break;
    }
    end = Math.min(lines.length, end + context);
    const hunk = lines.slice(start, end);
    const firstA = hunk.find((line) => line.a !== undefined)?.a ?? previous(lines, start, "a");
    const firstB = hunk.find((line) => line.b !== undefined)?.b ?? previous(lines, start, "b");
    const countA = hunk.filter((line) => line.kind !== "new").length;
    const countB = hunk.filter((line) => line.kind !== "gone").length;
    out.push(`@@ -${countA ? firstA + 1 : firstA},${countA} +${countB ? firstB + 1 : firstB},${countB} @@`);
    for (const line of hunk) {
      out.push(line.kind === "same" ? ` ${a[line.a!]}` : line.kind === "gone" ? `-${a[line.a!]}` : `+${b[line.b!]}`);
    }
    at = end;
  }
  return out.join("\n") + "\n";
}

/** Where a hunk with no lines of one side sits in it: after the last line before it. */
function previous(lines: Line[], before: number, side: "a" | "b") {
  for (let at = before - 1; at >= 0; at--) if (lines[at][side] !== undefined) return lines[at][side]! + 1;
  return 0;
}
