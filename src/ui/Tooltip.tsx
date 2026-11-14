import { onCleanup, onMount } from "solid-js";
import { shortcutText } from "./shortcut";
import "./tooltip.css";

const LABELLED = "button[aria-label], input[type=range][aria-label], [data-tip]";
const OPEN_DELAY_MS = 450;
/** Right after one closes, the next opens almost at once: the user is reading along a row. */
const WARM_DELAY_MS = 60;
const WARM_FOR_MS = 900;
const ANCHOR_GAP = 6;
const EDGE_GAP = 4;

/**
 * Perli's hover text for icon-only controls, read from each control's aria-label (or its
 * data-tip, where the label alone would not say how to use it), with the control's shortcut
 * from aria-keyshortcuts.
 * It is a popover so it can sit above the modal settings dialog.
 */
export function Tooltip() {
  let box!: HTMLDivElement;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: Element | undefined;
  let warmUntil = 0;
  let pointerY = 0;

  const isOpen = () => box.matches(":popover-open");

  function hide() {
    clearTimeout(timer);
    if (isOpen()) warmUntil = performance.now() + WARM_FOR_MS;
    current = undefined;
    box.togglePopover(false);
  }

  /** Each key of a shortcut as a small pill, and "or" between shortcuts that do the same. */
  function keyPills(keys: string) {
    const hint = document.createElement("span");
    hint.className = "tooltip-keys";
    shortcutText(keys)
      .split(" or ")
      .forEach((combo, at) => {
        if (at > 0) hint.append(" or ");
        for (const key of combo.split(/\+(?=.)/)) {
          const pill = document.createElement("kbd");
          pill.className = "tooltip-key";
          pill.textContent = key;
          hint.append(pill);
        }
      });
    return hint;
  }

  function place() {
    if (!current) return;
    // Already open, it glides over to the next control instead of jumping.
    box.classList.toggle("tooltip-glide", isOpen());
    box.textContent = current.getAttribute("data-tip") || current.getAttribute("aria-label");
    const keys = current.getAttribute("aria-keyshortcuts");
    if (keys) box.append(keyPills(keys));
    box.togglePopover(true);
    const whole = current.getBoundingClientRect();
    // A tall edge is met at the pointer, not at its far ends.
    const anchor = current.matches("[role=separator]") ? new DOMRect(whole.left, pointerY - 10, whole.width, 20) : whole;
    const { width, height } = box.getBoundingClientRect();
    const left = anchor.left + (anchor.width - width) / 2;
    const below = anchor.bottom + ANCHOR_GAP;
    const fitsBelow = below + height + EDGE_GAP <= innerHeight;
    box.style.left = `${Math.max(EDGE_GAP, Math.min(left, innerWidth - width - EDGE_GAP))}px`;
    box.style.top = `${fitsBelow ? below : anchor.top - ANCHOR_GAP - height}px`;
  }

  function onPointerOver(event: PointerEvent) {
    pointerY = event.clientY;
    const next = (event.target as Element).closest(LABELLED) ?? undefined;
    if (next === current) return;
    if (!next) return hide();
    clearTimeout(timer);
    current = next;
    if (isOpen()) place();
    else timer = setTimeout(place, performance.now() < warmUntil ? WARM_DELAY_MS : OPEN_DELAY_MS);
  }

  // A click can change the label, as the grouping icon does, or remove the control.
  function onClick() {
    if (!current?.isConnected) hide();
    else if (isOpen()) place();
    else clearTimeout(timer);
  }

  onMount(() => {
    const listeners = new AbortController();
    const { signal } = listeners;
    window.addEventListener("pointerover", onPointerOver, { signal });
    window.addEventListener("click", onClick, { signal });
    window.addEventListener("blur", hide, { signal });
    document.documentElement.addEventListener("pointerleave", hide, { signal });
    onCleanup(() => {
      clearTimeout(timer);
      listeners.abort();
    });
  });

  return <div ref={box} class="tooltip" popover="manual" aria-hidden="true" />;
}
