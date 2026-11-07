import assert from "node:assert/strict";
import { test } from "node:test";
import type { Thumb } from "../../api";
import { cachedThumb, createThumbLoader } from "./thumbs.ts";

const picture = (length = 4): Thumb => ({ width: 1, height: 1, pixels: new Uint8ClampedArray(length) });

function waitingFetches() {
  const started: { index: number; finish: (thumb: Thumb | null) => void }[] = [];
  const fetch = (index: number) =>
    new Promise<Thumb | null>((finish) => {
      started.push({ index, finish });
    });
  return { started, fetch };
}

const settle = () => new Promise((resolve) => setTimeout(resolve));

test("fetches four at a time, newest request first", async () => {
  const { started, fetch } = waitingFetches();
  const loader = createThumbLoader(fetch, () => true, () => {});

  for (let index = 0; index < 6; index++) loader.ask(index, `order-${index}`);
  assert.deepEqual(started.map(({ index }) => index), [0, 1, 2, 3]);

  started[0].finish(null);
  await settle();
  assert.equal(started[4].index, 5);
});

test("rows no longer wanted are never fetched", async () => {
  const { started, fetch } = waitingFetches();
  const gone = new Set([5]);
  const loader = createThumbLoader(fetch, (index) => !gone.has(index), () => {});

  for (let index = 0; index < 6; index++) loader.ask(index, `stale-${index}`);
  started[0].finish(null);
  await settle();

  assert.equal(started[4].index, 4);
});

test("a finished picture lands where its row is now, and is kept", async () => {
  const { started, fetch } = waitingFetches();
  const landed: number[] = [];
  const loader = createThumbLoader(fetch, () => true, (index) => landed.push(index));
  const thumb = picture();

  loader.ask(3, "moved");
  loader.ask(7, "moved");
  assert.equal(started.length, 1);
  started[0].finish(thumb);
  await settle();

  assert.deepEqual(landed, [7]);
  assert.equal(cachedThumb("moved"), thumb);
});

test("a file with no picture is remembered, unlike one nobody asked about", async () => {
  const { started, fetch } = waitingFetches();
  const loader = createThumbLoader(fetch, () => true, () => {});

  loader.ask(0, "plain");
  started[0].finish(null);
  await settle();

  assert.equal(cachedThumb("plain"), null);
  assert.equal(cachedThumb("never-asked"), undefined);
});

test("a failed fetch can be asked for again", async () => {
  const failing = () => Promise.reject(new Error("no snapshot"));
  const logged = console.error;
  console.error = () => {};
  const loader = createThumbLoader(failing, () => true, () => {});
  loader.ask(0, "failed");
  await settle();
  console.error = logged;

  assert.equal(cachedThumb("failed"), undefined);
  const { started, fetch } = waitingFetches();
  const again = createThumbLoader(fetch, () => true, () => {});
  again.ask(0, "failed");
  assert.equal(started.length, 1);
});

test("the oldest pictures go first once the cache is full, and a look keeps one", async () => {
  const load = async (key: string, thumb: Thumb) => {
    const loader = createThumbLoader(() => Promise.resolve(thumb), () => true, () => {});
    loader.ask(0, key);
    await settle();
  };
  const big = 30 * 1024 * 1024;

  await load("first", picture(big));
  await load("second", picture(big));
  cachedThumb("first");
  await load("third", picture(big));

  assert.notEqual(cachedThumb("first"), undefined);
  assert.equal(cachedThumb("second"), undefined);
  assert.notEqual(cachedThumb("third"), undefined);
});
