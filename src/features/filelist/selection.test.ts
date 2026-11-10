import assert from "node:assert/strict";
import { test } from "node:test";
import { createSelection } from "./selection.ts";

test("rows lists the focused row first and restore brings the selection back", () => {
  const selection = createSelection();
  selection.select(2);
  selection.extendTo(4, false);
  assert.equal(selection.rows()[0], 4);
  assert.deepEqual(selection.rows().sort(), [2, 3, 4]);

  const restored = createSelection();
  restored.restore(selection.rows());
  assert.equal(restored.focused(), 4);
  assert.equal(restored.size(), 3);
  assert.equal(restored.has(3), true);

  restored.restore([]);
  assert.equal(restored.focused(), -1);
});

test("select replaces the selection", () => {
  const selection = createSelection();
  selection.select(1);
  selection.select(3);
  assert.equal(selection.size(), 1);
  assert.ok(selection.has(3));
});

test("extendTo selects from the anchor in both directions", () => {
  const selection = createSelection();
  selection.select(5);
  selection.extendTo(7, false);
  assert.equal(selection.size(), 3);
  selection.extendTo(4, false);
  assert.equal(selection.size(), 2);
  assert.ok(selection.has(4) && selection.has(5));
  assert.equal(selection.focused(), 4);
});

test("extendTo with keep adds to the selection", () => {
  const selection = createSelection();
  selection.select(1);
  selection.toggle(10);
  selection.extendTo(11, true);
  assert.equal(selection.size(), 3);
});

test("toggle removes a selected row", () => {
  const selection = createSelection();
  selection.select(2);
  selection.toggle(2);
  assert.equal(selection.size(), 0);
});

test("selectAll on an empty list selects nothing", () => {
  const selection = createSelection();
  selection.selectAll(3);
  assert.equal(selection.size(), 3);
  selection.clear();
  assert.equal(selection.focused(), -1);
  selection.selectAll(0);
  assert.equal(selection.size(), 0);
});

test("Ctrl+click after Ctrl+A takes only that row out", () => {
  const selection = createSelection();
  selection.selectAll(5);
  selection.toggle(2);
  assert.equal(selection.size(), 4);
  assert.equal(selection.has(2), false);
  assert.deepEqual(selection.rows().sort(), [0, 1, 3, 4]);
  // And the same click again puts it back.
  selection.toggle(2);
  assert.equal(selection.size(), 5);
});
