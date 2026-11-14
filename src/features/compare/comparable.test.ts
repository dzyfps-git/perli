import assert from "node:assert/strict";
import { test } from "node:test";
import { compareKind, sideChips, WHOLE, zoomed } from "./comparable.ts";

test("two pictures or two texts compare, other pairs don't", () => {
  assert.equal(compareKind(["a.jpg", "b.PNG"], ["picture", "picture"]), "picture");
  assert.equal(compareKind(["a.txt", "b.ts"], ["text", "code"]), "text");
  assert.equal(compareKind(["a.csv", "b.json"], ["sheet", "data"]), "text");
  assert.equal(compareKind(["a.xlsx", "b.json"], ["sheet", "data"]), undefined);
  assert.equal(compareKind(["a.jpg", "b.txt"], ["picture", "text"]), undefined);
  assert.equal(compareKind(["a.txt", "b"], ["text", "folder"]), undefined);
  assert.equal(compareKind(["a.txt"], ["text"]), undefined);
  assert.equal(compareKind(["a.exe", "b.exe"], ["app", "app"]), undefined);
});

test("zooming keeps the spot under the pointer in place, and zooming all the way out centres", () => {
  const at = { x: 100, y: -40 };
  const lens = zoomed(WHOLE, 2, at);
  assert.equal(lens.scale, 2);
  // The point under the pointer maps to the same place before and after.
  const before = { x: (at.x - WHOLE.x) / WHOLE.scale, y: (at.y - WHOLE.y) / WHOLE.scale };
  assert.deepEqual({ x: before.x * lens.scale + lens.x, y: before.y * lens.scale + lens.y }, at);
  assert.deepEqual(zoomed(lens, 0.25, at), WHOLE);
  assert.equal(zoomed(lens, 100, at).scale, 16);
});

test("each side says what it has over the other", () => {
  const size = (bytes: number) => `${bytes} B`;
  const old = { bytes: 300, modified: 1, pixels: 100 };
  const fresh = { bytes: 100, modified: 2, pixels: 400 };
  assert.deepEqual(sideChips(fresh, old, size), ["200 B smaller", "Newer", "More pixels"]);
  assert.deepEqual(sideChips(old, fresh, size), []);
});
