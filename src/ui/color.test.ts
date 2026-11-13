import assert from "node:assert/strict";
import { test } from "node:test";
import { hexToHsv, hsvToHex, parseHex } from "./color.ts";

test("a hex is read with or without its sign, short or long", () => {
  assert.equal(parseHex("#9DB4FF"), "#9db4ff");
  assert.equal(parseHex(" abc "), "#aabbcc");
  assert.equal(parseHex("#12345"), undefined);
  assert.equal(parseHex("zzzzzz"), undefined);
});

test("the pure colors sit where the wheel has them", () => {
  assert.deepEqual(hexToHsv("#ff0000"), { h: 0, s: 1, v: 1 });
  assert.deepEqual(hexToHsv("#00ff00"), { h: 120, s: 1, v: 1 });
  assert.deepEqual(hexToHsv("#0000ff"), { h: 240, s: 1, v: 1 });
  assert.deepEqual(hexToHsv("#000000"), { h: 0, s: 0, v: 0 });
  assert.deepEqual(hexToHsv("#ffffff"), { h: 0, s: 0, v: 1 });
});

test("a color comes back the same after a turn through the picker", () => {
  for (const hex of ["#9db4ff", "#c4b5fd", "#f0a6d4", "#123456", "#808080", "#ff00ff", "#01fe7f"]) {
    assert.equal(hsvToHex(hexToHsv(hex)), hex);
  }
});
