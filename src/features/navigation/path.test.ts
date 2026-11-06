import assert from "node:assert/strict";
import { test } from "node:test";
import { join, nextTrail, parentOf, samePath, toCrumbs, typedPath } from "./path.ts";

test("samePath ignores case and handles no folder yet", () => {
  assert.equal(samePath("C:\\Users\\Me", "c:\\users\\me"), true);
  assert.equal(samePath("C:\\Users", "C:\\Users\\me"), false);
  assert.equal(samePath(undefined, "C:\\"), false);
});

test("toCrumbs starts at the drive root", () => {
  assert.deepEqual(toCrumbs("C:\\Users\\me"), [
    { label: "C:", path: "C:\\" },
    { label: "Users", path: "C:\\Users" },
    { label: "me", path: "C:\\Users\\me" },
  ]);
  assert.deepEqual(toCrumbs("C:\\"), [{ label: "C:", path: "C:\\" }]);
});

test("parentOf stops at the drive root", () => {
  assert.equal(parentOf("C:\\Users\\me"), "C:\\Users");
  assert.equal(parentOf("C:\\Users"), "C:\\");
  assert.equal(parentOf("C:\\"), undefined);
});

test("join does not double the slash on a drive root", () => {
  assert.equal(join("C:\\", "a.txt"), "C:\\a.txt");
  assert.equal(join("C:\\Users", "a.txt"), "C:\\Users\\a.txt");
});

test("nextTrail keeps deeper folders when going up", () => {
  assert.equal(nextTrail("C:\\a\\b\\c", "C:\\a"), "C:\\a\\b\\c");
  assert.equal(nextTrail("C:\\a\\b\\c", "C:\\"), "C:\\a\\b\\c");
  assert.equal(nextTrail("C:\\a\\b", "c:\\A"), "C:\\a\\b");
});

test("nextTrail starts over when leaving the trail", () => {
  assert.equal(nextTrail("C:\\a\\b", "C:\\x"), "C:\\x");
  assert.equal(nextTrail("C:\\ab", "C:\\a"), "C:\\a");
  assert.equal(nextTrail("", "C:\\a"), "C:\\a");
});

test("typedPath keeps full paths and strips the quotes of Copy as path", () => {
  assert.equal(typedPath("C:\\a", "D:\\b"), "D:\\b");
  assert.equal(typedPath("C:\\a", '  "D:\\My Files\\b"  '), "D:\\My Files\\b");
  assert.equal(typedPath("C:\\a", "d:/b"), "d:/b");
});

test("typedPath opens a bare drive at its root", () => {
  assert.equal(typedPath("C:\\a", "D:"), "D:\\");
});

test("typedPath reads other text from the current folder", () => {
  assert.equal(typedPath("C:\\a", "b\\c"), "C:\\a\\b\\c");
  assert.equal(typedPath("C:\\a", ".."), "C:\\a\\..");
});
