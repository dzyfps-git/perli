import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { fileSeen, type Preview } from "../../api";
import { coloredLines } from "./highlight";
import { createFind, findPattern, matchesOf } from "./FindBar";

export const ICON_EDIT = "";
const ICON_SAVE = "";
const ICON_DONE = "";
/** Past this many letters the draft shows uncolored: coloring it on every key would lag. */
const MOST_COLORED = 40_000;
const SAVED_MS = 1400;
/** Never what a file's stamp reads, so the next save asks first. */
const UNKNOWN_STAMP = "0:0";
/** A text box holds plain line ends, and Perli writes the file's own back when it saves. */
const plain = (text: string) => text.replace(/\r\n?/g, "\n");
const asHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");

/** A whole file that a quick edit may write over. */
export interface EditTarget {
  path: string;
  /** How the file stood when it was read, which a save checks first. */
  seen: string;
  /** Writes `text` over the file. True once it is written. `seen` is left out to skip the check. */
  save: (text: string, seen?: string) => Promise<boolean>;
  /** While a handler is set, a fresh read of the same file goes to it instead of a new view. */
  hold: (handler?: (preview: Preview) => void) => void;
  /** Reads the file again into a new view. */
  refresh: () => void;
}

interface Draft {
  text: string;
  seen?: string;
  caret: number;
  scroll: number;
}

/** Unsaved text outlives its view, which a step to another file takes down. */
const drafts = new Map<string, Draft>();
/** A menu's "Edit" asks the next view of the file to open in the box, if it opens soon. */
let asked: { path: string; at: number } | undefined;
const ASK_MS = 5000;
export const editWhenShown = (path: string) => void (asked = { path: path.toLowerCase(), at: Date.now() });

/** A view opens editing when unsaved text waits for it, or a menu just asked. The ask is used up. */
export function startsEditing(path: string) {
  const wanted = asked?.path === path.toLowerCase() && Date.now() - asked.at < ASK_MS;
  if (wanted) asked = undefined;
  return drafts.has(path) || wanted;
}

/** The text and stamp a fresh read of the file gives, if it is still a whole text. */
function freshOf(preview: Preview) {
  if (preview.kind === "text" && preview.next === null && preview.seen) return { text: preview.text, seen: preview.seen };
  if (preview.kind === "markdown" && preview.seen) return { text: preview.source, seen: preview.seen };
  return undefined;
}

/**
 * Edits a text file in place: a box over the colored text, which stays colored as it changes.
 * Ctrl+S saves through a job, so Ctrl+Z takes the save back, and a file changed by someone else
 * meanwhile is asked about first.
 */
export function QuickEdit(props: {
  target: EditTarget;
  text: string;
  language?: string;
  wrap: boolean;
  keys: (handler: ((event: KeyboardEvent) => boolean) | undefined) => void;
  /** `saved` says the file changed, so the view behind needs reading again. */
  onLeave: (saved: boolean) => void;
}) {
  // Taken once: the view's <Show> may be gone by the time the editor cleans up.
  const target = props.target;
  const { path } = target;
  const draft = drafts.get(path);
  drafts.delete(path);
  let box!: HTMLTextAreaElement;
  let scroller!: HTMLDivElement;
  /** The text again, under the box, for colors and for find to mark. */
  let mirror: HTMLPreElement | undefined;
  /** The stamp a save checks. Unset after a save, until the file is read again. */
  let stamp: string | undefined = draft ? draft.seen : target.seen;
  let savedOnce = false;
  let left = false;
  const [base, setBase] = createSignal(plain(props.text));
  const [value, setValue] = createSignal(draft?.text ?? base());
  const [saving, setSaving] = createSignal(false);
  const [saved, setSaved] = createSignal(false);
  const [asking, setAsking] = createSignal(false);
  const [problem, setProblem] = createSignal<string>();
  const [colored, setColored] = createSignal<string>();
  const dirty = () => value() !== base();
  const colors = () => !!props.language && value().length <= MOST_COLORED;

  // Replacing goes through the box's own typing, so Ctrl+Z takes a replace back like a key.
  const find = createFind(
    () => mirror,
    () => scroller,
    undefined,
    {
      chose(at, query) {
        const match = matchesOf(box.value, query)[at];
        if (match) box.setSelectionRange(...match);
      },
      replace(at, query, by) {
        const match = matchesOf(box.value, query)[at];
        if (!match) return at;
        box.focus({ preventScroll: true });
        box.setSelectionRange(...match);
        document.execCommand("insertText", false, by);
        const next = matchesOf(box.value, query).findIndex(([start]) => start >= match[0] + by.length);
        return Math.max(0, next);
      },
      replaceAll(query, by) {
        let count = 0;
        const text = box.value.replace(findPattern(query), () => (count++, by));
        if (!count) return 0;
        const top = scroller.scrollTop;
        box.focus({ preventScroll: true });
        box.select();
        document.execCommand("insertText", false, text);
        scroller.scrollTop = top;
        return count;
      },
    },
  );

  let painting = 0;
  /** A language already loaded colors at once, so the colors and the caret move together. */
  function paint(text: string) {
    const mine = ++painting;
    if (!colors()) {
      setColored(undefined);
      return queueMicrotask(find.refresh);
    }
    coloredLines(props.language!, text).then(
      (lines) => mine === painting && (setColored(lines.join("\n") + "\n"), find.refresh()),
      () => mine === painting && setColored(undefined),
    );
  }

  async function save() {
    if (saving() || !dirty()) return;
    const text = value();
    setSaving(true);
    setProblem(undefined);
    try {
      if (!(await target.save(text, stamp))) return;
      // The file as this save left it, so the next save still checks. Unread, the folder's next
      // read stands in for it.
      stamp = (await fileSeen(path).catch(() => null)) ?? undefined;
      savedOnce = true;
      setBase(text);
      setSaved(true);
      setTimeout(() => setSaved(false), SAVED_MS);
    } catch (reason) {
      setProblem(String(reason));
    } finally {
      setSaving(false);
    }
  }

  function leave() {
    left = true;
    props.onLeave(savedOnce);
  }

  props.keys((event) => {
    const key = event.key.toLowerCase();
    if (event.ctrlKey && !event.altKey && key === "s") void save();
    else if (key === "escape" && find.open()) {
      find.close();
      box.focus({ preventScroll: true });
    } else if (!asking() && find.keys(event)) event.preventDefault();
    else if (key === "escape") {
      if (asking()) setAsking(false);
      else if (dirty()) setAsking(true);
      else leave();
    } else return false;
    event.stopPropagation();
    return true;
  });

  // The folder is read again after each change in it. What the file holds then is only taken as
  // the new start when it is what was saved: anything else is someone else's change, so the next
  // save asks.
  target.hold((preview) => {
    if (stamp !== undefined) return;
    const fresh = freshOf(preview);
    stamp = fresh && plain(fresh.text) === base() ? fresh.seen : UNKNOWN_STAMP;
  });

  onMount(() => {
    box.value = value();
    paint(value());
    box.focus({ preventScroll: true });
    box.setSelectionRange(draft?.caret ?? 0, draft?.caret ?? 0);
    scroller.scrollTop = draft?.scroll ?? 0;
  });

  onCleanup(() => {
    find.close();
    props.keys(undefined);
    target.hold(undefined);
    if (!left && dirty()) drafts.set(path, { text: value(), seen: stamp ?? UNKNOWN_STAMP, caret: box.selectionStart, scroll: scroller.scrollTop });
  });

  const status = () => (saving() ? "Saving…" : saved() ? "Saved" : dirty() ? "Not saved" : "No changes");

  return (
    <div class="quick-edit">
      <div ref={scroller} class="quick-edit-scroll" data-wrap={props.wrap || undefined}>
        <div class="quick-edit-sheet" data-colored={colored() !== undefined || undefined}>
          <Show when={colored() !== undefined || find.open()}>
            <pre
              ref={mirror}
              class="preview-text quick-edit-colors hljs"
              data-plain={colored() === undefined || undefined}
              aria-hidden="true"
              innerHTML={colored() ?? asHtml(value()) + "\n"}
            />
          </Show>
          <textarea
            ref={box}
            class="preview-text quick-edit-box"
            aria-label="Text of the file"
            spellcheck={false}
            wrap={props.wrap ? "soft" : "off"}
            onInput={() => {
              setValue(box.value);
              paint(box.value);
              setAsking(false);
            }}
          />
        </div>
      </div>
      <div class="preview-tools quick-edit-tools" role="toolbar" aria-label="Editing">
        <Show
          when={asking()}
          fallback={
            <>
              {find.bar()}
              <span class="zoom-chip quick-edit-status" data-dirty={dirty() || undefined} role="status">
                {problem() ?? status()}
              </span>
              <button class="strip-icon" aria-label="Save" aria-keyshortcuts="Control+S" disabled={!dirty() || saving()} onClick={() => void save()}>
                {ICON_SAVE}
              </button>
              <button class="strip-icon" aria-label="Done editing" aria-keyshortcuts="Escape" onClick={() => (dirty() ? setAsking(true) : leave())}>
                {ICON_DONE}
              </button>
            </>
          }
        >
          <span class="zoom-chip quick-edit-status">Leave without saving?</span>
          <button class="preview-chip" onClick={leave}>
            Discard
          </button>
          <button class="preview-chip" onClick={() => (setAsking(false), box.focus())}>
            Keep editing
          </button>
        </Show>
      </div>
    </div>
  );
}
