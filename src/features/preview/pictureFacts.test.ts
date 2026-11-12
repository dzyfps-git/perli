import assert from "node:assert/strict";
import { test } from "node:test";
import { cameraFacts, edgeColor, headline, hexAt, tintOf } from "./pictureFacts.ts";

test("the tint is the picture's average colour, and see-through pixels count for less", () => {
  const solid = new Uint8ClampedArray([200, 100, 0, 255, 100, 200, 0, 255]);
  assert.deepEqual(tintOf(solid), { tint: "rgb(150 150 0)", clear: false });
  const half = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 0]);
  assert.deepEqual(tintOf(half), { tint: "rgb(255 0 0)", clear: true });
  assert.deepEqual(tintOf(new Uint8ClampedArray([9, 9, 9, 0])), { tint: "transparent", clear: true });
});

test("a pixel copies as six hex digits", () => {
  assert.equal(hexAt([255, 0, 16, 255]), "#ff0010");
});

test("camera facts come out in a fixed order, and only those that are there", () => {
  const facts: [string, string, string][] = [
    ["Camera", "ISO speed", "200"],
    ["File", "Size", "2 MB"],
    ["Camera", "Camera model", "X100"],
    ["Camera", "F-stop", " "],
  ];
  assert.deepEqual(cameraFacts(facts), ["X100", "ISO 200"]);
});

test("the headline is the few facts that suit the kind of file", () => {
  const song: [string, string, string][] = [["Media", "Album", "Blue"], ["Media", "Length", "00:03:12"], ["File", "Size", "4 MB"]];
  assert.deepEqual(headline(song), ["00:03:12", "Blue"]);
  const photo: [string, string, string][] = [["Camera", "Camera model", "X100"], ["Picture", "Dimensions", "40 x 30"], ["x", "Pages", " "]];
  assert.deepEqual(headline(photo), ["40 x 30", "X100"]);
  assert.deepEqual(headline([]), []);
});

test("a page's edge colour comes from its margin, not its middle", () => {
  // 10 by 10: white all round, a black square in the middle.
  const pixels = new Uint8ClampedArray(10 * 10 * 4).fill(255);
  for (let y = 2; y < 8; y++) for (let x = 2; x < 8; x++) pixels.set([0, 0, 0, 255], (y * 10 + x) * 4);
  assert.equal(edgeColor(pixels, 10), "rgb(255 255 255)");
  assert.equal(edgeColor(new Uint8ClampedArray(0), 0), "transparent");
});
