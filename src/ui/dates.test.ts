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

test("how long ago reads in the fewest words", async () => {
  const { ago } = await import("./dates.ts");
  const now = Date.UTC(2026, 10, 11, 12);
  const minute = 60_000;
  const day = 24 * 60 * minute;
  assert.equal(ago(now - 20_000, now), "just now");
  assert.equal(ago(now - 2 * minute, now), "2 min ago");
  assert.equal(ago(now - 60 * minute, now), "1 hour ago");
  assert.equal(ago(now - 5 * 60 * minute, now), "5 hours ago");
  assert.equal(ago(now - day, now), "yesterday");
  assert.equal(ago(now - 3 * day, now), "3 days ago");
  assert.equal(ago(now - 15 * day, now), "2 weeks ago");
  assert.equal(ago(now - 70 * day, now), "2 months ago");
  assert.equal(ago(now - 800 * day, now), "2 years ago");
  assert.equal(ago(now + minute, now), "in the future");
});

test("an ISO time has no words in it", async () => {
  const { isoText } = await import("./dates.ts");
  assert.equal(isoText(new Date(2026, 0, 5, 9, 7).getTime()), "2026-01-05 09:07");
});
