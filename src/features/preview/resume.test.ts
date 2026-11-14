import assert from "node:assert/strict";
import { test } from "node:test";
import { resumePlace } from "./resume.ts";

test("a long film picks up where it was left, unless that was near either end", () => {
  assert.equal(resumePlace(1200, 3600), 1200);
  assert.equal(resumePlace(3600, 3600), 0, "finished");
  assert.equal(resumePlace(3580, 3600), 0, "in the last half minute");
  assert.equal(resumePlace(20, 3600), 0, "barely started");
  assert.equal(resumePlace(undefined, 3600), 0, "never played");
  assert.equal(resumePlace(200, 300), 0, "too short to keep a place");
});
