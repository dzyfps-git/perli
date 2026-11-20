import { getCurrentWindow } from "@tauri-apps/api/window";
import { createEffect, createResource, createSignal, on, onCleanup } from "solid-js";
import {
  closeView,
  compared,
  compareFreshen,
  compareSettle,
  compareStop,
  compareSummary,
  isFile,
  MARKS,
  openWindow,
  rowNamed,
  type CompareSummary,
  type Mark,
  type Marks,
} from "../../api";
import { morph } from "../../ui/morph";
import { compareByContent, compareHideSame, compareScroll, newTabPlace } from "../filelist/prefs";
import { createFolderView, type FolderView } from "../navigation/folderView";
import { followTarget } from "../navigation/path";
import type { Place, SavedPane, SavedTab, Session } from "./session";
import { cycled, EVEN_SPLIT, moved, nextActive, otherPane, pinnedFirst, snapped } from "./tabList";

export type Tabs = ReturnType<typeof createTabs>;
export type Tab = ReturnType<typeof createTab>;

let tabCount = 0;
/** How many closed tabs can be reopened. */
const MOST_CLOSED = 20;
/** How often compared folders already known are walked again, for what changed deeper down. */
const FRESHEN_MS = 5000;

/** How a tab's two panes sit: side by side or stacked, the first one's share, and linked. */
type Layout = Pick<SavedTab, "split" | "stacked" | "linked" | "home">;

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
  /** The home page shows in place of the panes, which wait behind it. */
  const [home, setHome] = createSignal(saved.home === true);
  // Going anywhere in the tab, from the sidebar or a key, leaves the home page. A tab restored
  // onto the home page reads its folder the first time, which is no going anywhere.
  createEffect(
    on(
      () => active().path(),
      (now, before) => {
        if (before && now !== before) setHome(false);
      },
    ),
  );
  /** The two panes mark how each row stands against the other pane's row of the same name. */
  const [comparing, setComparing] = createSignal(false);
  createEffect(() => {
    if (panes().length < 2) setComparing(false);
  });
  /** Bumped when the compare learned more, for the marks to be asked for again. */
  const [learned, setLearned] = createSignal(0);
  /** The one mark each pane's rows are cut down to, picked from a count in its bar. */
  const [onlyMarks, setOnlyMarks] = createSignal(new Map<FolderView, Mark>());
  /** Which marks the rows `view` leaves out have, by their place in `MARKS`. */
  const hiding = (view: FolderView) => {
    const only = onlyMarks().get(view);
    if (only) return MARKS.flatMap((mark, at) => (mark === only ? [] : [at]));
    return compareHideSame() ? [MARKS.indexOf("same")] : [];
  };
  const apart = (summary: CompareSummary) => new Map(summary.folders.map(({ row, ...rest }) => [row, rest]));
  // Either pane reading again, sorting or going elsewhere compares anew. Searches have no marks.
  const [marks] = createResource(
    () => {
      const [one, two] = panes();
      const shown = [one?.folder(), two?.folder()];
      if (!comparing() || !shown[0] || !shown[1] || one.query() || two.query()) return undefined;
      return [one, shown[0].request, two, shown[1].request, compareByContent(), hiding(one), hiding(two), learned()] as const;
    },
    async ([one, oneRequest, two, twoRequest, content, hideOne, hideTwo]): Promise<Map<FolderView, Marks>> => {
      try {
        const [first, second, firstSaid, secondSaid] = await Promise.all([
          compared(one.id, oneRequest, two.id, twoRequest, content),
          compared(two.id, twoRequest, one.id, oneRequest, content),
          compareSummary(one.id, oneRequest, two.id, twoRequest, content, hideOne),
          compareSummary(two.id, twoRequest, one.id, oneRequest, content, hideTwo),
        ]);
        return new Map([
          [one, { snapshot: oneRequest, marks: first, summary: firstSaid, apart: apart(firstSaid) }],
          [two, { snapshot: twoRequest, marks: second, summary: secondSaid, apart: apart(secondSaid) }],
        ]);
      } catch {
        // A newer read took the place of one side meanwhile, and it compares in its turn.
        return marks.latest ?? new Map();
      }
    },
  );
  // Rows a pane leaves out go from its listing, and each side still stands against all of the other.
  createEffect(() => {
    const now = marks.latest;
    if (comparing() && now) for (const [view, { summary }] of now) view.setExcept(summary?.hidden ?? []);
  });
  // Folders, and files by content, take a while: a round at a time, until no mark waits.
  let settling = false;
  createEffect(() => {
    const now = marks.latest;
    const [one, two] = panes();
    const [mine, theirs] = [now?.get(one), now?.get(two)];
    if (!comparing() || settling || !mine || !theirs) return;
    const pending = MARKS.indexOf("pending");
    if (!mine.marks.includes(pending) && !theirs.marks.includes(pending)) return;
    settling = true;
    compareSettle(one.id, mine.snapshot, two.id, theirs.snapshot, compareByContent())
      .catch(() => 0)
      .then((settled) => {
        settling = false;
        // Marks that came meanwhile may wait on more.
        if (settled > 0 || marks.latest !== now) setLearned(learned() + 1);
      });
  });
  // A folder's time misses what changes deeper down, so while the window is in sight, folders
  // already compared are walked again now and then. Their marks hold until a walk is done.
  createEffect(() => {
    if (!comparing()) return;
    const timer = setInterval(() => {
      const now = marks.latest;
      const [one, two] = panes();
      const [mine, theirs] = [now?.get(one), now?.get(two)];
      if (settling || document.hidden || !mine || !theirs) return;
      settling = true;
      compareFreshen(one.id, mine.snapshot, two.id, theirs.snapshot, compareByContent())
        .catch(() => 0)
        .then((changed) => {
          settling = false;
          if (changed > 0 || marks.latest !== now) setLearned(learned() + 1);
        });
    }, FRESHEN_MS);
    onCleanup(() => clearInterval(timer));
  });
  createEffect(
    on(
      comparing,
      (now) => {
        if (now) return;
        setOnlyMarks(new Map());
        for (const view of panes()) view.setExcept([]);
        const [one, two] = panes();
        if (one && two) compareStop(one.id, two.id).catch(() => {});
      },
      { defer: true },
    ),
  );

  /** One line-up at a time. The latest scroll waits its turn, and those between are skipped. */
  let lining = false;
  let nextLine: (() => Promise<void>) | undefined;
  const lineUp = (line: () => Promise<void>) => {
    if (lining) return void (nextLine = line);
    lining = true;
    line().finally(() => {
      lining = false;
      const next = nextLine;
      nextLine = undefined;
      if (next) lineUp(next);
    });
  };

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
    // A pane still on its way follows from where it is going. Compared panes step in and out
    // together too, where the other side has that folder.
    const target = followTarget(from, to, going, linked() || comparing(), other && (led.get(other) ?? other.path()));
    if (!other || !target) return;
    if (linked()) return void lead(other, target, true);
    isFile(target)
      .then((file) => {
        if (!file && comparing()) void lead(other, target, true);
      })
      .catch(() => {});
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
    home,
    setHome,
    comparing,
    setComparing,
    /** How the rows of `view` stand against the other pane's, while the two are compared. */
    marksOf: (view: FolderView) => (comparing() ? marks.latest?.get(view) : undefined),
    /** The one mark `view`'s rows are cut down to, if any. */
    onlyMark: (view: FolderView) => onlyMarks().get(view),
    setOnlyMark(view: FolderView, mark: Mark | undefined) {
      const next = new Map(onlyMarks());
      if (mark) next.set(view, mark);
      else next.delete(view);
      setOnlyMarks(next);
    },
    /** The user scrolled `view`: the other compared pane lines up its row of the same name. */
    scrolled(view: FolderView, tops: { name: string; offset: number }[]) {
      const other = otherPane(panes(), view);
      const shown = other?.folder();
      if (!comparing() || !compareScroll() || !other || !shown || tops.length === 0) return;
      lineUp(() =>
        rowNamed(other.id, shown.request, tops.map((top) => top.name))
          .then((found) => {
            if (found) other.list()?.scrollToRow(found[1], tops[found[0]].offset);
          })
          .catch(() => {}),
      );
    },
    /** What to save of how the panes sit. Only what differs from a new tab. */
    layout(): Layout {
      return {
        ...(split() !== EVEN_SPLIT ? { split: split() } : {}),
        ...(stacked() ? { stacked: true } : {}),
        ...(linked() ? { linked: true } : {}),
        ...(home() ? { home: true } : {}),
      };
    },
  };
}

/** This window's tabs went to another window, so closing it leaves nothing to reopen. */
let left = false;

/** Closes this window once its tabs live in another one. */
export function leaveWindow() {
  left = true;
  return getCurrentWindow().close();
}

export const leftWindow = () => left;

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

  /** The tab others were last opened from, and the last of them, which the next one follows. */
  let openedFrom: { tab: Tab; last: Tab } | undefined;
  // Looking at another tab starts a new line, as in a browser.
  createEffect(() => {
    if (openedFrom && active() !== openedFrom.tab) openedFrom = undefined;
  });

  /** Where a tab opened from `after` goes: at the end, or after it and the ones opened from it already. */
  function placeAfter(after: Tab) {
    if (newTabPlace() === "end") return tabs().at(-1) ?? after;
    return openedFrom?.tab === after && tabs().includes(openedFrom.last) ? openedFrom.last : after;
  }

  /** Answers with the new tab's first pane, or nothing when no folder opened. `behind` leaves
   * the tab on show where it is. `layout` is how the new tab starts, such as on the home page. */
  async function add(paths: string[], after = active(), behind = false, layout: Layout = {}) {
    const views = paths.map(() => newView());
    const results = await Promise.all(views.map((view, index) => view.open(paths[index])));
    const opened = views.filter((_, index) => results[index]);
    if (opened.length === 0) return;

    const tab = createTab(opened, false, layout);
    const place = placeAfter(after);
    openedFrom = behind ? { tab: after, last: tab } : undefined;
    // Tab changes land a frame later, once the old look is captured, so each one reads the list
    // as it is by then. Closing several at once never brings back one closed just before.
    const placed = morph(() => {
      const result = [...tabs()];
      result.splice(result.indexOf(place) + 1, 0, tab);
      setTabs(inOrder(result));
      if (!behind) setActive(tab);
    }, "tabs");
    // Back only once the tab is in the list, so a caller adding the next one after it finds it.
    await placed?.updateCallbackDone.catch(() => undefined);
    return opened[0];
  }

  const inOrder = (list: Tab[]) => pinnedFirst(list, (tab) => tab.pinned());

  /** A pinned tab stays, unless `evenPinned`. A tab that `moved` to another window can't be reopened here. */
  function close(tab: Tab, evenPinned = false, moved = false) {
    if (tabs().length === 1 || (tab.pinned() && !evenPinned)) return;
    morph(() => {
      const list = tabs();
      if (list.length === 1 || !list.includes(tab)) return;
      if (!moved) remember(tab.paths());
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

  const fromSaved = (saved: SavedTab) => {
    const tab = createTab(
      saved.panes.map((pane) => newView(pane)),
      saved.swapped,
      saved,
    );
    tab.activate(tab.panes()[saved.active]);
    tab.setPinned(saved.pinned === true);
    return tab;
  };

  /** Every tab gives way to `list`. The ones replaced can be reopened when `remembered`. */
  function replaceAll(list: Tab[], shown: Tab, remembered: boolean) {
    for (const tab of tabs()) {
      if (remembered) remember(tab.paths());
      for (const view of tab.panes()) closeView(view.id).catch(console.error);
    }
    setTabs(inOrder(list));
    setActive(shown);
  }

  function restore(session: Omit<Session, "start">, remembered = false) {
    const restored = session.tabs.map(fromSaved);
    replaceAll(restored, restored[session.active], remembered);
  }

  /** Every tab gives way to one new tab on `path`, laid out as `layout` says. */
  function startOver(path: string, layout: Layout, remembered = false) {
    const view = newView();
    const tab = createTab([view], false, layout);
    replaceAll([tab], tab, remembered);
    return view.open(path);
  }

  /** A tab as saved, its panes written by `pane`. */
  const savedTab = (tab: Tab, pane: (view: FolderView) => SavedPane | undefined): SavedTab => ({
    panes: tab.panes().flatMap((view) => pane(view) ?? []),
    active: tab.panes().indexOf(tab.active()),
    swapped: tab.swapped(),
    ...(tab.pinned() ? { pinned: true } : {}),
    ...tab.layout(),
  });

  /** What to save, or undefined until a folder is open. Reading it tracks every part. */
  function session(): Session | undefined {
    const view = active().active();
    const path = view.path();
    if (!path) return undefined;
    const saved = tabs().map((tab) =>
      savedTab(tab, (pane) => {
        const panePath = pane.path();
        const expanded = pane.expanded();
        return panePath ? { path: panePath, sort: pane.folderSort(), layout: pane.layout(), ...(expanded.length > 0 ? { expanded } : {}) } : undefined;
      }),
    );
    return { start: { path, order: view.order() }, tabs: saved, active: tabs().indexOf(active()) };
  }

  /** All of a tab, for another window to take: its panes' history, selection and scroll too. */
  const handover = (tab: Tab) => savedTab(tab, (view) => view.handover());

  return {
    tabs,
    active,
    restore,
    startOver,
    session,
    /** Every tab with its panes' history, selection and scroll, as a workspace keeps them. */
    snapshot: () => ({ tabs: tabs().map(handover), active: tabs().indexOf(active()) }),
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
    handover,
    /** A tab from another window comes in after the one on show, and is shown. */
    adopt(saved: SavedTab) {
      const tab = fromSaved(saved);
      morph(() => {
        const result = [...tabs()];
        result.splice(result.indexOf(active()) + 1, 0, tab);
        setTabs(inOrder(result));
        setActive(tab);
      }, "tabs");
    },
    /** The whole tab goes to a window of its own, at `place` if given, and closes here. */
    async toWindow(tab: Tab, place?: Place) {
      const path = tab.active().path();
      if (!path) return;
      await openWindow(path, [], JSON.stringify({ tab: handover(tab), ...(place ? { place } : {}) }));
      close(tab, true, true);
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
