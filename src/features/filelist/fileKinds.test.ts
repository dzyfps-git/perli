import assert from "node:assert/strict";
import { test } from "node:test";
import { ageShare, hasPicture, iconSheet, kindOf } from "./fileKinds.ts";

const DAY_MS = 86_400_000;

test("a file's kind comes from its extension, whatever its case", () => {
  assert.equal(kindOf("Holiday.JPG", false), "picture");
  assert.equal(kindOf("main.rs", false), "code");
  assert.equal(kindOf("report.final.pdf", false), "pdf");
  assert.equal(kindOf(".gitignore", false), "config");
  assert.equal(kindOf("README", false), "file");
  assert.equal(kindOf("thing.unknown", false), "file");
});

test("a folder is a folder, even when its name ends like a file", () => {
  assert.equal(kindOf("photos.zip", true), "folder");
});

test("only what has a picture of its own asks for one", () => {
  assert.equal(hasPicture(kindOf("a.png", false)), true);
  assert.equal(hasPicture(kindOf("a.mp4", false)), true);
  assert.equal(hasPicture(kindOf("a.txt", false)), false);
});

test("every kind has one rule, and a folder takes the accent", () => {
  const rules = iconSheet().split("\n");
  assert.ok(rules.length >= 30);
  assert.equal(new Set(rules.map((rule) => rule.slice(0, rule.indexOf("{")))).size, rules.length);
  assert.match(rules.find((rule) => rule.startsWith('[data-kind="folder"]'))!, /--kind-color:var\(--accent\)\}$/);
  for (const rule of rules) assert.match(rule, /--kind-icon:url\("data:image\/svg\+xml,%3Csvg/);
});

test("a date ages fast at first and is old after a year", () => {
  const now = 400 * DAY_MS;
  assert.equal(ageShare(now, now), 0);
  assert.equal(ageShare(now + DAY_MS, now), 0);
  assert.equal(ageShare(now - 365 * DAY_MS, now), 1);
  assert.equal(ageShare(now - 3000 * DAY_MS, now), 1);
  assert.equal(ageShare(0, now), 1);
  const week = ageShare(now - 7 * DAY_MS, now);
  const month = ageShare(now - 30 * DAY_MS, now);
  assert.ok(week > 0.3 && week < month && month < 0.7);
});
