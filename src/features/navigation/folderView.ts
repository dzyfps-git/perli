import { batch, createSignal, untrack } from "solid-js";
import {
  arrangeView,
  countWhere,
  openFolder,
  reloadView,
  scanSizes,
  type GroupBy,
  type Opened,
  type Order,
  type SearchScope,
  type SearchStep,
  type SearchWalk,
  type Selection,
  type Sort,
} from "../../api";
import { filterActive, NO_FILTER, toFilter } from "../filelist/filter";
import type { Layout } from "../filelist/layout";
import type { ColumnSet } from "../filelist/columns";
import { extensionsOf, type Kind } from "../filelist/fileKinds";
import { dateGroups, KIND_GROUPS } from "../filelist/groups";
import {
  folderSizes,
  grouping,
  inlineFolders,
  lastLayout,
  lastSort,
  rememberedFilter,
  rememberedGroup,
  rememberedSort,
  rememberFilter,
  rememberGroup,
  rememberSort,
  setLastLayout,
  setLastSort,
  showHidden,
  showSystem,
} from "../filelist/prefs";
import type { SavedPane } from "../tabs/session";
import { historyList, jumped } from "./history";
import { baseName, isBin, nextTrail, parentOf, samePath } from "./path";
import { morph } from "../../ui/morph";

export type FolderView = ReturnType<typeof createFolderView>;

/** The newest deletions are the ones worth seeing first. */
const BIN_SORT: Sort = { key: "modified", descending: true };
/** Keeps rows where they are as more arrive. */
const SEARCH_SORT: Sort = { key: "found", descending: false };
/** Asks a search for every file, which makes a flat view of the folder. */
export const FLAT_QUERY = "*";
/** A folder is one of songs or pictures when at least this share of its files are. */
const SET_SHARE = 0.6;
/** The extensions of each kind group, as the listing sorts them in. */
const GROUP_KINDS = KIND_GROUPS.map((group) => group.kinds.flatMap(extensionsOf));

/** The filter that keeps only files of `kinds`, for counting them. */
const onlyKinds = (kinds: Kind[]) => ({ ...toFilter(NO_FILTER), kinds: "files" as const, extensions: kinds.flatMap(extensionsOf) });

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
  /** The list stays scrolled where it is, even with rows to select. */
  still?: boolean;
}

const combined = (a: ReadAgain, b: ReadAgain): ReadAgain => ({
  select: [...a.select, ...b.select],
  rename: a.rename || b.rename,
  step: strongerStep(a.step, b.step),
  top: a.top || b.top,
  still: a.still && b.still,
});

/** One row of one snapshot. */
export interface RowAt {
  snapshot: number;
  index: number;
}

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
  /** Where the list starts scrolled to, coming back to the folder. */
  scrollTo?: number;
}

/** What a folder left behind, for coming back to it. */
interface Kept {
  names: string[];
  scrollTop: number;
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
  /** How far from the folder a search looks. */
  const [scope, setScopeValue] = createSignal<SearchScope>("below");
  /** Stays with the folder until the view goes to another one, unless the user pinned it there. */
  const [filterForm, setFilterFormValue] = createSignal(NO_FILTER);
  /** The row of filter chips under the path bar, which a search shows too. */
  const [chipsOpen, setChipsOpen] = createSignal(false);
  /** A search reads small text files too. */
  const [inside, setInsideValue] = createSignal(false);
  /** Folders opened in place, whose rows show under them. They last until the view goes elsewhere. */
  const [expanded, setExpanded] = createSignal<string[]>([]);
  /** What the folder's rows gather under headers by, and a search's, which the folder keeps apart. */
  const [groupBy, setGroupByValue] = createSignal<GroupBy>(saved ? rememberedGroup(saved.path) : "none");
  const [searchGroupBy, setSearchGroupBy] = createSignal<GroupBy>("none");
  /** Groups whose rows are out of sight, by key. They open again when the view goes elsewhere. */
  const [folded, setFolded] = createSignal<string[]>([]);
  /** How many folders deep a flat view goes. None is all the way. */
  const [depth, setDepthValue] = createSignal<number | null>(null);
  /** The columns that suit the folder: its songs' or pictures' own, or the plain ones. */
  const [columnSet, setColumnSet] = createSignal<ColumnSet>("plain");
  /** The one row selected in the list, for the details panel. */
  const [cursor, setCursor] = createSignal<RowAt | undefined>(undefined, {
    equals: (a, b) => a?.snapshot === b?.snapshot && a?.index === b?.index,
  });
  let latestRequest = 0;
  let opening = false;
  let rearrangeAfterOpen = false;
  let reloadLater: ReadAgain | undefined;
  let list: ListHandle | undefined;
  let savedOpened = false;
  /** Which folders the user chose not to see the search walked, as hidden and system. */
  let walkedSight = "";
  /** Each folder this pane left: its selection and scroll, by lowercase path. */
  const kept = new Map<string, Kept>();
  /** Rows of a search say nothing about their folder, so leaving one keeps nothing. */
  let leavingSearch = false;
  /** Told when the pane moves from one folder to another, for linked panes. */
  let follower: ((from: string, to: string) => void) | undefined;
  const sight = () => `${showHidden()} ${showSystem()}`;

  /** Only the list with its arrows shows folders opened in place, and can close them again. */
  const nests = () => layout() === "list" && inlineFolders();

  /** The folder shown, or the saved one that has not been opened yet. */
  const path = () => folder()?.path ?? saved?.path;
  const shownSort = () => (query() ? searchSort() : sort());
  const shownGroupBy = () => (query() ? searchGroupBy() : groupBy());
  /** What the listing needs to gather rows under headers. The dates are worked out here, where
   *  the calendar and the time zone are. */
  const grouped = (by: GroupBy, foldedKeys: string[]) => ({
    groupBy: by,
    groupEdges: by === "date" ? dateGroups(new Date()).map((group) => group.from) : [],
    groupKinds: by === "kind" ? GROUP_KINDS : [],
    folded: by === "none" ? [] : foldedKeys,
  });
  // Date order is the point of the Recycle Bin, and a search's order is how well rows fit, so
  // folders don't jump ahead in either.
  const order = (target = path()): Order => ({
    ...shownSort(),
    group: query() || isBin(target) ? "mixed" : grouping(),
    showHidden: showHidden(),
    showSystem: showSystem(),
    // Rows of a search carry no tags, so a tag would leave none of them.
    filter: { ...toFilter(filterForm()), tags: query() ? [] : filterForm().tags },
    // Grouped rows don't nest, so the folders opened in place close.
    expanded: query() || isBin(target) || shownGroupBy() !== "none" || !nests() ? [] : expanded(),
    ...grouped(shownGroupBy(), folded()),
  });
  /** A folder opens in its own order, even from a search. */
  const openingOrder = (target: string, wanted: Sort, form: typeof NO_FILTER, by: GroupBy): Order => ({
    ...wanted,
    group: isBin(target) ? "mixed" : grouping(),
    showHidden: showHidden(),
    showSystem: showSystem(),
    filter: toFilter(form),
    expanded: samePath(path(), target) && !isBin(target) && by === "none" && nests() ? expanded() : [],
    ...grouped(by, samePath(path(), target) ? folded() : []),
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

  /** A folder that is mostly songs or pictures gets their columns. A search keeps its own. */
  async function noteColumnSet(opened: Opened) {
    const ask = (kinds: Kind[]) => countWhere(id, opened.request, onlyKinds(kinds));
    const files = await countWhere(id, opened.request, { ...toFilter(NO_FILTER), kinds: "files" });
    const [songs, pictures] = files === 0 ? [0, 0] : await Promise.all([ask(["audio"]), ask(["picture"])]);
    if (folder()?.request !== opened.request) return;
    setColumnSet(songs >= files * SET_SHARE && files > 0 ? "music" : pictures >= files * SET_SHARE && files > 0 ? "pictures" : "plain");
  }

  /** Adds up the folders shown, if the user wants that. */
  function scanFolder() {
    const shown = folder()?.path;
    if (shown && folderSizes() && !isBin(shown)) scanSizes(id, shown).catch(console.error);
  }

  /** Nothing about the shown rows changes until the folder has read fine. `scrollTo` is where
   *  the new list starts. A `quiet` load that fails says nothing. */
  async function load(target: string, scrollTo?: number, quiet = false) {
    const searched = query();
    const before = path();
    const request = ++latestRequest;
    const folderSort = arrivalSort(target);
    // Only a folder already open has a form of its own. A restored one reads its pinned filter.
    const form = samePath(folder()?.path, target) ? filterForm() : (rememberedFilter(target) ?? NO_FILTER);
    const by = samePath(path(), target) ? groupBy() : rememberedGroup(target);
    opening = true;
    try {
      const wanted = openingOrder(target, folderSort ?? sort(), form, by);
      const opened = await openFolder(id, request, folder()?.request ?? 0, target, wanted);
      if (request !== latestRequest) return undefined;
      setError(undefined);
      leavingSearch = !!searched;
      batch(() => {
        // Text typed while this opened is a search of the new folder, which is waiting to start.
        if (query() === searched) {
          setQuery("");
          setWalk("done");
        }
        if (folderSort) setSortValue(folderSort);
        setFilterFormValue(form);
        if (filterActive(form)) setChipsOpen(true);
        if (!samePath(path(), opened.path)) {
          setExpanded([]);
          setFolded([]);
        }
        setGroupByValue(by);
        show({ ...opened, scrollTo });
      });
      leavingSearch = false;
      setTrail(nextTrail(trail(), opened.path));
      if (before && !samePath(before, opened.path)) follower?.(before, opened.path);
      scanFolder();
      if (isBin(opened.path)) setColumnSet("plain");
      else noteColumnSet(opened).catch(console.error);
      return opened;
    } catch (failure) {
      if (request === latestRequest && !quiet) setError(String(failure));
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
    const search = query() ? { step, query: query(), scope: scope(), inside: inside(), depth: query() === FLAT_QUERY ? depth() : null } : null;
    const select = search ? [] : wanted.select;
    const request = ++latestRequest;
    opening = true;
    if (search && step !== "grown") {
      setWalk("going");
      walkedSight = sight();
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
        const reveal = select.length > 0 && !wanted.still;
        setFolder({ ...current, request, ...reloaded, reveal, rename, top, rearranged: false, scrollTo: undefined });
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
    // Groups of the folder mean nothing to a search, and the other way round.
    if (!query() || !text) setFolded([]);
    setQuery(text);
    if (!text) setWalk("done");
    readAgain({ select: [], rename: false, step: "start", top: true });
  }

  /** A search under way starts over with the new reach. */
  function setScope(next: SearchScope) {
    if (next === scope()) return;
    setScopeValue(next);
    if (query()) readAgain({ select: [], rename: false, step: "start", top: true });
  }

  function setInside(next: boolean) {
    setInsideValue(next);
    if (query()) readAgain({ select: [], rename: false, step: "start", top: true });
  }

  /** Whether the shown folder opens with its filter each time. */
  const filterPinned = () => {
    const shown = folder()?.path;
    return !!shown && !query() && rememberedFilter(shown) !== undefined;
  };

  /** A pinned filter follows each change. One cleared away is unpinned with it. */
  function setFilterForm(form: typeof NO_FILTER) {
    const shown = folder()?.path;
    if (shown && filterPinned()) rememberFilter(shown, filterActive(form) ? form : undefined);
    setFilterFormValue(form);
    if (filterActive(form)) setChipsOpen(true);
    rearrange();
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
    if (query() && sight() !== walkedSight) return reload();

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

  /** A folder keeps how it is grouped. Rows that nest under their folders can't be grouped, so
   *  those folders close, which needs a new read. */
  function setGroupBy(next: GroupBy) {
    setFolded([]);
    if (query()) {
      setSearchGroupBy(next);
      return rearrange();
    }
    setGroupByValue(next);
    const shown = folder()?.path;
    if (shown && !isBin(shown)) rememberGroup(shown, next);
    if (next !== "none" && expanded().length > 0) {
      setExpanded([]);
      return reload();
    }
    rearrange();
  }

  /** Folds a group away or opens it. `every` does the same to all of them, as this one goes. */
  function toggleFold(key: string, every = false) {
    const open = !folded().includes(key);
    const keys = every ? (folder()?.groups ?? []).map((group) => group.key) : [key];
    setFolded(open ? [...new Set([...folded(), ...keys])] : folded().filter((other) => !keys.includes(other)));
    rearrange();
  }

  function setLayout(next: Layout) {
    if (next !== layout()) morph(() => setLayoutValue(next), "layout");
    setLastLayout(next);
    if (next !== "list") collapseAll();
  }

  /** Closes every folder opened in place, where nothing could show or close them. */
  function collapseAll() {
    if (expanded().length === 0) return;
    setExpanded([]);
    reload();
  }

  /** A `quiet` open that fails leaves the folder shown as it was, with no word of it. */
  async function open(path: string, quiet = false) {
    const from = folder()?.path;
    const opened = await load(path, undefined, quiet);
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

  /** Opens `target` as it was left: scrolled the same, with the same rows selected, or else `select`. */
  async function comeBack(target: string, select: string[] = []) {
    const left = kept.get(target.toLowerCase());
    const opened = await load(target, left?.scrollTop);
    // Up names the folder it left, which wins over what was selected before; Back and Forward name none.
    const names = select.length > 0 ? select : (left?.names ?? []);
    if (opened && names.length > 0) await readAgain({ select: names, rename: false, step: "again", top: false, still: select.length === 0 });
    return opened;
  }

  /** Moves `steps` through the history: back for a negative count, forward for a positive one. */
  async function go(steps: number) {
    const from = folder()?.path;
    const moved = from ? jumped({ back: backStack(), forward: forwardStack() }, from, steps) : undefined;
    if (!moved || !(await comeBack(moved.target))) return;
    setBackStack(moved.back);
    setForwardStack(moved.forward);
  }

  const back = () => (query() ? search("") : go(-1));
  const forward = () => go(1);

  /** The folder left is the one selected, as Explorer does. */
  async function up() {
    const path = folder()?.path;
    const parent = path && parentOf(path);
    if (!parent || !path) return;
    const opened = await comeBack(parent, [baseName(path)]);
    if (opened && !samePath(opened.path, path)) {
      setBackStack([...backStack(), path]);
      setForwardStack([]);
    }
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
    scope,
    setScope,
    searchGrew,
    /** Totals came in. A search would start over, so its rows wait for the next read. */
    sizesGrew() {
      if (!query()) reload();
    },
    scanFolder,
    searchAsked,
    inside,
    setInside,
    filterForm,
    filtered: () => filterActive(filterForm()),
    setFilterForm,
    filterPinned,
    /** Keeps the filter for the shown folder, so it comes back each time the folder opens. */
    pinFilter(on: boolean) {
      const shown = folder()?.path;
      if (shown) rememberFilter(shown, on && filterActive(filterForm()) ? filterForm() : undefined);
    },
    /** A search has kind, size and date to narrow it as well, so the chips come with it. */
    chipsShown: () => chipsOpen() || !!query(),
    toggleChips: () => setChipsOpen(!chipsOpen()),
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
    expanded,
    groupBy: shownGroupBy,
    setGroupBy,
    folded,
    toggleFold,
    columnSet,
    /** How many folders deep the flat view goes, or null for all the way. */
    depth,
    setDepth(next: number | null) {
      setDepthValue(next);
      if (query() === FLAT_QUERY) readAgain({ select: [], rename: false, step: "start", top: true });
    },
    collapseAll,
    /** Opens `folder` in place, under its row, or closes it and every folder opened inside it. */
    toggleExpand(folder: string) {
      const open = expanded().some((other) => samePath(other, folder));
      const inside = `${folder.toLowerCase()}\\`;
      setExpanded(
        open
          ? expanded().filter((other) => !samePath(other, folder) && !other.toLowerCase().startsWith(inside))
          : [...expanded(), folder],
      );
      return reload();
    },
    cursor,
    setCursor,
    /** A reload that waited for an edit of a name can go ahead. */
    editEnded: runReloadLater,
    /** The list took the rows of `snapshot`, or gave up on them. */
    swapped: settle,
    canGoBack: () => !!query() || backStack().length > 0,
    /** The folders behind, or ahead, nearest first, with the steps to each. */
    historyList: (behind: boolean) => historyList({ back: backStack(), forward: forwardStack() }, behind),
    go,
    /** The list going away says what it had selected and how far down it was. */
    keep(path: string, names: string[], scrollTop: number) {
      if (!leavingSearch) kept.set(path.toLowerCase(), { names, scrollTop });
    },
    /** Linked panes follow each other through `follow`. */
    setFollower(follow: ((from: string, to: string) => void) | undefined) {
      follower = follow;
    },
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
