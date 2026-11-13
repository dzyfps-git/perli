import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isDaytime,
  newPalette,
  paletteFromPixels,
  paletteFromText,
  paletteStyle,
  paletteText,
  savedPalettes,
  START_COLORS,
  untilTurn,
  windowsColors,
} from "./palettes.ts";

test("only whole palettes survive from storage", () => {
  const good = { id: "custom-1", name: "Mine", colors: ["#112233", "#445566", "#AABBCC"] };
  const saved = [
    good,
    { ...good, id: "perli" },
    { ...good, colors: ["#112233", "#445566"] },
    { ...good, colors: ["red", "#445566", "#aabbcc"] },
    { ...good, name: 4 },
    null,
  ];
  assert.deepEqual(savedPalettes(saved), [good]);
  assert.deepEqual(savedPalettes("nope"), []);
});

test("a new palette is numbered past every one so far", () => {
  const first = newPalette([]);
  assert.deepEqual(first, { id: "custom-1", name: "Custom 1", colors: START_COLORS });
  assert.notEqual(first.colors, START_COLORS);
  const later = newPalette([first, { ...first, id: "custom-7" }]);
  assert.equal(later.id, "custom-8");
  assert.equal(later.name, "Custom 8");
});

test("a palette paints the three accent colors", () => {
  const style = paletteStyle({ id: "custom-1", name: "", colors: ["#000001", "#000002", "#000003"] });
  assert.deepEqual(style, { "--accent-start": "#000001", "--accent": "#000002", "--accent-end": "#000003" });
});

test("the Windows accent becomes three close colors around its own hue", () => {
  // Pure blue is already in the kept lightness range, so the middle color is itself.
  assert.deepEqual(windowsColors("#0000ff"), ["#0080ff", "#0000ff", "#8000ff"]);
  // Grey has no hue to step from, so all three are the same grey.
  assert.deepEqual(windowsColors("#808080"), ["#808080", "#808080", "#808080"]);
  // A very dark accent is lifted to where it reads on a dark theme.
  assert.deepEqual(windowsColors("#000040")?.[1], "#0000ff");
  assert.equal(windowsColors("blue"), undefined);
});

test("by the hour is light from seven until seven, and knows when it next turns", () => {
  const at = (hour: number, minute = 0) => new Date(2026, 10, 13, hour, minute);
  assert.equal(isDaytime(at(6, 59)), false);
  assert.equal(isDaytime(at(7)), true);
  assert.equal(isDaytime(at(18, 59)), true);
  assert.equal(isDaytime(at(19)), false);
  const HOUR = 3_600_000;
  assert.equal(untilTurn(at(6)), HOUR);
  assert.equal(untilTurn(at(7)), 12 * HOUR, "right on a turn, the next one");
  assert.equal(untilTurn(at(12, 30)), 6.5 * HOUR);
  assert.equal(untilTurn(at(20)), 11 * HOUR, "over midnight to the morning");
});

test("a picture's palette comes from its most common lively colour", () => {
  const pixel = (red: number, green: number, blue: number, alpha = 255) => [red, green, blue, alpha];
  const many = (count: number, one: number[]) => Array.from({ length: count }, () => one).flat();
  const blue = paletteFromPixels([...many(60, pixel(32, 80, 224)), ...many(30, pixel(128, 128, 128)), ...many(10, pixel(220, 30, 30))]);
  const middle = (colors: string[]) => [1, 3, 5].map((at) => parseInt(colors[1].slice(at, at + 2), 16));
  const [red, , bluePart] = middle(blue);
  assert.ok(bluePart > red, `blue wins over red and grey: ${blue}`);
  const grey = paletteFromPixels(many(10, pixel(90, 90, 90)));
  assert.equal(new Set(middle(grey)).size, 1, "a grey picture gives greys");
  assert.deepEqual(paletteFromPixels(many(4, pixel(255, 0, 0, 0))), START_COLORS, "nothing to see keeps the start");
});

test("a palette goes to a file and comes back with a new id", () => {
  const mine = { id: "custom-1", name: "Dusk", colors: ["#112233", "#445566", "#778899"] as [string, string, string] };
  const back = paletteFromText(paletteText(mine), [mine]);
  assert.deepEqual(back, { id: "custom-2", name: "Dusk", colors: mine.colors });
  assert.equal(paletteFromText("not json", []), undefined);
  assert.equal(paletteFromText(JSON.stringify({ name: "Bad", colors: ["red", "#000000", "#ffffff"] }), []), undefined);
  assert.equal(paletteFromText(JSON.stringify({ name: " ", colors: mine.colors }), [])?.name, "Custom 1");
});
