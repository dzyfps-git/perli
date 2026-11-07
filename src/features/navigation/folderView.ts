import { batch, createSignal, untrack } from "solid-js";
import {
  arrangeView,
  openFolder,
  reloadView,
  scanSizes,
  type Opened,
  type Order,
  type SearchStep,
  type SearchWalk,
  type Selection,
  type Sort,
} from "../../api";
import { filterActive, NO_FILTER, toFilter } from "../filelist/filter";
import type { Layout } from "../filelist/layout";
import {
  folderSizes,
  grouping,
  lastLayout,
  lastSort,
  rememberedSort,
  rememberSort,
  setLastLayout,
  setLastSort,
  showHidden,
} from "../filelist/prefs";
import type { SavedPane } from "../tabs/session";
import { isBin, nextTrail, parentOf, samePath } from "./path";

export type FolderView = ReturnType<typeof createFolderView>;

/** The newest deletions are the ones worth seeing first. */
const BIN_SORT: Sort = { key: "modified", descending: true };
/** Keeps rows where they are as more arrive. */
const SEARCH_SORT: Sort = { key: "found", descending: false };
/** Asks a search for every file, which makes a flat view of the folder. */
export const FLAT_QUERY = "*";
/** Weakest first. Each covers the ones before it, so one read can stand for all that waited. */
const SEARCH_STEPS: SearchStep[] = ["grown", "again", "start"];

const strongerStep = (a: SearchStep, b: SearchStep) =>
  SEARCH_STEPS[Math.max(SEARCH_STEPS.indexOf(a), SEARCH_STEPS.indexOf(b))];

/** What a new read of the shown folder is for. */
interface ReadAgain {
  /** Names the rows to select. Without any, the selection stays put. */
  select: string[];
  rename: boolean;
  /** What a search wants from this read. A plain folder ignores it. */
  step: SearchStep;
  /** These rows have nothing to do with the ones before. */
  top: boolean;
}

const combined = (a: ReadAgain, b: ReadAgain): ReadAgain => ({
  select: [...a.select, ...b.select],
  rename: a.rename || b.rename,
  step: strongerStep(a.step, b.step),
  top: a.top || b.top,
});

/** What the file list on screen tells its view. */
export interface ListHandle {
  /** The rows selected on screen, with the focused one first. */
  selection: () => Selection;
  rename: () => void;
  isEditing: () => boolean;
  focus: () => void;
  /** Selects `rows` in place of what was selected. */
  select: (rows: number[]) => void;
}

export interface ShownFolder extends Opened {
  rearranged?: boolean;
  /** Scroll to the selection, because the user asked for these rows. */
  reveal?: boolean;
  /** Open the selected row's name for editing. */
  rename?: boolean;
  /** Start from the top with nothing selected. */
  top?: boolean;
}

/**
 * One browsing location: its open folder, history and path bar trail. A `saved` pane waits
 * for `openSaved`, so tabs restored behind the active one cost nothing at startup.
 */
export function createFolderView(id: number, saved?: SavedPane) {
  const [folder, setFolder] = createSignal<ShownFolder>();
  /** Changes when the list should start over. A reload keeps it, so nothing blinks. */
  const [arrival, setArrival] = createSignal(0);
  const [error, setError] = createSignal<string>();
  const [trail, setTrail] = createSignal("");
  const [backStack, setBackStack] = createSignal<string[]>([]);
  const [forwardStack, setForwardStack] = createSignal<string[]>([]);
  const [sort, setSortValue] = createSignal(saved?.sort ?? lastSort());
  const [layout, setLayoutValue] = createSignal(saved?.layout ?? lastLayout());
  const [editingPath, setEditingPath] = createSignal(false);
  /** What the rows are a search for. Empty for a plain folder. */
  const [query, setQuery] = createSignal("");
  const [walk, setWalk] = createSignal<SearchWalk>("done");
  const [searchSort, setSearchSort] = createSignal(SEARCH_SORT);
  const [searchAsked, setSearchAsked] = createSignal(0);
  /** Stays with the folder until the view goes to another one. */
  const [filterForm, setFilterFormValue] = createSignal(NO_FILTER);
  let latestRequest = 0;
  let opening = false;
  let rearrangeAfterOpen = false;
  let reloadLater: ReadAgain | undefined;
  let list: ListHandle | undefined;
  let savedOpened = false;
  /** Whether the search walked hidden folders. */
  let walkedHidden = false;

  /** The folder shown, or the saved one that has not been opened yet. */
  const path = () => folder()?.path ?? saved?.path;
  const shownSort = () => (query() ? searchSort() : sort());
  // Date order is the point of the Recycle Bin, and a search's order is how well rows fit, so
  // folders don't jump ahead in either.
  const order = (target = path()): Order => ({
    ...shownSort(),
    group: query() || isBin(target) ? "mixed" : grouping(),
    showHidden: showHidden(),
    // Rows of a search carry no tags, so a tag would leave none of them.
    filter: { ...toFilter(filterForm()), tags: query() ? [] : filterForm().tags },
  });
  /** A folder opens in its own order, even from a search. */
  const openingOrder = (target: string, wanted: Sort, form: typeof NO_FILTER): Order => ({
    ...wanted,
    group: isBin(target) ? "mixed" : grouping(),
    showHidden: showHidden(),
    filter: toFilter(form),
  });
  /** Row numbers mean nothing outside the snapshot they came from. */
  const selectedRows = (snapshot: number) => {
    const selection = list?.selection();
    return selection?.request === snapshot ? selection.rows : [];
  };

  function show(next: ShownFolder) {
    batch(() => {
      setFolder(next);
      setArrival(arrival() + 1);
    });
  }

  /** Memory is for arriving at a folder. A refresh or restore keeps this pane's own sort. */
  function arrivalSort(target: string) {
    if (samePath(path(), target)) return undefined;
    const remembered = rememberedSort(target);
    if (remembered) return remembered;
    if (isBin(target)) return BIN_SORT;
    return isBin(path()) ? lastSort() : undefined;
  }

  function runReloadLater() {
    const wanted = reloadLater;
    reloadLater = undefined;
    if (wanted) readAgain(wanted);
    return wanted !== undefined;
  }

  /** Lets what waited for the read in flight go ahead. A reload covers a new order too. */
  function settle(request: number) {
    if (request !== latestRequest) return;
    opening = false;
    if (runReloadLater()) rearrangeAfterOpen = false;
    else if (rearrangeAfterOpen) rearrange();
  }

  /** Adds up the folders shown, if the user wants that. */
  function scanFolder() {
    const shown = folder()?.path;
    if (shown && folderSizes() && !isBin(shown)) scanSizes(id, shown).catch(console.error);
  }

  /** Nothing about the shown rows changes until the folder has read fine. */
  async function load(target: string) {
    const searched = query();
    const request = ++latestRequest;
    const folderSort = arrivalSort(target);
    const form = samePath(path(), target) ? filterForm() : NO_FILTER;
    opening = true;
    try {
      const wanted = openingOrder(target, folderSort ?? sort(), form);
      const opened = await openFolder(id, request, folder()?.request ?? 0, target, wanted);
      if (request !== latestRequest) return undefined;
      setError(undefined);
      batch(() => {
        // Text typed while this opened is a search of the new folder, which is waiting to start.
        if (query() === searched) {
          setQuery("");
          setWalk("done");
        }
        if (folderSort) setSortValue(folderSort);
        setFilterFormValue(form);
        show(opened);
      });
      setTrail(nextTrail(trail(), opened.path));
      scanFolder();
      return opened;
    } catch (failure) {
      if (request === latestRequest) setError(String(failure));
      return undefined;
    } finally {
      settle(request);
    }
  }

  /**
   * Reads the shown folder or its search again. The list stays in place and only its rows change.
   * Nothing else starts until the list takes the new rows, because until then the selection
   * still holds row numbers of the old ones.
   */
  async function readAgain(wanted: ReadAgain) {
    const current = folder();
    if (!current) return;
    if (opening || list?.isEditing()) {
      reloadLater = reloadLater ? combined(reloadLater, wanted) : wanted;
      return;
    }

    // Rows of a search have no names to go by, because one name can be in many folders.
    const { top, step } = wanted;
    const search = query() ? { step, query: query() } : null;
    const select = search ? [] : wanted.select;
    const request = ++latestRequest;
    opening = true;
    if (search && step !== "grown") {
      setWalk("going");
      walkedHidden = showHidden();
    }
    try {
      const reloaded = await reloadView(
        id,
        request,
        current.request,
        current.path,
        order(),
        top ? [] : selectedRows(current.request),
        select,
        search,
      );
      if (request === latestRequest) {
        setError(undefined);
        const rename = !search && wanted.rename;
        setFolder({ ...current, request, ...reloaded, reveal: select.length > 0, rename, top });
        return;
      }
    } catch (failure) {
      if (request === latestRequest) {
        setError(String(failure));
        setWalk("done");
      }
    }
    settle(request);
  }

  /** Shows what changed on disk. `select` names the rows to select. */
  function reload(select: string[] = [], rename = false) {
    return readAgain({ select, rename, step: "again", top: false });
  }

  /**
   * Searches under the shown folder. No text ends the search. Neither starts the list over,
   * because the search box must keep the focus while the user types.
   */
  function search(text: string) {
    if (text === query() || isBin(path())) return;
    if (!query()) setSearchSort(SEARCH_SORT);
    setQuery(text);
    if (!text) setWalk("done");
    readAgain({ select: [], rename: false, step: "start", top: true });
  }

  function searchGrew(walked: SearchWalk) {
    if (!query()) return;
    setWalk(walked);
    readAgain({ select: [], rename: false, step: "grown", top: false });
  }

  /** Applies a changed order to the shown folder. An open in flight must not be cancelled. */
  async function rearrange() {
    if (opening) {
      rearrangeAfterOpen = true;
      return;
    }
    rearrangeAfterOpen = false;
    const current = folder();
    if (!current) return;
    // A search found no rows in hidden folders unless it walked them.
    if (query() && showHidden() !== walkedHidden) return reload();

    const request = ++latestRequest;
    try {
      const rows = selectedRows(current.request);
      const arranged = await arrangeView(id, request, current.request, order(), rows);
      if (request === latestRequest) show({ ...current, request, ...arranged, rearranged: true });
    } catch (failure) {
      if (request === latestRequest) setError(String(failure));
    }
  }

  function setSort(next: Sort) {
    if (query()) {
      setSearchSort(next);
      return rearrange();
    }
    setSortValue(next);
    const path = folder()?.path;
    // Its sorts make no sense for normal folders, so new panes must not pick them up.
    if (!isBin(path)) setLastSort(next);
    if (path) rememberSort(path, next);
    rearrange();
  }

  function setLayout(next: Layout) {
    setLayoutValue(next);
    setLastLayout(next);
  }

  async function open(path: string) {
    const from = folder()?.path;
    const opened = await load(path);
    if (opened && from && opened.path !== from) {
      setBackStack([...backStack(), from]);
      setForwardStack([]);
    }
    return opened;
  }

  /** Also retries a saved folder that failed to open. */
  async function refresh() {
    if (query()) return reload();
    const target = path();
    if (target) await load(target);
  }

  async function back() {
    if (query()) return search("");
    const target = backStack().at(-1);
    const from = folder()?.path;
    if (!target || !from || !(await load(target))) return;
    setBackStack(backStack().slice(0, -1));
    setForwardStack([...forwardStack(), from]);
  }

  async function forward() {
    const target = forwardStack().at(-1);
    const from = folder()?.path;
    if (!target || !from || !(await load(target))) return;
    setForwardStack(forwardStack().slice(0, -1));
    setBackStack([...backStack(), from]);
  }

  async function up() {
    const path = folder()?.path;
    const parent = path && parentOf(path);
    if (parent) await open(parent);
  }

  return {
    id,
    folder,
    arrival,
    path,
    isBin: () => isBin(folder()?.path),
    openSaved() {
      if (saved && !savedOpened) untrack(() => open(saved.path));
      savedOpened = true;
    },
    order,
    error,
    trail,
    sort: shownSort,
    /** The folder's own sort, which a search leaves alone. */
    folderSort: sort,
    setSort,
    layout,
    setLayout,
    editingPath,
    setEditingPath,
    rearrange,
    reload,
    query,
    searching: () => walk() === "going",
    /** The rows so far aren't all of them, and more come as the user scrolls. */
    moreToFind: () => walk() === "waiting",
    search,
    searchGrew,
    /** Totals came in. A search would start over, so its rows wait for the next read. */
    sizesGrew() {
      if (!query()) reload();
    },
    scanFolder,
    searchAsked,
    filterForm,
    filtered: () => filterActive(filterForm()),
    setFilterForm(form: typeof NO_FILTER) {
      setFilterFormValue(form);
      rearrange();
    },
    /** A filter must not go on asking for a tag that is gone. */
    forgetTag(id: number) {
      const form = filterForm();
      setFilterFormValue({ ...form, tags: form.tags.filter((tag) => tag !== id) });
    },
    /** Sends the user to the search box. */
    askSearch() {
      if (!isBin(folder()?.path)) setSearchAsked(searchAsked() + 1);
    },
    /** The file list on screen reports in here, so a new order can keep its selection. */
    connectList(handle: ListHandle) {
      list = handle;
    },
    list: () => list,
    /** A reload that waited for an edit of a name can go ahead. */
    editEnded: runReloadLater,
    /** The list took the rows of `snapshot`, or gave up on them. */
    swapped: settle,
    canGoBack: () => !!query() || backStack().length > 0,
    canGoForward: () => forwardStack().length > 0,
    canGoUp: () => {
      const path = folder()?.path;
      return !!path && !!parentOf(path);
    },
    open,
    refresh,
    back,
    forward,
    up,
  };
}
