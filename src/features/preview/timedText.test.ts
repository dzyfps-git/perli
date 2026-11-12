import assert from "node:assert/strict";
import { test } from "node:test";
import { cuesOf, lineAt, lyricsOf } from "./timedText.ts";

test("lyrics come in the order they are sung, and a repeated line comes back", () => {
  const lines = lyricsOf("[ar: Someone]\r\n[00:12.50]Second\n[00:05.00][01:00]Chorus\nno time here\n[00:20.00]<00:20.50>Word by <00:21.00>word\n");
  assert.deepEqual(lines, [
    { at: 5, text: "Chorus" },
    { at: 12.5, text: "Second" },
    { at: 20, text: "Word by word" },
    { at: 60, text: "Chorus" },
  ]);
  assert.equal(lineAt(lines, 0), -1);
  assert.equal(lineAt(lines, 5), 0);
  assert.equal(lineAt(lines, 19.9), 1);
  assert.equal(lineAt(lines, 999), 3);
  assert.deepEqual(lyricsOf("just words\nand more"), []);
});

test("subtitles read from SRT and from WebVTT", () => {
  const srt = "1\r\n00:00:01,500 --> 00:00:03,000\r\n<i>Hello</i>\r\nthere\r\n\r\n2\r\n00:01:00,000 --> 00:01:02,250\r\n{\\an8}Up top\r\n\r\n3\r\nbroken\r\n";
  assert.deepEqual(cuesOf(srt), [
    { start: 1.5, end: 3, text: "Hello\nthere" },
    { start: 60, end: 62.25, text: "Up top" },
  ]);
  const vtt = "WEBVTT\n\nintro\n00:02.000 --> 00:04.000 line:0\nShort clock\n\n01:00:00.000 --> 01:00:01.000\nAn hour in\n\n00:09.000 --> 00:08.000\nBackwards\n";
  assert.deepEqual(cuesOf(vtt), [
    { start: 2, end: 4, text: "Short clock" },
    { start: 3600, end: 3601, text: "An hour in" },
  ]);
});
