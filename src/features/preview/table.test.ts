import assert from "node:assert/strict";
import { test } from "node:test";
import { arrange, guessDelimiter, lineEnding, parseTable, tableDelimiter } from "./table.ts";

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

test("a table sorts by a column, numbers as numbers, and keeps each row's own number", () => {
  const body = [["b", "10"], ["a", "9"], ["c", ""], ["d", "100"]];
  const numbers = (rows: { number: number }[]) => rows.map((row) => row.number);
  assert.deepEqual(numbers(arrange(body, { column: 1, down: false }, [])), [2, 1, 4, 3]);
  assert.deepEqual(numbers(arrange(body, { column: 1, down: true }, [])), [4, 1, 2, 3]);
  assert.deepEqual(numbers(arrange(body, { column: 0, down: false }, [])), [2, 1, 3, 4]);
  assert.deepEqual(numbers(arrange(body, undefined, [])), [1, 2, 3, 4]);
});

test("each column's filter keeps the rows that hold its text", () => {
  const body = [["Apple", "red"], ["Pear", "green"], ["Grape", "Green"]];
  assert.deepEqual(arrange(body, undefined, ["", "GREEN"]).map((row) => row.number), [2, 3]);
  assert.deepEqual(arrange(body, undefined, ["p", "green"]).map((row) => row.number), [2, 3]);
  assert.deepEqual(arrange(body, undefined, ["ap", " "]).map((row) => row.number), [1, 3]);
});

test("line endings are named", () => {
  assert.equal(lineEnding("a\r\nb\r\n"), "CRLF");
  assert.equal(lineEnding("a\nb"), "LF");
  assert.equal(lineEnding("a\r\nb\nc"), "Mixed");
  assert.equal(lineEnding("one line"), "LF");
});
