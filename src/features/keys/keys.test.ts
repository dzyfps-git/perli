import assert from "node:assert/strict";
import { test } from "node:test";

import { bound, comboOf, KEYS, keysOf, rebound, reset, taken } from "./keys.ts";

const press = (key: string, code = "", held: Partial<Record<"ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) =>
  comboOf({ key, code, ctrlKey: false, altKey: false, shiftKey: false, ...held });

test("keys are told in one fixed order", () => {
  assert.equal(press("c", "KeyC", { ctrlKey: true, shiftKey: true }), "Ctrl+Shift+C");
  assert.equal(press("ArrowLeft", "ArrowLeft", { altKey: true }), "Alt+Left");
  assert.equal(press(" ", "Space"), "Space");
  assert.equal(press("F2", "F2"), "F2");
});

test("digits and the key left of 1 are read by where they sit", () => {
  assert.equal(press("@", "Digit2", { ctrlKey: true, shiftKey: true }), "Ctrl+Shift+2");
  assert.equal(press("~", "Backquote", { ctrlKey: true }), "Ctrl+`");
  assert.equal(press("+", "Equal", { ctrlKey: true, shiftKey: true }), "Ctrl+Shift+=");
});

test("a modifier alone is no key", () => {
  assert.equal(press("Control", "ControlLeft", { ctrlKey: true }), "");
  assert.equal(press("Shift", "ShiftLeft", { shiftKey: true }), "");
});

test("no two commands start with the same key", () => {
  const seen = new Map<string, string>();
  for (const command of KEYS) {
    for (const key of command.keys) {
      assert.equal(seen.get(key), undefined, `${key} is on ${seen.get(key)} and ${command.id}`);
      seen.set(key, command.id);
    }
  }
});

test("a new key is taken from the command that had it", () => {
  const overrides = rebound(KEYS, {}, "duplicate", "Ctrl+T");
  const table = bound(KEYS, overrides);
  assert.equal(table.get("Ctrl+T")?.id, "duplicate");
  assert.equal(table.get("Ctrl+D"), undefined);
  assert.deepEqual(keysOf(KEYS.find((command) => command.id === "newTab")!, overrides), []);
});

test("one of two keys can go and the other stays", () => {
  const overrides = rebound(KEYS, {}, "duplicate", "Alt+D");
  assert.deepEqual(overrides.path, ["Ctrl+L"]);
});

test("a fixed key can't be found by its combo, and says who keeps it", () => {
  assert.equal(bound(KEYS, {}).get("Ctrl+P"), undefined);
  assert.equal(taken(KEYS, "Ctrl+P")?.id, "palette");
  assert.equal(taken(KEYS, "Ctrl+D"), undefined);
});

test("a key reset takes its keys back from what had them since", () => {
  const moved = rebound(KEYS, {}, "duplicate", "Ctrl+T");
  const back = reset(KEYS, moved, "newTab");
  const table = bound(KEYS, back);
  assert.equal(table.get("Ctrl+T")?.id, "newTab");
  assert.deepEqual(keysOf(KEYS.find((command) => command.id === "duplicate")!, back), []);
});

test("keys that move through the list stay with it", () => {
  for (const combo of ["Down", "Shift+Down", "Ctrl+Home", "Ctrl+Shift+End", "PageDown"]) {
    assert.equal(taken(KEYS, combo)?.id, "move", combo);
    assert.equal(bound(KEYS, { delete: [combo] }).get(combo), undefined, combo);
  }
  for (const combo of ["Alt+Left", "Ctrl+PageDown", "Ctrl+D"]) assert.notEqual(taken(KEYS, combo)?.id, "move", combo);
});
