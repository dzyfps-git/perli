import assert from "node:assert/strict";
import { test } from "node:test";
import { dateGroups, groupLabel } from "./groups.ts";

const names = { tag: (id: number) => (id === 3 ? "Work" : undefined), folder: (path: string) => path || "This folder" };

test("date groups start at midnight, with weeks from Monday", () => {
  // A Wednesday.
  const groups = dateGroups(new Date(2026, 10, 11, 15, 30));
  const day = (date: number, month = 10) => new Date(2026, month, date).getTime();
  assert.equal(groups[0].from, day(11));
  assert.equal(groups[1].from, day(10));
  assert.equal(groups[2].from, day(9));
  assert.equal(groups[3].from, day(2));
  assert.equal(groups[4].from, day(1));
  assert.equal(groups[5].from, day(1, 9));
  assert.equal(groups[7].from, new Date(2025, 0, 1).getTime());
});

test("headers name each kind of group, and the rest", () => {
  const now = new Date(2026, 10, 11);
  assert.equal(groupLabel("date", "1", now, names), "Yesterday");
  assert.equal(groupLabel("date", "older", now, names), "A long time ago");
  assert.equal(groupLabel("kind", "folders", now, names), "Folders");
  assert.equal(groupLabel("kind", "2", now, names), "Music");
  assert.equal(groupLabel("kind", "other", now, names), "Other files");
  assert.equal(groupLabel("size", "tiny", now, names), "Tiny, under 16 KB");
  assert.equal(groupLabel("tag", "3", now, names), "Work");
  assert.equal(groupLabel("tag", "none", now, names), "No tag");
  assert.equal(groupLabel("folder", "", now, names), "This folder");
});
