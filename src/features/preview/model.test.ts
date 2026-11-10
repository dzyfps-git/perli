import assert from "node:assert/strict";
import { test } from "node:test";

// The model view reads the motion setting as it loads.
Object.assign(globalThis, { matchMedia: () => ({ matches: false, addEventListener() {} }) });
const { glbJson } = await import("./model.ts");

test("a GLB's JSON names the files it keeps outside itself", () => {
  const json = new TextEncoder().encode(JSON.stringify({ buffers: [{ uri: "ship.bin" }], images: [{ uri: "hull.png" }] }));
  const bytes = new Uint8Array(20 + json.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, bytes.length, true);
  view.setUint32(12, json.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.set(json, 20);
  assert.deepEqual(glbJson(bytes.buffer), { buffers: [{ uri: "ship.bin" }], images: [{ uri: "hull.png" }] });
  assert.deepEqual(glbJson(new ArrayBuffer(4)), {});
});
