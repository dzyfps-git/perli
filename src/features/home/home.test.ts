import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanSections, HOME_SECTIONS, movedSection, readingPlaces } from "./home.ts";

test("cleanSections keeps the saved order and adds parts that are new", () => {
  assert.deepEqual(cleanSections(null), HOME_SECTIONS);
  const saved = [{ id: "today", hidden: true }, { id: "gone" }, { id: "drives" }, { id: "today" }];
  assert.deepEqual(
    cleanSections(saved).map((section) => section.id),
    ["today", "drives", "reading", "pinned", "folders"],
  );
  assert.deepEqual(cleanSections(saved)[0], { id: "today", hidden: true });
});

test("movedSection puts a part before another, or last", () => {
  const ids = (sections: typeof HOME_SECTIONS) => sections.map((section) => section.id);
  assert.deepEqual(ids(movedSection(HOME_SECTIONS, "today", "drives")), ["today", "drives", "reading", "pinned", "folders"]);
  assert.deepEqual(ids(movedSection(HOME_SECTIONS, "drives")), ["reading", "pinned", "folders", "today", "drives"]);
  assert.equal(movedSection(HOME_SECTIONS, "drives", "drives"), HOME_SECTIONS);
});

test("readingPlaces takes turns between kinds, newest first, each file once", () => {
  const places = readingPlaces(
    {
      book: { "C:\\a.epub": { chapter: 0, at: 0 }, "C:\\b.epub": { chapter: 2, at: 0.5 } },
      comic: { "C:\\c.cbz": 4 },
      pdf: { "C:\\B.EPUB": 1 },
      timed: { "C:\\film.mp4": 754 },
    },
    (seconds) => `${seconds}s`,
    4,
  );
  assert.deepEqual(places, [
    { path: "C:\\b.epub", where: "Chapter 3 · 50%" },
    { path: "C:\\c.cbz", where: "Page 5" },
    { path: "C:\\film.mp4", where: "At 754s" },
    { path: "C:\\a.epub", where: "Chapter 1" },
  ]);
});
