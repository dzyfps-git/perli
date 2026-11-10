import { createEffect, createSignal } from "solid-js";
import { closeView } from "../../api";
import { morph } from "../../ui/morph";
import { createFolderView, type FolderView } from "../navigation/folderView";
import type { SavedPane, Session } from "./session";
import { cycled, moved, nextActive, otherPane } from "./tabList";

export type Tabs = ReturnType<typeof createTabs>;
export type Tab = ReturnType<typeof createTab>;

let tabCount = 0;

/** One title bar tab: 1 or 2 folder views side by side. */
function createTab(views: FolderView[], startSwapped = false) {
  const [panes, setPanes] = createSignal(views);
  const [active, setActive] = createSignal(views[0]);
  const [swapped, setSwapped] = createSignal(startSwapped);
  return {
    /** Tells this tab apart while it moves along the strip. */
    id: tabCount++,
    panes,
    /**
     * Panes slide to their new widths, and one that comes or goes fades. The change lands a frame
     * later, so it is made to the panes as they are by then.
     */
    setPanes: (change: (panes: FolderView[]) => FolderView[]) => morph(() => setPanes(change), "panes"),
    active,
    activate: setActive,
    swapped,
    swap: () => morph(() => setSwapped(!swapped()), "panes"),
    other: () => otherPane(panes(), active()),
    paths: () => panes().flatMap((view) => view.path() ?? []),
  };
}

export function createTabs() {
  let nextId = 0;
  const newView = (saved?: SavedPane) => createFolderView(nextId++, saved);

  const first = createTab([newView()]);
  const [tabs, setTabs] = createSignal([first]);
  const [active, setActive] = createSignal(first);
  const closed: string[][] = [];

  // Only tabs the user looks at read their folders.
  createEffect(() => {
    for (const view of active().panes()) view.openSaved();
  });

  /** Answers with the new tab's first pane, or nothing when no folder opened. */
  async function add(paths: string[], after = active()) {
    const views = paths.map(() => newView());
    const results = await Promise.all(views.map((view, index) => view.open(paths[index])));
    const opened = views.filter((_, index) => results[index]);
    if (opened.length === 0) return;

    const tab = createTab(opened);
    // Tab changes land a frame later, once the old look is captured, so each one reads the list
    // as it is by then. Closing several at once never brings back one closed just before.
    morph(() => {
      const result = [...tabs()];
      result.splice(result.indexOf(after) + 1, 0, tab);
      setTabs(result);
      setActive(tab);
    }, "tabs");
    return opened[0];
  }

  function close(tab: Tab) {
    if (tabs().length === 1) return;
    morph(() => {
      const list = tabs();
      if (list.length === 1 || !list.includes(tab)) return;
      closed.push(tab.paths());
      setActive(nextActive(list, tab, active()));
      setTabs(list.filter((other) => other !== tab));
      for (const view of tab.panes()) closeView(view.id).catch(console.error);
    }, "tabs");
  }

  function closePane(tab: Tab, view: FolderView) {
    const panes = tab.panes();
    if (panes.length === 1) return close(tab);

    const path = view.path();
    if (path) closed.push([path]);
    tab.activate(nextActive(panes, view, tab.active()));
    tab.setPanes((now) => now.filter((pane) => pane !== view));
    closeView(view.id).catch(console.error);
  }

  /** Opens `path` in the other pane, adding that pane if the tab has only one. */
  function openToSide(path: string, tab = active()) {
    const view = tab.other() ?? newView();
    // ponytail: the new pane lands a frame later, once the old look is captured, so a second
    // open to the side inside that frame would add another pane. Nothing does that today.
    if (!tab.panes().includes(view)) tab.setPanes((now) => [...now, view]);
    tab.activate(view);
    return view.open(path);
  }

  function restore(session: Omit<Session, "start">) {
    const restored = session.tabs.map((saved) => {
      const tab = createTab(
        saved.panes.map((pane) => newView(pane)),
        saved.swapped,
      );
      tab.activate(tab.panes()[saved.active]);
      return tab;
    });
    for (const view of first.panes()) closeView(view.id).catch(console.error);
    setTabs(restored);
    setActive(restored[session.active]);
  }

  /** What to save, or undefined until a folder is open. Reading it tracks every part. */
  function session(): Session | undefined {
    const view = active().active();
    const path = view.path();
    if (!path) return undefined;
    const saved = tabs().map((tab) => ({
      panes: tab.panes().flatMap((pane) => {
        const panePath = pane.path();
        return panePath ? [{ path: panePath, sort: pane.folderSort(), layout: pane.layout() }] : [];
      }),
      active: tab.panes().indexOf(tab.active()),
      swapped: tab.swapped(),
    }));
    return { start: { path, order: view.order() }, tabs: saved, active: tabs().indexOf(active()) };
  }

  return {
    tabs,
    active,
    restore,
    session,
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
    activateAt(index: number) {
      const tab = tabs()[index];
      if (tab) setActive(tab);
    },
    canReopen: () => closed.length > 0,
    reopenClosed() {
      const paths = closed.pop();
      if (paths?.length) add(paths);
    },
  };
}
