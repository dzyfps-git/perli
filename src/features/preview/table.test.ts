import assert from "node:assert/strict";
import { test } from "node:test";
import { guessDelimiter, parseTable, tableDelimiter } from "./table.ts";

test("quotes hold delimiters, line breaks and doubled quotes", () => {
  const text = 'name,note\r\n"Smith, Jo","said ""hi""\nthen left"\nplain,\n';
  assert.deepEqual(parseTable(text, ",", 100, false), [
    ["name", "note"],
    ["Smith, Jo", 'said "hi"\nthen left'],
    ["plain", ""],
  ]);
});

test("a row cut off by the end of a piece waits for the rest, unless the file ends there", () => {
  assert.deepEqual(parseTable("a,b\nc,d", ",", 100, false), [["a", "b"]]);
  assert.deepEqual(parseTable("a,b\nc,d", ",", 100, true), [["a", "b"], ["c", "d"]]);
  assert.equal(parseTable("1\n2\n3\n4\n", ",", 2, true).length, 2);
});

test("the delimiter comes from the name or the first line", () => {
  assert.equal(tableDelimiter("x.TSV"), "\t");
  assert.equal(tableDelimiter("x.csv"), null);
  assert.equal(tableDelimiter("x.txt"), undefined);
  assert.equal(guessDelimiter('a;b;"c,d,e"\n1,2,3,4,5'), ";");
  assert.equal(guessDelimiter("a\tb\tc"), "\t");
  assert.equal(guessDelimiter("a,b"), ",");
});
