import assert from "node:assert/strict";
import test from "node:test";
import { withSkipped } from "./skipList.ts";

test("a folder left out takes the place of the folders it holds, and one inside a left out folder adds nothing", () => {
  assert.deepEqual(withSkipped([], "C:\\Games"), ["C:\\Games"]);
  assert.deepEqual(withSkipped(["C:\\Games\\Old", "D:\\Films"], "c:\\games"), ["D:\\Films", "c:\\games"]);
  assert.deepEqual(withSkipped(["C:\\Games"], "C:\\Games\\Old"), ["C:\\Games"]);
  assert.deepEqual(withSkipped(["C:\\Games"], "C:\\Games\\"), ["C:\\Games"], "a trailing backslash is the same folder");
  assert.deepEqual(withSkipped(["C:\\Game"], "C:\\Games"), ["C:\\Game", "C:\\Games"], "a name that only starts the same is another folder");
});
