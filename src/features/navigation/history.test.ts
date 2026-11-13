import assert from "node:assert/strict";
import { test } from "node:test";
import { historyList, jumped } from "./history.ts";

const history = { back: ["A", "B", "C"], forward: ["Z", "Y"] };

test("one step back is the plain Back button", () => {
  assert.deepEqual(jumped(history, "D", -1), { target: "C", back: ["A", "B"], forward: ["Z", "Y", "D"] });
});

test("a jump back keeps the folders it passed, nearest last, for Forward", () => {
  const moved = jumped(history, "D", -3);
  assert.deepEqual(moved, { target: "A", back: [], forward: ["Z", "Y", "D", "C", "B"] });
  // Forward from there walks the same way back.
  assert.equal(jumped({ back: moved!.back, forward: moved!.forward }, "A", 1)?.target, "B");
});

test("a jump forward keeps the folders it passed for Back", () => {
  assert.deepEqual(jumped(history, "D", 2), { target: "Z", back: ["A", "B", "C", "D", "Y"], forward: [] });
});

test("no jump past either end, and none of no steps", () => {
  assert.equal(jumped(history, "D", -4), undefined);
  assert.equal(jumped(history, "D", 3), undefined);
  assert.equal(jumped(history, "D", 0), undefined);
});

test("the history lists start with the nearest folder", () => {
  assert.deepEqual(historyList(history, true), [
    { path: "C", steps: -1 },
    { path: "B", steps: -2 },
    { path: "A", steps: -3 },
  ]);
  assert.deepEqual(historyList(history, false), [
    { path: "Y", steps: 1 },
    { path: "Z", steps: 2 },
  ]);
});
