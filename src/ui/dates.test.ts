import assert from "node:assert/strict";
import { test } from "node:test";
import { monthAfter, monthGrid, parseDay, toDay } from "./dates.ts";

test("a day goes to text and back", () => {
  assert.equal(toDay(2026, 10, 9), "2026-11-09");
  assert.deepEqual(parseDay("2026-11-09"), { year: 2026, month: 10, day: 9 });
});

test("text that is not a real day is nothing", () => {
  assert.equal(parseDay("2026-02-30"), undefined);
  assert.equal(parseDay("11/09/2026"), undefined);
  assert.equal(parseDay(""), undefined);
});

test("a month is laid out in weeks from Monday", () => {
  // November 2026 starts on a Sunday and has 30 days.
  const weeks = monthGrid(2026, 10);
  assert.deepEqual(weeks[0], [0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(weeks.at(-1), [30, 0, 0, 0, 0, 0, 0]);
  assert.equal(weeks.length, 6);
  // February 2027 starts on a Monday and fills four weeks exactly.
  assert.equal(monthGrid(2027, 1).length, 4);
});

test("stepping a month crosses the year", () => {
  assert.deepEqual(monthAfter(2026, 11, 1), { year: 2027, month: 0 });
  assert.deepEqual(monthAfter(2026, 0, -1), { year: 2025, month: 11 });
});
