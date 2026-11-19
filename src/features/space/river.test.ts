import assert from "node:assert/strict";
import { test } from "node:test";
import { addHours, columns, DAY, HOUR, LEAST_SPAN, panned, riverOf, softened, sumBetween, ticks, wholeSpan, zoomed } from "./river.ts";

const hour = (time: string) => Date.parse(time) / HOUR;

test("hours counted in pieces add up, and any stretch sums at once", () => {
  const known = new Map<number, [number, number]>();
  addHours(known, [[hour("2025-03-01T10:00Z"), 2, 200], [hour("2025-03-02T09:00Z"), 1, 50]]);
  addHours(known, [[hour("2025-03-01T10:00Z"), 3, 300]]);
  const river = riverOf(known);
  assert.deepEqual(sumBetween(river, Date.parse("2025-03-01T00:00Z"), Date.parse("2025-03-02T00:00Z")), { files: 5, bytes: 500 });
  assert.deepEqual(sumBetween(river, Date.parse("2025-03-01T00:00Z"), Date.parse("2025-03-03T00:00Z")), { files: 6, bytes: 550 });
  assert.deepEqual(sumBetween(river, Date.parse("2025-03-02T10:00Z"), Date.parse("2025-03-05T00:00Z")), { files: 0, bytes: 0 });
  assert.deepEqual(columns(river, Date.parse("2025-03-01T00:00Z"), Date.parse("2025-03-03T00:00Z"), 2), [5, 1]);
});

test("zooming keeps the point under the pointer still and stays within the river", () => {
  const whole: [number, number] = [0, 1000 * DAY];
  const at = 400 * DAY;
  const [from, to] = zoomed([0, 1000 * DAY], at, 0.5, whole);
  assert.equal(to - from, 500 * DAY);
  assert.equal((at - from) / (to - from), 0.4);
  assert.deepEqual(zoomed([0, 1000 * DAY], at, 4, whole), whole);
  const [nearFrom, nearTo] = zoomed([at, at + DAY], at, 0.01, whole);
  assert.equal(nearTo - nearFrom, LEAST_SPAN);
  assert.deepEqual(panned([900 * DAY, 1000 * DAY], 50 * DAY, whole), [900 * DAY, 1000 * DAY]);
  assert.deepEqual(panned([100 * DAY, 200 * DAY], -150 * DAY, whole), [0, 100 * DAY]);
});

test("an empty river still has a month to show, and a counted one some room each side", () => {
  const [from, to] = wholeSpan(riverOf(new Map()));
  assert.equal(to - from, 30 * DAY);
  const known = new Map<number, [number, number]>([[1000, [1, 1]]]);
  const [first, last] = wholeSpan(riverOf(known));
  assert.ok(first < 1000 * HOUR && last > 1001 * HOUR);
});

test("softened banks keep their total shape but lose their steps", () => {
  assert.deepEqual(softened([0, 9, 0], 0), [0, 9, 0]);
  const soft = softened([0, 0, 9, 0, 0], 1);
  assert.ok(soft[2] < 9 && soft[1] > 0 && soft[0] === 0);
});

test("ticks get finer as the river zooms in", () => {
  const years = ticks(Date.parse("2010-01-01"), Date.parse("2025-01-01"), 900);
  assert.ok(years.every((tick) => /^\d{4}$/.test(tick.label)));
  const months = ticks(Date.parse("2025-01-15"), Date.parse("2025-09-01"), 900);
  assert.ok(months.some((tick) => tick.label === "Mar"));
  const days = ticks(Date.parse("2025-03-01T12:00"), Date.parse("2025-03-08T12:00"), 900);
  assert.ok(days.some((tick) => tick.label === "4"));
  const hours = ticks(Date.parse("2025-03-01T06:00"), Date.parse("2025-03-01T18:00"), 900);
  assert.ok(hours.some((tick) => tick.label === "12:00"));
});
