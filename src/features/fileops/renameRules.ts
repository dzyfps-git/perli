export type LetterCase = "same" | "lower" | "upper" | "title";

/** What the user asks of a batch rename. The steps run in the order these are listed. */
export interface RenameRules {
  find: string;
  replace: string;
  regex: boolean;
  matchCase: boolean;
  prefix: string;
  suffix: string;
  letterCase: LetterCase;
  numbered: boolean;
  start: number;
  digits: number;
  includeExtension: boolean;
  /** Spaces at either end go, and runs of them become one. */
  trim: boolean;
  /** Letters taken off the start and the end of the name, before anything else. */
  dropFirst: number;
  dropLast: number;
}

export const START_RULES: RenameRules = {
  find: "",
  replace: "",
  regex: false,
  matchCase: false,
  prefix: "",
  suffix: "",
  letterCase: "same",
  numbered: false,
  start: 1,
  digits: 2,
  includeExtension: false,
  trim: false,
  dropFirst: 0,
  dropLast: 0,
};

/** What the name tokens read from one item. Dates are milliseconds since 1970. */
export interface NameFacts {
  modified?: number | null;
  taken?: number | null;
  artist?: string | null;
  title?: string | null;
  folder: string;
}

/** The tokens prefix, suffix and replacement understand, with what each puts in. */
export const TOKENS: { token: string; label: string }[] = [
  { token: "{name}", label: "Old name" },
  { token: "{counter}", label: "Number" },
  { token: "{date}", label: "Date changed" },
  { token: "{taken}", label: "Date taken" },
  { token: "{folder}", label: "Folder" },
  { token: "{artist}", label: "Artist" },
  { token: "{title}", label: "Title" },
];
/** Tokens that need the files' own properties read, which is slower. */
const DEEP_TOKENS = ["{taken}", "{artist}", "{title}"];
const FACT_TOKENS = ["{date}", "{folder}", ...DEEP_TOKENS];

const texts = (rules: RenameRules) => [rules.prefix, rules.suffix, rules.replace];

/** Which facts `rules` need: none, the quick ones (date, folder), or the files' own too. */
export function factsNeeded(rules: RenameRules): "none" | "quick" | "deep" {
  const used = (tokens: string[]) => texts(rules).some((text) => tokens.some((token) => text.includes(token)));
  return used(DEEP_TOKENS) ? "deep" : used(FACT_TOKENS) ? "quick" : "none";
}

/** The rules number the names, at the end or where `{counter}` stands. */
export const counts = (rules: RenameRules) => rules.numbered || texts(rules).some((text) => text.includes("{counter}"));

/** A date as YYYY-MM-DD in the user's own time, which sorts as it reads. */
export function dayText(ms: number) {
  const day = new Date(ms);
  const two = (part: number) => String(part).padStart(2, "0");
  return `${day.getFullYear()}-${two(day.getMonth() + 1)}-${two(day.getDate())}`;
}

/** Windows refuses these in a name, so a song by "AC/DC" gets a dash there instead. */
const safe = (text: string) => text.replace(/[\\/:*?"<>|]/g, "-").trim();

/** `text` with its tokens filled in. A token with nothing behind it yet stays as typed. */
function filled(text: string, stem: string, number: string, facts: NameFacts | undefined) {
  if (!text.includes("{")) return text;
  const day = (ms: number | null | undefined) => (ms ? dayText(ms) : undefined);
  const values: Record<string, string | undefined> = {
    "{name}": stem,
    "{counter}": number,
    "{date}": facts && (day(facts.modified) ?? ""),
    "{taken}": facts && (day(facts.taken) ?? day(facts.modified) ?? ""),
    "{folder}": facts && safe(facts.folder),
    "{artist}": facts && safe(facts.artist ?? ""),
    "{title}": facts && safe(facts.title ?? ""),
  };
  return text.replace(/\{[a-z]+\}/g, (token) => values[token] ?? token);
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The search `rules` ask for, if any. Throws on a regular expression that makes no sense. */
export function finder(rules: RenameRules) {
  if (!rules.find) return undefined;
  return new RegExp(rules.regex ? rules.find : escaped(rules.find), rules.matchCase ? "gu" : "giu");
}

function recased(text: string, letterCase: LetterCase) {
  if (letterCase === "lower") return text.toLocaleLowerCase();
  if (letterCase === "upper") return text.toLocaleUpperCase();
  if (letterCase === "same") return text;
  const lower = text.toLocaleLowerCase();
  return lower.replace(/(^|[^\p{L}\p{N}'’])(\p{L})/gu, (_, before: string, letter: string) => {
    return before + letter.toLocaleUpperCase();
  });
}

/**
 * The new name of the row at `index`, its place in the numbering order. A folder's name is all
 * stem. `find` is `finder(rules)`, made once for all the rows. `facts` fill the tokens that need
 * them.
 */
export function renamed(
  name: string,
  isDir: boolean,
  index: number,
  rules: RenameRules,
  find: RegExp | undefined,
  facts?: NameFacts,
) {
  const dot = isDir || rules.includeExtension ? -1 : name.lastIndexOf(".");
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  const number = String(rules.start + index).padStart(rules.digits, "0");
  const fill = (text: string) => filled(text, stem, number, facts);
  // Letters, not UTF-16 halves, so an emoji is one to take off.
  const letters = [...stem];
  const kept = letters.slice(rules.dropFirst, Math.max(rules.dropFirst, letters.length - rules.dropLast)).join("");
  // A plain replacement is taken as it is, so a `$` in it means nothing special. A regular
  // expression's `$1` still works, and what a token puts in is always plain.
  const plain = (text: string) => text.replaceAll("$", "$$$$");
  const replacement = rules.regex
    ? rules.replace.split(/(\{[a-z]+\})/).map((part, at) => (at % 2 ? plain(fill(part)) : part)).join("")
    : plain(fill(rules.replace));
  const changed = find ? kept.replace(find, replacement) : kept;
  let whole = fill(rules.prefix) + changed + fill(rules.suffix);
  if (rules.trim) whole = whole.replace(/\s+/g, " ").trim();
  return recased(whole, rules.letterCase) + (rules.numbered ? number : "") + extension;
}

/** Names typed one to a line for the rows in `order`, lined up with the rows again. */
export function typedNames(text: string, order: number[]) {
  const lines = text.split(/\r?\n/);
  // A last empty line is only the end of the text.
  if (lines.length === order.length + 1 && lines.at(-1) === "") lines.pop();
  if (lines.length !== order.length) return undefined;
  const names: string[] = [];
  order.forEach((row, at) => (names[row] = lines[at].trim()));
  return names;
}

/** `order` with the item at `from` moved to `to`. */
export function moved(order: number[], from: number, to: number) {
  const next = [...order];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

/** What a rename changes: the names agree before `start`, and again after `oldEnd` and `newEnd`. */
export function changedPart(before: string, after: string) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let tail = 0;
  while (
    tail < before.length - start &&
    tail < after.length - start &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++;
  }
  const oldEnd = before.length - tail;
  let newEnd = after.length - tail;
  // "new " before "notes" agrees on its first n, but reads as added in front, so slide it there.
  if (oldEnd === start && newEnd > start) {
    let at = start;
    while (at > 0 && after[at - 1] === after[newEnd - 1]) at--, newEnd--;
    if (at === 0) return { start: 0, oldEnd: 0, newEnd };
    newEnd = after.length - tail;
  }
  return { start, oldEnd, newEnd };
}
