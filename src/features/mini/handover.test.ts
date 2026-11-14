import assert from "node:assert/strict";
import { test } from "node:test";
import { caughtUp, placeOf, START_PLACE, upNextShown } from "./handover.ts";

test("a playing film has moved on by the time it lands, at its speed", () => {
  const film = { time: 10, at: 1_000, playing: true, speed: 2 };
  assert.equal(caughtUp(film, 1_500), 11);
  assert.equal(caughtUp({ ...film, playing: false }, 9_000), 10);
});

test("up next shows only in the last seconds, with a next film, of a film long enough", () => {
  assert.equal(upNextShown(95, 100, true), true);
  assert.equal(upNextShown(80, 100, true), false);
  assert.equal(upNextShown(95, 100, false), false);
  assert.equal(upNextShown(12, 15, true), false);
});

test("a place read back that is not one gives the first place", () => {
  assert.deepEqual(placeOf({ corner: "tl", width: 320 }), { corner: "tl", width: 320 });
  assert.deepEqual(placeOf({ corner: "middle", width: 320 }), START_PLACE);
  assert.deepEqual(placeOf({ corner: "tl" }), START_PLACE);
  assert.deepEqual(placeOf(null), START_PLACE);
});
