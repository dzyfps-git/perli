import { createEffect, Index, on, onCleanup, onMount, Show } from "solid-js";
import { expandPath, isFile, openFile } from "../../api";
import type { Layout } from "../filelist/layout";
import { showHidden } from "../filelist/prefs";
import type { FolderView } from "../navigation/folderView";
import { isBin, toCrumbs, typedPath } from "../navigation/path";
import "./pathbar.css";

const ICON_BACK = "";
const ICON_FORWARD = "";
const ICON_UP = "";

const ICON_LIST = "\uE8FD";
const ICON_GRID = "\uF0E2";
const ICON_SHOWN = "\uE7B3";
const ICON_HIDDEN = "\uED1A";
const ICON_FILTER = "\uE71C";
const ICON_CHEVRON = "\uE76C";

/** Long enough that typing a word starts one search, not one per letter. */
const SEARCH_WAIT_MS = 120;

export function PathBar(props: {
  view: FolderView;
  onToggleHidden: () => void;
  onFilter: () => void;
  onInputMenu: (event: MouseEvent) => void;
  /** A crumb's chevron asks for the folders inside it, in a menu at `x`, `y`. */
  onCrumbMenu: (path: string, x: number, y: number) => void;
  /** The crumb whose menu is open. */
  menuFor?: string;
  onNewTab: (path: string) => void;
}) {
  const crumbs = () => toCrumbs(props.view.trail());
  const depth = () => toCrumbs(props.view.folder()?.path ?? "").length;
  let list!: HTMLOListElement;
  let searchBox!: HTMLInputElement;
  let searchTimer: number | undefined;

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

  function onSearchInput() {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => props.view.search(searchBox.value), SEARCH_WAIT_MS);
  }

  function onSearchKey(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.stopPropagation();
      window.clearTimeout(searchTimer);
      searchBox.value = "";
      props.view.search("");
      focusList();
    } else if (event.key === "Enter" || event.key === "ArrowDown") {
      event.preventDefault();
      focusList();
    }
  }

  const searchStatus = () => {
    const count = props.view.folder()?.count ?? 0;
    if (!props.view.query()) return "";
    if (props.view.searching()) return "Searching…";
    if (props.view.moreToFind()) return `${count.toLocaleString()}+ matches`;
    return count === 1 ? "1 match" : `${count.toLocaleString()} matches`;
  };

  createEffect(() => {
    crumbs();
    depth();
    revealCurrent();
  });

  createEffect(
    on(
      props.view.searchAsked,
      () => {
        searchBox.focus();
        searchBox.select();
      },
      { defer: true },
    ),
  );

  onCleanup(() => window.clearTimeout(searchTimer));

  onMount(() => {
    const observer = new ResizeObserver(revealCurrent);
    observer.observe(list);
    onCleanup(() => observer.disconnect());
  });

  return (
    <nav class="pathbar" aria-label="Folder navigation">
      <button class="nav-button" aria-label="Back" aria-keyshortcuts="Alt+ArrowLeft" disabled={!props.view.canGoBack()} onClick={() => props.view.back()}>
        {ICON_BACK}
      </button>
      <button
        class="nav-button"
        aria-label="Forward"
        aria-keyshortcuts="Alt+ArrowRight"
        disabled={!props.view.canGoForward()}
        onClick={() => props.view.forward()}
      >
        {ICON_FORWARD}
      </button>
      <button class="nav-button" aria-label="Up" aria-keyshortcuts="Alt+ArrowUp" disabled={!props.view.canGoUp()} onClick={() => props.view.up()}>
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
        <Index each={crumbs()}>
          {(crumb, index) => (
            <li>
              <button
                class="crumb"
                classList={{ "crumb-left": index >= depth() }}
                data-drop={crumb().path}
                aria-current={index === depth() - 1 ? "location" : undefined}
                onClick={() => props.view.open(crumb().path)}
                onAuxClick={(event) => event.button === 1 && props.onNewTab(crumb().path)}
                onMouseDown={(event) => event.button === 1 && event.preventDefault()}
              >
                {crumb().label}
              </button>
              <Show when={!isBin(crumb().path)}>
                <button
                  class="crumb-chevron"
                  classList={{ "crumb-left": index >= depth() }}
                  aria-label={`Folders in ${crumb().label}`}
                  aria-haspopup="menu"
                  aria-expanded={props.menuFor === crumb().path}
                  onClick={(event) => {
                    const { left, bottom } = event.currentTarget.getBoundingClientRect();
                    props.onCrumbMenu(crumb().path, left, bottom + 2);
                  }}
                >
                  {ICON_CHEVRON}
                </button>
              </Show>
            </li>
          )}
        </Index>
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
      <button
        class="nav-button filter-button"
        aria-label="Filter"
        aria-keyshortcuts="Control+Shift+F"
        aria-pressed={props.view.filtered()}
        onClick={props.onFilter}
      >
        {ICON_FILTER}
      </button>
      <span class="search-status" aria-live="polite">
        {searchStatus()}
      </span>
      <input
        ref={searchBox}
        class="search-input"
        aria-label="Search this folder"
        aria-keyshortcuts="Control+F"
        placeholder="Search"
        spellcheck={false}
        hidden={props.view.isBin()}
        value={props.view.query()}
        onInput={onSearchInput}
        onKeyDown={onSearchKey}
        onContextMenu={props.onInputMenu}
      />
      <div class="layout-pill" role="group" aria-label="Layout" data-layout={props.view.layout()}>
        <button aria-label="List" aria-keyshortcuts="Control+Shift+1" aria-pressed={props.view.layout() === "list"} onClick={() => setLayout("list")}>
          {ICON_LIST}
        </button>
        <button aria-label="Grid" aria-keyshortcuts="Control+Shift+2" aria-pressed={props.view.layout() === "grid"} onClick={() => setLayout("grid")}>
          {ICON_GRID}
        </button>
      </div>
    </nav>
  );
}
