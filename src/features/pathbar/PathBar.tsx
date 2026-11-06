import { createEffect, For, onCleanup, onMount, Show } from "solid-js";
import { expandPath, isFile, openFile } from "../../api";
import type { Layout } from "../filelist/layout";
import { showHidden } from "../filelist/prefs";
import type { FolderView } from "../navigation/folderView";
import { toCrumbs, typedPath } from "../navigation/path";
import "./pathbar.css";

const ICON_BACK = "";
const ICON_FORWARD = "";
const ICON_UP = "";

const ICON_LIST = "\uE8FD";
const ICON_GRID = "\uF0E2";
const ICON_SHOWN = "\uE7B3";
const ICON_HIDDEN = "\uED1A";

export function PathBar(props: {
  view: FolderView;
  onToggleHidden: () => void;
  onInputMenu: (event: MouseEvent) => void;
}) {
  const crumbs = () => toCrumbs(props.view.trail());
  const depth = () => toCrumbs(props.view.folder()?.path ?? "").length;
  let list!: HTMLOListElement;

  // Narrow panes clip the crumbs, and the current folder must stay visible.
  const revealCurrent = () => list.querySelector("[aria-current]")?.scrollIntoView({ block: "nearest", inline: "end" });

  function focusInput(input: HTMLInputElement) {
    queueMicrotask(() => {
      input.focus();
      input.select();
    });
  }

  const focusList = () => list.closest(".pane")?.querySelector<HTMLElement>(".file-grid")?.focus();

  function closeInput() {
    props.view.setEditingPath(false);
    focusList();
  }

  function setLayout(layout: Layout) {
    props.view.setLayout(layout);
    focusList();
  }

  async function openTyped(text: string) {
    const path = typedPath(props.view.folder()?.path ?? "", await expandPath(text));
    if (await isFile(path)) {
      closeInput();
      await openFile(path);
    } else if (await props.view.open(path)) {
      props.view.setEditingPath(false);
    }
  }

  function onInputKey(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.stopPropagation();
      closeInput();
    } else if (event.key === "Enter") {
      openTyped((event.currentTarget as HTMLInputElement).value).catch(console.error);
    }
  }

  // Switching to another app to copy a path, or opening the paste menu, must not close this.
  function closeOnBlur(event: FocusEvent) {
    const movedToMenu = (event.relatedTarget as HTMLElement | null)?.closest(".menu");
    if (document.hasFocus() && !movedToMenu) props.view.setEditingPath(false);
  }

  createEffect(() => {
    crumbs();
    depth();
    revealCurrent();
  });

  onMount(() => {
    const observer = new ResizeObserver(revealCurrent);
    observer.observe(list);
    onCleanup(() => observer.disconnect());
  });

  return (
    <nav class="pathbar" aria-label="Folder navigation">
      <button class="nav-button" aria-label="Back" disabled={!props.view.canGoBack()} onClick={() => props.view.back()}>
        {ICON_BACK}
      </button>
      <button
        class="nav-button"
        aria-label="Forward"
        disabled={!props.view.canGoForward()}
        onClick={() => props.view.forward()}
      >
        {ICON_FORWARD}
      </button>
      <button class="nav-button" aria-label="Up" disabled={!props.view.canGoUp()} onClick={() => props.view.up()}>
        {ICON_UP}
      </button>
      <Show when={props.view.editingPath()}>
        <input
          ref={focusInput}
          class="path-input"
          aria-label="Folder path"
          spellcheck={false}
          value={props.view.folder()?.path ?? ""}
          onKeyDown={onInputKey}
          onContextMenu={props.onInputMenu}
          onBlur={closeOnBlur}
        />
      </Show>
      <ol
        ref={list}
        class="crumbs"
        hidden={props.view.editingPath()}
        onClick={(event) => {
          if (!(event.target as HTMLElement).closest("button")) props.view.setEditingPath(true);
        }}
      >
        <For each={crumbs()}>
          {(crumb, index) => (
            <li>
              <button
                class="crumb"
                classList={{ "crumb-left": index() >= depth() }}
                aria-current={index() === depth() - 1 ? "location" : undefined}
                onClick={() => props.view.open(crumb.path)}
              >
                {crumb.label}
              </button>
            </li>
          )}
        </For>
      </ol>
      <Show when={props.view.folder()?.hiddenCount}>
        {(count) => (
          <button class="hidden-count" aria-pressed={showHidden()} onClick={props.onToggleHidden}>
            <span class="hidden-icon" aria-hidden="true">
              {showHidden() ? ICON_SHOWN : ICON_HIDDEN}
            </span>
            {count()} hidden
          </button>
        )}
      </Show>
      <div class="layout-pill" role="group" aria-label="Layout" data-layout={props.view.layout()}>
        <button aria-label="List" aria-pressed={props.view.layout() === "list"} onClick={() => setLayout("list")}>
          {ICON_LIST}
        </button>
        <button aria-label="Grid" aria-pressed={props.view.layout() === "grid"} onClick={() => setLayout("grid")}>
          {ICON_GRID}
        </button>
      </div>
    </nav>
  );
}
