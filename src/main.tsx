import { render } from "solid-js/web";
import { availableMonitors, getCurrentWindow, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/window";
import { App } from "./App";
import { startState } from "./api";
import { saved, stored } from "./features/filelist/prefs";
import { parseMoved } from "./features/tabs/session";
import { onAScreen, screensKey, type WindowPlace } from "./ui/windowPlace";
import "./styles/tokens.css";
import "./styles/base.css";

/** Waits for the window to stop moving before its place is written down. */
const SETTLE_MS = 400;
const [places, setPlaces] = stored<Record<string, WindowPlace>>(
  "window-places",
  (saved("window-places") as Record<string, WindowPlace> | null) ?? {},
);

/**
 * The window opens where it was last left on the same screens, maximized if it was, and stays
 * hidden until then so it never jumps. A window started by "Move to new window" opens where
 * Windows puts it and leaves the place alone.
 */
async function keepPlace() {
  const appWindow = getCurrentWindow();
  /** The size is the inside, as `setSize` takes it, or the frame would be added again at each start. */
  const bounds = async () => ({ ...(await appWindow.outerPosition()), ...(await appWindow.innerSize()) });
  /** Where the window goes back to from maximized. */
  let normal: { x: number; y: number; width: number; height: number } | undefined;
  try {
    const start = await startState();
    if (start.newWindow) return void (await showMoved(parseMoved(start.moved)?.place));
    const screens = await availableMonitors();
    const place = places()[screensKey(screens)];
    if (place && onAScreen(place, screens)) {
      await appWindow.setSize(new PhysicalSize(place.width, place.height));
      await appWindow.setPosition(new PhysicalPosition(place.x, place.y));
      normal = { x: place.x, y: place.y, width: place.width, height: place.height };
      if (place.maximized) await appWindow.maximize();
    }
  } catch (failure) {
    console.error(failure);
  }
  await appWindow.show();
  // A first start has no place yet: the one Windows gave is the one to go back to.
  if (!normal && !(await appWindow.isMaximized())) normal = await bounds();

  let timer = 0;
  const note = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(async () => {
      if (await appWindow.isMinimized()) return;
      const key = screensKey(await availableMonitors());
      const maximized = await appWindow.isMaximized();
      if (!maximized) normal = await bounds();
      // A maximized window keeps the place it goes back to, never its maximized size.
      const box = normal ?? places()[key];
      if (!box) return;
      const { x, y, width, height } = box;
      setPlaces({ ...places(), [key]: { x, y, width, height, maximized } });
    }, SETTLE_MS);
  };
  await appWindow.onMoved(note);
  await appWindow.onResized(note);
}

/** A window that takes a dragged tab opens where it was let go, and springs in. */
async function showMoved(place?: { x: number; y: number; width: number; height: number; maximized?: boolean }) {
  const appWindow = getCurrentWindow();
  if (place) {
    await appWindow.setSize(new PhysicalSize(place.width, place.height));
    await appWindow.setPosition(new PhysicalPosition(place.x, place.y));
    if (place.maximized) await appWindow.maximize();
  }
  await appWindow.show();
  if (place && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    document.getElementById("root")?.animate(
      { scale: [0.94, 1], opacity: [0, 1] },
      { duration: 360, easing: "cubic-bezier(0.3, 1.25, 0.5, 1)" },
    );
  }
}

void keepPlace();
render(() => <App />, document.getElementById("root")!);
