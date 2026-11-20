import { createEffect, createSignal } from "solid-js";
import { bringWorkspace, sendWorkspace, setWorkspace, showWindow, workspaceWindows } from "../../api";
import { morph } from "../../ui/morph";
import { saved, stored } from "../filelist/prefs";
import { moveWorkspaceKeys } from "../keys/keybinds";
import { parseSession, parseWorkspaces, put, type Workspace } from "./session";
import { cycled } from "./tabList";
import type { Tabs } from "./tabs";

/** Every window shares the saved workspaces. */
export const [workspaces, setWorkspaces] = stored<Workspace[]>("workspaces", parseWorkspaces(saved("workspaces")));

/** How long the name of a workspace stepped to stays on screen. */
const PILL_MS = 1400;

/** The workspace a step went to, and where it stands among them all. */
export interface Pill {
  name: string;
  at: number;
  of: number;
}

export type Workspaces = ReturnType<typeof createWorkspaces>;

/**
 * Named sets of tabs, one on screen at a time. Which one is this window's own, so a switch in one
 * window never renames another's, and a workspace is on screen in one window at most: switching
 * to one shown elsewhere brings that window forward. Tabs are kept on leaving a workspace; till
 * then the session keeps them.
 */
export function createWorkspaces(tabs: Tabs) {
  const [named, setNamed] = createSignal<string>();
  const [pill, setPill] = createSignal<Pill>();
  let pillTimer = 0;
  /** A switch is under way. Another one now would keep tabs that are on their way out. */
  let busy = false;
  /** The workspace this window asked another to send here. Any other that comes is refused. */
  let awaiting: string | undefined;
  /** The workspace on screen, unless another window deleted or renamed it meanwhile. */
  const current = () => {
    const name = named();
    return workspaces().some((one) => one.name === name) ? name : undefined;
  };
  // Other windows ask the back end which workspace this one shows, as they can't wait on this page.
  createEffect(() => setWorkspace(current()).catch(console.error));
  const free = (name: string) => name !== "" && !workspaces().some((one) => one.name === name);
  /** Puts the tabs on screen into `name`. No other window shows it, so none has tabs to lose. */
  const keepAs = (name: string) => {
    const now = parseSession(JSON.stringify(tabs.snapshot()));
    if (now) setWorkspaces(put(workspaces(), { name, ...now }));
  };

  /**
   * Keeps the tabs on screen in their workspace, then lets `change` replace them and waits till it
   * has. A step to the next or previous one slides that way. Tabs no workspace holds can still be
   * reopened from the closed tabs.
   */
  async function leave(change: (unnamed: boolean) => void, step = 0) {
    const was = current();
    if (was !== undefined) keepAs(was);
    const root = document.documentElement;
    const slide = step > 0 ? "next" : "previous";
    if (step !== 0) root.dataset.slide = slide;
    const transition = morph(() => change(was === undefined), "tabs");
    await transition?.updateCallbackDone.catch(() => undefined);
    if (step === 0) return;
    void Promise.resolve(transition?.finished)
      .catch(() => undefined)
      .then(() => {
        if (root.dataset.slide === slide) delete root.dataset.slide;
      });
  }

  /** One change of workspace at a time, from its start till the new one is named. */
  async function alone(work: () => Promise<void> | void) {
    if (busy) return;
    busy = true;
    try {
      await work();
    } finally {
      busy = false;
    }
  }

  const switchTo = (name: string, step = 0) =>
    alone(async () => {
      const target = workspaces().find((one) => one.name === name);
      if (!target || name === current()) return;
      const [there] = await workspaceWindows([name]);
      if (there != null) return void (await showWindow(there));
      await leave((unnamed) => tabs.restore(target, unnamed), step);
      setNamed(name);
    });

  return {
    current,
    free,
    pill,
    /** The window's last workspace comes back with its tabs, unless another window shows it. */
    async resume(name: unknown) {
      if (typeof name !== "string") return;
      const [there] = await workspaceWindows([name]);
      if (there == null) setNamed(name);
    },
    switchTo,
    /** The tabs on screen become workspace `name`, the one on show. */
    saveAs: (name: string) =>
      alone(() => {
        if (!free(name)) return;
        keepAs(name);
        setNamed(name);
      }),
    /** A workspace of one tab, on the home page at `home`. */
    create: (name: string, home: string) =>
      alone(async () => {
        if (!free(name)) return;
        let opened: Promise<unknown> | undefined;
        // The folder is read after the change, so the change never waits on the disk.
        await leave((unnamed) => {
          opened = tabs.startOver(home, { home: true }, unnamed);
        });
        await opened;
        keepAs(name);
        setNamed(name);
      }),
    rename(name: string) {
      const was = current();
      if (busy || was === undefined || !free(name)) return;
      setWorkspaces(workspaces().map((one) => (one.name === was ? { ...one, name } : one)));
      moveWorkspaceKeys(was, name);
      setNamed(name);
    },
    /** The workspace goes, and its tabs stay on screen with no name. */
    remove() {
      const was = current();
      if (busy || was === undefined) return;
      setWorkspaces(workspaces().filter((one) => one.name !== was));
      moveWorkspaceKeys(was, undefined);
      setNamed(undefined);
    },
    /** The next or previous workspace, in the order they were made, past those other windows show. */
    async cycle(offset: number) {
      const names = workspaces().map((one) => one.name);
      if (names.length === 0) return;
      const held = await workspaceWindows(names);
      const open = names.filter((_, index) => held[index] == null);
      const now = current();
      const next = now === undefined ? (offset > 0 ? open[0] : open.at(-1)) : cycled(open, now, offset);
      if (next === undefined) return;
      window.clearTimeout(pillTimer);
      setPill({ name: next, at: names.indexOf(next) + 1, of: names.length });
      pillTimer = window.setTimeout(() => setPill(undefined), PILL_MS);
      return switchTo(next, offset);
    },
    /** Asks the window showing `name` to send it here. False when it won't, as while its jobs run. */
    bringHere(name: string, there: number) {
      awaiting = name;
      return bringWorkspace(there, name);
    },
    /**
     * Another window asked for the workspace on screen here. Its tabs are kept and sent there, and
     * true says this window is to close.
     */
    async handOver(asker: number, name: string) {
      if (busy || name !== current()) return false;
      keepAs(name);
      const workspace = workspaces().find((one) => one.name === name);
      if (!workspace || !(await sendWorkspace(asker, JSON.stringify(workspace)))) return false;
      setNamed(undefined);
      return true;
    },
    /** The workspace another window sent when asked: its tabs replace the ones here. */
    take(text: string) {
      let brought: Workspace | undefined;
      try {
        brought = parseWorkspaces([JSON.parse(text)])[0];
      } catch {
        return;
      }
      if (!brought || brought.name !== awaiting) return;
      awaiting = undefined;
      const workspace = brought;
      setWorkspaces(put(workspaces(), workspace));
      return alone(async () => {
        await leave((unnamed) => tabs.restore(workspace, unnamed));
        setNamed(workspace.name);
      });
    },
  };
}
