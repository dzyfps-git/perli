import assert from "node:assert/strict";
import { test } from "node:test";
import { coveringEntry, folderKey, remembered } from "./sortMemory.ts";

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

test("remembered forgets a folder given nothing", () => {
  const memory = remembered(remembered({}, "C:\\A", bySize), "C:\\B", byName);
  assert.deepEqual(remembered(memory, "c:\\a", undefined), { "c:\\b": byName });
});

test("remembered drops the oldest folder once full", () => {
  let memory = {};
  for (let i = 0; i < 1001; i++) memory = remembered(memory, `C:\\${i}x`, bySize);
  const folders = Object.keys(memory);
  assert.equal(folders.length, 1000);
  assert.equal(folders[0], "c:\\1x");
  assert.equal(folders.at(-1), "c:\\1000x");
});

test("coveringEntry takes a folder's own entry, then the nearest one above that covers it", () => {
  const memory = { "c:\\": { below: true, n: 1 }, "c:\\a": { below: false, n: 2 }, "c:\\a\\b": { below: true, n: 3 } };
  assert.equal(coveringEntry(memory, "C:\\A\\")?.value.n, 2);
  assert.equal(coveringEntry(memory, "C:\\A\\B\\C\\D")?.value.n, 3);
  assert.deepEqual(coveringEntry(memory, "C:\\A\\X"), { key: "c:\\", value: { below: true, n: 1 } });
  assert.equal(coveringEntry(memory, "D:\\A"), undefined);
  assert.equal(coveringEntry({ "c:\\a": { below: false } }, "C:\\A\\B"), undefined);
});
