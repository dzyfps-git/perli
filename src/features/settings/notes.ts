/** A piece of a release's notes, as the update sheet draws it. */
export type NoteBlock = { kind: "heading" | "text"; text: string } | { kind: "list"; items: string[] };

/** The words of a Markdown line without its marks, and a link as its text. */
const plain = (line: string) =>
  line
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|__|`/g, "")
    .trim();

/**
 * Release notes, written in Markdown, as headings, paragraphs and lists. Lines next to each other
 * make one paragraph, and an indented line goes on with the bullet above it.
 */
export function noteBlocks(text: string): NoteBlock[] {
  const blocks: NoteBlock[] = [];
  let joins = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const last = blocks.at(-1);
    const bullet = /^[-*+]\s+(.*)$/.exec(line);
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (!line) {
      joins = false;
    } else if (bullet) {
      if (last?.kind === "list") last.items.push(plain(bullet[1]));
      else blocks.push({ kind: "list", items: [plain(bullet[1])] });
      joins = false;
    } else if (heading) {
      blocks.push({ kind: "heading", text: plain(heading[1]) });
      joins = false;
    } else if (last?.kind === "list" && /^\s/.test(raw)) {
      last.items[last.items.length - 1] += ` ${plain(line)}`;
    } else if (joins && last?.kind === "text") {
      last.text += ` ${plain(line)}`;
    } else {
      blocks.push({ kind: "text", text: plain(line) });
      joins = true;
    }
  }
  return blocks;
}
