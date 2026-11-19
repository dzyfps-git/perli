import assert from "node:assert/strict";
import { test } from "node:test";
import { CELL, goers, idOf, keeperOf, setsOf, twinsLayout, wasted, without } from "./twins.ts";

const twin = (path: string, modified: number, sharp: number | null = null, bytes = 100) => ({ path, bytes, modified, sharp });

test("the oldest copy stays, and of pictures that look alike the sharpest", () => {
  assert.equal(keeperOf([twin("a", 30), twin("b", 10), twin("c", 20)]), 1);
  assert.equal(keeperOf([twin("a", 10, 5), twin("b", 30, 900), twin("c", 20, 40)]), 1);
});

test("cleaning frees all but the keeper of each set, and a set of one is no set", () => {
  const sets = setsOf([[twin("a", 1, null, 50), twin("b", 2, null, 50), twin("c", 3, null, 50)], [twin("lonely", 1)]]);
  assert.equal(sets.length, 1);
  assert.deepEqual(goers(sets[0]).map((file) => file.path), ["b", "c"]);
  assert.equal(wasted(sets), 100);
});

test("sets fill the stage in rows, keeper first, and the rest wait for the next page", () => {
  const sets = setsOf(Array.from({ length: 10 }, (_, at) => [twin(`A${at}`, 2), twin(`B${at}`, 1)]));
  const { shown, spots, left } = twinsLayout(sets, 0, CELL.width * 3, CELL.height * 2, false);
  assert.equal(shown.length, 6);
  assert.equal(left, 4);
  // B is older, so it stays and sits on the left of its pair.
  assert.ok(spots.get(idOf("B0"))!.x < spots.get(idOf("A0"))!.x);
  assert.ok(spots.get(idOf("A3"))!.y > spots.get(idOf("A0"))!.y);
  assert.equal(twinsLayout(sets, 6, CELL.width * 3, CELL.height * 2, false).shown.length, 4);
});

test("cleaned files leave their sets, and a set down to its keeper goes", () => {
  const sets = setsOf([[twin("a", 1), twin("b", 2), twin("c", 3)], [twin("d", 1), twin("e", 2)]]);
  const left = without(sets, new Set(["b", "e"]));
  assert.equal(left.length, 1);
  assert.deepEqual(left[0].files.map((file) => file.path), ["a", "c"]);
  assert.equal(left[0].keep, 0);
});
