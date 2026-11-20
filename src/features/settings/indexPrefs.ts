import type { IndexOptions } from "../../api";
import { saved, stored } from "../filelist/prefs";

/** The whole-PC index, off until the user turns it on. Every window hands these to its own
 *  process, and the one that keeps the index follows them. */
export const [indexOn, setIndexOn] = stored("index-on", (saved("index-on") as boolean | null) ?? false);
export const [indexPaused, setIndexPaused] = stored("index-paused", (saved("index-paused") as boolean | null) ?? false);
export const [indexBattery, setIndexBattery] = stored("index-battery", (saved("index-battery") as boolean | null) ?? true);
export const [indexNetwork, setIndexNetwork] = stored("index-network", (saved("index-network") as boolean | null) ?? false);
export const [indexSkip, setIndexSkip] = stored("index-skip", (saved("index-skip") as string[] | null) ?? []);

export const indexOptions = (): IndexOptions => ({
  on: indexOn(),
  paused: indexPaused(),
  battery: indexBattery(),
  network: indexNetwork(),
  skip: indexSkip(),
});
