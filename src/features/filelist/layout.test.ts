import assert from "node:assert/strict";
import { test } from "node:test";
import { besidePoint, groupedMove, justifiedPlaces, moveTarget, placesOf } from "./layout.ts";

const list = { count: 100, perRow: 1, pageRows: 10 };
const grid = { count: 10, perRow: 4, pageRows: 2 };

test("list keys move by rows and clamp to the ends", () => {
  assert.equal(moveTarget("ArrowDown", 5, list), 6);
  assert.equal(moveTarget("ArrowUp", 0, list), 0);
  assert.equal(moveTarget("PageDown", 95, list), 99);
  assert.equal(moveTarget("End", 5, list), 99);
  assert.equal(moveTarget("Home", 5, list), 0);
});

test("left and right do nothing in a list", () => {
  assert.equal(moveTarget("ArrowLeft", 5, list), undefined);
  assert.equal(moveTarget("ArrowRight", 5, list), undefined);
});

test("grid up and down move a whole row", () => {
  assert.equal(moveTarget("ArrowDown", 1, grid), 5);
  assert.equal(moveTarget("ArrowUp", 5, grid), 1);
  assert.equal(moveTarget("ArrowRight", 3, grid), 4);
  assert.equal(moveTarget("ArrowLeft", 4, grid), 3);
});

test("grid up from the top row stays put", () => {
  assert.equal(moveTarget("ArrowUp", 2, grid), 2);
});

test("grid down into a short last row lands on its last tile", () => {
  assert.equal(moveTarget("ArrowDown", 7, grid), 9);
});

test("grid down on the last row stays put", () => {
  assert.equal(moveTarget("ArrowDown", 9, grid), 9);
});

test("grid page keys move by rows of tiles", () => {
  assert.equal(moveTarget("PageDown", 0, grid), 8);
  assert.equal(moveTarget("PageUp", 9, grid), 1);
});

test("the first arrow press with no focus lands on the first row", () => {
  assert.equal(moveTarget("ArrowDown", -1, grid), 0);
  assert.equal(moveTarget("ArrowRight", -1, grid), 0);
  assert.equal(moveTarget("ArrowUp", -1, list), 0);
});

test("other keys are not moves", () => {
  assert.equal(moveTarget("a", 1, list), undefined);
});

test("a box beside a point flips at the window edge and stays inside", () => {
  const window = { width: 1000, height: 800 };
  assert.deepEqual(besidePoint(100, 100, 200, 100, window), { left: 116, top: 116 });
  assert.deepEqual(besidePoint(900, 750, 200, 100, window), { left: 684, top: 634 });
  assert.deepEqual(besidePoint(10, 10, 2000, 100, window), { left: 4, top: 26 });
});

test("rows with no groups follow each other in lines", () => {
  const places = placesOf([], 10, 4, 100, 30);
  assert.equal(places.height, 300);
  assert.equal(places.top(5), 100);
  assert.equal(places.column(5), 1);
  assert.equal(places.firstAt(150), 4);
});

test("each group starts a line of its own under its header", () => {
  // Five rows, then a folded group of three, then two rows.
  const groups = [
    { start: 0, count: 5 },
    { start: 5, count: 0 },
    { start: 5, count: 2 },
  ];
  const places = placesOf(groups, 7, 4, 100, 30);
  assert.deepEqual(places.tops, [0, 230, 260]);
  assert.equal(places.height, 390);
  assert.equal(places.top(0), 30);
  assert.equal(places.top(4), 130);
  assert.equal(places.column(4), 0);
  assert.equal(places.groupOf(5), 2);
  assert.equal(places.top(5), 290);
  assert.equal(places.column(6), 1);
  assert.equal(places.firstAt(0), 0);
  assert.equal(places.firstAt(135), 4);
  assert.equal(places.firstAt(240), 5);
  assert.equal(places.groupAt(250), 1);
});

test("a header stays at the top until the next one pushes it off", () => {
  const places = placesOf([{ start: 0, count: 10 }, { start: 10, count: 10 }], 20, 1, 20, 30);
  assert.equal(places.headerTop(0, 0), 0);
  assert.equal(places.headerTop(0, 100), 100);
  assert.equal(places.headerTop(0, 220), 200);
  assert.equal(places.headerTop(1, 220), 230);
});

test("grid up and down step between groups, keeping the tile and skipping folded ones", () => {
  // Three per line: a group of 5 (lines 0-2, 3-4), a folded one, then a group of 4 (5-7, 8).
  const groups = [{ start: 0, count: 5 }, { start: 5, count: 0 }, { start: 5, count: 4 }];
  assert.equal(groupedMove("ArrowDown", 1, groups, 3), 4);
  assert.equal(groupedMove("ArrowDown", 2, groups, 3), 4, "a short line takes its last tile");
  assert.equal(groupedMove("ArrowDown", 4, groups, 3), 6, "into the next group's first line");
  assert.equal(groupedMove("ArrowUp", 6, groups, 3), 4, "back to the last line above");
  assert.equal(groupedMove("ArrowUp", 7, groups, 3), 4);
  assert.equal(groupedMove("ArrowUp", 1, groups, 3), 1, "the top stays put");
  assert.equal(groupedMove("ArrowDown", 8, groups, 3), 8, "the bottom stays put");
  assert.equal(groupedMove("ArrowLeft", 1, groups, 3), undefined);
});

test("a gallery fills each line to the width, keeps shapes, and leaves the last line short", () => {
  // Three squares fill 308 pixels at 100 tall with two gaps of 4. The rest start a new line.
  const shapes = [1, 1, 1, 2, 1];
  const wall = justifiedPlaces([], 5, (index) => shapes[index], 308, 100, 4, 30);
  assert.deepEqual([0, 1, 2].map(wall.x), [0, 104, 208]);
  assert.deepEqual([0, 1, 2].map(wall.width), [100, 100, 100]);
  assert.equal(wall.top(3), 104);
  assert.equal(wall.lineHeight(3), 100);
  assert.equal(wall.width(3), 200);
  assert.equal(wall.x(4), 204);
  assert.equal(wall.height, 204);
  assert.equal(wall.firstAt(0), 0);
  assert.equal(wall.firstAt(150), 3);
  assert.equal(wall.firstAt(1000), 5);
});

test("a gallery line stops one picture early when that comes closer to the height wanted", () => {
  // Two squares at 300 wide make a line 150 tall; a third makes it 100. 150 is nearer 140.
  const wall = justifiedPlaces([], 3, () => 1, 300, 140, 0, 0);
  assert.equal(wall.lineHeight(0), 150);
  assert.equal(wall.top(2), 150);
  // A picture with no shape known shows square, and a panorama crops to three times as wide.
  const odd = justifiedPlaces([], 2, (index) => [0, 10][index], 1000, 100, 0, 0);
  assert.deepEqual([odd.width(0), odd.width(1)], [100, 300]);
});

test("gallery groups start their own lines under their headers", () => {
  const groups = [{ start: 0, count: 2 }, { start: 2, count: 0 }, { start: 2, count: 1 }];
  const wall = justifiedPlaces(groups, 3, () => 1, 200, 100, 0, 30);
  assert.deepEqual(wall.tops, [0, 130, 160]);
  assert.equal(wall.top(0), 30);
  assert.equal(wall.top(2), 190);
  assert.equal(wall.groupOf(2), 2);
  assert.equal(wall.height, 290);
});

test("gallery up and down land on the picture nearest across", () => {
  // Line one: a square then a wide 3, 100 tall; line two: three squares, short.
  const shapes = [1, 3, 1, 1, 1];
  const wall = justifiedPlaces([], 5, (index) => shapes[index], 400, 100, 0, 0);
  assert.equal(wall.nearest(1, 1), 4);
  assert.equal(wall.nearest(0, 1), 2);
  assert.equal(wall.nearest(4, -1), 1);
  assert.equal(wall.nearest(0, -1), 0);
  assert.equal(wall.nearest(2, 5), 2);
  assert.equal(wall.most(100), 5);
  assert.equal(wall.most(0), 3);
});
