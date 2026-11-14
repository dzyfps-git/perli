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

/** A field of a table. Null is a database's empty, which is not the same as an empty text. */
export type Cell = string | null;

/**
 * The rows of a table's body as shown: only those where each column holds its filter's text,
 * in `order` if there is one. Each row keeps the number it has in the file. Numbers sort as
 * numbers, and empty fields go last either way.
 */
export function arrange(body: Cell[][], order: TableOrder | undefined, filters: string[]) {
  const wanted = filters.map((filter) => filter.trim().toLowerCase());
  const kept = body
    .map((row, at) => ({ row, number: at + 1 }))
    .filter(({ row }) => wanted.every((filter, column) => !filter || (row[column] ?? "").toLowerCase().includes(filter)));
  if (!order) return kept;
  const field = (item: { row: Cell[] }) => (item.row[order.column] ?? "").trim();
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

const isNumber = (field: string) => field.trim() !== "" && Number.isFinite(Number(field));

/** Columns whose every filled field is a number, judged from the first `most` rows. */
export function numberColumns(rows: Cell[][], columns: number, most = 200): boolean[] {
  const sample = rows.slice(0, most);
  return Array.from({ length: columns }, (_, column) => {
    const filled = sample.map((row) => row[column]).filter((field): field is string => !!field?.trim());
    return filled.length > 0 && filled.every(isNumber);
  });
}

/** What a column holds, in a line: how many fields are empty, and its least and most. */
export function columnFacts(rows: Cell[][], column: number): string {
  const filled = rows.map((row) => row[column]).filter((field): field is string => !!field?.trim());
  const empty = rows.length - filled.length;
  const parts = [`${rows.length.toLocaleString()} rows`];
  if (empty) parts.push(`${empty.toLocaleString()} empty`);
  if (filled.length) {
    const numbers = filled.every(isNumber);
    const sorted = numbers ? filled.map(Number).sort((a, b) => a - b).map(String) : [...filled].sort(names.compare);
    const short = (field: string) => (field.length > 24 ? `${field.slice(0, 23)}…` : field);
    parts.push(`${short(sorted[0])} to ${short(sorted.at(-1)!)}`);
    if (!numbers) parts.push(`${new Set(filled).size.toLocaleString()} different`);
  }
  return parts.join(" · ");
}

/** Rows as CSV or TSV text, quoted the way `parseTable` reads them back. */
export function asDelimited(rows: Cell[][], delimiter: string): string {
  const quote = (field: Cell) => {
    const text = field ?? "";
    return /["\r\n]/.test(text) || text.includes(delimiter) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return rows.map((row) => row.map(quote).join(delimiter)).join("\r\n");
}

/** A longer text in one field is cut here, with an ellipsis, as the database's fields are. */
const MOST_CHARS = 4000;
/** A nested value shows this much of itself in one field. */
const MOST_NESTED = 200;

const cut = (text: string, most: number) => (text.length > most ? `${text.slice(0, most)}…` : text);

/** Any value read from a file, as a table shows it. Bytes say how many; nested values show as JSON. */
export function cellText(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return cut(value, MOST_CHARS);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? String(value) : value.toISOString().replace(".000Z", "Z");
  if (value instanceof Uint8Array) return `[Binary, ${value.length.toLocaleString()} bytes]`;
  if (typeof value !== "object") return String(value);
  const json = JSON.stringify(value, (_, inner: unknown) =>
    typeof inner === "bigint" ? inner.toString() : inner instanceof Uint8Array ? `[Binary, ${inner.length} bytes]` : inner,
  );
  return cut(json, MOST_NESTED);
}

/** A Parquet column as its schema has it, enough to name its type. */
export interface ParquetColumn {
  type?: string;
  converted_type?: string;
  logical_type?: { type: string; bitWidth?: number; isSigned?: boolean };
}

/** A Parquet column's type as people say it: by its meaning where the file gives one. */
export function parquetType(column: ParquetColumn, nested: boolean): string {
  const logical = column.logical_type;
  if (logical?.type === "INTEGER") return `${logical.isSigned === false ? "UINT" : "INT"}${logical.bitWidth ?? ""}`;
  if (logical) return logical.type;
  if (nested) return column.converted_type === "LIST" || column.converted_type === "MAP" ? column.converted_type : "STRUCT";
  if (column.converted_type) return column.converted_type === "UTF8" ? "STRING" : column.converted_type;
  if (column.type === "BYTE_ARRAY") return "BINARY";
  if (column.type === "FIXED_LEN_BYTE_ARRAY") return "FIXED";
  return column.type ?? "";
}
