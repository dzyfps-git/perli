import assert from "node:assert/strict";
import { test } from "node:test";
import { shortcutText } from "./shortcut.ts";

test("shortcut hints use the names on the keyboard", () => {
  assert.equal(shortcutText("Alt+ArrowLeft"), "Alt+Left");
  assert.equal(shortcutText("Control+Shift+1"), "Ctrl+Shift+1");
});

test("a space in aria-keyshortcuts reads as a choice of keys", () => {
  assert.equal(shortcutText("Control+= Control+-"), "Ctrl+= or Ctrl+-");
});
