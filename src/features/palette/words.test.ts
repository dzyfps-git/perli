import assert from "node:assert/strict";
import { test } from "node:test";
import { wordsFor, type Verb } from "./words.ts";

const verbs: Verb[] = [
  { says: "sort by", words: ["name", "size", "type"] },
  { says: "tag", words: ["Red", "Rent"] },
  { says: "select", words: "free" },
];

test("a whole verb offers the words that start with what follows it", () => {
  assert.deepEqual(wordsFor("sort by s", verbs), [{ verb: 0, word: "size" }]);
  assert.deepEqual(wordsFor("Tag  re", verbs), [
    { verb: 1, word: "Red" },
    { verb: 1, word: "Rent" },
  ]);
});

test("a verb still being typed offers all its words", () => {
  assert.deepEqual(
    wordsFor("sor", verbs).map(({ word }) => word),
    ["name", "size", "type"],
  );
  // One letter is too little to go on.
  assert.deepEqual(wordsFor("s", verbs), []);
});

test("a free verb takes the rest as typed, and nothing without it", () => {
  assert.deepEqual(wordsFor("select  *.JPG", verbs), [{ verb: 2, word: "*.JPG" }]);
  assert.deepEqual(wordsFor("select", verbs), []);
});

test("a word that fits no verb is left to the plain commands", () => {
  assert.deepEqual(wordsFor("sort by colour", verbs), []);
  assert.deepEqual(wordsFor("rename", verbs), []);
});
