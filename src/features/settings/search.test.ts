import assert from "node:assert/strict";
import { test } from "node:test";
import { fitsSearch } from "./search.ts";

test("a settings search needs every word, in any order and case", () => {
  assert.ok(fitsSearch("Hover cards Show details", ""));
  assert.ok(fitsSearch("Hover cards Show details", "  "));
  assert.ok(fitsSearch("Hover cards Show details", "DETAILS hover"));
  assert.ok(!fitsSearch("Hover cards Show details", "hover sizes"));
});
