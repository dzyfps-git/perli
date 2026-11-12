import assert from "node:assert/strict";
import { test } from "node:test";
import { missingTags, packed, settingsOf, unpacked } from "./backup.ts";

test("only Perli's settings are packed, and reading places stay behind", () => {
  const prefs = settingsOf([
    ["perli-theme", '"dark"'],
    ["perli-shelf", '["C:\\\\a"]'],
    ["perli-book-places", "{}"],
    ["other-app", "1"],
    ["perli-accent", '"sea"'],
  ]);
  assert.deepEqual(prefs, { accent: '"sea"', theme: '"dark"' });
});

test("a packed file reads back as it was", () => {
  const backup = { prefs: { theme: '"dark"' }, tags: [{ name: "Work", color: 3 }] };
  assert.deepEqual(unpacked(packed(backup)), backup);
});

test("a file that is not Perli's is refused, and odd parts of one are dropped", () => {
  assert.throws(() => unpacked("not json"));
  assert.throws(() => unpacked('{"prefs":{}}'));
  const text = JSON.stringify({
    app: "Perli",
    kind: "settings",
    prefs: { theme: '"dark"', broken: 5, shelf: "[]" },
    tags: [{ name: "Work", color: 3, extra: true }, { name: 7, color: 1 }, { name: "Bad", color: -1 }],
  });
  assert.deepEqual(unpacked(text), { prefs: { theme: '"dark"' }, tags: [{ name: "Work", color: 3 }] });
});

test("only tags with a new name are made", () => {
  const wanted = [
    { name: "work", color: 1 },
    { name: "Art", color: 2 },
  ];
  assert.deepEqual(missingTags(wanted, [{ name: "Work" }]), [{ name: "Art", color: 2 }]);
});
