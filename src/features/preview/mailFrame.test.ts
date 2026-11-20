import assert from "node:assert/strict";
import test from "node:test";
import { framedMail } from "./mailFrame.ts";

test("a mail's HTML comes after rules it can't loosen", () => {
  const page = framedMail(`<meta http-equiv="Content-Security-Policy" content="default-src *"><base href="https://evil.example/"><p>Hi</p>`);
  const rule = page.indexOf("default-src 'none'");
  const base = page.indexOf(`<base target="_blank">`);
  assert.ok(rule > 0 && rule < page.indexOf("default-src *"), "its own rule is first, and rules only add up");
  assert.ok(base > 0 && base < page.indexOf("evil.example"), "the first base's target is the one that counts");
  assert.ok(page.endsWith("<p>Hi</p>"));
});
