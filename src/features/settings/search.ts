/** Whether every word of `query` is somewhere in `text`, ignoring case. An empty query fits all. */
export function fitsSearch(text: string, query: string) {
  const haystack = text.toLocaleLowerCase();
  return query
    .toLocaleLowerCase()
    .split(/\s+/)
    .every((word) => haystack.includes(word));
}
