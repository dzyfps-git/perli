import assert from "node:assert/strict";
import { test } from "node:test";
import {
  filterActive,
  hasSince,
  hasTypes,
  NO_FILTER,
  parseSize,
  sinceDay,
  sizesAreGood,
  toFilter,
  toggleKinds,
  toggleMinSize,
  toggleSince,
  toggleTypes,
} from "./filter.ts";

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


test("a week starts on Monday and a year on the first of January", () => {
  const thursday = new Date(2026, 10, 12, 15, 30);
  assert.equal(sinceDay("today", thursday), "2026-11-12");
  assert.equal(sinceDay("week", thursday), "2026-11-09");
  assert.equal(sinceDay("week", new Date(2026, 10, 15)), "2026-11-09");
  assert.equal(sinceDay("year", thursday), "2026-01-01");
});

test("a type chip adds its types and takes them away, keeping typed ones", () => {
  const typed = { ...NO_FILTER, types: "txt" };
  const on = toggleTypes(typed, ["png", "jpg"]);
  assert.equal(on.types, "txt png jpg");
  assert.ok(hasTypes(on, ["jpg", "png"]));
  assert.equal(toggleTypes(on, ["png", "jpg"]).types, "txt");
});

test("folders and types rule each other out", () => {
  const folders = toggleKinds({ ...NO_FILTER, types: "png" }, "folders");
  assert.deepEqual([folders.kinds, folders.types], ["folders", ""]);
  assert.equal(toggleTypes(folders, ["png"]).kinds, "all");
  assert.equal(toggleKinds(folders, "folders").kinds, "all");
});

test("size and date chips turn off when pressed again", () => {
  const big = toggleMinSize(NO_FILTER, "100 MB");
  assert.equal(big.minSize, "100 MB");
  assert.equal(toggleMinSize({ ...NO_FILTER, minSize: "100mb" }, "100 MB").minSize, "");
  const now = new Date(2026, 10, 12);
  const today = toggleSince({ ...NO_FILTER, to: "2026-12-01" }, "today", now);
  assert.deepEqual([today.from, today.to], ["2026-11-12", ""]);
  assert.ok(hasSince(today, "today", now));
  assert.equal(toggleSince(today, "today", now).from, "");
});
