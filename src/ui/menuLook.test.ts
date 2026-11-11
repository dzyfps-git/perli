import assert from "node:assert/strict";
import { test } from "node:test";
import { iconFor, keysFor, starredFirst } from "./menuLook.ts";

const run = () => {};

test("a label that asks for more looks like the plain one", () => {
  assert.equal(iconFor("Filter…"), iconFor("Filter"));
  assert.equal(keysFor("Filter…"), "Ctrl+Shift+F");
  assert.equal(iconFor("Never heard of it"), undefined);
});

test("starred items go on top, and the rest starts under a line", () => {
  const items = [
    { label: "Open", action: run },
    { label: "Send to", items: [] },
    { label: "Rename", action: run, divider: true },
    { label: "Delete", action: run },
  ];
  const starred = starredFirst(items, (item) => ["Delete", "Rename", "Send to"].includes(item.label));
  assert.deepEqual(
    starred.map((item) => [item.label, !!item.divider]),
    [["Rename", false], ["Delete", false], ["Open", true], ["Send to", false]],
  );
  assert.equal(starredFirst(items, () => false), items);
});
