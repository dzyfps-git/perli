import assert from "node:assert/strict";
import { test } from "node:test";
import type { OfficeFacts } from "../../api";
import { asTabs, cellOf, colorRef, columnName, factsLine, overlaps, startsInOffice } from "./office.ts";

test("columns are named the way spreadsheets name them, and cells read back", () => {
  assert.deepEqual([0, 25, 26, 51, 701, 702].map(columnName), ["A", "Z", "AA", "AZ", "ZZ", "AAA"]);
  assert.deepEqual(cellOf(" b12 "), { row: 11, column: 1 });
  assert.deepEqual(cellOf("AA1"), { row: 0, column: 26 });
  for (let at = 0; at < 800; at += 37) assert.equal(cellOf(`${columnName(at)}1`)?.column, at);
  assert.equal(cellOf("A0"), null);
  assert.equal(cellOf("12"), null);
  assert.equal(cellOf("hello"), null);
});

test("shown rows copy as tab-separated text", () => {
  assert.equal(asTabs([["Name", 3, null], ["Ana", 1.5, "x"]]), "Name\t3\t\nAna\t1.5\tx");
  assert.equal(asTabs([["a\tb", "two\nlines", 'say "hi"', "plain"]]), '"a\tb"\t"two\nlines"\t"say ""hi"""\tplain');
});

test("Office's previewer shows first only when it is safe and wanted", () => {
  const facts: OfficeFacts = { family: "word", facts: [], macros: false, locked: false, marked: false, handler: true };
  assert.equal(startsInOffice(facts, true, true), true);
  assert.equal(startsInOffice(facts, false, true), false);
  assert.equal(startsInOffice({ ...facts, handler: false }, true, true), false);
  assert.equal(startsInOffice({ ...facts, locked: true }, true, true), false);
  assert.equal(startsInOffice({ ...facts, marked: true }, true, true), false);
  assert.equal(startsInOffice({ ...facts, marked: true }, true, false), true);
});

test("the facts line counts and names the author", () => {
  assert.equal(factsLine([["Pages", "12"], ["Words", "3,400"], ["Author", "Ana"], ["Created", "today"]]), "12 pages  ·  3,400 words  ·  Ana");
  assert.equal(factsLine([["Slides", "1"]]), "1 slide");
  assert.equal(factsLine([]), "");
});

test("page colours turn into Windows colours, red in the low byte", () => {
  assert.equal(colorRef("rgb(255, 0, 0)"), 0x0000ff);
  assert.equal(colorRef("rgba(1, 2, 3, 0.5)"), 0x030201);
  assert.equal(colorRef("transparent"), 0);
});

test("rectangles overlap only when they share area", () => {
  const box = (left: number, top: number, width: number, height: number) => ({ left, top, right: left + width, bottom: top + height }) as DOMRect;
  assert.equal(overlaps(box(0, 0, 10, 10), box(5, 5, 10, 10)), true);
  assert.equal(overlaps(box(0, 0, 10, 10), box(10, 0, 10, 10)), false);
  assert.equal(overlaps(box(0, 0, 10, 10), box(2, 2, 2, 2)), true);
});
