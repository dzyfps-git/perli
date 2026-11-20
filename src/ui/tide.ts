import { createEffect, createSignal, on, onCleanup } from "solid-js";

/** How long the tide of newly used space shows in a drive's bar. */
const TIDE_MS = 1500;

/**
 * Space taken since the last reading of a drive, as the stretch of its bar that rises like a tide
 * for a moment, then settles. `used` is the share used, or undefined before the first reading,
 * which shows no tide.
 */
export function tideOf(used: () => number | undefined) {
  const [tide, setTide] = createSignal<{ from: number; to: number }>();
  let timer: number | undefined;
  createEffect(
    on(used, (now, before) => {
      if (before === undefined || now === undefined || now <= before) return;
      setTide({ from: before, to: now });
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setTide(undefined), TIDE_MS);
    }),
  );
  onCleanup(() => window.clearTimeout(timer));
  return tide;
}
