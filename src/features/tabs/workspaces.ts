import { createSignal } from "solid-js";
import { morph } from "../../ui/morph";
import { saved, stored } from "../filelist/prefs";
import { moveWorkspaceKeys } from "../keys/keybinds";
import { parseSession, parseWorkspaces, put, type Workspace } from "./session";
import { cycled } from "./tabList";
import type { Tabs } from "./tabs";

/** Every window shares the saved workspaces. */
export const [workspaces, setWorkspaces] = stored<Workspace[]>("workspaces", parseWorkspaces(saved("workspaces")));

export type Workspaces = ReturnType<typeof createWorkspaces>;

/**
 * Named sets of tabs, one on screen at a time. Which one is this window's own, so a switch in one
 * window never renames another's. Tabs are kept on leaving a workspace; till then the session
 * keeps them.
 */
export function createWorkspaces(tabs: Tabs) {
  const [named, setNamed] = createSignal<string>();
  /** The first window takes its workspace over to the next start. */
  let main = false;
  /** A switch is under way. Another one now would keep tabs that are on their way out. */
  let busy = false;
  /** The workspace on screen, unless another window deleted or renamed it meanwhile. */
  const current = () => {
    const name = named();
    return workspaces().some((one) => one.name === name) ? name : undefined;
  };
  const show = (name: string | undefined) => {
    setNamed(name);
    if (main) localStorage.setItem("perli-workspace", JSON.stringify(name ?? null));
  };
  const free = (name: string) => name !== "" && !workspaces().some((one) => one.name === name);
  /** Puts the tabs on screen into `name`. */
  // ponytail: two windows on one workspace each keep their own tabs on leaving it, and the last
  // to leave wins. Telling each window's tabs apart would need a workspace per window.
  const keepAs = (name: string) => {
    const now = parseSession(JSON.stringify(tabs.snapshot()));
    if (now) setWorkspaces(put(workspaces(), { name, ...now }));
  };

  /**
   * Keeps the tabs on screen in their workspace, then lets `change` replace them and waits till it
   * has. Tabs no workspace holds can still be reopened from the closed tabs.
   */
  async function leave(change: (unnamed: boolean) => void) {
    busy = true;
    const was = current();
    if (was !== undefined) keepAs(was);
    try {
      await morph(() => change(was === undefined), "tabs")?.updateCallbackDone.catch(() => undefined);
    } finally {
      busy = false;
    }
  }

  async function switchTo(name: string) {
    const target = workspaces().find((one) => one.name === name);
    if (busy || !target || name === current()) return;
    await leave((unnamed) => tabs.restore(target, unnamed));
    show(name);
  }

  return {
    current,
    free,
    /** The first window's last workspace comes back with its tabs. */
    resume() {
      main = true;
      const name = saved("workspace");
      if (typeof name === "string") setNamed(name);
    },
    switchTo,
    /** The tabs on screen become workspace `name`, the one on show. */
    saveAs(name: string) {
      if (!free(name)) return;
      keepAs(name);
      show(name);
    },
    /** A workspace of one tab, on the home page at `home`. */
    async create(name: string, home: string) {
      if (busy || !free(name)) return;
      let opened: Promise<unknown> | undefined;
      // The folder is read after the change, so the change never waits on the disk.
      await leave((unnamed) => {
        opened = tabs.startOver(home, { home: true }, unnamed);
      });
      await opened;
      keepAs(name);
      show(name);
    },
    rename(name: string) {
      const was = current();
      if (was === undefined || !free(name)) return;
      setWorkspaces(workspaces().map((one) => (one.name === was ? { ...one, name } : one)));
      moveWorkspaceKeys(was, name);
      show(name);
    },
    /** The workspace goes, and its tabs stay on screen with no name. */
    remove() {
      const was = current();
      if (was === undefined) return;
      setWorkspaces(workspaces().filter((one) => one.name !== was));
      moveWorkspaceKeys(was, undefined);
      show(undefined);
    },
    /** The next or previous workspace, in the order they were made. */
    cycle(offset: number) {
      const names = workspaces().map((one) => one.name);
      const now = current();
      if (names.length === 0) return;
      return switchTo(now === undefined ? (offset > 0 ? names[0] : names[names.length - 1]) : cycled(names, now, offset));
    },
  };
}
