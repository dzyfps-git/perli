import assert from "node:assert/strict";
import { test } from "node:test";
import { matchSpans } from "./nameMatch.ts";

test("a name holding the whole query lights that run, whatever the case", () => {
  assert.deepEqual(matchSpans("Holiday Photos.zip", "PHOTO"), [[8, 13]]);
});

test("otherwise its letters light up in order, joined where they touch", () => {
  assert.deepEqual(matchSpans("report-final.docx", "rpfin"), [[0, 1], [2, 3], [7, 10]]);
});

test("a name missing a letter, or an empty query, lights nothing", () => {
  assert.deepEqual(matchSpans("notes.txt", "zz"), []);
  assert.deepEqual(matchSpans("notes.txt", ""), []);
});

test("the letters lit are the ones search's best fit scored, not the first found", () => {
  // From the second f the letters sit closer and the r starts a word, as search scores it.
  assert.deepEqual(matchSpans("fax_fab_r", "fbr"), [[4, 5], [6, 7], [8, 9]]);
  // A capital after a small letter starts a word too.
  assert.deepEqual(matchSpans("xmasMovie", "mv"), [[4, 5], [6, 7]]);
});

test("a letter outside the basic plane lights whole, never half of it", () => {
  assert.deepEqual(matchSpans("😀xb", "😀b"), [[0, 2], [3, 4]]);
});
