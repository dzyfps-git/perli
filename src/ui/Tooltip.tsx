import { onCleanup, onMount } from "solid-js";
import { shortcutText } from "./shortcut";
import "./tooltip.css";

const LABELLED = "button[aria-label], input[type=range][aria-label]";
const OPEN_DELAY_MS = 450;
const ANCHOR_GAP = 6;
const EDGE_GAP = 4;

/**
 * Perli's hover text for icon-only controls, read from each control's aria-label, with the
 * control's shortcut from aria-keyshortcuts.
 * It is a popover so it can sit above the modal settings dialog.
 */
export function Tooltip() {
  let box!: HTMLDivElement;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: Element | undefined;

  const isOpen = () => box.matches(":popover-open");

  function hide() {
    clearTimeout(timer);
    current = undefined;
    box.togglePopover(false);
  }

  function place() {
    if (!current) return;
    box.textContent = current.getAttribute("aria-label");
    const keys = current.getAttribute("aria-keyshortcuts");
    if (keys) {
      const hint = document.createElement("span");
      hint.className = "tooltip-keys";
      hint.textContent = shortcutText(keys);
      box.append(hint);
    }
    box.togglePopover(true);
    const anchor = current.getBoundingClientRect();
    const { width, height } = box.getBoundingClientRect();
    const left = anchor.left + (anchor.width - width) / 2;
    const below = anchor.bottom + ANCHOR_GAP;
    const fitsBelow = below + height + EDGE_GAP <= innerHeight;
    box.style.left = `${Math.max(EDGE_GAP, Math.min(left, innerWidth - width - EDGE_GAP))}px`;
    box.style.top = `${fitsBelow ? below : anchor.top - ANCHOR_GAP - height}px`;
  }

  function onPointerOver(event: PointerEvent) {
    const next = (event.target as Element).closest(LABELLED) ?? undefined;
    if (next === current) return;
    if (!next) return hide();
    clearTimeout(timer);
    current = next;
    if (isOpen()) place();
    else timer = setTimeout(place, OPEN_DELAY_MS);
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
