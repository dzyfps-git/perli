import assert from "node:assert/strict";
import { test } from "node:test";
import { dayOf, looksLikeName, readTyped, serverOf, visited, withPaths } from "./lists.ts";

test("a path goes on the shelf once, whatever its case", () => {
  assert.deepEqual(withPaths(["C:\\a"], ["c:\\A", "C:\\b", "C:\\B"]), ["C:\\a", "C:\\b"]);
});

test("the folder seen last comes first, and old ones fall off", () => {
  assert.deepEqual(visited(["C:\\a", "C:\\b", "C:\\c"], "c:\\B", 3), ["c:\\B", "C:\\a", "C:\\c"]);
  assert.deepEqual(visited(["C:\\a", "C:\\b"], "C:\\c", 2), ["C:\\c", "C:\\a"]);
});

test("the path bar tells a command, a terminal, a nickname, a search and a path apart", () => {
  assert.deepEqual(readTyped(" > new tab "), { kind: "command", text: "new tab" });
  assert.deepEqual(readTyped("CMD"), { kind: "terminal", shell: "cmd" });
  assert.deepEqual(readTyped("wt"), { kind: "terminal", shell: "wt" });
  assert.deepEqual(readTyped("@Work"), { kind: "nickname", name: "work", save: false });
  assert.deepEqual(readTyped("@work ="), { kind: "nickname", name: "work", save: true });
  assert.deepEqual(readTyped("?report"), { kind: "search", text: "report" });
  assert.deepEqual(readTyped("C:\\Users"), { kind: "path", text: "C:\\Users" });
  assert.deepEqual(readTyped("cmd files"), { kind: "path", text: "cmd files" });
});

test("only text with nothing of a path in it is searched for", () => {
  assert.equal(looksLikeName("report 2026"), true);
  assert.equal(looksLikeName("C:\\Users"), false);
  assert.equal(looksLikeName("%temp%"), false);
  assert.equal(looksLikeName(".."), false);
  assert.equal(looksLikeName(""), false);
});

test("steps of the activity log fall under their day", () => {
  const now = new Date(2026, 10, 11, 15).getTime();
  assert.equal(dayOf(new Date(2026, 10, 11, 0, 5).getTime(), now), "Today");
  assert.equal(dayOf(new Date(2026, 10, 10, 23).getTime(), now), "Yesterday");
  assert.equal(dayOf(0, now), "Earlier");
  assert.notEqual(dayOf(new Date(2026, 10, 2).getTime(), now), "Today");
});

test("a server is told from the path of a folder on it", () => {
  assert.equal(serverOf("\\\\nas\\photos\\2026"), "\\\\nas");
  assert.equal(serverOf("\\\\nas"), "\\\\nas");
  assert.equal(serverOf("C:\\Users"), undefined);
  assert.equal(serverOf("\\\\?\\C:\\long"), undefined, "a long path is this PC");
  assert.equal(serverOf("\\\\.\\pipe"), undefined);
});
