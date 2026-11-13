import assert from "node:assert/strict";
import { test } from "node:test";
import { radiiOf, relax, startSpot } from "./pack.ts";

const WIDTH = 640;
const HEIGHT = 420;

test("a circle's area follows its bytes, and nothing is too small to see", () => {
  const radii = radiiOf([400, 100, 0], WIDTH, HEIGHT);
  assert.ok(Math.abs(radii[0] / radii[1] - 2) < 1e-9);
  assert.equal(radii[2], 8);
  assert.deepEqual(radiiOf([0, 0], WIDTH, HEIGHT), [8, 8]);
  assert.ok(radiiOf([1], WIDTH, HEIGHT)[0] <= HEIGHT / 2);
});

test("settling leaves the circles apart and on the stage", () => {
  const bytes = Array.from({ length: 40 }, (_, at) => 1000 / (at + 1) ** 1.3);
  const radii = radiiOf(bytes, WIDTH, HEIGHT);
  const spots = bytes.map((_, at) => startSpot(at, WIDTH, HEIGHT));
  let moved = Infinity;
  for (let step = 0; step < 600 && moved > 0.05; step++) moved = relax(spots, radii, WIDTH, HEIGHT);

  for (let a = 0; a < spots.length; a++) {
    assert.ok(spots[a].x >= radii[a] && spots[a].x <= WIDTH - radii[a], `circle ${a} is on the stage across`);
    assert.ok(spots[a].y >= radii[a] && spots[a].y <= HEIGHT - radii[a], `circle ${a} is on the stage down`);
    for (let b = a + 1; b < spots.length; b++) {
      const apart = Math.hypot(spots[a].x - spots[b].x, spots[a].y - spots[b].y);
      assert.ok(apart > radii[a] + radii[b], `circles ${a} and ${b} overlap by ${radii[a] + radii[b] - apart}`);
    }
  }
});

test("circles on one point still come apart", () => {
  const spots = [
    { x: 100, y: 100 },
    { x: 100, y: 100 },
  ];
  for (let step = 0; step < 50; step++) relax(spots, [20, 20], WIDTH, HEIGHT);
  assert.ok(Math.hypot(spots[0].x - spots[1].x, spots[0].y - spots[1].y) > 40);
});
