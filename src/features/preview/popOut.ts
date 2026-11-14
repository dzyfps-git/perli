import { emitTo } from "@tauri-apps/api/event";
import { miniOpen } from "../../api";
import type { HandBack, Handover } from "../mini/handover";

/** Hands a film to the small window that plays it on over every other window. */
export const popOut = (film: Omit<Handover, "seq">) => miniOpen({ ...film, seq: Date.now() });

/** The small window's film stops, for sound that starts here. No window, nothing to stop. */
export const hushMini = () => void emitTo("mini", "mini-hush").catch(() => {});

let back: HandBack | undefined;

/** The film the small window handed back, until the full player of that file takes it. */
export const holdBack = (handed: HandBack) => (back = handed);

export function takeBack(path: string) {
  if (back?.path !== path) return undefined;
  const handed = back;
  back = undefined;
  return handed;
}
