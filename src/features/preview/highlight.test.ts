import assert from "node:assert/strict";
import { test } from "node:test";
import { coloredLines, htmlLines, pieceColorer } from "./highlight.ts";

test("colored text cuts into lines that each close what they open", async () => {
  assert.deepEqual(htmlLines('a<span class="c">b\r\nc</span>d\ne'), ['a<span class="c">b</span>', '<span class="c">c</span>d', "e"]);
  const lines = await coloredLines("rust", "/* one\ntwo */\nlet x = 1;");
  assert.deepEqual(lines.slice(0, 2), ['<span class="hljs-comment">/* one</span>', '<span class="hljs-comment">two */</span>']);
  assert.match(lines[2], /<span class="hljs-keyword">let<\/span>/);
});

test("a comment that crosses into the next piece is colored again with it", async () => {
  const color = pieceColorer("rust");
  const first = await color("fn main() {}\n/* a long");
  assert.equal(first.replaces, false);
  const second = await color(" comment */\nlet x = 1;");
  assert.equal(second.replaces, true);
  // The whole comment is one comment span, and the code after it is code again.
  assert.match(second.html, /<span class="hljs-comment">\/\* a long comment \*\/<\/span>/);
  assert.match(second.html, /<span class="hljs-keyword">let<\/span>/);
  // Closed now, so the next piece stands alone.
  assert.equal((await color("\nfn b() {}")).replaces, false);
});
