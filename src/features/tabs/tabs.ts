import { createSignal } from "solid-js";
import { closeView } from "../../api";
import { createFolderView, type FolderView } from "../navigation/folderView";
import { cycled, moved, nextActive, otherPane } from "./tabList";

export type Tabs = ReturnType<typeof createTabs>;
export type Tab = ReturnType<typeof createTab>;

/** One title bar tab: 1 or 2 folder views side by side. */
function createTab(views: FolderView[]) {
  const [panes, setPanes] = createSignal(views);
  const [active, setActive] = createSignal(views[0]);
  const [swapped, setSwapped] = createSignal(false);
  return {
    panes,
    setPanes,
    active,
    activate: setActive,
    swapped,
    swap: () => setSwapped(!swapped()),
    other: () => otherPane(panes(), active()),
    paths: () => panes().flatMap((view) => view.folder()?.path ?? []),
  };
}

export function createTabs() {
  let nextId = 0;
  const newView = () => createFolderView(nextId++);

  const first = createTab([newView()]);
  const [tabs, setTabs] = createSignal([first]);
  const [active, setActive] = createSignal(first);
  const closed: string[][] = [];

  async function add(paths: string[], after = active()) {
    const views = paths.map(newView);
    const results = await Promise.all(views.map((view, index) => view.open(paths[index])));
    const opened = views.filter((_, index) => results[index]);
    if (opened.length === 0) return;

    const tab = createTab(opened);
    const list = tabs();
    const result = [...list];
    result.splice(list.indexOf(after) + 1, 0, tab);
    setTabs(result);
    setActive(tab);
  }

  function close(tab: Tab) {
    const list = tabs();
    if (list.length === 1) return;

    closed.push(tab.paths());
    setActive(nextActive(list, tab, active()));
    setTabs(list.filter((other) => other !== tab));
    for (const view of tab.panes()) closeView(view.id).catch(console.error);
  }

  function closePane(tab: Tab, view: FolderView) {
    const panes = tab.panes();
    if (panes.length === 1) return close(tab);

    const path = view.folder()?.path;
    if (path) closed.push([path]);
    tab.activate(nextActive(panes, view, tab.active()));
    tab.setPanes(panes.filter((pane) => pane !== view));
    closeView(view.id).catch(console.error);
  }

  /** Opens `path` in the other pane, adding that pane if the tab has only one. */
  function openToSide(path: string, tab = active()) {
    let view = tab.other();
    if (!view) {
      view = newView();
      tab.setPanes([...tab.panes(), view]);
    }
    tab.activate(view);
    return view.open(path);
  }

  return {
    tabs,
    active,
    activeView: () => active().active(),
    allViews: () => tabs().flatMap((tab) => tab.panes()),
    add,
    close,
    closePane,
    openToSide,
    activate: setActive,
    closeOthers(tab: Tab) {
      for (const other of tabs()) if (other !== tab) close(other);
    },
    duplicate: (tab: Tab) => add(tab.paths(), tab),
    move: (tab: Tab, offset: number) => setTabs(moved(tabs(), tab, offset)),
    cycle: (offset: number) => setActive(cycled(tabs(), active(), offset)),
    reopenClosed() {
      const paths = closed.pop();
      if (paths?.length) add(paths);
    },
  };
}
