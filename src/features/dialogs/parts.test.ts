import assert from "node:assert/strict";
import { test } from "node:test";
import { contents, detailsText, isShare, matching, nameOf, parentOf, shareText, withShare } from "./parts.ts";

test("a path gives its name and the folder it is in", () => {
  assert.equal(nameOf("C:\\Users\\me\\note.txt"), "note.txt");
  assert.equal(nameOf("C:\\Users\\me\\"), "me");
  assert.equal(nameOf("C:\\"), "C:\\");
  assert.equal(parentOf("C:\\Users\\me\\note.txt"), "C:\\Users\\me");
  assert.equal(parentOf("C:\\note.txt"), "C:\\");
  assert.equal(parentOf("C:\\"), undefined);
  assert.equal(parentOf("\\\\server\\share"), undefined);
  assert.equal(parentOf("\\\\server\\share\\deep"), "\\\\server\\share");
});

test("contents leave out the kind there is none of", () => {
  assert.equal(contents(2, 1), "2 files, 1 folder");
  assert.equal(contents(1, 0), "1 file");
  assert.equal(contents(0, 3), "3 folders");
});

test("a share is read from the ways people write one", () => {
  assert.equal(shareText("//server/share"), "\\\\server\\share");
  assert.equal(shareText("smb://server/share/"), "\\\\server\\share");
  assert.equal(shareText("  server\\share "), "\\\\server\\share");
  assert.equal(shareText("\\\\server\\share\\deep"), "\\\\server\\share\\deep");
  assert.equal(shareText("  "), "");
});

test("only a server with a share is one", () => {
  assert.ok(isShare("\\\\server\\share"));
  assert.ok(isShare("\\\\server\\share\\deep"));
  assert.ok(!isShare("\\\\server"));
  assert.ok(!isShare("\\\\server\\"));
  assert.ok(!isShare("C:\\Users"));
  assert.ok(!isShare(""));
});

test("a share mapped again moves to the front, and the list stays short", () => {
  assert.deepEqual(withShare(["\\\\a\\b", "\\\\c\\d"], "\\\\C\\D"), ["\\\\C\\D", "\\\\a\\b"]);
  assert.equal(withShare(["1", "2", "3", "4", "5"], "6").length, 5);
});

test("details become lines, without the empty ones", () => {
  assert.equal(detailsText([["Name", "a.txt"], ["Kind", undefined], ["Size", "4 B"], ["Place", false]]), "Name: a.txt\nSize: 4 B");
});

test("apps are found by every word typed", () => {
  const apps = [{ name: "Visual Studio Code" }, { name: "Notepad" }, { name: "Visual Studio" }];
  assert.deepEqual(matching(apps, "studio code"), [apps[0]]);
  assert.deepEqual(matching(apps, " "), apps);
  assert.deepEqual(matching(apps, "paint"), []);
});
