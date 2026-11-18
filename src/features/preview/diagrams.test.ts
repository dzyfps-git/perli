import assert from "node:assert/strict";
import test from "node:test";
import { badLine, mix, rgbOf } from "./diagrams.ts";

test("a Mermaid error's line is found in either parser's words", () => {
  assert.equal(badLine("Parse error on line 3:\n...A-->\n----^\nExpecting 'NODE_STRING'"), 3);
  assert.equal(badLine("Lexer error on line 12, column 4: unexpected character"), 12);
  assert.equal(badLine("No diagram type detected matching given configuration"), undefined);
  assert.equal(badLine("Pipeline is offline"), undefined, "a word that holds 'line' is not one");
});

test("Chromium's colors read as parts, and mix as a page would", () => {
  assert.deepEqual(rgbOf("rgb(122, 95, 224)"), [122, 95, 224]);
  assert.deepEqual(rgbOf("rgba(0, 0, 0, 0.08)"), [0, 0, 0]);
  assert.deepEqual(rgbOf("color(srgb 1 0.5 0)"), [255, 128, 0]);
  assert.deepEqual(rgbOf("nonsense"), [128, 128, 128]);
  assert.equal(mix([255, 0, 0], [0, 0, 255], 0.25), "#4000bf");
  assert.equal(mix([18, 52, 86], [18, 52, 86], 1), "#123456");
});
