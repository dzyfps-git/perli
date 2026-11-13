import assert from "node:assert/strict";
import { test } from "node:test";
import { cycled, moved, nextActive, otherPane, pinnedFirst } from "./tabList.ts";

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
