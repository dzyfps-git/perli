import { createSignal } from "solid-js";
import { appVersion, checkUpdate, installUpdate, type UpdateOffer } from "../../api";
import { saved, stored } from "../filelist/prefs";

export type UpdateState = "idle" | "checking" | "current" | "ready" | "installing" | "failed";

/** Waits for the window to settle, so a check never slows the start. */
const START_DELAY_MS = 5000;

const [state, setState] = createSignal<UpdateState>("idle");
const [offer, setOffer] = createSignal<UpdateOffer>();
const [failure, setFailure] = createSignal<string>();
const [version, setVersion] = createSignal("");

export const updateState = state;
export const updateOffer = offer;
export const updateFailure = failure;
export const currentVersion = version;
export const [checkOnStart, setCheckOnStart] = stored("update-check", saved("update-check") !== false);
/** The version whose notes were put off with Later, so they don't come up again on their own. */
const [putOff, setPutOff] = stored("update-put-off", typeof saved("update-put-off") === "string" ? (saved("update-put-off") as string) : "");
/** The sheet with the new version's notes is up. */
export const [updateSheet, setUpdateSheet] = createSignal(false);
export const putOffUpdate = () => setPutOff(offer()?.version ?? "");

/** A quiet check says nothing when it fails, since being offline is normal. */
export async function lookForUpdate(quiet = false) {
  if (state() === "checking" || state() === "installing") return;
  setState("checking");
  setFailure(undefined);
  try {
    const found = await checkUpdate();
    setOffer(found ?? undefined);
    setState(found ? "ready" : "current");
    // A version found on its own shows what it brings once. Asked for, Settings says so already.
    if (found && quiet && putOff() !== found.version) setUpdateSheet(true);
  } catch (error) {
    setState(quiet ? "idle" : "failed");
    if (!quiet) setFailure(String(error));
  }
}

/** Perli ends once the installer starts, so whatever must be kept is saved first. */
export async function installNow(beforeExit: () => Promise<unknown>) {
  setState("installing");
  setFailure(undefined);
  try {
    await beforeExit().catch((error: unknown) => {
      // Shown as is, like the backend's own failures.
      throw `Your open tabs couldn't be saved, so the update waits. ${String(error)}`;
    });
    await installUpdate();
  } catch (error) {
    setState("ready");
    setFailure(String(error));
  }
}

export function startUpdates() {
  appVersion().then(setVersion).catch(console.error);
  if (checkOnStart()) setTimeout(() => lookForUpdate(true), START_DELAY_MS);
}
