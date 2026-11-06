import assert from "node:assert/strict";
import { test } from "node:test";
import {
  columnsWidth,
  DEFAULT_COLUMNS,
  dragTarget,
  gridTemplate,
  movedColumn,
  nextSort,
  restoreColumns,
  typeLabel,
} from "./columns.ts";

const ids = (columns: { id: string }[]) => columns.map((column) => column.id).join();

test("movedColumn takes the target's place in either direction", () => {
  assert.equal(ids(movedColumn(DEFAULT_COLUMNS, "modified", "type")), "name,created,type,modified,size");
  assert.equal(ids(movedColumn(DEFAULT_COLUMNS, "size", "created")), "name,modified,size,created,type");
});

test("movedColumn keeps name first", () => {
  assert.equal(movedColumn(DEFAULT_COLUMNS, "name", "size"), DEFAULT_COLUMNS);
  assert.equal(movedColumn(DEFAULT_COLUMNS, "size", "name"), DEFAULT_COLUMNS);
});

test("dragTarget waits for the pointer to pass a title's middle", () => {
  const middles = [100, 200, 300, 400];
  assert.equal(dragTarget(middles, 1, 290), -1);
  assert.equal(dragTarget(middles, 1, 310), 2);
  assert.equal(dragTarget(middles, 3, 310), -1);
  assert.equal(dragTarget(middles, 3, 290), 2);
  assert.equal(dragTarget(middles, 3, 190), 1);
});

test("dragTarget never picks name", () => {
  assert.equal(dragTarget([100, 200, 300], 1, 10), -1);
});

test("restoreColumns keeps the saved order and adds new columns at the end", () => {
  const saved = [{ id: "size", width: 90, visible: true }, { id: "name" }, { id: "type", width: 90, visible: true }];
  assert.equal(ids(restoreColumns(saved)), "name,size,type,modified,created");
});

test("columnsWidth adds visible columns with name at its minimum", () => {
  assert.equal(columnsWidth(DEFAULT_COLUMNS), 120 + 160 + 90);
});

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
