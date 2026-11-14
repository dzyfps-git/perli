import assert from "node:assert/strict";
import { test } from "node:test";
import {
  baseName,
  followed,
  followTarget,
  sameFolder,
  BIN_PATH,
  isDriveRoot,
  isZipName,
  join,
  nextTrail,
  parentOf,
  relativeTo,
  resolveRelative,
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

test("resolveRelative follows a document's own links to files beside it", () => {
  const folder = "C:\\docs";
  assert.equal(resolveRelative(folder, "pics/cat%20one.png"), "C:\\docs\\pics\\cat one.png");
  assert.equal(resolveRelative(folder, "./a.png#top"), "C:\\docs\\a.png");
  assert.equal(resolveRelative(folder, "../../../x.png"), "C:\\x.png");
  assert.equal(resolveRelative("C:\\", ".."), "C:\\");
  assert.equal(resolveRelative("\\\\server\\share\\docs", "../../a.png"), "\\\\server\\share\\a.png");
  assert.equal(resolveRelative(folder, "100%.png"), "C:\\docs\\100%.png");
});

test("a linked pane goes as deep, or as far up, as its partner", () => {
  assert.equal(followed("C:\\a", "C:\\a\\b\\c", "D:\\x"), "D:\\x\\b\\c");
  assert.equal(followed("C:\\", "C:\\b", "D:\\"), "D:\\b");
  assert.equal(followed("C:\\a\\b\\c", "C:\\a", "D:\\x\\y\\z"), "D:\\x");
  // Past the other pane's drive, there is nowhere to go.
  assert.equal(followed("C:\\a\\b", "C:\\", "D:\\x"), undefined);
  // A jump elsewhere is not followed, and nor is the Recycle Bin.
  assert.equal(followed("C:\\a", "E:\\b", "D:\\x"), undefined);
  assert.equal(followed("C:\\a", "C:\\a", "D:\\x"), undefined);
  assert.equal(followed("C:\\a", BIN_PATH, "D:\\x"), undefined);
});

test("a folder is the same however its slashes are written", () => {
  assert.ok(sameFolder("C:\\a\\b\\", "c:/A/b"));
  assert.ok(sameFolder("C:", "C:\\"));
  assert.ok(sameFolder("\\\\nas\\share\\", "\\\\NAS\\share"));
  assert.ok(!sameFolder("C:\\a", "C:\\ab"));
});

test("a linked pane follows the user, never the tab's own lead (R42.1, R42.2)", () => {
  // The user goes deeper: the other pane goes the same way in its own folder.
  assert.equal(followTarget("C:\\a", "C:\\a\\b", undefined, true, "D:\\x"), "D:\\x\\b");
  // Unlinked, nothing follows.
  assert.equal(followTarget("C:\\a", "C:\\a\\b", undefined, false, "D:\\x"), undefined);
  // Arriving where the tab led it, as "Same folder in other pane" does, bounces nothing back,
  // even when the path comes back written another way (N9).
  assert.equal(followTarget("D:\\x", "C:\\a", "C:\\a", true, "C:\\a"), undefined);
  assert.equal(followTarget("D:\\x", "C:\\a\\b", "c:/a/b/", true, "C:\\a"), undefined);
  // The user going on while the tab's lead is still on its way still leads.
  assert.equal(followTarget("C:\\a", "C:\\a\\c", "C:\\a\\b", true, "D:\\x"), "D:\\x\\c");
});


test("isZipName takes any case and only the end of the name", () => {
  assert.equal(isZipName("pack.zip"), true);
  assert.equal(isZipName("PACK.ZIP"), true);
  assert.equal(isZipName("pack.zip.txt"), false);
  assert.equal(isZipName("zip"), false);
});
