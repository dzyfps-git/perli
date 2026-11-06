import { createSignal } from "solid-js";
import { closeView, type Opened } from "../../api";
import { createFolderView, type FolderView } from "../navigation/folderView";
import { cycled, moved, nextActive } from "./tabList";

export type Tabs = ReturnType<typeof createTabs>;

export function createTabs() {
  const first = createFolderView(0);
  let nextId = 1;
  const [tabs, setTabs] = createSignal<FolderView[]>([first]);
  const [active, setActive] = createSignal(first);
  const closedPaths: string[] = [];

  async function add(path: string, after = active()): Promise<Opened | undefined> {
    const view = createFolderView(nextId++);
    const opened = await view.open(path);
    if (!opened) return undefined;

    const list = tabs();
    const result = [...list];
    result.splice(list.indexOf(after) + 1, 0, view);
    setTabs(result);
    setActive(view);
    return opened;
  }

  function close(view: FolderView) {
    const list = tabs();
    if (list.length === 1) return;

    const path = view.folder()?.path;
    if (path) closedPaths.push(path);
    setActive(nextActive(list, view, active()));
    setTabs(list.filter((tab) => tab !== view));
    closeView(view.id).catch(console.error);
  }

  return {
    tabs,
    active,
    add,
    close,
    activate: setActive,
    closeOthers(view: FolderView) {
      for (const tab of tabs()) if (tab !== view) close(tab);
    },
    duplicate(view: FolderView) {
      const path = view.folder()?.path;
      if (path) add(path, view);
    },
    move: (view: FolderView, offset: number) => setTabs(moved(tabs(), view, offset)),
    cycle: (offset: number) => setActive(cycled(tabs(), active(), offset)),
    reopenClosed() {
      const path = closedPaths.pop();
      if (path) add(path);
    },
  };
}
