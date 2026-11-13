/** Files shown as a table, and what splits their fields. Null means find out from the text. */
export function tableDelimiter(name: string): string | null | undefined {
  const lower = name.toLowerCase();
  if (lower.endsWith(".tsv") || lower.endsWith(".tab")) return "\t";
  return lower.endsWith(".csv") ? null : undefined;
}

/** The delimiter used most in the first line, outside quotes: comma, semicolon or tab. */
export function guessDelimiter(text: string): string {
  const counts = new Map([[",", 0], [";", 0], ["\t", 0]]);
  let quoted = false;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && (char === "\n" || char === "\r")) break;
    else if (!quoted && counts.has(char)) counts.set(char, counts.get(char)! + 1);
  }
  return [...counts].reduce((best, next) => (next[1] > best[1] ? next : best))[0];
}

/**
 * Rows of a CSV or TSV the way RFC 4180 reads them: quotes hold delimiters and line breaks, and
 * two quotes are one. Stops after `most` rows. A last row cut off mid-file is left out unless
 * `whole`, since the next piece of the file finishes it.
 */
export function parseTable(text: string, delimiter: string, most: number, whole: boolean): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (quoted) {
      if (char !== '"') field += char;
      else if (text[at + 1] === '"') {
        field += '"';
        at++;
      } else quoted = false;
    } else if (char === '"' && field === "") quoted = true;
    else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[at + 1] === "\n") at++;
      row.push(field);
      rows.push(row);
      if (rows.length >= most) return rows;
      row = [];
      field = "";
    } else field += char;
  }
  if (whole && (field || row.length)) rows.push([...row, field]);
  return rows;
}

/** Which column a table is sorted by, counted from 0, and which way. */
export interface TableOrder {
  column: number;
  down: boolean;
}

const names = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * The rows of a table's body as shown: only those where each column holds its filter's text,
 * in `order` if there is one. Each row keeps the number it has in the file. Numbers sort as
 * numbers, and empty fields go last either way.
 */
export function arrange(body: string[][], order: TableOrder | undefined, filters: string[]) {
  const wanted = filters.map((filter) => filter.trim().toLowerCase());
  const kept = body
    .map((row, at) => ({ row, number: at + 1 }))
    .filter(({ row }) => wanted.every((filter, column) => !filter || (row[column] ?? "").toLowerCase().includes(filter)));
  if (!order) return kept;
  const field = (item: { row: string[] }) => (item.row[order.column] ?? "").trim();
  return kept.sort((a, b) => {
    const [left, right] = [field(a), field(b)];
    if (!left || !right) return left ? -1 : right ? 1 : a.number - b.number;
    const both = left !== "" && right !== "" && !Number.isNaN(Number(left)) && !Number.isNaN(Number(right));
    const way = both ? Number(left) - Number(right) : names.compare(left, right);
    return (order.down ? -way : way) || a.number - b.number;
  });
}

/** How the lines of a text end: the Windows way, the Unix way, or both. */
export function lineEnding(text: string) {
  const windows = text.includes("\r\n");
  const unix = /(^|[^\r])\n/.test(text);
  return windows && unix ? "Mixed" : windows ? "CRLF" : "LF";
}
