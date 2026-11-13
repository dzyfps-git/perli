/** Scores as search.rs's `fit_from` gives them, so the lit letters are the ones search chose. */
const LETTER = 1;
const IN_A_ROW = 8;
const WORD_START = 6;
const SKIPPED_COST = 1;
const ALNUM = /[\p{L}\p{N}]/u;

const isLower = (letter: string) => letter !== letter.toUpperCase() && letter === letter.toLowerCase();
const isUpper = (letter: string) => letter !== letter.toLowerCase() && letter === letter.toUpperCase();

/** The positions the query's letters take from `start`, each the next one along, with their score. */
function fitFrom(name: string, lowered: string, wanted: string, start: number) {
  const places: number[] = [];
  let [at, fit] = [start, 0];
  for (const letter of wanted) {
    const found = lowered.indexOf(letter, at);
    if (found < 0) return undefined;
    const last = places.at(-1);
    fit += LETTER + (last === undefined ? 0 : last + 1 === found ? IN_A_ROW : -(found - last) * SKIPPED_COST);
    const before = name[found - 1];
    if (found === 0 || !ALNUM.test(before) || (isLower(before) && isUpper(name[found]))) fit += WORD_START;
    places.push(found);
    at = found + letter.length;
  }
  return { places, fit };
}

/** Where a search's letters sit in a name, as [start, end) runs, to light them up.
 *  A name holding the whole query shows that; otherwise the letters search's best fit chose. */
export function matchSpans(name: string, query: string): [number, number][] {
  const lowered = name.toLowerCase();
  const wanted = query.toLowerCase();
  // A few letters change length when lowered, which would shift every position.
  if (!wanted || lowered.length !== name.length) return [];
  const whole = lowered.indexOf(wanted);
  if (whole >= 0) return [[whole, whole + wanted.length]];
  let best: { places: number[]; fit: number } | undefined;
  for (let start = lowered.indexOf(wanted[0]); start >= 0; start = lowered.indexOf(wanted[0], start + 1)) {
    const tried = fitFrom(name, lowered, wanted, start);
    // Rust's `max` keeps the last of equal fits, so this does too.
    if (tried && (!best || tried.fit >= best.fit)) best = tried;
  }
  const spans: [number, number][] = [];
  for (const found of best?.places ?? []) {
    const last = spans.at(-1);
    if (last && last[1] === found) last[1] = found + 1;
    else spans.push([found, found + 1]);
  }
  return spans;
}
