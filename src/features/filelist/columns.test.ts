import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_COLUMNS, gridTemplate, nextSort, restoreColumns, typeLabel } from "./columns.ts";

test("nextSort flips the same column", () => {
  assert.deepEqual(nextSort({ key: "name", descending: false }, "name"), { key: "name", descending: true });
  assert.deepEqual(nextSort({ key: "size", descending: true }, "size"), { key: "size", descending: false });
});

test("nextSort starts dates and sizes with the newest and largest", () => {
  const sort = { key: "name", descending: false } as const;
  assert.deepEqual(nextSort(sort, "modified"), { key: "modified", descending: true });
  assert.deepEqual(nextSort(sort, "size"), { key: "size", descending: true });
  assert.deepEqual(nextSort({ key: "size", descending: true }, "type"), { key: "type", descending: false });
});

test("gridTemplate lets only the name column flex and skips hidden columns", () => {
  assert.equal(gridTemplate(DEFAULT_COLUMNS), "minmax(120px, 1fr) 160px 90px");
});

test("typeLabel names folders, extensions and plain files", () => {
  assert.equal(typeLabel("notes.txt", false), "TXT file");
  assert.equal(typeLabel("archive.tar.gz", false), "GZ file");
  assert.equal(typeLabel("README", false), "File");
  assert.equal(typeLabel("my.folder", true), "Folder");
});

test("restoreColumns keeps saved widths and ignores unknown columns", () => {
  const restored = restoreColumns([
    { id: "size", width: 200, visible: false },
    { id: "gone", width: 10, visible: true },
  ]);
  assert.equal(restored.find((column) => column.id === "size")?.width, 200);
  assert.equal(restored.find((column) => column.id === "size")?.visible, false);
  assert.equal(restored.length, DEFAULT_COLUMNS.length);
  assert.deepEqual(restoreColumns("broken"), DEFAULT_COLUMNS);
});

test("restoreColumns never hides the name column", () => {
  const restored = restoreColumns([{ id: "name", width: 0, visible: false }]);
  assert.equal(restored[0].visible, true);
});
