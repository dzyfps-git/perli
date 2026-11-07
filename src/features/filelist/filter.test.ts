import assert from "node:assert/strict";
import { test } from "node:test";
import { filterActive, NO_FILTER, parseSize, sizesAreGood, toFilter } from "./filter.ts";

test("sizes read in any unit and case", () => {
  assert.equal(parseSize("512"), 512);
  assert.equal(parseSize("1 KB"), 1024);
  assert.equal(parseSize("1.5mb"), 1572864);
  assert.equal(parseSize(" 2 g "), 2147483648);
  assert.equal(parseSize("0"), 0);
});

test("no text is no limit, and wrong text is no size", () => {
  assert.equal(parseSize("  "), null);
  assert.equal(parseSize("big"), undefined);
  assert.equal(parseSize("1 PB"), undefined);
  assert.equal(sizesAreGood({ ...NO_FILTER, minSize: "big" }), false);
  assert.equal(sizesAreGood({ ...NO_FILTER, minSize: "1 kb", maxSize: "" }), true);
});

test("a huge size stays a whole number Rust can read", () => {
  assert.equal(parseSize("99999999999 TB"), Number.MAX_SAFE_INTEGER);
});

test("types lose their dots and case, whatever separates them", () => {
  const { extensions } = toFilter({ ...NO_FILTER, types: " JPG, .png;*.Txt  gz " });
  assert.deepEqual(extensions, ["jpg", "png", "txt", "gz"]);
});

test("dates cover the whole of their day", () => {
  const { modifiedFrom, modifiedTo } = toFilter({ ...NO_FILTER, from: "2026-03-05", to: "2026-03-05" });
  assert.equal(modifiedTo! - modifiedFrom!, 24 * 60 * 60 * 1000 - 1);
  assert.equal(new Date(modifiedFrom!).getHours(), 0);
});

test("only a form that asks for something is active", () => {
  assert.equal(filterActive(NO_FILTER), false);
  assert.equal(filterActive({ ...NO_FILTER, name: "  " }), false);
  assert.equal(filterActive({ ...NO_FILTER, kinds: "files" }), true);
  assert.equal(filterActive({ ...NO_FILTER, maxSize: "0" }), true);
  assert.equal(filterActive({ ...NO_FILTER, tags: [3] }), true);
});
