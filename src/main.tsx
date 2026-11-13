import { render } from "solid-js/web";
import { availableMonitors, getCurrentWindow, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/window";
import { App } from "./App";
import { startState } from "./api";
import { saved, stored } from "./features/filelist/prefs";
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
  try {
    if ((await startState()).newWindow) return void (await appWindow.show());
    const screens = await availableMonitors();
    const place = places()[screensKey(screens)];
    if (place && onAScreen(place, screens)) {
      await appWindow.setSize(new PhysicalSize(place.width, place.height));
      await appWindow.setPosition(new PhysicalPosition(place.x, place.y));
      if (place.maximized) await appWindow.maximize();
    }
  } catch (failure) {
    console.error(failure);
  }
  await appWindow.show();

  let timer = 0;
  const note = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(async () => {
      if (await appWindow.isMinimized()) return;
      const key = screensKey(await availableMonitors());
      const maximized = await appWindow.isMaximized();
      const before = places()[key];
      // A maximized window keeps the place it goes back to. The size is the inside, as `setSize`
      // takes it, or the frame would be added again at each start.
      const box = maximized && before ? before : { ...(await appWindow.outerPosition()), ...(await appWindow.innerSize()) };
      const { x, y, width, height } = box;
      setPlaces({ ...places(), [key]: { x, y, width, height, maximized } });
    }, SETTLE_MS);
  };
  await appWindow.onMoved(note);
  await appWindow.onResized(note);
}

void keepPlace();
render(() => <App />, document.getElementById("root")!);
