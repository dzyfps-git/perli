/**
 * Dialogs open as sheets that grow out of where the user asked for them, and go back there when
 * they close: the button pressed, the menu item picked, or the row a key was pressed on.
 */

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const GROW_MS = 420;
const RETURN_MS = 170;
const SMALL = 0.35;

let asked: { x: number; y: number } | undefined;

function middleOf(element: Element | null) {
  if (!element || element === document.body) return undefined;
  const { left, top, width, height } = element.getBoundingClientRect();
  return width || height ? { x: left + width / 2, y: top + height / 2 } : undefined;
}

window.addEventListener("pointerdown", (event) => (asked = { x: event.clientX, y: event.clientY }), true);
window.addEventListener(
  "keydown",
  () => {
    const focused = document.activeElement;
    // The file list holds the focus for all of its rows.
    asked = middleOf(focused?.querySelector(".file-row[data-focused]") ?? focused) ?? asked;
  },
  true,
);

/**
 * Shows a dialog as a sheet. Answers with what closes it: the sheet goes back to where it came
 * from, and `after` runs once it is gone. Escape closes it the same way.
 */
export function openSheet(dialog: HTMLDialogElement) {
  dialog.showModal();
  const box = dialog.getBoundingClientRect();
  const from = asked ?? { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  dialog.style.transformOrigin = `${from.x - box.left}px ${from.y - box.top}px`;
  const spring = getComputedStyle(document.documentElement).getPropertyValue("--spring").trim() || "ease-out";
  if (!reducedMotion.matches) {
    dialog.animate({ scale: [SMALL, 1], opacity: [0, 1] }, { duration: GROW_MS, easing: spring });
  }

  let closing = false;
  function close(after?: () => void) {
    if (closing || !dialog.open) return;
    closing = true;
    const finish = () => {
      dialog.close();
      after?.();
    };
    if (reducedMotion.matches) return finish();
    dialog
      .animate({ scale: [1, SMALL], opacity: [1, 0] }, { duration: RETURN_MS, easing: "ease-in", fill: "forwards" })
      .finished.then(finish, finish);
  }

  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  return close;
}
