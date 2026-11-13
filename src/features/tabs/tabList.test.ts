import assert from "node:assert/strict";
import { test } from "node:test";
import { cycled, EVEN_SPLIT, moved, nextActive, otherPane, pinnedFirst, snapped, SPLIT_MAX, SPLIT_MIN } from "./tabList.ts";

test("closing the active tab activates the next, then the previous", () => {
  assert.equal(nextActive(["a", "b", "c"], "b", "b"), "c");
  assert.equal(nextActive(["a", "b", "c"], "c", "c"), "b");
});

test("closing another tab keeps the active tab", () => {
  assert.equal(nextActive(["a", "b", "c"], "a", "c"), "c");
});

test("moved stops at the ends", () => {
  assert.deepEqual(moved(["a", "b", "c"], "a", 1), ["b", "a", "c"]);
  assert.deepEqual(moved(["a", "b", "c"], "c", 1), ["a", "b", "c"]);
  assert.deepEqual(moved(["a", "b", "c"], "a", -1), ["a", "b", "c"]);
});

test("cycled wraps around", () => {
  assert.equal(cycled(["a", "b"], "b", 1), "a");
  assert.equal(cycled(["a", "b"], "a", -1), "b");
});

test("otherPane finds the second pane, and nothing when there is one pane", () => {
  assert.equal(otherPane(["left", "right"], "left"), "right");
  assert.equal(otherPane(["left", "right"], "right"), "left");
  assert.equal(otherPane(["left"], "left"), undefined);
});

test("pinnedFirst keeps each group in its own order", () => {
  assert.deepEqual(
    pinnedFirst(["a", "B", "c", "D"], (tab) => tab === tab.toUpperCase()),
    ["B", "D", "a", "c"],
  );
});

test("a divider is drawn to a third, a half or two thirds, and stays in bounds", () => {
  assert.equal(snapped(0.49), EVEN_SPLIT);
  assert.equal(snapped(0.65), 2 / 3);
  assert.equal(snapped(0.32), 1 / 3);
  assert.equal(snapped(0.42), 0.42);
  assert.equal(snapped(0.05), SPLIT_MIN);
  assert.equal(snapped(1), SPLIT_MAX);
});
