import { createEffect, createSignal, For, Index, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { expandPath, isFile, openFile, type SearchScope } from "../../api";
import { ariaKeys } from "../keys/keybinds";
import { looksLikeName, readTyped } from "../reach/lists";
import type { Layout } from "../filelist/layout";
import { forgetSearch, recentSearches, rememberSearch, showHidden } from "../filelist/prefs";
import { FLAT_QUERY, type FolderView } from "../navigation/folderView";
import { baseName, isBin, parentOf, toCrumbs, typedPath, type Crumb } from "../navigation/path";
import { lookOf } from "../sidebar/saved";
import { tagColor } from "../tags/tags";
import "./pathbar.css";

const ICON_BACK = "";
const ICON_FORWARD = "";
const ICON_UP = "";

const ICON_LIST = "\uE8FD";
const ICON_GRID = "\uF0E2";
const ICON_SHOWN = "\uE7B3";
const ICON_HIDDEN = "\uED1A";
const ICON_FILTER = "\uE71C";
const ICON_AWAY = "\uE8CD";
const ICON_CHEVRON = "\uE76C";
const ICON_LINK = "\uE71B";
const ICON_MORE = "\uE712";

const ICON_FORGET = "";

/** The color a folder wears, which its crumb takes on too. */
function lookColor(path: string) {
  const color = lookOf(path)?.color;
  return color === undefined ? undefined : tagColor(color);
}

/** Long enough that typing a word starts one search, not one per letter. */
const SEARCH_WAIT_MS = 120;
/** Holding Back or Forward this long shows the folders behind or ahead. */
const HOLD_MS = 450;

/** A folder's name as a crumb shows it. */
const nameOf = (path: string) => toCrumbs(path).at(-1)?.label ?? baseName(path);

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
  /** Back or Forward was held or right-clicked: the folders behind or ahead, in a menu at `x`, `y`. */
  onHistory: (behind: boolean, x: number, y: number) => void;
  /** A crumb's own menu. */
  onCrumbContext: (path: string, event: MouseEvent) => void;
  /** The crumbs folded away in the middle of a long path, in a menu at `x`, `y`. */
  onFoldedMenu: (crumbs: Crumb[], x: number, y: number) => void;
  /** With two panes in the tab, whether they follow each other. */
  linked?: { on: boolean; toggle: () => void };
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
  /** The recent searches show under the box while it is focused and empty. */
  const [recentOpen, setRecentOpen] = createSignal(false);
  /** The recent search the arrow keys are on, or -1 for none. */
  const [recentAt, setRecentAt] = createSignal(-1);
  const recents = () => (recentOpen() ? recentSearches() : []);
  /** How many crumbs after the first are folded into "…" to fit a long path. */
  const [fold, setFold] = createSignal(0);
  /** What has been typed in the path box, which the ghost of the first offer carries on from. */
  const [typed, setTyped] = createSignal("");
  let holdTimer: number | undefined;
  let held = false;

  /** A long path folds in the middle: the first crumb stays, then "…", then the nearest ones. */
  function fitCrumbs() {
    setFold(0);
    const most = Math.max(0, depth() - 2);
    while (fold() < most && list.scrollWidth > list.clientWidth) setFold(fold() + 1);
  }

  // Narrow panes clip the crumbs, and the current folder must stay visible.
  function revealCurrent() {
    untrack(fitCrumbs);
    list.querySelector("[aria-current]")?.scrollIntoView({ block: "nearest", inline: "end" });
    list.toggleAttribute("data-clipped", list.scrollLeft > 0);
  }

  /** The rest of the first offer, shown faintly after the typed text, which Tab or Right takes. */
  const ghost = () => {
    const first = offered().items[0]?.fill;
    const text = typed();
    if (!first || !text || chosen() > 0 || !first.toLowerCase().startsWith(text.toLowerCase())) return "";
    return first.slice(text.length);
  };

  function startHold(behind: boolean, button: HTMLElement) {
    held = false;
    window.clearTimeout(holdTimer);
    holdTimer = window.setTimeout(() => {
      held = true;
      showHistory(behind, button);
    }, HOLD_MS);
  }

  function showHistory(behind: boolean, button: HTMLElement) {
    const { left, bottom } = button.getBoundingClientRect();
    props.onHistory(behind, left, bottom + 2);
  }

  /** A click that ends a hold only closes it. */
  function endHold(event: MouseEvent, go: () => void) {
    window.clearTimeout(holdTimer);
    if (held) event.preventDefault();
    else go();
    held = false;
  }

  const nearest = (behind: boolean) => props.view.historyList(behind)[0]?.path;
  const backLabel = () => {
    const to = nearest(true);
    return props.view.query() ? "Back to the folder" : to ? `Back to ${nameOf(to)}` : "Back";
  };
  const forwardLabel = () => {
    const to = nearest(false);
    return to ? `Forward to ${nameOf(to)}` : "Forward";
  };
  const upLabel = () => {
    const parent = parentOf(props.view.folder()?.path ?? "");
    return parent ? `Up to ${nameOf(parent)}` : "Up";
  };

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
      setTyped("");
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
    } else if (
      (event.key === "Tab" && items.length > 0) ||
      (event.key === "ArrowRight" && ghost() && input.selectionStart === input.value.length)
    ) {
      event.preventDefault();
      const fill = items[Math.max(0, chosen())].fill;
      if (fill === undefined) return;
      input.value = fill;
      setTyped(fill);
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
    setRecentOpen(!searchBox.value);
    setRecentAt(-1);
    searchTimer = window.setTimeout(() => props.view.search(searchBox.value), SEARCH_WAIT_MS);
  }

  /** A search the user moved on from is one worth offering again. */
  function keepSearch() {
    const text = searchBox.value.trim();
    if (text && text !== FLAT_QUERY) rememberSearch(text);
  }

  function searchAgain(text: string) {
    window.clearTimeout(searchTimer);
    searchBox.value = text;
    setRecentOpen(false);
    props.view.search(text);
    rememberSearch(text);
  }

  function onSearchKey(event: KeyboardEvent) {
    const offered = recents();
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (event.key === "Escape" && offered.length > 0) {
      event.stopPropagation();
      setRecentOpen(false);
    } else if (event.key === "Escape") {
      event.stopPropagation();
      window.clearTimeout(searchTimer);
      searchBox.value = "";
      props.view.search("");
      focusList();
    } else if (step && offered.length > 0) {
      event.preventDefault();
      setRecentAt(((recentAt() + 1 + step + offered.length + 1) % (offered.length + 1)) - 1);
    } else if (event.key === "Enter" && offered[recentAt()]) {
      event.preventDefault();
      searchAgain(offered[recentAt()]);
    } else if (event.key === "Delete" && offered[recentAt()] && !searchBox.value) {
      event.preventDefault();
      forgetSearch(offered[recentAt()]);
      setRecentAt(Math.min(recentAt(), recentSearches().length - 1));
    } else if (event.key === "Enter" || event.key === "ArrowDown") {
      event.preventDefault();
      keepSearch();
      focusList();
    }
  }

  const searchStatus = () => {
    const count = props.view.folder()?.items ?? 0;
    if (!props.view.query()) return "";
    if (props.view.searching()) return "Searching…";
    if (props.view.moreToFind()) return `${count.toLocaleString()}+ matches`;
    return count === 1 ? "1 match" : `${count.toLocaleString()} matches`;
  };

  // Inside an effect the crumbs hidden by a fold only leave the page once it ends, so the fit
  // measures after, or it sees no change and folds all or nothing.
  createEffect(() => {
    crumbs();
    depth();
    queueMicrotask(revealCurrent);
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

  onCleanup(() => {
    window.clearTimeout(searchTimer);
    window.clearTimeout(holdTimer);
  });

  onMount(() => {
    const observer = new ResizeObserver(revealCurrent);
    observer.observe(list);
    onCleanup(() => observer.disconnect());
  });

  return (
    <nav class="pathbar" aria-label="Folder navigation">
      <button
        class="nav-button"
        aria-label={backLabel()}
        aria-keyshortcuts={ariaKeys("back")}
        aria-haspopup="menu"
        aria-description="Hold or right-click for the folders behind"
        disabled={!props.view.canGoBack()}
        onPointerDown={(event) => event.button === 0 && props.view.historyList(true).length > 1 && startHold(true, event.currentTarget)}
        onPointerLeave={() => window.clearTimeout(holdTimer)}
        onClick={(event) => endHold(event, () => props.view.back())}
        onContextMenu={(event) => {
          event.preventDefault();
          showHistory(true, event.currentTarget);
        }}
      >
        {ICON_BACK}
      </button>
      <button
        class="nav-button"
        aria-label={forwardLabel()}
        aria-keyshortcuts={ariaKeys("forward")}
        aria-haspopup="menu"
        aria-description="Hold or right-click for the folders ahead"
        disabled={!props.view.canGoForward()}
        onPointerDown={(event) => event.button === 0 && props.view.historyList(false).length > 1 && startHold(false, event.currentTarget)}
        onPointerLeave={() => window.clearTimeout(holdTimer)}
        onClick={(event) => endHold(event, () => props.view.forward())}
        onContextMenu={(event) => {
          event.preventDefault();
          showHistory(false, event.currentTarget);
        }}
      >
        {ICON_FORWARD}
      </button>
      <button class="nav-button" aria-label={upLabel()} aria-keyshortcuts={ariaKeys("up")} disabled={!props.view.canGoUp()} onClick={() => props.view.up()}>
        {ICON_UP}
      </button>
      <Show when={props.linked}>
        {(linked) => (
          <button
            class="nav-button link-button"
            aria-label={linked().on ? "Unlink panes" : "Link panes"}
            aria-description="Linked panes go into folders and back up together"
            aria-pressed={linked().on}
            onClick={() => linked().toggle()}
          >
            {ICON_LINK}
          </button>
        )}
      </Show>
      <Show when={props.view.editingPath()}>
        <div class="path-field">
          <Show when={ghost()}>
            <span class="path-ghost" aria-hidden="true">
              <span class="path-ghost-typed">{typed()}</span>
              {ghost()}
            </span>
          </Show>
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
            onInput={(event) => {
              setTyped(event.currentTarget.value);
              offer(event.currentTarget.value);
            }}
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
            <li hidden={index > 0 && index <= fold()}>
              <button
                class="crumb"
                classList={{ "crumb-left": index >= depth() }}
                data-drop={crumb().path}
                data-look={lookOf(crumb().path)?.color === undefined ? undefined : ""}
                style={{ "--look-color": lookColor(crumb().path) }}
                aria-current={index === depth() - 1 ? "location" : undefined}
                onClick={() => props.view.open(crumb().path)}
                onAuxClick={(event) => event.button === 1 && props.onNewTab(crumb().path)}
                onMouseDown={(event) => event.button === 1 && event.preventDefault()}
                onContextMenu={(event) => {
                  event.preventDefault();
                  props.onCrumbContext(crumb().path, event);
                }}
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
              <Show when={index === 0 && fold() > 0}>
                <button
                  class="crumb crumb-fold"
                  aria-label={`${fold()} more folders`}
                  aria-haspopup="menu"
                  onClick={(event) => {
                    const { left, bottom } = event.currentTarget.getBoundingClientRect();
                    props.onFoldedMenu(crumbs().slice(1, 1 + fold()), left, bottom + 2);
                  }}
                >
                  {ICON_MORE}
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
      {/* Tagged files a tag view can't reach: on a drive not plugged in or a computer that isn't
          answering. A click looks again, for a drive plugged in since. */}
      <Show when={props.view.folder()?.away}>
        {(away) => (
          <button
            class="hidden-count"
            aria-label={`${away() === 1 ? "1 tagged file is" : `${away()} tagged files are`} on a drive that isn't plugged in or a computer that isn't answering. Click to look again.`}
            onClick={() => void props.view.refresh()}
          >
            <span class="hidden-icon" aria-hidden="true">
              {ICON_AWAY}
            </span>
            {away()} away
          </button>
        )}
      </Show>
      <button
        class="nav-button filter-button"
        aria-label="Quick filters"
        aria-keyshortcuts={ariaKeys("filter")}
        aria-pressed={props.view.filtered()}
        aria-expanded={props.view.chipsShown()}
        onClick={props.onFilter}
      >
        {ICON_FILTER}
      </button>
      <span class="search-status" aria-live="polite">
        {searchStatus()}
      </span>
      <div class="search-field" hidden={props.view.isBin()}>
        <input
          ref={searchBox}
          class="search-input"
          role="combobox"
          aria-label="Search this folder"
          aria-keyshortcuts={ariaKeys("search")}
          aria-expanded={recents().length > 0}
          aria-controls={`search-recents-${props.view.id}`}
          aria-activedescendant={recentAt() >= 0 ? `search-recent-${props.view.id}-${recentAt()}` : undefined}
          placeholder="Search"
          spellcheck={false}
          value={props.view.query()}
          onInput={onSearchInput}
          onKeyDown={onSearchKey}
          onContextMenu={props.onInputMenu}
          onFocus={() => setRecentOpen(!searchBox.value)}
          onBlur={() => {
            setRecentOpen(false);
            setRecentAt(-1);
            keepSearch();
          }}
        />
        <Show when={recents().length > 0}>
          <ul id={`search-recents-${props.view.id}`} class="path-offers search-recents" role="listbox" aria-label="Recent searches">
            <li class="search-recents-title" role="presentation">
              Recent searches
            </li>
            <For each={recents()}>
              {(text, at) => (
                <li
                  id={`search-recent-${props.view.id}-${at()}`}
                  class="path-offer"
                  role="option"
                  aria-selected={at() === recentAt()}
                  onPointerMove={() => setRecentAt(at())}
                  // The box keeps the focus, or its blur would close this first.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => searchAgain(text)}
                >
                  <span class="path-offer-label">{text}</span>
                  <button
                    class="search-recent-forget"
                    tabIndex={-1}
                    aria-label={`Forget “${text}”`}
                    onClick={(event) => {
                      event.stopPropagation();
                      forgetSearch(text);
                    }}
                  >
                    {ICON_FORGET}
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
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
