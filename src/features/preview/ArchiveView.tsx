import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { ArchiveEntry, Thumb } from "../../api";
import { formatSize } from "../../ui/format";
import { draw } from "./QuickPreview";

const ICON_FOLD = "";
const ICON_LOOK = "";
const ICON_EXTRACT = "";
const ICON_BACK = "";
const PICTURES = /\.(jpe?g|png|gif|webp|bmp|tiff?|ico)$/i;
/** A filter can match a lot. This many rows are plenty to scroll through. */
const MOST_ROWS = 2000;
const LOOK_EDGE = 1600;

type Column = "name" | "size" | "modified";

interface Node {
  /** The entry's own name inside the archive, the way the job asks for it. */
  path: string;
  name: string;
  folder: boolean;
  size: number;
  modified: string | null;
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
    const made: Node = { path: `${path}/`, name: path.slice(cut + 1), folder: true, size: 0, modified: null, children: [] };
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
    folder(path.slice(0, Math.max(cut, 0))).push({ ...entry, path: entry.name, name: path.slice(cut + 1), children: [] });
  }
  // A folder's size is all it holds.
  const total = (node: Node): number => (node.folder ? (node.size = node.children.reduce((sum, child) => sum + total(child), 0)) : node.size);
  top.forEach(total);
  return top;
}

export interface ArchiveViewProps {
  entries: ArchiveEntry[];
  more: boolean;
  picture: (entry: string, edge: number) => Promise<Thumb | null>;
  text: (entry: string) => Promise<string | null>;
  extract: (entry: string) => Promise<void>;
  keys: (handler: ((event: KeyboardEvent) => boolean) | undefined) => void;
}

/**
 * What a ZIP holds, as folders that fold, with a filter and sortable columns. A file inside can be
 * looked at or taken out on its own, without unpacking the rest.
 */
export function ArchiveView(live: ArchiveViewProps) {
  const props = { ...live };
  const tree = treeOf(props.entries);
  const [open, setOpen] = createSignal(new Set<string>(tree.length === 1 && tree[0].folder ? [tree[0].path] : []));
  const [query, setQuery] = createSignal("");
  const [sort, setSort] = createSignal<{ by: Column; down: boolean }>({ by: "name", down: false });
  const [picked, setPicked] = createSignal<string>();
  const [look, setLook] = createSignal<Node>();
  const [taken, setTaken] = createSignal<string>();
  let filterBox!: HTMLInputElement;

  const files = props.entries.filter((entry) => !entry.folder);
  const unpacked = files.reduce((sum, entry) => sum + entry.size, 0);
  const count = (amount: number, one: string) => `${amount.toLocaleString()} ${one}${amount === 1 ? "" : "s"}`;
  const summary = [count(files.length, "file"), count(props.entries.length - files.length, "folder"), `${formatSize(unpacked)} unpacked`].join("  ·  ");

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

  /** The rows to show: the open part of the tree, or every match of the filter with its path. */
  const rows = createMemo(() => {
    const shown: { node: Node; depth: number }[] = [];
    const wanted = query().trim().toLowerCase();
    const walk = (nodes: Node[], depth: number) => {
      for (const node of order(nodes)) {
        if (shown.length >= MOST_ROWS) return;
        if (wanted) {
          if (!node.folder && node.path.toLowerCase().includes(wanted)) shown.push({ node, depth: 0 });
          walk(node.children, 0);
        } else {
          shown.push({ node, depth });
          if (node.folder && open().has(node.path)) walk(node.children, depth + 1);
        }
      }
    };
    walk(tree, 0);
    return shown;
  });

  const fold = (node: Node) => {
    const next = new Set(open());
    if (!next.delete(node.path)) next.add(node.path);
    setOpen(next);
  };

  const sortBy = (by: Column) => setSort({ by, down: sort().by === by ? !sort().down : by !== "name" });

  async function extract(node: Node) {
    setTaken(undefined);
    await props.extract(node.path);
    setTaken(node.path);
  }

  props.keys((event) => {
    if (event.altKey) return false;
    if (event.key === "Escape" && look()) {
      setLook(undefined);
      return true;
    }
    if (event.ctrlKey && event.key.toLowerCase() === "f") {
      filterBox.focus();
      filterBox.select();
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
                  aria-selected={picked() === row.node.path}
                  onClick={() => (row.node.folder && !query() ? fold(row.node) : setPicked(row.node.path))}
                  onDblClick={() => !row.node.folder && setLook(row.node)}
                >
                  <td style={{ "padding-left": `${8 + row.depth * 16}px` }}>
                    <Show when={row.node.folder && !query()}>
                      <span class="archive-fold" data-open={open().has(row.node.path) || undefined} aria-hidden="true">
                        {ICON_FOLD}
                      </span>
                    </Show>
                    {query() ? row.node.path : row.node.name}
                  </td>
                  <td>{formatSize(row.node.size)}</td>
                  <td>{row.node.modified ?? ""}</td>
                  <td class="archive-actions">
                    <Show when={!row.node.folder}>
                      <button
                        class="strip-icon"
                        aria-label={`Look at ${row.node.name}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          setLook(row.node);
                        }}
                      >
                        {ICON_LOOK}
                      </button>
                    </Show>
                    <button
                      class="strip-icon"
                      aria-label={`Extract ${row.node.name}`}
                      data-done={taken() === row.node.path || undefined}
                      onClick={(event) => {
                        event.stopPropagation();
                        void extract(row.node);
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
        {(node) => <Look node={node} picture={props.picture} text={props.text} onExtract={() => void extract(node)} onBack={() => setLook(undefined)} />}
      </Show>
    </div>
  );
}

/** One file inside, shown over the list without taking it out. */
function Look(props: {
  node: Node;
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
      ? props.picture(props.node.path, LOOK_EDGE).then((picture) => {
          if (gone) return;
          if (!picture) return setState("none");
          draw(canvas, picture);
          setState("picture");
        })
      : props.text(props.node.path).then((text) => {
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
