import assert from "node:assert/strict";
import { test } from "node:test";
import {
  baseName,
  BIN_PATH,
  isDriveRoot,
  join,
  nextTrail,
  parentOf,
  relativeTo,
  samePath,
  toCrumbs,
  typedPath,
} from "./path.ts";

test("a network path starts at its server", () => {
  assert.deepEqual(toCrumbs("\\\\server\\share\\a"), [
    { label: "\\\\server", path: "\\\\server" },
    { label: "share", path: "\\\\server\\share" },
    { label: "a", path: "\\\\server\\share\\a" },
  ]);
  assert.equal(parentOf("\\\\server\\share\\a"), "\\\\server\\share");
  assert.equal(parentOf("\\\\server\\share"), "\\\\server");
  assert.equal(parentOf("\\\\server"), undefined);
});

test("typedPath takes network paths with either slash", () => {
  assert.equal(typedPath("C:\\Work", "\\\\server\\share"), "\\\\server\\share");
  assert.equal(typedPath("C:\\Work", "//server/share"), "//server/share");
});

test("isDriveRoot only takes a drive's root", () => {
  assert.equal(isDriveRoot("Z:\\"), true);
  assert.equal(isDriveRoot("Z:\\Work"), false);
  assert.equal(isDriveRoot("\\\\server\\share"), false);
});

test("relativeTo shortens paths inside the folder and leaves the rest whole", () => {
  assert.equal(relativeTo("C:\\Work", "C:\\Work\\deep\\inner"), "deep\\inner");
  assert.equal(relativeTo("C:\\", "C:\\deep"), "deep");
  assert.equal(relativeTo("C:\\Work", "C:\\Work"), "");
  assert.equal(relativeTo("C:\\Work", "C:\\Workshop\\old"), "C:\\Workshop\\old");
  assert.equal(relativeTo(BIN_PATH, "C:\\Work"), "C:\\Work");
});

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

test("the Recycle Bin is one crumb with no parent, and typing its name opens it", () => {
  assert.deepEqual(toCrumbs(BIN_PATH), [{ label: "Recycle Bin", path: BIN_PATH }]);
  assert.equal(parentOf(BIN_PATH), undefined);
  assert.equal(typedPath("C:\\Users", BIN_PATH), BIN_PATH);
});

test("baseName is the last part of a path", () => {
  assert.equal(baseName("C:\\a\\b.txt"), "b.txt");
});
