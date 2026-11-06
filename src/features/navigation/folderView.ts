import { createSignal } from "solid-js";
import { arrangeView, openFolder, type Opened, type Order, type Sort } from "../../api";
import type { Layout } from "../filelist/layout";
import { filesFirst, lastLayout, lastSort, setLastLayout, setLastSort, showHidden } from "../filelist/prefs";
import { nextTrail, parentOf } from "./path";

export type FolderView = ReturnType<typeof createFolderView>;

/** One browsing location: its open folder, history and path bar trail. */
export function createFolderView(id: number) {
  const [folder, setFolder] = createSignal<Opened>();
  const [error, setError] = createSignal<string>();
  const [trail, setTrail] = createSignal("");
  const [backStack, setBackStack] = createSignal<string[]>([]);
  const [forwardStack, setForwardStack] = createSignal<string[]>([]);
  const [sort, setSortValue] = createSignal(lastSort());
  const [layout, setLayoutValue] = createSignal(lastLayout());
  const [editingPath, setEditingPath] = createSignal(false);
  let latestRequest = 0;
  let opening = false;
  let rearrangeAfterOpen = false;
  let selectedRows = (): number[] => [];

  const order = (): Order => ({ ...sort(), filesFirst: filesFirst(), showHidden: showHidden() });

  async function load(path: string) {
    const request = ++latestRequest;
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
    back,
    forward,
    up,
  };
}
