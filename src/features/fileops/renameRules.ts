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
};

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
 * The new name of the row at `index`. A folder's name is all stem. `find` is `finder(rules)`,
 * made once for all the rows.
 */
export function renamed(
  name: string,
  isDir: boolean,
  index: number,
  rules: RenameRules,
  find: RegExp | undefined,
) {
  const dot = isDir || rules.includeExtension ? -1 : name.lastIndexOf(".");
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  // A plain replacement is taken as it is, so a `$` in it means nothing special.
  const replacement = rules.regex ? rules.replace : rules.replace.replaceAll("$", "$$$$");
  const changed = find ? stem.replace(find, replacement) : stem;
  const number = rules.numbered ? String(rules.start + index).padStart(rules.digits, "0") : "";
  return recased(rules.prefix + changed + rules.suffix, rules.letterCase) + number + extension;
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
