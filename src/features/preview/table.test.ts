import assert from "node:assert/strict";
import { test } from "node:test";
import { arrange, asDelimited, cellText, columnFacts, guessDelimiter, lineEnding, numberColumns, parquetType, parseTable, tableDelimiter } from "./table.ts";

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

test("a column of numbers is told apart from one that only starts with them", () => {
  const rows = [["1", "a1", ""], ["2.5", "2", "x"], [null, "3", "-4e2"]];
  assert.deepEqual(numberColumns(rows, 3), [true, false, false]);
  assert.deepEqual(numberColumns([["", null]], 2), [false, false]);
});

test("a column's facts count the empty fields and give its least and most", () => {
  const rows = [["10"], ["9"], [""], [null], ["100"]];
  assert.equal(columnFacts(rows, 0), "5 rows · 2 empty · 9 to 100");
  assert.equal(columnFacts([["b"], ["a"], ["b"]], 0), "3 rows · a to b · 2 different");
});

test("rows copy as text that reads back the same", () => {
  const rows = [["a", 'say "hi"'], ["x,y", null], ["line\nbreak", "tab\there"]];
  const csv = asDelimited(rows, ",");
  assert.deepEqual(parseTable(csv, ",", 100, true), rows.map((row) => row.map((field) => field ?? "")));
  assert.equal(asDelimited([["a\tb", "c"]], "\t"), '"a\tb"\tc');
});

test("values read from a file show as a table's fields", () => {
  assert.equal(cellText(null), null);
  assert.equal(cellText(undefined), null);
  assert.equal(cellText(12n), "12");
  assert.equal(cellText(true), "true");
  assert.equal(cellText(new Date(Date.UTC(2024, 0, 2, 3, 4, 5))), "2024-01-02T03:04:05Z");
  assert.equal(cellText(new Uint8Array(3)), "[Binary, 3 bytes]");
  assert.equal(cellText({ a: 1n, b: [1, "x"] }), '{"a":"1","b":[1,"x"]}');
  assert.equal(cellText("x".repeat(5000))?.length, 4001);
});

test("a Parquet column's type reads as its meaning first", () => {
  assert.equal(parquetType({ type: "BYTE_ARRAY", logical_type: { type: "STRING" } }, false), "STRING");
  assert.equal(parquetType({ type: "BYTE_ARRAY", converted_type: "UTF8" }, false), "STRING");
  assert.equal(parquetType({ type: "INT32", logical_type: { type: "INTEGER", bitWidth: 16, isSigned: false } }, false), "UINT16");
  assert.equal(parquetType({ type: "INT64" }, false), "INT64");
  assert.equal(parquetType({ type: "BYTE_ARRAY" }, false), "BINARY");
  assert.equal(parquetType({ converted_type: "LIST" }, true), "LIST");
  assert.equal(parquetType({}, true), "STRUCT");
});
