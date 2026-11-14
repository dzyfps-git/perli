import assert from "node:assert/strict";
import { test } from "node:test";
import { clampPan, originShift, panFor, seenPart, viewWindow } from "./zoomView.ts";

test("a picture twice the stage's size shows its middle half, and a pan moves that", () => {
  const stage = { width: 100, height: 50 };
  const content = { width: 200, height: 100 };
  assert.deepEqual(viewWindow(stage, content, { x: 0, y: 0 }), { x: 0.25, y: 0.25, width: 0.5, height: 0.5 });
  assert.deepEqual(viewWindow(stage, content, { x: 50, y: -25 }), { x: 0, y: 0.5, width: 0.5, height: 0.5 });
});

test("a pan for a point puts that point back in the middle", () => {
  const stage = { width: 100, height: 100 };
  const content = { width: 400, height: 400 };
  const pan = panFor({ x: 0.75, y: 0.25 }, content);
  const shown = viewWindow(stage, content, pan);
  assert.equal(shown.x + shown.width / 2, 0.75);
  assert.equal(shown.y + shown.height / 2, 0.25);
});

test("a picture smaller than the stage shows whole", () => {
  assert.deepEqual(viewWindow({ width: 100, height: 100 }, { width: 50, height: 50 }, { x: 0, y: 0 }), { x: 0, y: 0, width: 1, height: 1 });
});

test("a box on screen shows the part of a bigger one it covers", () => {
  const viewport = { left: 0, top: 0, width: 100, height: 100 };
  assert.deepEqual(seenPart(viewport, { left: -100, top: -50, width: 400, height: 200 }), { x: 0.25, y: 0.25, width: 0.25, height: 0.5 });
  assert.deepEqual(seenPart(viewport, { left: 50, top: 0, width: 100, height: 100 }), { x: 0, y: 0, width: 0.5, height: 1 });
});

test("moving the zoom's middle by the shift brings a spot where it was asked", () => {
  // Scaled 2.5 times about `origin`, a spot `at` on the page shows at `at * 2.5 - origin * 1.5`.
  const zoom = 2.5;
  const shown = (at: number, origin: number) => at * zoom - origin * (zoom - 1);
  const origin = 50 + originShift(shown(100, 50), 100, zoom);
  assert.equal(shown(100, origin), 100);
});

test("a pan stops where the picture's edge meets the stage's", () => {
  const stage = { width: 100, height: 100 };
  assert.deepEqual(clampPan({ x: 80, y: -10 }, stage, { width: 200, height: 100 }), { x: 50, y: 0 });
  assert.deepEqual(clampPan({ x: -80, y: 30 }, stage, { width: 200, height: 160 }), { x: -50, y: 30 });
});
