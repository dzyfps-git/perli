import assert from "node:assert/strict";
import { test } from "node:test";
import { changedPart, counts, dayText, factsNeeded, finder, moved, renamed, START_RULES, typedNames, type NameFacts, type RenameRules } from "./renameRules.ts";

function rename(name: string, change: Partial<RenameRules>, { isDir = false, index = 0, facts }: { isDir?: boolean; index?: number; facts?: NameFacts } = {}) {
  const rules = { ...START_RULES, ...change };
  return renamed(name, isDir, index, rules, finder(rules), facts);
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

test("the changed part of a rename sits between what both names share", () => {
  assert.deepEqual(changedPart("IMG_0042.jpg", "Trip 0042.jpg"), { start: 0, oldEnd: 4, newEnd: 5 });
  assert.deepEqual(changedPart("notes.txt", "notes (2).txt"), { start: 5, oldEnd: 5, newEnd: 9 });
  assert.deepEqual(changedPart("same.txt", "same.txt"), { start: 8, oldEnd: 8, newEnd: 8 });
  assert.deepEqual(changedPart("aa", "aaa"), { start: 0, oldEnd: 0, newEnd: 1 });
  assert.deepEqual(changedPart("notes.txt", "new notes.txt"), { start: 0, oldEnd: 0, newEnd: 4 });
  assert.deepEqual(changedPart("notes.txt", "notes s.txt"), { start: 5, oldEnd: 5, newEnd: 7 });
});

const day = new Date(2024, 2, 5, 14, 30).getTime();
const facts: NameFacts = { modified: day, taken: null, artist: "AC/DC", title: "", folder: "Trip" };

test("tokens fill in from the item, and wait for its facts", () => {
  assert.equal(rename("a.jpg", { prefix: "{folder} {date} " }, { facts }), "Trip 2024-03-05 a.jpg");
  assert.equal(rename("a.jpg", { prefix: "{folder} " }), "{folder} a.jpg");
  assert.equal(rename("a.jpg", { prefix: "{taken}_" }, { facts }), "2024-03-05_a.jpg", "date taken falls back to the date changed");
  assert.equal(rename("a.mp3", { suffix: " - {artist}" }, { facts }), "a - AC-DC.mp3", "a slash can't be in a name");
  assert.equal(rename("a.txt", { prefix: "{nope}" }, { facts }), "{nope}a.txt");
});

test("the counter goes where it is put, and the name where {name} is", () => {
  assert.equal(rename("a.txt", { find: "a", replace: "{counter}-{name}", start: 7, digits: 3 }, { index: 2 }), "009-a.txt");
  assert.equal(rename("x.txt", { find: "(x)", replace: "$1{name}$", regex: true }), "xx$.txt");
});

test("letters come off the ends first, and spaces can be tidied", () => {
  assert.equal(rename("IMG_0042.jpg", { dropFirst: 4 }), "0042.jpg");
  assert.equal(rename("song (1).mp3", { dropLast: 4 }), "song.mp3");
  assert.equal(rename("ab.txt", { dropFirst: 5, dropLast: 5 }), ".txt");
  assert.equal(rename("  a   b  .txt", { trim: true }), "a b.txt");
});

test("the rules say which facts they need and whether they number", () => {
  assert.equal(factsNeeded(START_RULES), "none");
  assert.equal(factsNeeded({ ...START_RULES, prefix: "{date}" }), "quick");
  assert.equal(factsNeeded({ ...START_RULES, replace: "{artist}" }), "deep");
  assert.equal(counts({ ...START_RULES, suffix: "{counter}" }), true);
  assert.equal(counts(START_RULES), false);
});

test("a day reads as year, month, day", () => {
  assert.equal(dayText(new Date(2025, 0, 9).getTime()), "2025-01-09");
});

test("typed names line up with the rows in the order shown", () => {
  assert.deepEqual(typedNames(["b", "c", "a", ""].join("\n"), [1, 2, 0]), ["a", "b", "c"]);
  assert.equal(typedNames("one", [0, 1]), undefined);
});

test("a row moves to its new place in the order", () => {
  assert.deepEqual(moved([0, 1, 2, 3], 0, 2), [1, 2, 0, 3]);
  assert.deepEqual(moved([0, 1, 2, 3], 3, 0), [3, 0, 1, 2]);
});
