/** Commands that take a word, like "sort by size". Pure, so it can be tested alone. */

/** One such command: what it starts with, and the words it takes. `free` takes any text. */
export interface Verb {
  says: string;
  words: string[] | "free";
}

/** A verb is offered as it is typed, once this much of it is. */
const LEAST_TYPED = 2;

const plain = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();

/** What was typed after `says`, as typed. */
function after(text: string, says: string) {
  const words = says.split(" ").map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return text.trim().replace(new RegExp(`^${words.join("\\s+")}\\s*`, "i"), "");
}

/**
 * The verb and word pairs that fit `text`: every word of a verb being typed, and the words that
 * start with what follows a whole one. A free verb takes what follows it as its word.
 */
export function wordsFor(text: string, verbs: Verb[]) {
  const typed = plain(text);
  const found: { verb: number; word: string }[] = [];
  if (typed.length < LEAST_TYPED) return found;
  verbs.forEach((verb, index) => {
    const says = plain(verb.says);
    const whole = typed === says || typed.startsWith(`${says} `);
    if (!whole && !says.startsWith(typed)) return;
    const rest = whole ? typed.slice(says.length).trim() : "";
    if (verb.words === "free") {
      if (rest) found.push({ verb: index, word: after(text, says) });
      return;
    }
    for (const word of verb.words) if (plain(word).startsWith(rest)) found.push({ verb: index, word });
  });
  return found;
}
