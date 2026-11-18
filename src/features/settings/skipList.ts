/** `skip` with `folder` added, unless it or a folder holding it is there already. Folders it
 *  holds go, since leaving it out leaves them out too. */
export function withSkipped(skip: string[], folder: string) {
  const low = (path: string) => path.replace(/\\+$/, "").toLowerCase();
  const inside = (path: string, outer: string) => low(path) === low(outer) || low(path).startsWith(`${low(outer)}\\`);
  if (skip.some((kept) => inside(folder, kept))) return skip;
  return [...skip.filter((kept) => !inside(kept, folder)), folder];
}
