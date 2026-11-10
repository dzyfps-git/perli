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
