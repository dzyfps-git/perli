import { cursorPosition, getCurrentWindow, monitorFromPoint } from "@tauri-apps/api/window";
import { ghostHide, ghostMove, ghostShow, jobsRunning, perliWindowAt, sendTab } from "../../api";
import type { Place } from "./session";
import { placeFor } from "./tabList";
import { leaveWindow, type Tab, type Tabs } from "./tabs";

/** How far the pointer goes before a press on a tab becomes a drag. */
const LIFT_PX = 5;
/** How far past the strip the pointer goes before the tab comes out of it. */
const TEAR_PX = 24;
/** The tab's picture while it is out, at 96 DPI, with room around it for its shadow. */
const CARD = { width: 232, height: 56, margin: 12, radius: 10 };
const ICON_FOLDER = "";
const SLIDE = { duration: 200, easing: "cubic-bezier(0.3, 1.1, 0.5, 1)" };
const SETTLE = { duration: 320, easing: "cubic-bezier(0.3, 1.25, 0.5, 1)" };
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

/** A colour token as the canvas can take it. */
function token(name: string) {
  const probe = document.createElement("span");
  probe.style.color = `var(${name})`;
  document.body.append(probe);
  const colour = getComputedStyle(probe).color;
  probe.remove();
  return colour;
}

/** `text` cut to `width`, with an ellipsis where it was cut. */
function fitted(context: CanvasRenderingContext2D, text: string, width: number) {
  if (context.measureText(text).width <= width) return text;
  let kept = text;
  while (kept.length > 1 && context.measureText(`${kept}…`).width > width) kept = kept.slice(0, -1);
  return `${kept}…`;
}

/** The card that follows the pointer: the folder's glyph, its name and how many items it holds. */
function picture(title: string, items: number | undefined) {
  const scale = devicePixelRatio;
  const { width, height, margin, radius } = CARD;
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil((width + margin * 2) * scale);
  canvas.height = Math.ceil((height + margin * 2) * scale);
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  context.scale(scale, scale);

  context.beginPath();
  context.roundRect(margin, margin, width, height, radius);
  context.shadowColor = "rgb(0 0 0 / 0.4)";
  context.shadowBlur = 12;
  context.shadowOffsetY = 3;
  context.fillStyle = token("--surface");
  context.fill();
  context.shadowColor = "transparent";
  context.strokeStyle = token("--border");
  context.lineWidth = 1;
  context.stroke();

  context.textBaseline = "middle";
  context.fillStyle = token("--accent");
  context.font = '20px "Segoe Fluent Icons", "Segoe MDL2 Assets"';
  context.fillText(ICON_FOLDER, margin + 14, margin + height / 2);
  const textLeft = margin + 46;
  context.fillStyle = token("--text");
  context.font = '600 13px "Segoe UI Variable Text", "Segoe UI", sans-serif';
  context.fillText(fitted(context, title, width - 58), textLeft, margin + 20);
  context.fillStyle = token("--text-muted");
  context.font = '12px "Segoe UI Variable Text", "Segoe UI", sans-serif';
  const count = items === undefined ? "Folder" : `${items.toLocaleString()} ${items === 1 ? "item" : "items"}`;
  context.fillText(count, textLeft, margin + 38);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

/** Where a new window for the tab goes, so the tab lands under the pointer. */
async function placeHere(strip: HTMLElement, element: HTMLElement, grab: { x: number; y: number }): Promise<Place | undefined> {
  const at = await cursorPosition();
  const screen = await monitorFromPoint(at.x, at.y);
  if (!screen) return undefined;
  const size = await getCurrentWindow().innerSize();
  // The tab comes first in its new window's strip.
  const first = strip.getBoundingClientRect().left + parseFloat(getComputedStyle(strip).paddingLeft);
  const held = { x: (first + grab.x) * devicePixelRatio, y: (element.getBoundingClientRect().top + grab.y) * devicePixelRatio };
  const { position, size: area } = screen.workArea;
  const work = { x: position.x, y: position.y, width: area.width, height: area.height };
  return placeFor(at, work, { width: size.width, height: size.height }, held, screen.scaleFactor);
}

/**
 * A press on a tab that moves becomes a drag. Along the strip the tab moves among the others,
 * which slide out of its way. Pulled out of the strip, it becomes a card that follows the pointer
 * over every window. Let go on another Perli window's tabs, it moves there; elsewhere it opens a
 * window of its own; back on this window, it stays.
 */
export function dragTab(down: PointerEvent, tab: Tab, tabs: Tabs, strip: HTMLElement, title: string, lifted: () => void) {
  if (down.button !== 0 || (down.target as Element).closest("button")) return;
  const element = down.currentTarget as HTMLElement;
  const box = element.getBoundingClientRect();
  const grab = { x: down.clientX - box.left, y: down.clientY - box.top };
  let mode: "press" | "reorder" | "tear" = "press";
  let frame = 0;

  /** The pointer's place along the strip's own row, scrolled part included. */
  const along = (event: PointerEvent) => event.clientX - strip.getBoundingClientRect().left + strip.scrollLeft;
  const tabElements = () => [...strip.querySelectorAll<HTMLElement>(".tab:not(.tab-settings)")];
  const middle = (other: HTMLElement) => other.offsetLeft + other.offsetWidth / 2;

  function follow(event: PointerEvent) {
    element.style.translate = `${along(event) - grab.x - element.offsetLeft}px 0`;
  }

  /** Steps the tab past a neighbour whose middle it crossed, and slides the others to their places. */
  function reorder(event: PointerEvent) {
    const list = tabElements();
    const at = list.indexOf(element);
    const centre = along(event) - grab.x + element.offsetWidth / 2;
    const offset = list[at + 1] && centre > middle(list[at + 1]) ? 1 : list[at - 1] && centre < middle(list[at - 1]) ? -1 : 0;
    if (offset !== 0) {
      const before = new Map(list.map((other) => [other, other.offsetLeft]));
      tabs.move(tab, offset);
      // Moving the tab's element in the page lets go of the pointer, so it is taken again.
      element.setPointerCapture(down.pointerId);
      for (const other of tabElements()) {
        const shift = (before.get(other) ?? other.offsetLeft) - other.offsetLeft;
        if (other !== element && shift !== 0 && !reducedMotion.matches) {
          other.animate({ translate: [`${shift}px 0`, "0 0"] }, SLIDE);
        }
      }
    }
    follow(event);
  }

  const outside = (event: PointerEvent) => {
    const bar = strip.getBoundingClientRect();
    return event.clientY < bar.top - TEAR_PX || event.clientY > bar.bottom + TEAR_PX || event.clientX < 0 || event.clientX > innerWidth;
  };

  function tear() {
    mode = "tear";
    element.style.translate = "";
    element.dataset.torn = "";
    const card = picture(title, tab.active().folder()?.items);
    ghostShow(card.width, card.height, card.data).catch(console.error);
  }

  function untear() {
    mode = "reorder";
    delete element.dataset.torn;
    ghostHide().catch(console.error);
  }

  function onMove(event: PointerEvent) {
    if (event.pointerId !== down.pointerId) return;
    if (mode === "press") {
      if (Math.hypot(event.clientX - down.clientX, event.clientY - down.clientY) < LIFT_PX) return;
      mode = "reorder";
      element.setPointerCapture(down.pointerId);
      element.dataset.lifted = "";
      lifted();
    }
    if (mode === "reorder" && outside(event)) tear();
    else if (mode === "tear" && !outside(event)) untear();
    if (mode === "reorder") reorder(event);
    else if (!frame) {
      frame = requestAnimationFrame(() => {
        frame = 0;
        ghostMove().catch(console.error);
      });
    }
  }

  /** The tab goes back to its place in the strip. */
  function settle() {
    const from = element.style.translate || "0 0";
    element.style.translate = "";
    delete element.dataset.torn;
    delete element.dataset.lifted;
    if (!reducedMotion.matches) element.animate({ translate: [from, "0 0"] }, SETTLE);
  }

  function stop() {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("keydown", onKey, true);
    cancelAnimationFrame(frame);
    frame = 0;
    if (element.hasPointerCapture(down.pointerId)) element.releasePointerCapture(down.pointerId);
  }

  function onCancel() {
    stop();
    if (mode === "tear") ghostHide().catch(console.error);
    if (mode !== "press") settle();
  }

  function onKey(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onCancel();
  }

  /** The tab now lives in another window: it goes from here, and so does a window it leaves empty. */
  async function gone() {
    if (tabs.tabs().length > 1) return tabs.close(tab, true, true);
    // A window whose jobs still run stays, with the folder in both windows until they finish.
    if (await jobsRunning()) return settle();
    await leaveWindow();
  }

  async function letGo(event: PointerEvent) {
    await ghostHide();
    const target = await perliWindowAt();
    if (target?.tabBar) {
      const moved = await sendTab(target.window, JSON.stringify({ tab: tabs.handover(tab) }));
      return moved ? gone() : settle();
    }
    const here = event.clientX >= 0 && event.clientY >= 0 && event.clientX <= innerWidth && event.clientY <= innerHeight;
    if (here || tabs.tabs().length === 1) return settle();
    await tabs.toWindow(tab, await placeHere(strip, element, grab));
  }

  function onUp(event: PointerEvent) {
    if (event.pointerId !== down.pointerId) return;
    stop();
    if (mode === "reorder") return settle();
    if (mode === "tear") {
      letGo(event).catch((failure) => {
        console.error(failure);
        settle();
      });
    }
  }

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  window.addEventListener("keydown", onKey, true);
}
