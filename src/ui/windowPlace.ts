/**
 * Where the window was, in physical pixels, and whether it filled its screen. `x` and `y` are its
 * outer corner and the size is its inside, which is what `setPosition` and `setSize` take.
 */
export interface WindowPlace {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
}

/** A screen, as Tauri's `availableMonitors` gives it. */
export interface Screen {
  name: string | null;
  position: { x: number; y: number };
  size: { width: number; height: number };
}

/** How much of the window's top edge must be on a screen for it to be grabbed there. */
const GRAB = 48;
/** Windows puts a window's frame a few pixels past the screen's edge. */
const FRAME = 16;

/** The same screens give the same key, whatever order Windows lists them in. */
export const screensKey = (screens: Screen[]) =>
  screens
    .map(({ name, position, size }) => `${name ?? "screen"} ${size.width}x${size.height} at ${position.x},${position.y}`)
    .sort()
    .join(" | ");

/** True when enough of the window's top edge is on one of `screens` to grab it there. */
export const onAScreen = (place: WindowPlace, screens: Screen[]) =>
  screens.some(({ position, size }) => {
    const across = Math.min(place.x + place.width, position.x + size.width) - Math.max(place.x, position.x);
    return across >= GRAB && place.y >= position.y - FRAME && place.y <= position.y + size.height - GRAB;
  });
