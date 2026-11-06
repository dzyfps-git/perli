import { createSignal } from "solid-js";
import { openFolder, type Opened } from "../../api";
import { nextTrail, parentOf } from "./path";

export type FolderView = ReturnType<typeof createFolderView>;

/** One browsing location: its open folder, history and path bar trail. */
export function createFolderView(id: number) {
  const [folder, setFolder] = createSignal<Opened>();
  const [error, setError] = createSignal<string>();
  const [trail, setTrail] = createSignal("");
  const [backStack, setBackStack] = createSignal<string[]>([]);
  const [forwardStack, setForwardStack] = createSignal<string[]>([]);
  let latestRequest = 0;

  async function load(path: string) {
    const request = ++latestRequest;
    try {
      const opened = await openFolder(id, request, path);
      if (request !== latestRequest) return undefined;
      setError(undefined);
      setFolder(opened);
      setTrail(nextTrail(trail(), opened.path));
      return opened;
    } catch (failure) {
      if (request === latestRequest) setError(String(failure));
      return undefined;
    }
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
