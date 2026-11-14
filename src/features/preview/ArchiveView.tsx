import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { ArchiveEntry, ArchiveTested, Thumb } from "../../api";
import { formatSize } from "../../ui/format";
import { draw } from "./QuickPreview";

const ICON_FOLD = "";
const ICON_LOOK = "";
const ICON_EXTRACT = "";
const ICON_BACK = "";
const ICON_LOCK = "";
const PICTURES = /\.(jpe?g|png|gif|webp|bmp|tiff?|ico)$/i;
/** A filter can match a lot. This many rows are plenty to scroll through. */
const MOST_ROWS = 2000;
const LOOK_EDGE = 1600;
/** A press that moves this far is a drag out of the archive. */
const DRAG_PX = 6;
const WRONG_PASSWORD = "Wrong password";
/** Rust adds this when the file tried is damaged but the password opened another one. */
const PASSWORD_RIGHT = "The password is right.";

type Column = "name" | "size" | "modified";

interface Node {
  /** The entry's own name inside the archive, the way the job asks for it. */
  path: string;
  name: string;
  folder: boolean;
  size: number;
  modified: string | null;
  locked: boolean;
  children: Node[];
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** The entries as folders holding files, with the folders a ZIP only implies filled in. */
export function treeOf(entries: ArchiveEntry[]): Node[] {
  const top: Node[] = [];
  const folders = new Map<string, Node>();
  const folder = (path: string): Node[] => {
    if (!path) return top;
    const known = folders.get(path);
    if (known) return known.children;
    const cut = path.lastIndexOf("/");
    const made: Node = { path: `${path}/`, name: path.slice(cut + 1), folder: true, size: 0, modified: null, locked: false, children: [] };
    folders.set(path, made);
    folder(path.slice(0, Math.max(cut, 0))).push(made);
    return made.children;
  };
  for (const entry of entries) {
    const path = entry.name.replace(/\/+$/, "");
    if (!path) continue;
    if (entry.folder) {
      folder(path);
      folders.get(path)!.modified = entry.modified;
      continue;
    }
    const cut = path.lastIndexOf("/");
    folder(path.slice(0, Math.max(cut, 0))).push({ ...entry, locked: !!entry.locked, path: entry.name, name: path.slice(cut + 1), children: [] });
  }
  // A folder's size is all it holds.
  const total = (node: Node): number => (node.folder ? (node.size = node.children.reduce((sum, child) => sum + total(child), 0)) : node.size);
  top.forEach(total);
  return top;
}

export interface ArchiveViewProps {
  entries: ArchiveEntry[];
  more: boolean;
  picture: (entry: string, edge: number, password?: string) => Promise<Thumb | null>;
  text: (entry: string, password?: string) => Promise<string | null>;
  /** Fails unless the password opens all of the entry. */
  check: (entry: string, password: string) => Promise<void>;
  /** Takes these entries out beside the archive. */
  extract: (only: string[], password?: string) => Promise<void>;
  test: (password?: string) => Promise<ArchiveTested>;
  /** Drags one file out, the way a row is dragged out of the list. */
  drag: (entry: string, password?: string) => Promise<void>;
  keys: (handler: ((event: KeyboardEvent) => boolean) | undefined) => void;
}

const count = (amount: number, one: string) => `${amount.toLocaleString()} ${one}${amount === 1 ? "" : "s"}`;

/** What a test found, in a sentence. */
export function testSentence(found: ArchiveTested) {
  const parts = [
    found.damaged.length
      ? `${count(found.damaged.length, "file")} damaged: ${found.damaged.slice(0, 3).join(", ")}${found.damaged.length > 3 ? "…" : ""}`
      : found.sound
        ? `All ${count(found.sound, "file")} read back whole`
        : "",
    found.locked ? `${count(found.locked, "locked file")} not read, for want of the password` : "",
  ];
  return `${parts.filter(Boolean).join(". ") || "Nothing to test"}.`;
}

/**
 * What a ZIP holds, as folders that fold, with a filter and sortable columns. A file inside can be
 * looked at, dragged out or taken out on its own, without unpacking the rest. A file under a
 * password asks for it once, in Perli's own card.
 */
export function ArchiveView(live: ArchiveViewProps) {
  const props = { ...live };
  const tree = treeOf(props.entries);
  const [open, setOpen] = createSignal(new Set<string>(tree.length === 1 && tree[0].folder ? [tree[0].path] : []));
  const [query, setQuery] = createSignal("");
  const [sort, setSort] = createSignal<{ by: Column; down: boolean }>({ by: "name", down: false });
  const [picked, setPicked] = createSignal(new Set<string>());
  const [look, setLook] = createSignal<Node>();
  const [taken, setTaken] = createSignal(new Set<string>());
  const [password, setPassword] = createSignal<string>();
  /** What waits for the password, and what went wrong with the last one tried. */
  const [asking, setAsking] = createSignal<{ then: () => void; wrong?: string }>();
  const [tested, setTested] = createSignal<string>();
  const [testing, setTesting] = createSignal(false);
  let filterBox!: HTMLInputElement;
  let anchor: string | undefined;

  const files = props.entries.filter((entry) => !entry.folder);
  const unpacked = files.reduce((sum, entry) => sum + entry.size, 0);
  // The smallest, so the password check reads it to the end, where its checksum is.
  const firstLocked = files.filter((entry) => entry.locked).sort((a, b) => a.size - b.size)[0];
  const summary = [
    count(files.length, "file"),
    count(props.entries.length - files.length, "folder"),
    `${formatSize(unpacked)} unpacked`,
    ...(firstLocked ? ["some under a password"] : []),
  ].join("  ·  ");

  function order(nodes: Node[]) {
    const { by, down } = sort();
    const sign = down ? -1 : 1;
    return [...nodes].sort((a, b) => {
      if (a.folder !== b.folder) return a.folder ? -1 : 1;
      const compared =
        by === "size" ? a.size - b.size : by === "modified" ? (a.modified ?? "").localeCompare(b.modified ?? "") : 0;
      return sign * (compared || collator.compare(a.name, b.name));
    });
  }

  /**
   * The rows to show: the open part of the tree, or every match of the filter with its path. Each
   * carries how much of its folder it takes, for the bar behind its size.
   */
  const rows = createMemo(() => {
    const shown: { node: Node; depth: number; share: number }[] = [];
    const wanted = query().trim().toLowerCase();
    const walk = (nodes: Node[], depth: number, whole: number) => {
      for (const node of order(nodes)) {
        if (shown.length >= MOST_ROWS) return;
        if (wanted) {
          if (!node.folder && node.path.toLowerCase().includes(wanted)) shown.push({ node, depth: 0, share: node.size / (unpacked || 1) });
          walk(node.children, 0, node.size);
        } else {
          shown.push({ node, depth, share: node.size / (whole || 1) });
          if (node.folder && open().has(node.path)) walk(node.children, depth + 1, node.size);
        }
      }
    };
    walk(tree, 0, unpacked);
    return shown;
  });

  const fold = (node: Node) => {
    const next = new Set(open());
    if (!next.delete(node.path)) next.add(node.path);
    setOpen(next);
  };

  const sortBy = (by: Column) => setSort({ by, down: sort().by === by ? !sort().down : by !== "name" });

  /** A plain click picks one row, Ctrl adds or drops one, and Shift takes all from the last. */
  function pick(event: MouseEvent, node: Node) {
    const next = new Set(event.ctrlKey ? picked() : []);
    if (event.shiftKey && anchor) {
      const list = rows().map((row) => row.node.path);
      const [from, to] = [list.indexOf(anchor), list.indexOf(node.path)].sort((a, b) => a - b);
      if (from >= 0) list.slice(from, to + 1).forEach((path) => next.add(path));
    } else if (event.ctrlKey && picked().has(node.path)) next.delete(node.path);
    else next.add(node.path);
    if (!event.shiftKey) anchor = node.path;
    setPicked(next);
  }

  /** Runs `then` with the password, asking for it first if a locked file needs one. */
  function unlocked(locked: boolean, then: () => void) {
    if (!locked || password()) then();
    else setAsking({ then });
  }

  /** The password is tried on all of the smallest locked file before anything uses it. */
  async function tryPassword(tried: string) {
    const waiting = asking();
    if (!waiting || !firstLocked) return;
    try {
      await props.check(firstLocked.name, tried).catch((reason) => {
        // The file tried is damaged, but the password is proven on another, so it goes on.
        if (!String(reason).includes(PASSWORD_RIGHT)) throw reason;
      });
      setPassword(tried);
      setAsking(undefined);
      waiting.then();
    } catch (reason) {
      // Anything other than a wrong password, such as a kind of lock Perli can't open, says what it is.
      setAsking({ ...waiting, wrong: String(reason).includes(WRONG_PASSWORD) ? "That password does not open it. Try again." : String(reason) });
    }
  }

  const needs = (paths: string[]) =>
    paths.some((path) => (path.endsWith("/") ? files.some((entry) => entry.locked && entry.name.startsWith(path)) : files.find((entry) => entry.name === path)?.locked));

  function extract(paths: string[]) {
    unlocked(needs(paths), async () => {
      await props.extract(paths, password());
      setTaken(new Set([...taken(), ...paths]));
    });
  }

  function test() {
    setTesting(true);
    setTested(undefined);
    props
      .test(password())
      .then((found) => setTested(testSentence(found)))
      .catch((reason) => setTested(String(reason)))
      .finally(() => setTesting(false));
  }

  /** A press on a file that moves becomes a drag out of the archive. */
  function onRowDown(event: PointerEvent, node: Node) {
    if (event.button !== 0 || node.folder) return;
    const [x, y] = [event.clientX, event.clientY];
    const move = (next: PointerEvent) => {
      if (Math.hypot(next.clientX - x, next.clientY - y) < DRAG_PX) return;
      done();
      unlocked(node.locked, () => void props.drag(node.path, password()).catch(() => {}));
    };
    const done = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", done);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", done);
  }

  props.keys((event) => {
    if (event.altKey) return false;
    if (event.key === "Escape" && asking()) {
      setAsking(undefined);
      return true;
    }
    if (event.key === "Escape" && look()) {
      setLook(undefined);
      return true;
    }
    if (event.ctrlKey && event.key.toLowerCase() === "f") {
      filterBox.focus();
      filterBox.select();
      return true;
    }
    if (event.ctrlKey && event.key.toLowerCase() === "a" && !(event.target instanceof HTMLInputElement)) {
      setPicked(new Set(rows().map((row) => row.node.path)));
      return true;
    }
    return false;
  });

  onCleanup(() => props.keys(undefined));

  const arrow = (by: Column) => (sort().by === by ? (sort().down ? " ▾" : " ▴") : "");

  return (
    <div class="archive-view">
      <div class="archive-head">
        <p class="preview-archive-sum">
          {summary}
          {props.more && ". Only the first ones are listed."}
        </p>
        <Show when={picked().size}>
          <button class="details-button archive-take" onClick={() => extract([...picked()])}>
            Extract {picked().size.toLocaleString()}
          </button>
        </Show>
        <button class="details-button" disabled={testing()} onClick={test}>
          {testing() ? "Testing…" : "Test"}
        </button>
        <input
          ref={filterBox}
          class="archive-filter"
          aria-label="Filter what is inside"
          aria-keyshortcuts="Control+F"
          placeholder="Filter"
          spellcheck={false}
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
      </div>
      <Show when={tested()}>
        <p class="archive-tested" role="status" data-bad={/damaged|can't|error/i.test(tested()!) || undefined}>
          {tested()}
        </p>
      </Show>
      <div class="preview-archive archive-list">
        <table>
          <thead>
            <tr>
              <th aria-sort={sort().by === "name" ? (sort().down ? "descending" : "ascending") : undefined}>
                <button onClick={() => sortBy("name")}>Name{arrow("name")}</button>
              </th>
              <th aria-sort={sort().by === "size" ? (sort().down ? "descending" : "ascending") : undefined}>
                <button onClick={() => sortBy("size")}>Size{arrow("size")}</button>
              </th>
              <th aria-sort={sort().by === "modified" ? (sort().down ? "descending" : "ascending") : undefined}>
                <button onClick={() => sortBy("modified")}>Modified{arrow("modified")}</button>
              </th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            <For each={rows()}>
              {(row) => (
                <tr
                  data-folder={row.node.folder || undefined}
                  aria-selected={picked().has(row.node.path)}
                  onPointerDown={(event) => onRowDown(event, row.node)}
                  onClick={(event) => (row.node.folder && !query() && !event.ctrlKey && !event.shiftKey ? fold(row.node) : pick(event, row.node))}
                  onDblClick={() => !row.node.folder && unlocked(row.node.locked, () => setLook(row.node))}
                >
                  <td style={{ "padding-left": `${8 + row.depth * 16}px` }}>
                    <Show when={row.node.folder && !query()}>
                      <span class="archive-fold" data-open={open().has(row.node.path) || undefined} aria-hidden="true">
                        {ICON_FOLD}
                      </span>
                    </Show>
                    {query() ? row.node.path : row.node.name}
                    <Show when={row.node.locked}>
                      <span class="archive-locked" role="img" aria-label="Under a password">
                        {ICON_LOCK}
                      </span>
                    </Show>
                  </td>
                  <td class="archive-size" style={{ "--share": Math.min(row.share, 1) }}>
                    {formatSize(row.node.size)}
                  </td>
                  <td>{row.node.modified ?? ""}</td>
                  <td class="archive-actions">
                    <Show when={!row.node.folder}>
                      <button
                        class="strip-icon"
                        aria-label={`Look at ${row.node.name}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          unlocked(row.node.locked, () => setLook(row.node));
                        }}
                      >
                        {ICON_LOOK}
                      </button>
                    </Show>
                    <button
                      class="strip-icon"
                      aria-label={`Extract ${row.node.name}`}
                      data-done={taken().has(row.node.path) || undefined}
                      onClick={(event) => {
                        event.stopPropagation();
                        extract([row.node.path]);
                      }}
                    >
                      {ICON_EXTRACT}
                    </button>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
        <Show when={rows().length >= MOST_ROWS}>
          <p class="preview-archive-sum">The first {MOST_ROWS.toLocaleString()} rows. Filter to find the rest.</p>
        </Show>
        <Show when={query() && !rows().length}>
          <p class="preview-archive-sum">Nothing inside has that in its name.</p>
        </Show>
      </div>
      <Show when={look()} keyed>
        {(node) => (
          <Look
            node={node}
            password={password()}
            picture={props.picture}
            text={props.text}
            onExtract={() => extract([node.path])}
            onBack={() => setLook(undefined)}
          />
        )}
      </Show>
      <Show when={asking()}>
        {(waiting) => <PasswordCard wrong={waiting().wrong} onTry={(tried) => void tryPassword(tried)} onCancel={() => setAsking(undefined)} />}
      </Show>
    </div>
  );
}

/** Asks for the archive's password, over the list, in Perli's own look. */
function PasswordCard(props: { wrong?: string; onTry: (password: string) => void; onCancel: () => void }) {
  let box!: HTMLInputElement;
  return (
    <form
      class="archive-password"
      aria-label="Password"
      onSubmit={(event) => {
        event.preventDefault();
        if (box.value) props.onTry(box.value);
      }}
    >
      <span class="archive-password-icon" aria-hidden="true">
        {ICON_LOCK}
      </span>
      <label class="archive-password-label">
        This file is under a password
        <input ref={(element) => ((box = element), queueMicrotask(() => element.focus()))} type="password" autocomplete="off" class="archive-filter" />
      </label>
      <Show when={props.wrong}>
        <p class="archive-password-wrong" role="alert">
          {props.wrong}
        </p>
      </Show>
      <span class="archive-password-buttons">
        <button type="button" class="details-button" onClick={props.onCancel}>
          Cancel
        </button>
        <button type="submit" class="details-button archive-take">
          Unlock
        </button>
      </span>
      <p class="archive-password-note">Perli keeps it only while this preview is open.</p>
    </form>
  );
}

/** One file inside, shown over the list without taking it out. */
function Look(props: {
  node: Node;
  password?: string;
  picture: ArchiveViewProps["picture"];
  text: ArchiveViewProps["text"];
  onExtract: () => void;
  onBack: () => void;
}) {
  const [state, setState] = createSignal<"loading" | "picture" | "text" | "none">("loading");
  const [words, setWords] = createSignal("");
  let gone = false;
  onCleanup(() => (gone = true));

  function start(canvas: HTMLCanvasElement) {
    const load = PICTURES.test(props.node.name)
      ? props.picture(props.node.path, LOOK_EDGE, props.password).then((picture) => {
          if (gone) return;
          if (!picture) return setState("none");
          draw(canvas, picture);
          setState("picture");
        })
      : props.text(props.node.path, props.password).then((text) => {
          if (gone) return;
          setWords(text ?? "");
          setState(text === null ? "none" : "text");
        });
    load.catch(() => !gone && setState("none"));
  }

  return (
    <section class="archive-look" aria-label={`Inside: ${props.node.name}`}>
      <header class="archive-look-head">
        <button class="strip-icon" aria-label="Back to the list" aria-keyshortcuts="Escape" onClick={props.onBack}>
          {ICON_BACK}
        </button>
        <span class="archive-look-name">{props.node.path}</span>
        <button class="details-button" onClick={props.onExtract}>
          Extract
        </button>
      </header>
      <div class="archive-look-body" data-state={state()}>
        <canvas ref={start} class="archive-look-picture" hidden={state() !== "picture"} />
        <Show when={state() === "text"}>
          <pre class="preview-text">{words()}</pre>
        </Show>
        <Show when={state() === "none"}>
          <p class="preview-note">This one can't show here. Extract it to open it.</p>
        </Show>
      </div>
    </section>
  );
}
