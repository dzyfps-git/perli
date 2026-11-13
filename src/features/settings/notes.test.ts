import assert from "node:assert/strict";
import { test } from "node:test";
import { noteBlocks } from "./notes.ts";

test("release notes read as headings, paragraphs and lists", () => {
  const notes = [
    "## What's new",
    "Perli now **remembers** where",
    "its window was.",
    "",
    "A second [paragraph](https://example.com).",
    "- Pinned places `drag` into order",
    "  and glide.",
    "* Recent is grouped by day",
    "",
    "- Still the same list",
  ].join("\r\n");
  assert.deepEqual(noteBlocks(notes), [
    { kind: "heading", text: "What's new" },
    { kind: "text", text: "Perli now remembers where its window was." },
    { kind: "text", text: "A second paragraph." },
    { kind: "list", items: ["Pinned places drag into order and glide.", "Recent is grouped by day", "Still the same list"] },
  ]);
  assert.deepEqual(noteBlocks(""), []);
});
