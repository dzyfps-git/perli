import assert from "node:assert/strict";
import { test } from "node:test";
import { cameraFacts, headline, hexAt, tintOf } from "./pictureFacts.ts";

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
