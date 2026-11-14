import { createEffect, createSignal } from "solid-js";
import { closeView, openWindow } from "../../api";
import { morph } from "../../ui/morph";
import { createFolderView, type FolderView } from "../navigation/folderView";
import { followTarget } from "../navigation/path";
import type { SavedPane, SavedTab, Session } from "./session";
import { cycled, EVEN_SPLIT, moved, nextActive, otherPane, pinnedFirst, snapped } from "./tabList";

export type Tabs = ReturnType<typeof createTabs>;
export type Tab = ReturnType<typeof createTab>;

let tabCount = 0;
/** How many closed tabs can be reopened. */
const MOST_CLOSED = 20;

/** How a tab's two panes sit: side by side or stacked, the first one's share, and linked. */
type Layout = Pick<SavedTab, "split" | "stacked" | "linked">;

/** One title bar tab: 1 or 2 folder views side by side, or one over the other. */
function createTab(views: FolderView[], startSwapped = false, saved: Layout = {}) {
  const [panes, setPanes] = createSignal(views);
  const [active, setActive] = createSignal(views[0]);
  const [swapped, setSwapped] = createSignal(startSwapped);
  const [pinned, setPinned] = createSignal(false);
  /** The share of the first pane on screen, left or top. */
  const [split, setSplit] = createSignal(saved.split === undefined ? EVEN_SPLIT : snapped(saved.split));
  const [stacked, setStacked] = createSignal(saved.stacked === true);
  /** Linked panes follow each other into folders and back up. */
  const [linked, setLinked] = createSignal(saved.linked === true);
  /** Where the tab itself is taking each pane, so getting there leads the other pane nowhere. */
  const led = new Map<FolderView, string>();
  const lead = (view: FolderView, target: string, quiet = false) => {
    led.set(view, target);
    return view.open(target, quiet).finally(() => {
      if (led.get(view) === target) led.delete(view);
    });
  };

  /**
   * When `mover` goes deeper or up, the other pane goes the same way in its own folder. Only a
   * pane's arrival where the tab led it is quiet, so the user going on meanwhile still leads.
   */
  const follow = (mover: FolderView) => (from: string, to: string) => {
    const going = led.get(mover);
    led.delete(mover);
    const other = otherPane(panes(), mover);
    // A pane still on its way follows from where it is going.
    const target = followTarget(from, to, going, linked(), other && (led.get(other) ?? other.path()));
    if (other && target) lead(other, target, true);
  };
  const listen = (list: FolderView[]) => {
    for (const view of list) view.setFollower(follow(view));
    return list;
  };
  listen(views);

  return {
    /** A pinned tab sits first, stays narrow and does not close by accident. */
    pinned,
    setPinned,
    /** Tells this tab apart while it moves along the strip. */
    id: tabCount++,
    panes,
    /**
     * Panes slide to their new widths, and one that comes or goes fades. The change lands a frame
     * later, so it is made to the panes as they are by then.
     */
    setPanes: (change: (panes: FolderView[]) => FolderView[]) => morph(() => setPanes((now) => listen(change(now))), "panes"),
    active,
    activate: setActive,
    /** Opens `target` in one of this tab's panes without a linked pane following it. */
    lead,
    swapped,
    swap: () => morph(() => setSwapped(!swapped()), "panes"),
    other: () => otherPane(panes(), active()),
    paths: () => panes().flatMap((view) => view.path() ?? []),
    split,
    setSplit,
    stacked,
    /** Side by side becomes one over the other, or back. */
    stack: () => morph(() => setStacked(!stacked()), "panes"),
    linked,
    setLinked,
    /** What to save of how the panes sit. Only what differs from a new tab. */
    layout(): Layout {
      return {
        ...(split() !== EVEN_SPLIT ? { split: split() } : {}),
        ...(stacked() ? { stacked: true } : {}),
        ...(linked() ? { linked: true } : {}),
      };
    },
  };
}

export function createTabs() {
  let nextId = 0;
  const newView = (saved?: SavedPane) => createFolderView(nextId++, saved);

  const first = createTab([newView()]);
  const [tabs, setTabs] = createSignal([first]);
  const [active, setActive] = createSignal(first);
  /** Closed tabs and panes by their folders, the latest last. */
  const [closed, setClosed] = createSignal<string[][]>([]);
  const remember = (paths: string[]) => {
    if (paths.length > 0) setClosed([...closed(), paths].slice(-MOST_CLOSED));
  };

  // Only tabs the user looks at read their folders.
  createEffect(() => {
    for (const view of active().panes()) view.openSaved();
  });

  /** Answers with the new tab's first pane, or nothing when no folder opened. `behind` leaves
   * the tab on show where it is. */
  async function add(paths: string[], after = active(), behind = false) {
    const views = paths.map(() => newView());
    const results = await Promise.all(views.map((view, index) => view.open(paths[index])));
    const opened = views.filter((_, index) => results[index]);
    if (opened.length === 0) return;

    const tab = createTab(opened);
    // Tab changes land a frame later, once the old look is captured, so each one reads the list
    // as it is by then. Closing several at once never brings back one closed just before.
    const placed = morph(() => {
      const result = [...tabs()];
      result.splice(result.indexOf(after) + 1, 0, tab);
      setTabs(inOrder(result));
      if (!behind) setActive(tab);
    }, "tabs");
    // Back only once the tab is in the list, so a caller adding the next one after it finds it.
    await placed?.updateCallbackDone.catch(() => undefined);
    return opened[0];
  }

  const inOrder = (list: Tab[]) => pinnedFirst(list, (tab) => tab.pinned());

  /** A pinned tab stays, unless `evenPinned`. */
  function close(tab: Tab, evenPinned = false) {
    if (tabs().length === 1 || (tab.pinned() && !evenPinned)) return;
    morph(() => {
      const list = tabs();
      if (list.length === 1 || !list.includes(tab)) return;
      remember(tab.paths());
      setActive(nextActive(list, tab, active()));
      setTabs(list.filter((other) => other !== tab));
      for (const view of tab.panes()) closeView(view.id).catch(console.error);
    }, "tabs");
  }

  function closePane(tab: Tab, view: FolderView) {
    const panes = tab.panes();
    if (panes.length === 1) return close(tab);

    const path = view.path();
    if (path) remember([path]);
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
    return tab.lead(view, path);
  }

  function restore(session: Omit<Session, "start">) {
    const restored = session.tabs.map((saved) => {
      const tab = createTab(
        saved.panes.map((pane) => newView(pane)),
        saved.swapped,
        saved,
      );
      tab.activate(tab.panes()[saved.active]);
      tab.setPinned(saved.pinned === true);
      return tab;
    });
    for (const view of first.panes()) closeView(view.id).catch(console.error);
    setTabs(inOrder(restored));
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
        const expanded = pane.expanded();
        return panePath ? [{ path: panePath, sort: pane.folderSort(), layout: pane.layout(), ...(expanded.length > 0 ? { expanded } : {}) }] : [];
      }),
      active: tab.panes().indexOf(tab.active()),
      swapped: tab.swapped(),
      ...(tab.pinned() ? { pinned: true } : {}),
      ...tab.layout(),
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
    closeRight(tab: Tab) {
      for (const other of tabs().slice(tabs().indexOf(tab) + 1)) close(other);
    },
    togglePinned(tab: Tab) {
      morph(() => {
        tab.setPinned(!tab.pinned());
        setTabs(inOrder(tabs()));
      }, "tabs");
    },
    /** The tab's folder opens in a window of its own, and the tab closes here. */
    async toWindow(tab: Tab) {
      const path = tab.active().path();
      if (!path) return;
      await openWindow(path, []);
      close(tab, true);
    },
    duplicate: (tab: Tab) => add(tab.paths(), tab),
    /** The other pane shows the folder of the one in use, which a tab of one pane gets. */
    mirror(tab = active()) {
      const path = tab.active().path();
      if (!path) return;
      const other = tab.other();
      return other ? tab.lead(other, path) : openToSide(path, tab);
    },
    /** A tab moves among its own kind: pinned tabs stay ahead of the rest. */
    move: (tab: Tab, offset: number) => setTabs(inOrder(moved(tabs(), tab, offset))),
    cycle: (offset: number) => setActive(cycled(tabs(), active(), offset)),
    activateAt(index: number) {
      const tab = tabs()[index];
      if (tab) setActive(tab);
    },
    canReopen: () => closed().length > 0,
    /** Closed tabs, the latest first, by their folders. */
    closedList: () => [...closed()].reverse(),
    /** The latest closed tab, or the one `back` places before it. */
    reopenClosed(back = 0) {
      const list = closed();
      const paths = list[list.length - 1 - back];
      if (!paths) return;
      setClosed(list.filter((other) => other !== paths));
      add(paths);
    },
  };
}
