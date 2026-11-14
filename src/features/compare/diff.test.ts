import assert from "node:assert/strict";
import { test } from "node:test";
import { changedSpans, diffLines, linesOf, patchOf, rowsOf, spacesAside, type Line } from "./diff.ts";

const marks = (lines: Line[], a: string[], b: string[]) =>
  lines.map((line) => (line.kind === "same" ? ` ${a[line.a!]}` : line.kind === "gone" ? `-${a[line.a!]}` : `+${b[line.b!]}`));

test("lines are kept, gone or new, in order", () => {
  const a = ["one", "two", "three", "four"];
  const b = ["one", "2", "three", "four", "five"];
  assert.deepEqual(marks(diffLines(a, b), a, b), [" one", "-two", "+2", " three", " four", "+five"]);
  assert.deepEqual(marks(diffLines([], ["x"]), [], ["x"]), ["+x"]);
  assert.deepEqual(marks(diffLines(["x"], []), ["x"], []), ["-x"]);
  assert.deepEqual(diffLines([], []), []);
});

test("the shortest way through keeps every line the two texts share", () => {
  const a = "a b c a b b a".split(" ");
  const b = "c b a b a c".split(" ");
  const lines = diffLines(a, b);
  // Myers' own example: seven lines and six, with four in common, take five changes.
  assert.equal(lines.filter((line) => line.kind !== "same").length, 5);
  for (const line of lines) if (line.kind === "same") assert.equal(a[line.a!], b[line.b!]);
  assert.deepEqual(
    lines.filter((line) => line.kind !== "new").map((line) => line.a),
    a.map((_, at) => at),
  );
  assert.deepEqual(
    lines.filter((line) => line.kind !== "gone").map((line) => line.b),
    b.map((_, at) => at),
  );
});

test("spaces can be set aside", () => {
  const a = ["if (x)  {", "\treturn;"];
  const b = ["if (x) {", "  return;  "];
  assert.ok(diffLines(a, b, spacesAside).every((line) => line.kind === "same"));
  assert.equal(diffLines(a, b).filter((line) => line.kind === "same").length, 0);
});

test("any line ending splits lines", () => {
  assert.deepEqual(linesOf("a\r\nb\nc\rd"), ["a", "b", "c", "d"]);
});

test("the ending of the last line starts no line of its own", () => {
  assert.deepEqual(linesOf("one\r\ntwo\r\n"), ["one", "two"]);
  assert.deepEqual(linesOf("one\n\n"), ["one", ""]);
  assert.deepEqual(linesOf(""), []);
});

test("only the words that changed are marked", () => {
  const spans = changedSpans("the quick brown fox", "the slow brown fox jumps");
  assert.deepEqual(spans.a, [[4, 9]]);
  assert.deepEqual(spans.b, [[4, 8], [18, 24]]);
});

test("gone lines meet the new ones beside them, and long same runs fold", () => {
  const a = Array.from({ length: 20 }, (_, at) => `line ${at}`);
  const b = [...a];
  b[10] = "changed";
  b.splice(15, 0, "added");
  const rows = rowsOf(diffLines(a, b), 2);
  assert.deepEqual(
    rows.map((row) => (row.kind === "fold" ? `fold ${row.lines.length}` : row.kind)),
    ["fold 8", "same", "same", "change", "same", "same", "same", "same", "change", "same", "same", "fold 3"],
  );
  const change = rows.find((row) => row.kind === "change");
  assert.deepEqual(change, { kind: "change", a: 10, b: 10 });
});

test("a run too short to fold stays as it is", () => {
  const rows = rowsOf(diffLines(["a", "b", "c", "x"], ["a", "b", "c", "y"]), 3);
  assert.deepEqual(
    rows.map((row) => row.kind),
    ["same", "same", "same", "change"],
  );
});

test("a patch reads like diff -u", () => {
  const a = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
  const b = ["one", "two", "THREE", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven"];
  assert.equal(
    patchOf("a.txt", "b.txt", a, b, diffLines(a, b), 1),
    ["--- a.txt", "+++ b.txt", "@@ -2,3 +2,3 @@", " two", "-three", "+THREE", " four", "@@ -10,1 +10,2 @@", " ten", "+eleven", ""].join("\n"),
  );
  // Nothing of the first text in the hunk: it sits after the line before.
  assert.equal(patchOf("a", "b", [], ["x"], diffLines([], ["x"]), 3), "--- a\n+++ b\n@@ -0,0 +1,1 @@\n+x\n");
});
