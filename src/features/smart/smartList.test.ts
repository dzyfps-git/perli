import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanSmart, renamedSmart, showsSmart, withoutSmart, withSmart, type SmartFolder } from "./smartList.ts";

const NO_FILTER = { name: "", types: "", kinds: "all" as const, minSize: "", maxSize: "", from: "", to: "", tags: [] as number[] };

const smart = (name: string, query = ""): SmartFolder => ({ name, folder: "C:\\Work", query, scope: "below", filter: NO_FILTER });

test("saved smart folders keep what is usable and fill in the rest", () => {
  const saved = [
    { name: "Big", folder: "C:\\Work", query: 5, scope: "moon", filter: { minSize: "1 GB", tags: [1, "x"] } },
    { name: "No folder" },
    "junk",
  ];
  assert.deepEqual(cleanSmart(saved, NO_FILTER), [
    { name: "Big", folder: "C:\\Work", query: "", scope: "below", filter: { ...NO_FILTER, minSize: "1 GB", tags: [1] } },
  ]);
  assert.deepEqual(cleanSmart(null, NO_FILTER), []);
});

test("a smart folder saved under a taken name replaces that one in place", () => {
  const list = [smart("A"), smart("B")];
  assert.deepEqual(withSmart(list, smart("a", "pdf")), [smart("a", "pdf"), smart("B")]);
  assert.deepEqual(withSmart(list, smart("C")), [...list, smart("C")]);
  assert.deepEqual(withoutSmart(list, "b"), [smart("A")]);
});

test("a rename never takes another one's name", () => {
  const list = [smart("A"), smart("B")];
  assert.deepEqual(renamedSmart(list, "A", "b"), list);
  assert.deepEqual(renamedSmart(list, "a", "C"), [smart("C"), smart("B")]);
});

test("a view shows a smart folder when folder, search and filter all match", () => {
  const shown = { folder: "c:\\work", query: "pdf", scope: "below" as const, filter: NO_FILTER };
  assert.equal(showsSmart(smart("A", "pdf"), shown), true);
  assert.equal(showsSmart(smart("A", "doc"), shown), false);
  assert.equal(showsSmart(smart("A", "pdf"), { ...shown, filter: { ...NO_FILTER, name: "x" } }), false);
  assert.equal(showsSmart(smart("A", "pdf"), { ...shown, folder: undefined }), false);
});
