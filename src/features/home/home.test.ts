import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanSections, daysToFull, fullText, HOME_SECTIONS, loggedSpace, movedSection, readingPlaces } from "./home.ts";

test("cleanSections keeps the saved order and adds parts that are new", () => {
  assert.deepEqual(cleanSections(null), HOME_SECTIONS);
  const saved = [{ id: "today", hidden: true }, { id: "gone" }, { id: "drives" }, { id: "today" }];
  assert.deepEqual(
    cleanSections(saved).map((section) => section.id),
    ["today", "drives", "space", "reading", "pinned", "folders"],
  );
  assert.deepEqual(cleanSections(saved)[0], { id: "today", hidden: true });
});

test("movedSection puts a part before another, or last", () => {
  const ids = (sections: typeof HOME_SECTIONS) => sections.map((section) => section.id);
  assert.deepEqual(ids(movedSection(HOME_SECTIONS, "today", "drives")), ["today", "drives", "space", "reading", "pinned", "folders"]);
  assert.deepEqual(ids(movedSection(HOME_SECTIONS, "drives")), ["space", "reading", "pinned", "folders", "today", "drives"]);
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

test("free space is logged once a day for the last days only", () => {
  const day = 86_400_000;
  const now = new Date(2026, 5, 10, 15).getTime();
  const today = new Date(2026, 5, 10).getTime();
  let log = loggedSpace([[today - 200 * day, 1], [today - day, 50]], 40, now);
  assert.deepEqual(log, [[today - day, 50], [today, 40]]);
  log = loggedSpace(log, 30, now + 3600_000);
  assert.deepEqual(log, [[today - day, 50], [today, 30]], "a second look today replaces the first");
});

test("a drive filling at a steady pace says when it will be full", () => {
  const day = 86_400_000;
  const now = new Date(2026, 5, 30).getTime();
  const steady = Array.from({ length: 10 }, (_, at): [number, number] => [now - (9 - at) * 2 * day, 1000 - at * 20]);
  // 10 bytes a day, with 820 left.
  assert.equal(Math.round(daysToFull(steady, now)!), 82);
  assert.equal(daysToFull(steady.slice(0, 3), now), undefined, "too few samples");
  assert.equal(daysToFull(steady.map(([at]) => [at, 500]), now), undefined, "not filling up");
  assert.equal(daysToFull(steady.map(([at], i) => [at, 1e12 - i]), now), undefined, "years away");
  assert.equal(fullText(1.2), "full in about 1 day");
  assert.equal(fullText(30), "full in about 4 weeks");
  assert.equal(fullText(122), "full in about 4 months");
});
