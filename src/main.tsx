import { render } from "solid-js/web";
import { availableMonitors, getCurrentWindow, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/window";
import { App } from "./App";
import { startState } from "./api";
import { saved, stored } from "./features/filelist/prefs";
import { parseMoved, windowExtras } from "./features/tabs/session";
import { backOnScreen, onAScreen, screensKey, setOwnPlace, type WindowPlace } from "./ui/windowPlace";
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
 * hidden until then so it never jumps. The first window keeps a place for each set of screens.
 * One more window keeps its own in its session, so it comes back there; one that takes a dragged
 * tab opens where the tab was let go, and springs in.
 */
async function keepPlace() {
  const appWindow = getCurrentWindow();
  /** The size is the inside, as `setSize` takes it, or the frame would be added again at each start. */
  const bounds = async () => ({ ...(await appWindow.outerPosition()), ...(await appWindow.innerSize()) });
  /** Where the window goes back to from maximized. */
  let normal: { x: number; y: number; width: number; height: number } | undefined;
  let own = false;
  let springs = false;
  try {
    const start = await startState();
    own = start.newWindow;
    const screens = await availableMonitors();
    const moved = parseMoved(start.moved)?.place;
    const kept = own ? windowExtras(start.session).place : places()[screensKey(screens)];
    const place = moved ?? (kept && onAScreen(kept, screens) ? kept : undefined);
    if (place) {
      await appWindow.setSize(new PhysicalSize(place.width, place.height));
      await appWindow.setPosition(new PhysicalPosition(place.x, place.y));
      normal = { x: place.x, y: place.y, width: place.width, height: place.height };
      if (place.maximized) await appWindow.maximize();
    }
    springs = moved !== undefined;
  } catch (failure) {
    console.error(failure);
  }
  await appWindow.show();
  if (springs && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    document.getElementById("root")?.animate(
      { scale: [0.94, 1], opacity: [0, 1] },
      { duration: 360, easing: "cubic-bezier(0.3, 1.25, 0.5, 1)" },
    );
  }
  // A first start has no place yet: the one Windows gave is the one to go back to.
  if (!normal && !(await appWindow.isMaximized())) normal = await bounds();

  // The screens can change while it runs, as when one is unplugged or a scale changes. A window
  // they leave where it can't be grabbed comes back, checked once it settles and when it's used.
  const rescue = async () => {
    if ((await appWindow.isMinimized()) || (await appWindow.isMaximized())) return;
    const screens = await availableMonitors();
    const back = backOnScreen(await bounds(), screens, own ? undefined : places()[screensKey(screens)]);
    if (back === "middle") await appWindow.center();
    else if (back) await appWindow.setPosition(new PhysicalPosition(back.x, back.y));
    return back !== undefined;
  };
  await appWindow.onFocusChanged(({ payload }) => void (payload && rescue().catch(console.error)));
  await appWindow.onScaleChanged(() => void rescue().catch(console.error));

  let timer = 0;
  const note = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(async () => {
      if (await appWindow.isMinimized()) return;
      // A move it is brought back by notes its place again.
      if (await rescue().catch(() => false)) return;
      const maximized = await appWindow.isMaximized();
      if (!maximized) normal = await bounds();
      // A maximized window keeps the place it goes back to, never its maximized size.
      if (own) {
        if (normal) setOwnPlace({ ...normal, maximized });
        return;
      }
      const key = screensKey(await availableMonitors());
      const box = normal ?? places()[key];
      if (!box) return;
      const { x, y, width, height } = box;
      setPlaces({ ...places(), [key]: { x, y, width, height, maximized } });
    }, SETTLE_MS);
  };
  await appWindow.onMoved(note);
  await appWindow.onResized(note);
  // One more window writes its place down from the start, to come back where it opened.
  if (own) note();
}

void keepPlace();
render(() => <App />, document.getElementById("root")!);
