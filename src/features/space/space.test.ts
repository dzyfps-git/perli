import assert from "node:assert/strict";
import { test } from "node:test";
import type { MapCell } from "../../api";
import {
  ageGlow,
  agoText,
  allNodes,
  brainLayout,
  ease,
  folderTree,
  isUnder,
  layersLayout,
  msOf,
  nearestShown,
  onShape,
  pcTree,
  PC,
  route,
  tagsLayout,
  touches,
  upOne,
  useShares,
} from "./space.ts";

const DAY = 86_400_000;
/** 2024-01-01 in FILETIME ticks. */
const TICKS_2024 = 133_485_408_000_000_000;
const cell = (name: string, bytes: number, extra: Partial<MapCell> = {}): MapCell => ({ name, bytes, folder: true, newest: TICKS_2024, exts: [], ...extra });
const kindOf = (one: MapCell) => (one.folder ? "folder" : "file");

test("FILETIME ticks turn into milliseconds since 1970", () => {
  assert.equal(new Date(msOf(TICKS_2024)).toISOString(), "2024-01-01T00:00:00.000Z");
  assert.equal(msOf(0), 0);
});

test("a folder's tree keeps its biggest parts, folds the rest into one, and brings their parts along", () => {
  const cells = Array.from({ length: 15 }, (_, at) => cell(`f${at}`, (at + 1) * 10, { inner: [cell("small", 1), cell("big", 9)] }));
  const tree = folderTree("C:\\Data", "Data", cells, kindOf, 12);
  assert.equal(tree.kids.length, 13);
  assert.equal(tree.kids[0].name, "f14");
  assert.equal(tree.kids[0].id, "c:\\data\\f14");
  assert.deepEqual(tree.kids[0].kids.map((kid) => kid.name), ["big", "small"]);
  assert.equal(tree.kids[0].kids[0].path, "C:\\Data\\f14\\big");
  const folded = tree.kids[12];
  assert.equal(folded.folded, 3);
  assert.equal(folded.bytes, 10 + 20 + 30);
  assert.equal(tree.bytes, cells.reduce((sum, one) => sum + one.bytes, 0));
  assert.equal(folderTree("D:\\", "D:", [], kindOf).place, true);
});

test("This PC holds the drives, each with what it held when last weighed", () => {
  const tree = pcTree(
    [
      { path: "C:\\", name: "Windows", used: 500 },
      { path: "D:\\", name: "", used: 900 },
    ],
    { "c:\\": [cell("Users", 400), cell("Windows", 90)] },
    kindOf,
  );
  assert.equal(tree.id, PC);
  assert.equal(tree.bytes, 1400);
  assert.deepEqual(tree.kids.map((drive) => drive.name), ["Windows", "D:\\"]);
  assert.deepEqual(tree.kids[0].kids.map((kid) => kid.path), ["C:\\Users", "C:\\Windows"]);
  assert.equal(tree.kids[1].kids.length, 0);
  assert.equal(allNodes(tree).length, 5);
  const layered = pcTree([{ path: "C:\\", name: "", used: 1 }], {}, kindOf, { "c:\\": [[2020, 5]] });
  assert.deepEqual(layered.kids[0].years, [[2020, 5]], "a drive carries its years, for Layers on This PC");
});

test("paths go up one folder at a time and know what they lie under", () => {
  assert.equal(upOne("c:\\users\\me"), "c:\\users");
  assert.equal(upOne("c:\\users"), "c:\\");
  assert.equal(upOne("c:\\"), "");
  assert.ok(isUnder("c:\\users\\me", "c:\\users"));
  assert.ok(isUnder("c:\\users", "c:\\"));
  assert.ok(!isUnder("c:\\users2", "c:\\users"), "a name that only starts the same is not inside");
  assert.ok(isUnder("d:\\x", PC));
});

test("an untouched part dims with age, down to half", () => {
  const now = Date.UTC(2026, 0, 1);
  assert.equal(ageGlow(now, now), 1);
  assert.ok(ageGlow(now - 30 * DAY, now) < 1);
  assert.equal(ageGlow(now - 5000 * DAY, now), 0.5);
  assert.ok(ageGlow(0, now) > 0.5 && ageGlow(0, now) < 1, "no files is neither new nor old");
});

test("use counts visits under a part, fades with time, and measures parts among themselves", () => {
  const now = Date.UTC(2026, 0, 1);
  const shares = useShares(["c:\\", "c:\\work", "c:\\games", "c:\\old"], {
    "c:\\work\\perli": [10, now],
    "c:\\work": [2, now],
    "c:\\games": [12, now - 28 * DAY],
  }, now);
  assert.equal(shares.get("c:\\work"), 1);
  assert.equal(shares.get("c:\\games"), 0.25, "two half-lives later, 12 counts as 3 of 12");
  assert.equal(shares.get("c:\\old"), 0);
  assert.equal(shares.get("c:\\"), 1, "the root holds everything");
});

test("Brain puts the parts on a ring around the root, their own parts outside, none overlapping", () => {
  const cells = Array.from({ length: 10 }, (_, at) => cell(`f${at}`, 2 ** at, { inner: [cell("a", 2 ** at / 2), cell("b", 2 ** at / 4)] }));
  const tree = folderTree("C:\\", "C:", cells, kindOf);
  const { spots, links } = brainLayout(tree, 900, 600);
  assert.equal(spots.size, allNodes(tree).length);
  assert.equal(links.length, spots.size - 1);
  const root = spots.get(tree.id)!;
  assert.ok(Math.abs(root.x - 450) < 120 && Math.abs(root.y - 300) < 120, "the root sits near the middle");
  const list = [...spots.values()];
  for (const spot of list) {
    assert.ok(spot.x - spot.r >= 0 && spot.x + spot.r <= 900 && spot.y - spot.r >= 0 && spot.y + spot.r <= 600, "on the stage");
  }
  let overlaps = 0;
  for (let a = 0; a < list.length; a++)
    for (let b = a + 1; b < list.length; b++) if (Math.hypot(list[a].x - list[b].x, list[a].y - list[b].y) < list[a].r + list[b].r - 0.5) overlaps++;
  assert.equal(overlaps, 0);
  const big = tree.kids[0];
  const kid = big.kids[0];
  const out = (id: string) => Math.hypot(spots.get(id)!.x - root.x, spots.get(id)!.y - root.y);
  assert.ok(out(kid.id) > out(big.id), "a part's own parts sit further out");
  assert.ok(spots.get(big.id)!.r > spots.get(tree.kids[9].id)!.r, "bigger holds more");
  assert.deepEqual(brainLayout(tree, 900, 600).spots.get(kid.id), spots.get(kid.id), "the same tree is drawn the same way");
});

test("Layers stacks years oldest at the bottom, each as thick as its bytes, split among the parts", () => {
  const tree = folderTree(
    "C:\\",
    "C:",
    [
      cell("Old", 0, { years: [[2019, 100], [2024, 10]] }),
      cell("New", 0, { years: [[2024, 300]] }),
    ],
    kindOf,
  );
  const { bricks, rows } = layersLayout(tree.kids, 800, 500);
  assert.deepEqual(rows.map((row) => row.year), [2019, 2024]);
  const [old, recent] = rows;
  assert.ok(old.y > recent.y, "2019 lies below 2024");
  assert.ok(recent.h > old.h, "more bytes, a thicker band");
  const in2024 = bricks.filter((brick) => brick.year === 2024);
  assert.deepEqual(in2024.map((brick) => brick.owner), ["c:\\new", "c:\\old"]);
  assert.ok(in2024[0].w > in2024[1].w * 25);
  assert.equal(bricks.find((brick) => brick.owner === "c:\\old" && brick.year === 2019)!.id, "c:\\old", "a part's own year carries its ID");
  assert.equal(in2024[1].id, "c:\\old@2024");
  assert.deepEqual(layersLayout([], 800, 500), { bricks: [], rows: [] });
});

test("Tags draws a star per used tag and puts a file with two tags between them", () => {
  const { stars, specks, left } = tagsLayout(
    [{ id: 1 }, { id: 2 }, { id: 3 }],
    [
      { path: "C:\\a.txt", tags: [1] },
      { path: "C:\\b.txt", tags: [1, 2] },
      { path: "C:\\c.txt", tags: [9] },
    ],
    800,
    600,
  );
  assert.deepEqual(stars.map((star) => [star.tag, star.count]), [[1, 2], [2, 1]]);
  const both = specks.find((speck) => speck.path === "C:\\b.txt")!;
  const [one, two] = stars;
  const between = Math.hypot(both.x - (one.x + two.x) / 2, both.y - (one.y + two.y) / 2);
  assert.ok(between < 60, `${between}`);
  assert.equal(specks.length, 2, "a file whose tags have no star is left out");
  assert.equal(left, 1);
  assert.deepEqual(tagsLayout([{ id: 1 }], [{ path: "C:\\a", tags: [1] }], 800, 600).stars[0].x, 400, "one tag sits in the middle");
});

test("a pulse goes up to where two places meet, then down", () => {
  const parents: Record<string, string> = { a: "root", b: "root", a1: "a", b1: "b" };
  const parentOf = (id: string) => parents[id];
  assert.deepEqual(route("a1", "b1", parentOf), ["a1", "a", "root", "b", "b1"]);
  assert.deepEqual(route("a1", "a", parentOf), ["a1", "a"]);
  assert.deepEqual(route("a", "a", parentOf), ["a"]);
});

test("a path lands on the deepest part on show that holds it", () => {
  const shown = new Set(["c:\\", "c:\\users", "c:\\users\\me\\downloads"]);
  assert.equal(nearestShown("C:\\Users\\Me\\Downloads\\x.zip", shown, "c:\\"), "c:\\users\\me\\downloads");
  assert.equal(nearestShown("C:\\Users\\Me\\Music", shown, "c:\\"), "c:\\users");
  assert.equal(nearestShown("C:\\Temp", shown, "c:\\"), "c:\\");
  assert.equal(nearestShown("D:\\Games", shown, "c:\\"), undefined);
  assert.equal(nearestShown("D:\\Games", new Set([PC, "d:\\"]), PC), "d:\\");
});

test("easing takes the same way at any frame rate", () => {
  let fast = 0;
  for (let frame = 0; frame < 12; frame++) fast = ease(fast, 100, 1 / 120);
  let slow = 0;
  for (let frame = 0; frame < 6; frame++) slow = ease(slow, 100, 1 / 60);
  assert.ok(Math.abs(fast - slow) < 1e-9);
});

test("ages read as words", () => {
  const now = Date.UTC(2026, 5, 1);
  assert.equal(agoText(now - 3 * 3600_000, now), "changed today");
  assert.equal(agoText(now - 40 * DAY, now), "changed 1 month ago");
  assert.equal(agoText(now - 100 * DAY, now), "changed 3 months ago");
  assert.equal(agoText(now - 800 * DAY, now), "changed 2 years ago");
  assert.equal(agoText(0, now), "never changed");
});

test("a folder of more cells than a call takes arguments still makes its tree", () => {
  const cells = Array.from({ length: 200_000 }, (_, at) => cell(`f${at}`, at, { folder: false, newest: TICKS_2024 + at }));
  const tree = folderTree("C:\\Big", "Big", cells, kindOf);
  assert.equal(tree.newest, msOf(TICKS_2024 + 199_999));
  assert.equal(tree.kids.at(-1)?.folded, 200_000 - tree.kids.length + 1);
});

test("a job is weighed again where it changed what shows", () => {
  const copy = { from: ["C:\\Data\\In"], to: "C:\\Data\\Out\\Deep" };
  assert.equal(touches(copy, "C:\\Data"), true, "both ends are inside");
  assert.equal(touches(copy, "c:\\data\\out"), true, "in any case");
  assert.equal(touches(copy, "C:\\Data\\In"), true, "what it took away from");
  assert.equal(touches(copy, "C:\\Other"), false);
  assert.equal(touches(copy, "C:\\Data\\Out\\Deep\\Below"), false, "nothing changed below where it landed");
  assert.equal(touches({ from: ["D:\\x"], to: null }, ""), true, "This PC shows every drive");
});

test("a long thin pill is hit only where it shows", () => {
  // 400 wide and 6 high, fully rounded, as a band of Layers.
  const on = (dx: number, dy: number, pad = 0) => onShape(dx, dy, 400, 6, 3, pad);
  assert.equal(on(0, 50, 6), false, "50 below is off it, even with room around");
  assert.equal(on(0, 80), false);
  assert.equal(on(0, 3), true);
  assert.equal(on(199, 0), true, "its round end");
  assert.equal(on(201, 0), false, "just past its end");
  assert.equal(on(201, 0, 6), true, "unless there is room around it");
  assert.equal(onShape(0, 40, 80, 80, 40, 0), true, "a circle is a circle");
  assert.equal(onShape(39, 39, 80, 80, 40, 0), false, "outside its corner");
  assert.equal(onShape(39, 39, 80, 80, 2, 0), true, "a box has its corners");
});
