import assert from "node:assert/strict";
import { test } from "node:test";
import type { Progress } from "../../api";
import {
  formatSeconds,
  fraction,
  nextRate,
  nextThen,
  secondsLeft,
  SPEED_SAMPLES,
  speedLine,
  startRate,
  sweptText,
  withSpeed,
} from "./progress.ts";

test("a card keeps only the newest speeds, and draws them with the fastest on top", () => {
  let speeds: number[] = [];
  for (let at = 0; at < SPEED_SAMPLES + 5; at++) speeds = withSpeed(speeds, at);
  assert.equal(speeds.length, SPEED_SAMPLES);
  assert.equal(speeds[0], 5);
  assert.equal(speedLine([0, 50, 100], 100, 10), "0,10 50,5 100,0");
  assert.equal(speedLine([5], 100, 10), "");
  assert.equal(speedLine([0, 0], 100, 10), "");
});

test("the when-done chip offers eject only for a drive that can go", () => {
  assert.equal(nextThen("none", false), "open");
  assert.equal(nextThen("open", false), "none");
  assert.equal(nextThen("open", true), "eject");
  assert.equal(nextThen("eject", true), "none");
});

test("the crash card says what was put right, in words", () => {
  assert.equal(sweptText(0, 0), "");
  assert.equal(sweptText(1, 0), "1 moved file was put back where it was.");
  assert.equal(sweptText(3, 2), "3 moved files were put back where they were, and unfinished copies were cleared from 2 folders.");
  assert.equal(sweptText(0, 1), "Unfinished copies were cleared from 1 folder.");
});

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
