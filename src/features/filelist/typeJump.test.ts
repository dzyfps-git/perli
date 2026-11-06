import assert from "node:assert/strict";
import { test } from "node:test";
import { createTypeJump } from "./typeJump.ts";

function jump() {
  let time = 0;
  const typed = createTypeJump(() => time);
  return { typed, wait: (ms: number) => (time += ms) };
}

test("letters typed quickly build one prefix from the current row", () => {
  const { typed } = jump();
  assert.deepEqual(typed("r"), { prefix: "r", offset: 1 });
  assert.deepEqual(typed("e"), { prefix: "re", offset: 0 });
  assert.deepEqual(typed("p"), { prefix: "rep", offset: 0 });
});

test("a pause starts a new prefix", () => {
  const { typed, wait } = jump();
  typed("r");
  wait(1001);
  assert.deepEqual(typed("e"), { prefix: "e", offset: 1 });
});

test("repeating one letter steps through its matches", () => {
  const { typed } = jump();
  typed("a");
  assert.deepEqual(typed("a"), { prefix: "a", offset: 1 });
  assert.deepEqual(typed("A"), { prefix: "a", offset: 1 });
});

test("a space only counts inside a prefix", () => {
  const { typed } = jump();
  assert.equal(typed(" "), undefined);
  typed("m");
  assert.deepEqual(typed(" "), { prefix: "m ", offset: 0 });
});
