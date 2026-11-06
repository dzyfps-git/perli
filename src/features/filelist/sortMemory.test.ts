import assert from "node:assert/strict";
import { test } from "node:test";
import { folderKey, remembered } from "./sortMemory.ts";

const bySize = { key: "size", descending: true } as const;
const byName = { key: "name", descending: false } as const;

test("folderKey ignores case and trailing slashes but keeps drive roots", () => {
  assert.equal(folderKey("C:\\Users\\Me\\"), "c:\\users\\me");
  assert.equal(folderKey("C:\\"), "c:\\");
});

test("remembered replaces a folder's old sort", () => {
  const memory = remembered(remembered({}, "C:\\A", bySize), "c:\\a\\", byName);
  assert.deepEqual(memory, { "c:\\a": byName });
});

test("remembered drops the oldest folder once full", () => {
  let memory = {};
  for (let i = 0; i < 1001; i++) memory = remembered(memory, `C:\\${i}x`, bySize);
  const folders = Object.keys(memory);
  assert.equal(folders.length, 1000);
  assert.equal(folders[0], "c:\\1x");
  assert.equal(folders.at(-1), "c:\\1000x");
});
