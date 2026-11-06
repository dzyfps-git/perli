import { createSignal, untrack } from "solid-js";
import { arrangeView, openFolder, type Opened, type Order, type Sort } from "../../api";
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
import { nextTrail, parentOf } from "./path";

export type FolderView = ReturnType<typeof createFolderView>;

/**
 * One browsing location: its open folder, history and path bar trail. A `saved` pane waits
 * for `openSaved`, so tabs restored behind the active one cost nothing at startup.
 */
export function createFolderView(id: number, saved?: SavedPane) {
  const [folder, setFolder] = createSignal<Opened>();
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
  let selectedRows = (): number[] => [];
  let savedOpened = false;

  /** The folder shown, or the saved one that has not been opened yet. */
  const path = () => folder()?.path ?? saved?.path;
  const order = (): Order => ({ ...sort(), group: grouping(), showHidden: showHidden() });

  async function load(path: string) {
    const request = ++latestRequest;
    const folderSort = rememberedSort(path);
    if (folderSort) setSortValue(folderSort);
    opening = true;
    try {
      const opened = await openFolder(id, request, folder()?.request ?? 0, path, order());
      if (request !== latestRequest) return undefined;
      setError(undefined);
      setFolder(opened);
      setTrail(nextTrail(trail(), opened.path));
      return opened;
    } catch (failure) {
      if (request === latestRequest) setError(String(failure));
      return undefined;
    } finally {
      if (request === latestRequest) {
        opening = false;
        if (rearrangeAfterOpen) rearrange();
      }
    }
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
      const arranged = await arrangeView(id, request, current.request, order(), selectedRows());
      if (request === latestRequest) setFolder({ ...current, request, ...arranged });
    } catch (failure) {
      if (request === latestRequest) setError(String(failure));
    }
  }

  function setSort(next: Sort) {
    setSortValue(next);
    setLastSort(next);
    const path = folder()?.path;
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
    path,
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
    /** The file list reports its selection here, so a new order can keep it. */
    readSelectionFrom(read: () => number[]) {
      selectedRows = read;
    },
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
