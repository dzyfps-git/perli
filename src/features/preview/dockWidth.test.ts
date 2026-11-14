import assert from "node:assert/strict";
import { test } from "node:test";
import { dockShare, dragged, DOCK_MAX, DOCK_MIN } from "./dockWidth.ts";

test("the pane's share stays in bounds and settles on a snap", () => {
  assert.equal(dockShare(0.05), DOCK_MIN);
  assert.equal(dockShare(0.95), DOCK_MAX);
  assert.equal(dockShare(0.49), 1 / 2);
  assert.equal(dockShare(0.34), 1 / 3);
  assert.equal(dockShare(0.42), 0.42);
});

test("the edge measures from the right of the room, and folds when dragged far right", () => {
  assert.deepEqual(dragged(600, 0, 1000), { share: 0.4, folds: false });
  assert.deepEqual(dragged(900, 0, 1000), { share: DOCK_MIN, folds: true });
  assert.equal(dragged(500, 0, 1000).share, 1 / 2);
});
