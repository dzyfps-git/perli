import assert from "node:assert/strict";
import { test } from "node:test";
import { join, nextTrail, parentOf, toCrumbs } from "./path.ts";

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
