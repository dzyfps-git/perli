import { batch, createSignal, untrack } from "solid-js";
import {
  arrangeView,
  openFolder,
  reloadView,
  type Opened,
  type Order,
  type Selection,
  type Sort,
} from "../../api";
import type { Layout } from "../filelist/layout";
import {
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

/** What the file list on screen tells its view. */
export interface ListHandle {
  /** The rows selected on screen, with the focused one first. */
  selection: () => Selection;
  rename: () => void;
  isEditing: () => boolean;
}

export interface ShownFolder extends Opened {
  rearranged?: boolean;
  /** Scroll to the selection, because the user asked for these rows. */
  reveal?: boolean;
  /** Open the selected row's name for editing. */
  rename?: boolean;
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
  let latestRequest = 0;
  let opening = false;
  let rearrangeAfterOpen = false;
  let reloadLater: { select: string[]; rename: boolean } | undefined;
  let list: ListHandle | undefined;
  let savedOpened = false;

  /** The folder shown, or the saved one that has not been opened yet. */
  const path = () => folder()?.path ?? saved?.path;
  // Date order is the point of the Recycle Bin, so folders don't jump ahead there.
  const order = (target = path()): Order => ({
    ...sort(),
    group: isBin(target) ? "mixed" : grouping(),
    showHidden: showHidden(),
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
    if (wanted) reload(wanted.select, wanted.rename);
    return wanted !== undefined;
  }

  /** Lets what waited for the read in flight go ahead. A reload covers a new order too. */
  function settle(request: number) {
    if (request !== latestRequest) return;
    opening = false;
    if (runReloadLater()) rearrangeAfterOpen = false;
    else if (rearrangeAfterOpen) rearrange();
  }

  async function load(target: string) {
    const request = ++latestRequest;
    const folderSort = arrivalSort(target);
    if (folderSort) setSortValue(folderSort);
    opening = true;
    try {
      const opened = await openFolder(id, request, folder()?.request ?? 0, target, order(target));
      if (request !== latestRequest) return undefined;
      setError(undefined);
      show(opened);
      setTrail(nextTrail(trail(), opened.path));
      return opened;
    } catch (failure) {
      if (request === latestRequest) setError(String(failure));
      return undefined;
    } finally {
      settle(request);
    }
  }

  /**
   * Reads the shown folder again, after a job changed it. The list stays in place and only its
   * rows change. `select` names the rows to select, and without any the selection stays put.
   * Nothing else starts until the list takes the new rows, because until then the selection
   * still holds row numbers of the old ones.
   */
  async function reload(select: string[] = [], rename = false) {
    const current = folder();
    if (!current) return;
    if (opening || list?.isEditing()) {
      reloadLater = {
        select: [...(reloadLater?.select ?? []), ...select],
        rename: rename || !!reloadLater?.rename,
      };
      return;
    }

    const request = ++latestRequest;
    opening = true;
    try {
      const reloaded = await reloadView(
        id,
        request,
        current.request,
        current.path,
        order(),
        selectedRows(current.request),
        select,
      );
      if (request === latestRequest) {
        setError(undefined);
        setFolder({ ...current, request, ...reloaded, reveal: select.length > 0, rename });
        return;
      }
    } catch (failure) {
      if (request === latestRequest) setError(String(failure));
    }
    settle(request);
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
    const target = path();
    if (target) await load(target);
  }

  async function back() {
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
    sort,
    setSort,
    layout,
    setLayout,
    editingPath,
    setEditingPath,
    rearrange,
    reload,
    /** The file list on screen reports in here, so a new order can keep its selection. */
    connectList(handle: ListHandle) {
      list = handle;
    },
    list: () => list,
    /** A reload that waited for an edit of a name can go ahead. */
    editEnded: runReloadLater,
    /** The list took the rows of `snapshot`, or gave up on them. */
    swapped: settle,
    canGoBack: () => backStack().length > 0,
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
