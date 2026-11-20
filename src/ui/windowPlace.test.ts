import assert from "node:assert/strict";
import { test } from "node:test";
import { backOnScreen, onAScreen, screensKey, type Screen } from "./windowPlace.ts";

const left: Screen = { name: "\\\\.\\DISPLAY2", position: { x: -1920, y: 0 }, size: { width: 1920, height: 1080 } };
const main: Screen = { name: "\\\\.\\DISPLAY1", position: { x: 0, y: 0 }, size: { width: 2560, height: 1440 } };

test("the same screens give the same key, in any order", () => {
  assert.equal(screensKey([left, main]), screensKey([main, left]));
  assert.notEqual(screensKey([main]), screensKey([main, left]));
});

test("a window the screens left behind goes to the place kept for them, or the middle", () => {
  const place = (x: number, y: number) => ({ x, y, width: 1100, height: 700, maximized: false });
  assert.equal(backOnScreen(place(-1700, 120), [left, main]), undefined, "still on a screen, it stays");
  assert.deepEqual(backOnScreen(place(-1700, 120), [main], place(300, 200)), { x: 300, y: 200 });
  assert.equal(backOnScreen(place(-1700, 120), [main], place(-1700, 120)), "middle", "a kept place off the screens is no help");
  assert.equal(backOnScreen(place(-1700, 120), [main]), "middle");
});

test("a window comes back only where its top edge can still be grabbed", () => {
  const place = (x: number, y: number) => ({ x, y, width: 1100, height: 700, maximized: false });
  assert.ok(onAScreen(place(-1700, 120), [left, main]), "on the left screen");
  assert.ok(!onAScreen(place(-1700, 120), [main]), "that screen is gone");
  assert.ok(onAScreen(place(-1050, 0), [main]), "mostly off to the left, but its right end is on");
  assert.ok(!onAScreen(place(-1060, 0), [main]), "too little of it left to grab");
  assert.ok(onAScreen(place(100, -8), [main]), "a frame just past the top is fine");
  assert.ok(!onAScreen(place(100, 1420), [main]), "its top edge is below the screen");
});
