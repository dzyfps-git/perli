import type { OfficeCell, OfficeFacts } from "../../api";

/** Column 0 as "A", 26 as "AA". */
export function columnName(index: number) {
  let name = "";
  for (let left = index + 1; left > 0; left = Math.floor((left - 1) / 26)) name = String.fromCharCode(65 + ((left - 1) % 26)) + name;
  return name;
}

/** "B12" as row 11 and column 1, or null when it isn't a cell. */
export function cellOf(text: string) {
  const found = /^\s*([a-z]{1,3})\s*(\d{1,7})\s*$/i.exec(text);
  if (!found) return null;
  const column = [...found[1].toUpperCase()].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0) - 1;
  const row = Number(found[2]) - 1;
  return row >= 0 ? { row, column } : null;
}

/** A sheet's shown rows as tab-separated text, the way spreadsheets paste. */
export const asTabs = (rows: OfficeCell[][]) => rows.map((row) => row.map((cell) => (cell === null ? "" : String(cell))).join("\t")).join("\n");

/** Whether Office's own previewer shows the file at first, or Perli's reader. */
export function startsInOffice(facts: OfficeFacts, useOffice: boolean, internetFirst: boolean) {
  return facts.handler && useOffice && !facts.locked && !(facts.marked && internetFirst);
}

/** A short line of the facts that matter most, such as "12 pages · 3,400 words · Ana". */
export function factsLine(facts: [string, string][]) {
  const get = (label: string) => facts.find(([name]) => name === label)?.[1];
  const counts = [
    ["Pages", "page", "pages"],
    ["Slides", "slide", "slides"],
    ["Words", "word", "words"],
  ].flatMap(([label, one, many]) => {
    const value = get(label);
    return value ? [`${value} ${value === "1" ? one : many}`] : [];
  });
  const author = get("Author");
  return [...counts, ...(author ? [author] : [])].join("  ·  ");
}

/** "rgb(30, 31, 34)" as a colour the way Windows writes it, red in the low byte. */
export function colorRef(css: string) {
  const [red = 0, green = 0, blue = 0] = css.match(/\d+(\.\d+)?/g)?.map(Number) ?? [];
  return Math.round(red) | (Math.round(green) << 8) | (Math.round(blue) << 16);
}

/** Whether two rectangles share any area. */
export const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
