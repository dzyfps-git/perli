import assert from "node:assert/strict";
import { test } from "node:test";
import {
  columnsWidth,
  DEFAULT_COLUMNS,
  dragTarget,
  gridTemplate,
  movedColumn,
  nextGrouping,
  nextSort,
  restoreColumns,
  savedShare,
  startColumns,
  typeLabel,
} from "./columns.ts";

const ids = (columns: { id: string }[]) => columns.map((column) => column.id).join();

test("nextGrouping cycles through all three and wraps", () => {
  assert.equal(nextGrouping("foldersFirst"), "filesFirst");
  assert.equal(nextGrouping("filesFirst"), "mixed");
  assert.equal(nextGrouping("mixed"), "foldersFirst");
});

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

test("a folder of songs puts artist and length before size, and keeps the rest to add", () => {
  const music = startColumns("music");
  assert.equal(ids(music.filter((column) => column.visible)), "name,modified,artist,length,size");
  assert.equal(music.length, 10);
  assert.equal(ids(restoreColumns(undefined, startColumns("pictures")).filter((column) => column.visible)), "name,modified,taken,dimensions,size");
});

test("restoreColumns never hides the name column", () => {
  const restored = restoreColumns([{ id: "name", width: 0, visible: false }]);
  assert.equal(restored[0].visible, true);
});

test("savedShare is how much smaller packing made a file, never below nothing", () => {
  assert.equal(savedShare(250, 1000), 75);
  assert.equal(savedShare(710, 1000), 29);
  // Nearly all gone still leaves something, so it never reads 100.
  assert.equal(savedShare(326, 109_000), 99);
  assert.equal(savedShare(1000, 1000), 0);
  // A stored file can come out a little bigger than it went in.
  assert.equal(savedShare(1010, 1000), 0);
  assert.equal(savedShare(0, 0), undefined);
});
