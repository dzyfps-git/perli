/** What changed between two texts, line by line and word by word. */

/** One line of a compare: in both texts, only in the first (gone), or only in the second (new). */
export interface Line {
  kind: "same" | "gone" | "new";
  /** Its number in the first text, from 0, when it is there. */
  a?: number;
  /** Its number in the second text, from 0, when it is there. */
  b?: number;
}

/**
 * Past this many changes in one stretch the search looks at the clock, and once a compare has
 * searched for `BUDGET_MS` it splits where it got furthest, as GNU diff does: only then may a few
 * more lines show as changed than had to, and a compare never stalls. It runs in a worker.
 */
const COSTLY = 4096;
const BUDGET_MS = 3000;
/** When the compare under way stops looking for the shortest way. */
let deadline = Infinity;

/**
 * The shortest way from a[aLo, aHi) to b[bLo, bHi), as lines kept, gone and new, onto `lines` in
 * order. Myers' linear-space way: find the middle stretch of the shortest path, then each side.
 */
function edits<T>(a: T[], b: T[], aLo: number, aHi: number, bLo: number, bHi: number, lines: Line[]) {
  // Lines alike at either end are kept as they are.
  while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) lines.push({ kind: "same", a: aLo++, b: bLo++ });
  let tail = 0;
  while (aLo < aHi - tail && bLo < bHi - tail && a[aHi - 1 - tail] === b[bHi - 1 - tail]) tail++;
  aHi -= tail;
  bHi -= tail;
  if (aLo === aHi) for (let y = bLo; y < bHi; y++) lines.push({ kind: "new", b: y });
  else if (bLo === bHi) for (let x = aLo; x < aHi; x++) lines.push({ kind: "gone", a: x });
  else {
    const [x, y, u, v] = middle(a, b, aLo, aHi, bLo, bHi);
    edits(a, b, aLo, x, bLo, y, lines);
    for (let at = 0; at < u - x; at++) lines.push({ kind: "same", a: x + at, b: y + at });
    edits(a, b, u, aHi, v, bHi, lines);
  }
  for (let at = 0; at < tail; at++) lines.push({ kind: "same", a: aHi + at, b: bHi + at });
}

/**
 * The middle stretch of the shortest way through two runs that differ at both ends, as [x, y]
 * where it starts and [u, v] where it ends: searched for from the start and from the end at once,
 * until the two searches meet.
 */
function middle<T>(a: T[], b: T[], aLo: number, aHi: number, bLo: number, bHi: number): [number, number, number, number] {
  const n = aHi - aLo;
  const m = bHi - bLo;
  const delta = n - m;
  const odd = (delta & 1) !== 0;
  const full = Math.ceil((n + m) / 2);
  const zero = full + 1;
  /** How far along a each diagonal the search from the start got, and the one from the end. */
  const ahead = new Int32Array(2 * full + 3);
  const behind = new Int32Array(2 * full + 3);
  /** The last round both searches finished. */
  let most = full;
  for (let d = 0; d <= full; d++) {
    if (d > COSTLY && (d & 63) === 0 && performance.now() > deadline) {
      most = d - 1;
      break;
    }
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && ahead[zero + k - 1] < ahead[zero + k + 1]) ? ahead[zero + k + 1] : ahead[zero + k - 1] + 1;
      let y = x - k;
      const [x0, y0] = [x, y];
      while (x < n && y < m && a[aLo + x] === b[bLo + y]) {
        x++;
        y++;
      }
      ahead[zero + k] = x;
      // The diagonal the search from the end sees this one as.
      const other = delta - k;
      if (odd && other >= 1 - d && other <= d - 1 && x + behind[zero + other] >= n) return [aLo + x0, bLo + y0, aLo + x, bLo + y];
    }
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && behind[zero + k - 1] < behind[zero + k + 1]) ? behind[zero + k + 1] : behind[zero + k - 1] + 1;
      let y = x - k;
      const [x0, y0] = [x, y];
      while (x < n && y < m && a[aHi - 1 - x] === b[bHi - 1 - y]) {
        x++;
        y++;
      }
      behind[zero + k] = x;
      const other = delta - k;
      if (!odd && other >= -d && other <= d && x + ahead[zero + other] >= n) return [aHi - x, bHi - y, aHi - x0, bHi - y0];
    }
  }
  // Too many changes to finish: split where the search from the start got furthest, so each side
  // is smaller. All gone, then all new, if it got nowhere.
  let [bestX, bestY] = [0, 0];
  for (let k = -most; k <= most; k += 2) {
    const x = ahead[zero + k];
    const y = x - k;
    if (x <= n && y >= 0 && y <= m && x + y > bestX + bestY && x + y < n + m) [bestX, bestY] = [x, y];
  }
  if (bestX + bestY === 0) [bestX, bestY] = [n, 0];
  return [aLo + bestX, bLo + bestY, aLo + bestX, bLo + bestY];
}

/** Within each run of changes the gone lines come first, the way `diff -u` writes them. */
function goneFirst(lines: Line[]) {
  for (let at = 0; at < lines.length; ) {
    let end = at;
    while (end < lines.length && lines[end].kind !== "same") end++;
    if (end > at) {
      const run = lines.slice(at, end);
      let put = at;
      for (const line of run) if (line.kind === "gone") lines[put++] = line;
      for (const line of run) if (line.kind === "new") lines[put++] = line;
    }
    at = Math.max(end, at + 1);
  }
}

/** Which of two texts end with no line ending after their last line. */
export type Open = readonly [boolean, boolean];

/**
 * Lines of `a` and `b` in order, each marked same, gone or new. `key` says when two lines count as
 * one. A last line with no ending (`open`) never counts as one with a last line that has one.
 */
export function diffLines(a: string[], b: string[], key: (line: string) => string = (line) => line, open: Open = [false, false]) {
  const keysA = a.map(key);
  const keysB = b.map(key);
  // No line holds a line ending, so one on the key marks the open end and matches nothing else.
  if (open[0] && keysA.length) keysA[keysA.length - 1] += "\n";
  if (open[1] && keysB.length) keysB[keysB.length - 1] += "\n";
  // A line on one side only can't be kept, so those are set aside before the search, as GNU diff
  // does: the shortest way stays the same, and the search goes through only lines that may match.
  const [inA, inB] = [new Set(keysA), new Set(keysB)];
  const keptA = keysA.flatMap((line, at) => (inB.has(line) ? [at] : []));
  const keptB = keysB.flatMap((line, at) => (inA.has(line) ? [at] : []));
  const found: Line[] = [];
  deadline = performance.now() + BUDGET_MS;
  edits(keptA.map((at) => keysA[at]), keptB.map((at) => keysB[at]), 0, keptA.length, 0, keptB.length, found);
  // Back in place, with the lines set aside where they were.
  const lines: Line[] = [];
  let [x, y] = [0, 0];
  const goneTo = (end: number) => {
    for (; x < end; x++) lines.push({ kind: "gone", a: x });
  };
  const newTo = (end: number) => {
    for (; y < end; y++) lines.push({ kind: "new", b: y });
  };
  for (const line of found) {
    if (line.a !== undefined) goneTo(keptA[line.a]);
    if (line.b !== undefined) newTo(keptB[line.b]);
    if (line.kind === "same") lines.push({ kind: "same", a: x++, b: y++ });
    else if (line.kind === "gone") lines.push({ kind: "gone", a: x++ });
    else lines.push({ kind: "new", b: y++ });
  }
  goneTo(a.length);
  newTo(b.length);
  goneFirst(lines);
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

/** True when a text's last line has no line ending after it. */
export const endsOpen = (text: string) => text !== "" && !/[\r\n]$/.test(text);

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

/** The changes as a unified patch, the way `diff -u` writes one, open ends marked as it marks them. */
export function patchOf(nameA: string, nameB: string, a: string[], b: string[], lines: Line[], context = CONTEXT, open: Open = [false, false]) {
  const noEnd = (line: Line) => (line.kind === "new" ? open[1] && line.b === b.length - 1 : open[0] && line.a === a.length - 1);
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
      if (noEnd(line)) out.push("\\ No newline at end of file");
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
