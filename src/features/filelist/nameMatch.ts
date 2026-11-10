/** Where a search's letters sit in a name, as [start, end) runs, to light them up.
 *  A name holding the whole query shows that; otherwise its letters in order, as search finds them. */
// ponytail: greedy letter order, which can light other letters than search's best fit scored.
export function matchSpans(name: string, query: string): [number, number][] {
  const lowered = name.toLowerCase();
  const wanted = query.toLowerCase();
  // A few letters change length when lowered, which would shift every position.
  if (!wanted || lowered.length !== name.length) return [];
  const whole = lowered.indexOf(wanted);
  if (whole >= 0) return [[whole, whole + wanted.length]];
  const spans: [number, number][] = [];
  let at = 0;
  for (const letter of wanted) {
    const found = lowered.indexOf(letter, at);
    if (found < 0) return [];
    const last = spans[spans.length - 1];
    if (last && last[1] === found) last[1] = found + letter.length;
    else spans.push([found, found + letter.length]);
    at = found + letter.length;
  }
  return spans;
}
