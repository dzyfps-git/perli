import assert from "node:assert/strict";
import { test } from "node:test";
import { moveTarget } from "./layout.ts";

const list = { count: 100, perRow: 1, pageRows: 10 };
const grid = { count: 10, perRow: 4, pageRows: 2 };

test("list keys move by rows and clamp to the ends", () => {
  assert.equal(moveTarget("ArrowDown", 5, list), 6);
  assert.equal(moveTarget("ArrowUp", 0, list), 0);
  assert.equal(moveTarget("PageDown", 95, list), 99);
  assert.equal(moveTarget("End", 5, list), 99);
  assert.equal(moveTarget("Home", 5, list), 0);
});

test("left and right do nothing in a list", () => {
  assert.equal(moveTarget("ArrowLeft", 5, list), undefined);
  assert.equal(moveTarget("ArrowRight", 5, list), undefined);
});

test("grid up and down move a whole row", () => {
  assert.equal(moveTarget("ArrowDown", 1, grid), 5);
  assert.equal(moveTarget("ArrowUp", 5, grid), 1);
  assert.equal(moveTarget("ArrowRight", 3, grid), 4);
  assert.equal(moveTarget("ArrowLeft", 4, grid), 3);
});

test("grid up from the top row stays put", () => {
  assert.equal(moveTarget("ArrowUp", 2, grid), 2);
});

test("grid down into a short last row lands on its last tile", () => {
  assert.equal(moveTarget("ArrowDown", 7, grid), 9);
});

test("grid down on the last row stays put", () => {
  assert.equal(moveTarget("ArrowDown", 9, grid), 9);
});

test("grid page keys move by rows of tiles", () => {
  assert.equal(moveTarget("PageDown", 0, grid), 8);
  assert.equal(moveTarget("PageUp", 9, grid), 1);
});

test("the first arrow press with no focus lands on the first row", () => {
  assert.equal(moveTarget("ArrowDown", -1, grid), 0);
  assert.equal(moveTarget("ArrowRight", -1, grid), 0);
  assert.equal(moveTarget("ArrowUp", -1, list), 0);
});

test("other keys are not moves", () => {
  assert.equal(moveTarget("a", 1, list), undefined);
});
