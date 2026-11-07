import assert from "node:assert/strict";
import { test } from "node:test";
import { finder, renamed, START_RULES, type RenameRules } from "./renameRules.ts";

function rename(name: string, change: Partial<RenameRules>, { isDir = false, index = 0 } = {}) {
  const rules = { ...START_RULES, ...change };
  return renamed(name, isDir, index, rules, finder(rules));
}

test("no rules leave a name alone", () => {
  assert.equal(rename("a b.txt", {}), "a b.txt");
});

test("find replaces every match, ignoring case unless asked", () => {
  assert.equal(rename("aXbxc.txt", { find: "x", replace: "-" }), "a-b-c.txt");
  assert.equal(rename("aXbxc.txt", { find: "x", replace: "-", matchCase: true }), "aXb-c.txt");
});

test("plain text means itself, in the search and the replacement", () => {
  assert.equal(rename("a.b(c)-d.txt", { find: ".b(c)-", replace: "$&$1" }), "a$&$1d.txt");
});

test("a regular expression can use its groups", () => {
  const rules = { find: "(\\d+)-(\\d+)", replace: "$2-$1", regex: true };
  assert.equal(rename("12-34.txt", rules), "34-12.txt");
  assert.throws(() => finder({ ...START_RULES, find: "(", regex: true }));
});

test("the extension stays out of it unless included", () => {
  assert.equal(rename("a.txt", { find: "txt", replace: "md" }), "a.txt");
  assert.equal(rename("a.txt", { find: "txt", replace: "md", includeExtension: true }), "a.md");
  assert.equal(rename("a.tar.gz", { suffix: "!" }), "a.tar!.gz");
  assert.equal(rename("a.txt", { suffix: "!", includeExtension: true }), "a.txt!");
});

test("a dot at the start is no extension, and a folder has none", () => {
  assert.equal(rename(".gitignore", { suffix: "!" }), ".gitignore!");
  assert.equal(rename("v1.2", { suffix: "!" }, { isDir: true }), "v1.2!");
});

test("prefix, suffix and number go around the stem", () => {
  const rules = { prefix: "p ", suffix: " s ", numbered: true, start: 9, digits: 3 };
  assert.equal(rename("a.txt", rules, { index: 2 }), "p a s 011.txt");
  assert.equal(rename("a.txt", { numbered: true, digits: 1 }, { index: 11 }), "a12.txt");
});

test("letter case changes all but the extension", () => {
  assert.equal(rename("Ab cD.TXT", { letterCase: "lower" }), "ab cd.TXT");
  assert.equal(rename("Ab cD.txt", { letterCase: "upper" }), "AB CD.txt");
  assert.equal(rename("heLLo wORLD-it's_élan.txt", { letterCase: "title" }), "Hello World-It's_Élan.txt");
});
