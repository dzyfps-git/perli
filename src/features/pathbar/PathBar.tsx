import { createEffect, createSignal, For, Index, on, onCleanup, onMount, Show } from "solid-js";
import { expandPath, isFile, openFile, type SearchScope } from "../../api";
import { ariaKeys } from "../keys/keybinds";
import { looksLikeName, readTyped } from "../reach/lists";
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

/** One thing the path bar offers for what is typed in it. */
export interface Suggestion {
  label: string;
  /** Said quietly beside the label: a key, or where it goes. */
  hint?: string;
  /** What Tab puts in the bar in place of what was typed. */
  fill?: string;
  run: () => void;
}

/** What is offered, and whether Enter takes the first of it or the text as typed. */
export interface Suggested {
  items: Suggestion[];
  first: boolean;
}

const SCOPES: { id: SearchScope; short: string; label: string }[] = [
  { id: "folder", short: "Here", label: "Search this folder only" },
  { id: "below", short: "Below", label: "Search this folder and the ones inside it" },
  { id: "drive", short: "Drive", label: "Search this whole drive" },
  { id: "drives", short: "All", label: "Search every drive" },
];

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
  /** What to offer for the text typed in the path bar. */
  suggest: (text: string) => Promise<Suggested>;
}) {
  const [offered, setOffered] = createSignal<Suggested>({ items: [], first: false });
  /** The offer the arrow keys are on, or -1 for the text as typed. */
  const [chosen, setChosen] = createSignal(-1);
  let asked = 0;
  const crumbs = () => toCrumbs(props.view.trail());
  const depth = () => toCrumbs(props.view.folder()?.path ?? "").length;
  let list!: HTMLOListElement;
  let searchBox!: HTMLInputElement;
  let searchTimer: number | undefined;

  // Narrow panes clip the crumbs, and the current folder must stay visible.
  function revealCurrent() {
    list.querySelector("[aria-current]")?.scrollIntoView({ block: "nearest", inline: "end" });
    list.toggleAttribute("data-clipped", list.scrollLeft > 0);
  }

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

  function offer(text: string) {
    const ticket = ++asked;
    props
      .suggest(text)
      .then((found) => {
        if (ticket !== asked) return;
        setOffered(found);
        setChosen(found.first && found.items.length > 0 ? 0 : -1);
      })
      .catch(console.error);
  }

  function take(suggestion: Suggestion) {
    closeInput();
    suggestion.run();
  }

  // The offers belong to one stretch of typing, and start empty the next time.
  createEffect(() => {
    if (!props.view.editingPath()) {
      asked++;
      setOffered({ items: [], first: false });
    }
  });

  function setLayout(layout: Layout) {
    props.view.setLayout(layout);
    focusList();
  }

  async function openTyped(text: string) {
    const typed = readTyped(text);
    if (typed.kind === "search") {
      closeInput();
      return props.view.search(typed.text);
    }
    // A command, a nickname or a terminal is only ever taken from the offers.
    if (typed.kind !== "path") return;
    const path = typedPath(props.view.folder()?.path ?? "", await expandPath(text));
    if (await isFile(path)) {
      closeInput();
      await openFile(path);
    } else if (await props.view.open(path)) {
      props.view.setEditingPath(false);
    } else if (looksLikeName(text.trim())) {
      // No folder has that name, so it is something to look for.
      closeInput();
      props.view.search(text.trim());
    }
  }

  function onInputKey(event: KeyboardEvent) {
    const input = event.currentTarget as HTMLInputElement;
    const { items } = offered();
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (event.key === "Escape") {
      event.stopPropagation();
      closeInput();
    } else if (step && items.length > 0) {
      event.preventDefault();
      // One step past either end is the text as typed.
      setChosen(((chosen() + 1 + step + items.length + 1) % (items.length + 1)) - 1);
    } else if (event.key === "Tab" && items.length > 0) {
      event.preventDefault();
      const fill = items[Math.max(0, chosen())].fill;
      if (fill === undefined) return;
      input.value = fill;
      offer(fill);
    } else if (event.key === "Enter") {
      const picked = items[chosen()];
      if (picked) take(picked);
      else openTyped(input.value).catch(console.error);
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
      <button class="nav-button" aria-label="Back" aria-keyshortcuts={ariaKeys("back")} disabled={!props.view.canGoBack()} onClick={() => props.view.back()}>
        {ICON_BACK}
      </button>
      <button
        class="nav-button"
        aria-label="Forward"
        aria-keyshortcuts={ariaKeys("forward")}
        disabled={!props.view.canGoForward()}
        onClick={() => props.view.forward()}
      >
        {ICON_FORWARD}
      </button>
      <button class="nav-button" aria-label="Up" aria-keyshortcuts={ariaKeys("up")} disabled={!props.view.canGoUp()} onClick={() => props.view.up()}>
        {ICON_UP}
      </button>
      <Show when={props.view.editingPath()}>
        <div class="path-field">
          <input
            ref={focusInput}
            class="path-input"
            role="combobox"
            aria-label="Folder path, a search, > for a command, @ for a nickname"
            aria-expanded={offered().items.length > 0}
            aria-controls={`path-offers-${props.view.id}`}
            aria-activedescendant={chosen() >= 0 ? `path-offer-${props.view.id}-${chosen()}` : undefined}
            spellcheck={false}
            value={props.view.folder()?.path ?? ""}
            onInput={(event) => offer(event.currentTarget.value)}
            onKeyDown={onInputKey}
            onContextMenu={props.onInputMenu}
            onBlur={closeOnBlur}
          />
          <Show when={offered().items.length > 0}>
            <ul id={`path-offers-${props.view.id}`} class="path-offers" role="listbox" aria-label="Offers">
              <For each={offered().items}>
                {(item, at) => (
                  <li
                    id={`path-offer-${props.view.id}-${at()}`}
                    class="path-offer"
                    role="option"
                    aria-selected={at() === chosen()}
                    onPointerMove={() => setChosen(at())}
                    // The input keeps the focus, or its blur would close this first.
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => take(item)}
                  >
                    <span class="path-offer-label">{item.label}</span>
                    <span class="path-offer-hint">{item.hint}</span>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>
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
        aria-keyshortcuts={ariaKeys("filter")}
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
        aria-keyshortcuts={ariaKeys("search")}
        placeholder="Search"
        spellcheck={false}
        hidden={props.view.isBin()}
        value={props.view.query()}
        onInput={onSearchInput}
        onKeyDown={onSearchKey}
        onContextMenu={props.onInputMenu}
      />
      <Show when={props.view.query()}>
        <div class="scope-pill" role="radiogroup" aria-label="Where to search">
          <For each={SCOPES}>
            {(scope) => (
              <button
                role="radio"
                aria-label={scope.label}
                aria-checked={props.view.scope() === scope.id}
                onClick={() => props.view.setScope(scope.id)}
              >
                {scope.short}
              </button>
            )}
          </For>
        </div>
      </Show>
      <div class="layout-pill" role="group" aria-label="Layout" data-layout={props.view.layout()}>
        <button aria-label="List" aria-keyshortcuts={ariaKeys("list")} aria-pressed={props.view.layout() === "list"} onClick={() => setLayout("list")}>
          {ICON_LIST}
        </button>
        <button aria-label="Grid" aria-keyshortcuts={ariaKeys("grid")} aria-pressed={props.view.layout() === "grid"} onClick={() => setLayout("grid")}>
          {ICON_GRID}
        </button>
      </div>
    </nav>
  );
}
