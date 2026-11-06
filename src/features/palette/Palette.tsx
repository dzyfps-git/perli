import { createSignal, onCleanup, onMount } from "solid-js";
import "./palette.css";

// Only the glass panel for now, so the speed test can measure blur. Commands arrive in Phase 3.
export function Palette() {
  const [open, setOpen] = createSignal(false);

  function onKeyDown(event: KeyboardEvent) {
    if (event.ctrlKey && event.key.toLowerCase() === "p") {
      event.preventDefault();
      setOpen(!open());
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  }

  onMount(() => window.addEventListener("keydown", onKeyDown));
  onCleanup(() => window.removeEventListener("keydown", onKeyDown));

  return (
    <div class="palette" classList={{ "palette-open": open() }} role="dialog" aria-label="Command palette">
      Command palette
    </div>
  );
}
