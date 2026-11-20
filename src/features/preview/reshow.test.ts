import assert from "node:assert/strict";
import { test } from "node:test";
import type { Row } from "../../api";
import { sameFile } from "./reshow.ts";

const row = (name: string, more: Partial<Row> = {}): Row =>
  ({ name, size: 10, modified: 1000, created: 0, isDir: false, isHidden: false, isCloud: false, isPinned: false, isCustom: false, isSystem: false, location: "", tags: [], ...more }) as Row;
const pathOf = (one: Row) => `C:/f/${one.name}`;

test("a file read again after its folder changed keeps its view only while it is the same", () => {
  assert.equal(sameFile(row("a.pdf"), row("a.pdf", { tags: [1] }), pathOf), true);
  assert.equal(sameFile(row("a.pdf"), row("b.pdf"), pathOf), false);
  assert.equal(sameFile(row("a.pdf"), row("a.pdf", { size: 11 }), pathOf), false);
  assert.equal(sameFile(row("a.pdf"), row("a.pdf", { modified: 2000 }), pathOf), false);
  assert.equal(sameFile(row("a.pdf", { isCloud: true }), row("a.pdf"), pathOf), false);
  assert.equal(sameFile(undefined, row("a.pdf"), pathOf), false);
  assert.equal(sameFile(row("a.pdf"), undefined, pathOf), false);
});
