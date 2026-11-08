import assert from "node:assert/strict";
import { test } from "node:test";
import { installerName, manifest } from "./release.mjs";

test("latest.json points at the installer the release uploads", () => {
  const latest = manifest({ version: "1.2.3", notes: "Fixes", signature: "sig", date: new Date(0) });
  assert.deepEqual(latest, {
    version: "1.2.3",
    notes: "Fixes",
    pub_date: "1970-01-01T00:00:00.000Z",
    platforms: {
      "windows-x86_64": {
        signature: "sig",
        url: "https://github.com/dzyfps-git/perli-releases/releases/download/v1.2.3/Perli_1.2.3_x64-setup.exe",
      },
    },
  });
  assert.equal(installerName("1.2.3"), "Perli_1.2.3_x64-setup.exe");
});
