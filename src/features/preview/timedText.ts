/** Words that come with a time: a song's lyrics from an `.lrc` file, a film's subtitles from an `.srt`. */

export interface Line {
  /** When the line starts, in seconds. */
  at: number;
  text: string;
}

export interface Cue {
  start: number;
  end: number;
  text: string;
}

/**
 * The lines of an LRC file in the order they are sung. A line can carry several times, for a
 * chorus that comes back. Lines with no time at all are left out, and so are the file's notes
 * about itself, such as `[ar: the artist]`.
 */
export function lyricsOf(text: string): Line[] {
  const lines: Line[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const times = [...raw.matchAll(/\[(\d+):(\d+(?:[.:]\d+)?)\]/g)];
    if (!times.length) continue;
    const words = raw.replace(/\[[^\]]*\]/g, "").replace(/<\d+:\d+(?:\.\d+)?>/g, "").trim();
    for (const [, minutes, seconds] of times) lines.push({ at: Number(minutes) * 60 + Number(seconds.replace(":", ".")), text: words });
  }
  return lines.sort((a, b) => a.at - b.at);
}

/** Which line is being sung at `seconds`, or -1 before the first. */
export function lineAt(lines: Line[], seconds: number) {
  let low = 0;
  let high = lines.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (lines[middle].at <= seconds) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

const clock = (text: string) => {
  const parts = text.replace(",", ".").split(":").map(Number);
  return parts.reduce((total, part) => total * 60 + part, 0);
};

/** The cues of an SRT or WebVTT file. Tags that style the words are dropped, and the words kept. */
export function cuesOf(text: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of text.replace(/\r/g, "").split(/\n{2,}/)) {
    const lines = block.split("\n");
    const timed = lines.findIndex((line) => line.includes("-->"));
    if (timed < 0) continue;
    const found = lines[timed].match(/([\d:]+[.,]\d+)\s*-->\s*([\d:]+[.,]\d+)/);
    if (!found) continue;
    const words = lines
      .slice(timed + 1)
      .join("\n")
      .replace(/<[^>]*>|\{\\[^}]*\}/g, "")
      .trim();
    const [start, end] = [clock(found[1]), clock(found[2])];
    if (words && end > start) cues.push({ start, end, text: words });
  }
  return cues;
}
