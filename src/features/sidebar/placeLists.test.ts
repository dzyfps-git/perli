import assert from "node:assert/strict";
import { test } from "node:test";
import { byDay, groupsOf, holds, lookIn, lookKey, moved, movedTo, placeLabel, savedPaths, toggled, withGroup, withLook } from "./placeLists.ts";

test("toggling adds at the end and takes out whatever the case", () => {
  const list = toggled(toggled([], "C:\\A"), "D:\\B");
  assert.deepEqual(list, ["C:\\A", "D:\\B"]);
  assert.ok(holds(list, "c:\\a"));
  assert.deepEqual(toggled(list, "c:\\a"), ["D:\\B"]);
});

test("moving swaps with a neighbour and stops at the ends", () => {
  const list = ["a", "b", "c"];
  assert.deepEqual(moved(list, "b", -1), ["b", "a", "c"]);
  assert.deepEqual(moved(list, "B", 1), ["a", "c", "b"]);
  assert.equal(moved(list, "a", -1), list);
  assert.equal(moved(list, "c", 1), list);
  assert.equal(moved(list, "gone", 1), list);
});

test("only text paths survive from storage", () => {
  assert.deepEqual(savedPaths(["C:\\a", 3, null, "D:\\"]), ["C:\\a", "D:\\"]);
  assert.deepEqual(savedPaths({ a: 1 }), []);
  assert.deepEqual(savedPaths(null), []);
});

test("a place is called by its last name, and a drive by its path", () => {
  assert.equal(placeLabel("C:\\Users\\me\\Work"), "Work");
  assert.equal(placeLabel("C:\\Users\\me\\Work\\"), "Work");
  assert.equal(placeLabel("D:\\"), "D:\\");
  assert.equal(placeLabel("\\\\server\\share"), "share");
});

test("a look changes in parts and goes once it is empty", () => {
  let looks = withLook({}, "C:\\Work\\", { color: 2 });
  assert.deepEqual(looks, { "c:\\work": { color: 2 } });
  looks = withLook(looks, "c:\\WORK", { icon: "\uE734" });
  assert.deepEqual(looks[lookKey("C:\\Work")], { color: 2, icon: "\uE734" });
  looks = withLook(looks, "C:\\Work", { color: undefined });
  assert.deepEqual(looks, { "c:\\work": { icon: "\uE734" } });
  assert.deepEqual(withLook(looks, "C:\\Work", { icon: undefined }), {});
  const covered = withLook({}, "C:\\Trip", { cover: "C:\\Trip\\beach.jpg" });
  assert.deepEqual(covered, { "c:\\trip": { cover: "C:\\Trip\\beach.jpg" } });
  assert.deepEqual(withLook(covered, "C:\\Trip", { cover: undefined }), {});
});

test("where a cover is cropped goes with that cover", () => {
  const top = withLook(withLook({}, "C:\\Trip", { cover: "C:\\Trip\\a.jpg" }), "C:\\Trip", { coverAt: "start" });
  assert.deepEqual(top, { "c:\\trip": { cover: "C:\\Trip\\a.jpg", coverAt: "start" } });
  assert.deepEqual(withLook(top, "C:\\Trip", { color: 1 })["c:\\trip"].coverAt, "start", "other changes keep it");
  assert.deepEqual(withLook(top, "C:\\Trip", { cover: "C:\\Trip\\b.jpg" }), { "c:\\trip": { cover: "C:\\Trip\\b.jpg" } });
  assert.deepEqual(withLook(top, "C:\\Trip", { cover: undefined }), {});
  assert.deepEqual(withLook({}, "C:\\Trip", { coverAt: "end" }), {}, "no cover, nothing to crop");
});

test("a look handed to the folders inside reaches every depth, but not past their own", () => {
  let looks = withLook({}, "C:\\Work", { color: 2, inside: true });
  looks = withLook(looks, "C:\\Work\\Old\\Mine", { icon: "\uE734" });
  looks = withLook(looks, "C:\\Work\\Old", { cover: "C:\\Work\\Old\\a.jpg" });
  assert.deepEqual(lookIn(looks, "c:\\work\\a\\b\\c"), { color: 2, icon: undefined });
  assert.deepEqual(lookIn(looks, "C:\\Work\\Old"), { cover: "C:\\Work\\Old\\a.jpg", color: 2, icon: undefined });
  assert.deepEqual(lookIn(looks, "C:\\Work\\Old\\Mine\\Deeper"), { color: 2, icon: undefined }, "an own look hands nothing down");
  assert.deepEqual(lookIn(looks, "C:\\Work\\Old\\Mine"), { icon: "\uE734" });
  assert.equal(lookIn(looks, "C:\\Workshop"), undefined);
  assert.deepEqual(withLook(looks, "C:\\Work", { color: undefined })["c:\\work"], undefined, "nothing left to hand down");
});

test("bookmark groups are kept by path, whatever its case", () => {
  const groups = withGroup(withGroup({}, "C:\\Work\\", "Jobs"), "D:\\Art", "Fun");
  assert.deepEqual(groupsOf(["d:\\art", "C:\\WORK", "C:\\Other"], groups), ["Fun", "Jobs"]);
  assert.deepEqual(withGroup(groups, "c:\\work", undefined), { "d:\\art": "Fun" });
});

test("a dragged place lands where it is dropped, whatever its case", () => {
  const list = ["C:\\a", "C:\\b", "C:\\c", "C:\\d"];
  assert.deepEqual(movedTo(list, "c:\\A", 2), ["C:\\b", "C:\\c", "C:\\a", "C:\\d"]);
  assert.deepEqual(movedTo(list, "C:\\d", 0), ["C:\\d", "C:\\a", "C:\\b", "C:\\c"]);
  assert.deepEqual(movedTo(list, "C:\\b", 99), ["C:\\a", "C:\\c", "C:\\d", "C:\\b"], "past the end is the end");
  assert.equal(movedTo(list, "C:\\z", 0), list, "a place not in the list changes nothing");
});

test("recent items fall under today, yesterday and earlier", () => {
  const now = new Date(2026, 10, 13, 9, 30);
  const at = (day: number, hour: number) => ({ opened: new Date(2026, 10, day, hour).getTime() });
  const days = byDay([at(13, 8), at(13, 0), at(12, 23), at(12, 0), at(11, 23), { opened: 0 }], now);
  assert.deepEqual(
    days.map((day) => [day.label, day.items.length]),
    [["Today", 2], ["Yesterday", 2], ["Earlier", 2]],
  );
  assert.deepEqual(byDay([at(1, 1)], now).map((day) => day.label), ["Earlier"], "an empty day has no heading");
});
