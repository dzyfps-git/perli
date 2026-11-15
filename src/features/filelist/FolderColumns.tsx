import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { subfolders } from "../../api";
import type { FolderView } from "../navigation/folderView";
import { baseName, join, parentOf } from "../navigation/path";
import { folderColumnWidth, setFolderColumnWidth, showHidden, showSystem } from "./prefs";
import { createTypeJump } from "./typeJump";

const NARROWEST = 120;
const WIDEST = 480;
/** Room a fitted column keeps beside its longest name, for the arrow and the padding. */
const FIT_ROOM = 72;

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const clampWidth = (width: number) => Math.round(Math.min(WIDEST, Math.max(NARROWEST, width)));

interface ColumnsProps {
  view: FolderView;
  onMenu: (event: MouseEvent, path: string) => void;
  onNewTab: (path: string) => void;
}

/**
 * The column view's columns: every folder above the one on show, from the drive down, each
 * listing its folders with the way down lit. The list of the folder on show comes after them.
 */
export function FolderColumns(props: ColumnsProps) {
  const ancestors = createMemo(
    () => {
      const chain: string[] = [];
      const path = props.view.folder()?.path;
      for (let at = path && parentOf(path); at; at = parentOf(at)) chain.unshift(at);
      return chain;
    },
    [],
    { equals: (a, b) => a.join("|") === b.join("|") },
  );
  /** Widths dragged this session, by column. The rest take the saved width. */
  const [widths, setWidths] = createSignal<Record<string, number>>({});
  let strip!: HTMLDivElement;

  // The nearest folders above stay in sight, so the strip scrolls to its end on each step.
  createEffect(
    on(ancestors, () =>
      requestAnimationFrame(() => strip.scrollTo({ left: strip.scrollWidth, behavior: reducedMotion.matches ? "auto" : "smooth" })),
    ),
  );

  /** The folder a column leads down to: the next column's, or the one on show. */
  const litIn = (path: string) => {
    const chain = ancestors();
    return chain[chain.indexOf(path) + 1] ?? props.view.folder()?.path;
  };

  return (
    <div class="folder-columns" ref={strip} role="group" aria-label="Folders above">
      <For each={ancestors()}>
        {(path) => (
          <FolderColumn
            path={path}
            lit={() => litIn(path)}
            width={widths()[path] ?? folderColumnWidth()}
            onWidth={(width, every) => {
              if (every) {
                setFolderColumnWidth(width);
                setWidths({});
              } else setWidths({ ...widths(), [path]: width });
            }}
            onOpen={(folder) => void props.view.open(folder)}
            onMenu={props.onMenu}
            onNewTab={props.onNewTab}
            onLast={() => props.view.list()?.focus()}
          />
        )}
      </For>
    </div>
  );
}

interface ColumnProps {
  path: string;
  lit: () => string | undefined;
  width: number;
  onWidth: (width: number, every: boolean) => void;
  onOpen: (path: string) => void;
  onMenu: (event: MouseEvent, path: string) => void;
  onNewTab: (path: string) => void;
  /** Right from the last column goes on to the list. */
  onLast: () => void;
}

function FolderColumn(props: ColumnProps) {
  const [names, setNames] = createSignal<string[]>();
  const [resizing, setResizing] = createSignal(false);
  const typed = createTypeJump();
  let list!: HTMLDivElement;
  let column!: HTMLElement;
  let ticket = 0;

  createEffect(
    on([showHidden, showSystem], ([hidden, system]) => {
      const asked = ++ticket;
      subfolders(props.path, hidden, system)
        .then((found) => asked === ticket && setNames(found))
        .catch(() => asked === ticket && setNames([]));
    }),
  );
  onCleanup(() => ticket++);

  const litName = () => {
    const lit = props.lit();
    return lit && parentOf(lit)?.toLowerCase() === props.path.toLowerCase() ? baseName(lit).toLowerCase() : undefined;
  };
  // The way down shows, however long the column.
  createEffect(on([names, litName], () => requestAnimationFrame(() => list?.querySelector("[aria-current]")?.scrollIntoView({ block: "nearest" }))));

  const buttons = () => [...list.querySelectorAll<HTMLButtonElement>("button")];
  const litButton = (of: Element | null | undefined) =>
    of?.querySelector<HTMLButtonElement>(".folder-column-list [aria-current]") ?? of?.querySelector<HTMLButtonElement>(".folder-column-list button");

  function onKeyDown(event: KeyboardEvent) {
    const all = buttons();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    const move = (to: HTMLElement | null | undefined) => {
      event.preventDefault();
      to?.focus();
    };
    if (event.key === "ArrowDown") return move(all[Math.min(all.length - 1, at + 1)]);
    if (event.key === "ArrowUp") return move(all[Math.max(0, at - 1)]);
    if (event.key === "Home") return move(all[0]);
    if (event.key === "End") return move(all[all.length - 1]);
    if (event.key === "ArrowLeft") return move(litButton(column.previousElementSibling));
    if (event.key === "ArrowRight") {
      const next = column.nextElementSibling;
      event.preventDefault();
      return next ? litButton(next)?.focus() : props.onLast();
    }
    if (event.key.length !== 1 || event.ctrlKey || event.altKey || event.metaKey) return;
    // Typing jumps to the folder whose name starts so, as in the list.
    const jump = typed(event.key);
    if (!jump) return;
    event.preventDefault();
    for (let step = jump.offset; step < all.length + jump.offset; step++) {
      const button = all[(at + step + all.length) % all.length];
      if (button?.textContent?.toLowerCase().startsWith(jump.prefix)) return button.focus();
    }
  }

  /** Drags the column's right edge. Alt sets every column's width. */
  function onEdgeDown(event: PointerEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    const edge = event.currentTarget as HTMLElement;
    edge.setPointerCapture(event.pointerId);
    const start = { x: event.clientX, width: column.offsetWidth };
    setResizing(true);
    const moved = (move: PointerEvent) => props.onWidth(clampWidth(start.width + move.clientX - start.x), move.altKey);
    const done = () => {
      setResizing(false);
      edge.removeEventListener("pointermove", moved);
    };
    edge.addEventListener("pointermove", moved);
    edge.addEventListener("pointerup", done, { once: true });
    edge.addEventListener("lostpointercapture", done, { once: true });
  }

  /** Fits the column to its longest name. */
  function fit() {
    const longest = Math.max(0, ...buttons().map((button) => button.querySelector(".folder-column-name")?.scrollWidth ?? 0));
    props.onWidth(clampWidth(longest + FIT_ROOM), false);
  }

  const title = () => baseName(props.path) || props.path.replace(/\\$/, "");

  return (
    <section
      ref={column}
      class="folder-column"
      style={{ width: `${props.width}px` }}
      aria-label={title()}
      data-drop={props.path}
      data-resizing={resizing() ? "" : undefined}
      onKeyDown={onKeyDown}
    >
      <p class="folder-column-head">
        <span>{title()}</span>
        <Show when={names()}>{(found) => <span class="folder-column-count">{found().length.toLocaleString()}</span>}</Show>
      </p>
      <div ref={list} class="folder-column-list">
        <Show when={names()?.length === 0}>
          <p class="folder-column-empty">No folders</p>
        </Show>
        <For each={names()}>
          {(name) => {
            const path = join(props.path, name);
            return (
              <button
                aria-current={name.toLowerCase() === litName() ? "true" : undefined}
                data-drop={path}
                onClick={() => props.onOpen(path)}
                onAuxClick={(event) => event.button === 1 && props.onNewTab(path)}
                onMouseDown={(event) => event.button === 1 && event.preventDefault()}
                onContextMenu={(event) => {
                  event.preventDefault();
                  props.onMenu(event, path);
                }}
              >
                <span class="file-icon" data-kind="folder" aria-hidden="true" />
                <span class="folder-column-name">{name}</span>
              </button>
            );
          }}
        </For>
      </div>
      <div
        class="folder-column-edge"
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${title()}`}
        data-tip="Drag to resize. Alt-drag sizes every column. Double-click fits the longest name"
        onPointerDown={onEdgeDown}
        onDblClick={fit}
      />
    </section>
  );
}
