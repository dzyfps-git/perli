import assert from "node:assert/strict";
import { test } from "node:test";
import type { Progress } from "../../api";
import { formatSeconds, fraction, nextRate, secondsLeft, startRate } from "./progress.ts";

const progress = (bytes: number, items = 0): Progress => ({
  bytes,
  totalBytes: 1000,
  items,
  totalItems: 0,
  current: "",
});

test("fraction counts items as well as bytes", () => {
  assert.equal(fraction(progress(500)), 0.5);
  assert.equal(fraction({ ...progress(0, 1), totalBytes: 0, totalItems: 2 }), 0.5);
  assert.equal(fraction({ ...progress(0), totalBytes: 0 }), 0);
});

test("fraction never passes 1, even if files grow while they copy", () => {
  assert.equal(fraction(progress(2000)), 1);
});

test("speed starts at the first reading and then moves toward new ones", () => {
  const first = nextRate(startRate(0), progress(100), 1000);
  assert.equal(first.speed, 100);

  const second = nextRate(first, progress(600), 2000);
  assert.equal(second.speed, 200);
});

test("readings too close together are ignored", () => {
  const rate = startRate(0);
  assert.equal(nextRate(rate, progress(100), 50), rate);
});

test("time left waits for a pace", () => {
  assert.equal(secondsLeft(progress(0), startRate(0)), undefined);
  const rate = nextRate(startRate(0), progress(100), 1000);
  assert.equal(secondsLeft(progress(100), rate), 9);
});

test("time left reads in the largest sensible unit", () => {
  assert.equal(formatSeconds(4.2), "5 s");
  assert.equal(formatSeconds(90), "2 min");
  assert.equal(formatSeconds(3700), "1 h 2 min");
});
