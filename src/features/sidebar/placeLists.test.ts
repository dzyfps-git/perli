import assert from "node:assert/strict";
import { test } from "node:test";
import { holds, lookKey, moved, placeLabel, savedPaths, toggled, withLook } from "./placeLists.ts";

test("toggling adds at the end and takes out whatever the case", () => {
  const list = toggled(toggled([], "C:\\A"), "D:\\B");
  assert.deepEqual(list, ["C:\\A", "D:\\B"]);
  assert.ok(holds(list, "c:\\a"));
  assert.deepEqual(toggled(list, "c:\\a"), ["D:\\B"]);
});

test("moving swaps with a neighbour and stops at the ends", () => {
  const list = ["a", "b", "c"];
  assert.deepEqual(moved(list, "b", -1), ["b", "a", "c"]);
  assert.deepEqual(moved(list, "B", 1), ["a", "c", "b"]);
  assert.equal(moved(list, "a", -1), list);
  assert.equal(moved(list, "c", 1), list);
  assert.equal(moved(list, "gone", 1), list);
});

test("only text paths survive from storage", () => {
  assert.deepEqual(savedPaths(["C:\\a", 3, null, "D:\\"]), ["C:\\a", "D:\\"]);
  assert.deepEqual(savedPaths({ a: 1 }), []);
  assert.deepEqual(savedPaths(null), []);
});

test("a place is called by its last name, and a drive by its path", () => {
  assert.equal(placeLabel("C:\\Users\\me\\Work"), "Work");
  assert.equal(placeLabel("C:\\Users\\me\\Work\\"), "Work");
  assert.equal(placeLabel("D:\\"), "D:\\");
  assert.equal(placeLabel("\\\\server\\share"), "share");
});

test("a look changes in parts and goes once it is empty", () => {
  let looks = withLook({}, "C:\\Work\\", { color: 2 });
  assert.deepEqual(looks, { "c:\\work": { color: 2 } });
  looks = withLook(looks, "c:\\WORK", { icon: "\uE734" });
  assert.deepEqual(looks[lookKey("C:\\Work")], { color: 2, icon: "\uE734" });
  looks = withLook(looks, "C:\\Work", { color: undefined });
  assert.deepEqual(looks, { "c:\\work": { icon: "\uE734" } });
  assert.deepEqual(withLook(looks, "C:\\Work", { icon: undefined }), {});
});
