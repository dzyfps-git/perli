import assert from "node:assert/strict";
import { test } from "node:test";
import { KIND_NAMES } from "./fileKinds.ts";
import { cleanTheme, extensionKey, KIND_LABELS, PLAIN_THEME, themeFromText, themeText } from "./iconTheme.ts";

test("a theme goes to a file and comes back the same", () => {
  const theme = { style: "solid" as const, colors: { pdf: "#ff0000" }, extensions: { nfo: "text" as const }, accent: true };
  assert.deepEqual(themeFromText(themeText(theme)), theme);
  assert.equal(themeFromText('{"style":"line"}'), undefined, "a file that isn't a theme");
  assert.equal(themeFromText("not json"), undefined);
});

test("only the well-formed parts of a theme are kept", () => {
  const theme = cleanTheme({
    style: "wobbly",
    colors: { pdf: "#00ff00", nothing: "#000000", code: "red" },
    extensions: { log: "text", "Bad.Ext": "text", md: "nothing" },
    accent: "yes",
  });
  assert.deepEqual(theme, { style: "tile", colors: { pdf: "#00ff00" }, extensions: { log: "text" }, accent: false });
  assert.deepEqual(cleanTheme(null), PLAIN_THEME);
});

test("an extension is kept the way it is typed most often", () => {
  assert.equal(extensionKey(" *.NFO "), "nfo");
  assert.equal(extensionKey(".tar.gz"), "");
  assert.equal(extensionKey("a b"), "");
});

test("every kind has a name in Settings", () => {
  assert.deepEqual(Object.keys(KIND_LABELS).sort(), [...KIND_NAMES].sort());
});
