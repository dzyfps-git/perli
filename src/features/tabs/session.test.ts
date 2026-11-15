import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMoved, parseSession, parseWorkspaces, put } from "./session.ts";

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

test("parseSession keeps how a tab's panes sit, and drops what makes no sense", () => {
  const session = parseSession(
    JSON.stringify({
      tabs: [
        { panes: [pane, pane], split: 0.3, stacked: true, linked: true },
        { panes: [pane, pane], split: 7, stacked: "yes" },
      ],
    }),
  );
  assert.deepEqual(
    session?.tabs.map(({ split, stacked, linked }) => ({ split, stacked, linked })),
    [
      { split: 0.3, stacked: true, linked: true },
      { split: undefined, stacked: undefined, linked: undefined },
    ],
  );
});

test("parseSession keeps the folders opened in place, and only their names", () => {
  const session = parseSession(
    JSON.stringify({ tabs: [{ panes: [{ ...pane, expanded: ["C:\a\b", 4, null] }, { ...pane, expanded: "C:\a\b" }] }] }),
  );
  assert.deepEqual(session?.tabs[0].panes[0].expanded, ["C:\a\b"]);
  assert.equal(session?.tabs[0].panes[1].expanded, undefined);
});

test("a tab on the home page stays there, after a restart or a move to another window", () => {
  const session = parseSession(JSON.stringify({ tabs: [{ panes: [pane], home: true }, { panes: [pane], home: "yes" }] }));
  assert.deepEqual(
    session?.tabs.map((tab) => tab.home),
    [true, undefined],
  );
  assert.equal(parseMoved(JSON.stringify({ tab: { panes: [pane], home: true } }))?.tab.home, true);
});

test("parseMoved keeps the tab's history, selection, scroll and the window's place", () => {
  const moving = { ...pane, back: ["C:\b", 3], forward: [], select: ["x.txt"], scrollTop: 420 };
  const moved = parseMoved(
    JSON.stringify({ tab: { panes: [moving], active: 0, linked: true }, place: { x: -1700, y: 40, width: 900, height: 600, maximized: true } }),
  );
  assert.deepEqual(moved, {
    tab: { panes: [{ ...pane, back: ["C:\b"], select: ["x.txt"], scrollTop: 420 }], active: 0, swapped: false, linked: true },
    place: { x: -1700, y: 40, width: 900, height: 600, maximized: true },
  });
});

test("parseMoved drops a place that makes no sense, and a tab with no folder", () => {
  const moved = parseMoved(JSON.stringify({ tab: { panes: [{ ...pane, scrollTop: -5 }] }, place: { x: 1, y: 2, width: 0, height: 9 } }));
  assert.deepEqual(moved, { tab: { panes: [pane], active: 0, swapped: false } });
  for (const text of [null, "", "nope", "{}", '{"tab":{"panes":[{"path":4}]}}']) assert.equal(parseMoved(text), undefined);
});

test("parseWorkspaces keeps named sets of usable tabs, each name once", () => {
  const tab = { panes: [pane], active: 0, swapped: false };
  const list = parseWorkspaces([
    { name: " Work ", tabs: [tab], active: 0 },
    { name: "Work", tabs: [tab, tab], active: 1 },
    { name: "  ", tabs: [tab] },
    { name: "Empty", tabs: [{ panes: [] }] },
    { name: "Broken" },
    null,
    { name: 4, tabs: [tab] },
    { name: "Play", tabs: [tab, tab], active: 9 },
  ]);
  assert.deepEqual(list, [
    { name: "Work", tabs: [tab], active: 0 },
    { name: "Play", tabs: [tab, tab], active: 0 },
  ]);
  for (const value of [null, "x", {}, 3]) assert.deepEqual(parseWorkspaces(value), []);
});

test("put replaces the workspace of the same name, or adds it at the end", () => {
  const a = { name: "a", tabs: [], active: 0 };
  const b = { name: "b", tabs: [], active: 0 };
  const newA = { name: "a", tabs: [], active: 1 };
  assert.deepEqual(put([a, b], newA), [newA, b]);
  assert.deepEqual(put([a], b), [a, b]);
});
