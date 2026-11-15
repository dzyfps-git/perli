import assert from "node:assert/strict";
import { test } from "node:test";
import {
  contents,
  datedName,
  detailsText,
  fitsTypes,
  isShare,
  isTypedPath,
  matching,
  nameOf,
  nameProblem,
  parentOf,
  shareText,
  slideOf,
  stemEnd,
  withExtension,
  withShare,
} from "./parts.ts";

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

test("a saved file is named for the day, in place of the day it had", () => {
  const day = new Date(2026, 10, 5);
  assert.equal(datedName("Perli keys.json", day), "Perli keys 2026-11-05.json");
  assert.equal(datedName("Perli keys 2025-01-02.json", day), "Perli keys 2026-11-05.json");
  assert.equal(datedName("notes", day), "notes 2026-11-05");
  assert.equal(stemEnd("Perli keys.json"), 10);
  assert.equal(stemEnd(".hidden"), 7);
  assert.equal(withExtension("mine", "json"), "mine.json");
  assert.equal(withExtension("mine.JSON", "json"), "mine.JSON");
});

test("names Windows refuses are caught before saving", () => {
  assert.equal(nameProblem("Perli keys.json"), undefined);
  assert.equal(nameProblem("  "), "Type a name");
  assert.ok(nameProblem("a?b.json"));
  assert.ok(nameProblem("ends with dot."));
  assert.ok(nameProblem("CON.json"));
  assert.equal(nameProblem("console.json"), undefined);
});

test("the list slides into a folder and back out of it", () => {
  assert.equal(slideOf("C:\\Users", "C:\\Users\\me"), "in");
  assert.equal(slideOf("C:\\", "C:\\Users"), "in");
  assert.equal(slideOf("C:\\Users\\me", "C:\\users"), "out");
  assert.equal(slideOf("C:\\Users", "D:\\"), undefined);
  assert.equal(slideOf("C:\\Users", "C:\\Users2"), undefined);
  assert.equal(slideOf(undefined, "C:\\"), undefined);
});

test("typed text is a place when it has a slash or a drive, and types fit by extension", () => {
  assert.ok(isTypedPath("C:\\Users"));
  assert.ok(isTypedPath("..\\up"));
  assert.ok(isTypedPath("d:"));
  assert.ok(!isTypedPath("Perli keys.json"));
  assert.ok(fitsTypes("a.JSON", ["json"]));
  assert.ok(!fitsTypes("a.txt", ["json"]));
  assert.ok(!fitsTypes("json", ["json"]));
  assert.ok(fitsTypes("a.txt", undefined));
});
