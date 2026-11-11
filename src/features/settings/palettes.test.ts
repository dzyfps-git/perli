import assert from "node:assert/strict";
import { test } from "node:test";
import { newPalette, paletteStyle, savedPalettes, START_COLORS, windowsColors } from "./palettes.ts";

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
