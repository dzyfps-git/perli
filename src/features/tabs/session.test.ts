import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSession } from "./session.ts";

const pane = { path: "C:\\a", sort: { key: "size", descending: true }, layout: "grid" };

test("parseSession keeps tabs, panes and their state", () => {
  const session = parseSession(
    JSON.stringify({ tabs: [{ panes: [pane, pane], active: 1, swapped: true }], active: 0 }),
  );
  assert.deepEqual(session, { tabs: [{ panes: [pane, pane], active: 1, swapped: true }], active: 0 });
});

test("parseSession starts fresh on damaged text", () => {
  for (const text of [null, undefined, "", "not json", "{}", '{"tabs":3}', '{"tabs":[]}']) {
    assert.equal(parseSession(text), undefined);
  }
});

test("parseSession drops panes without a path and tabs left empty", () => {
  const session = parseSession(
    JSON.stringify({ tabs: [{ panes: [{ path: 3 }] }, { panes: [pane, null] }], active: 9 }),
  );
  assert.equal(session?.tabs.length, 1);
  assert.equal(session?.tabs[0].panes.length, 1);
  assert.equal(session?.active, 0);
});

test("parseSession falls back on an unknown sort or layout", () => {
  const session = parseSession(
    JSON.stringify({ tabs: [{ panes: [{ path: "C:\\", sort: { key: "color" }, layout: "tree" }] }] }),
  );
  assert.deepEqual(session?.tabs[0].panes[0], {
    path: "C:\\",
    sort: { key: "name", descending: false },
    layout: "list",
  });
});

test("parseSession keeps at most 2 panes per tab", () => {
  const session = parseSession(JSON.stringify({ tabs: [{ panes: [pane, pane, pane], active: 2 }] }));
  assert.equal(session?.tabs[0].panes.length, 2);
  assert.equal(session?.tabs[0].active, 0);
});

test("parseSession keeps a pinned tab pinned", () => {
  const session = parseSession(JSON.stringify({ tabs: [{ panes: [pane], pinned: true }, { panes: [pane], pinned: "yes" }] }));
  assert.deepEqual(
    session?.tabs.map((tab) => tab.pinned),
    [true, undefined],
  );
});
