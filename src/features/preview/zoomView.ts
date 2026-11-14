/** What part of a zoomed picture shows, each side from 0 to 1 across the whole picture. */
export interface ViewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

/** The part of a picture drawn `content` big that a `stage` shows, moved by `pan` from the middle. */
export function viewWindow(stage: Size, content: Size, pan: { x: number; y: number }): ViewRect {
  const side = (stageSide: number, contentSide: number, moved: number) => {
    const start = clamp((contentSide - stageSide) / 2 / contentSide - moved / contentSide, 0, 1);
    const end = clamp(start + stageSide / contentSide, 0, 1);
    return [start, end - start] as const;
  };
  const [x, width] = side(stage.width, content.width, pan.x);
  const [y, height] = side(stage.height, content.height, pan.y);
  return { x, y, width, height };
}

/** How far to move a picture drawn `content` big so the point `center` (0 to 1) sits in the middle. */
export const panFor = (center: { x: number; y: number }, content: Size) => ({
  x: content.width * (0.5 - center.x),
  y: content.height * (0.5 - center.y),
});

/** A box on screen, as `getBoundingClientRect` gives it. */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The part of `content` that `viewport` shows, both boxes on screen. */
export function seenPart(viewport: Box, content: Box): ViewRect {
  const side = (from: number, length: number, start: number, size: number) => {
    const first = clamp((from - start) / size, 0, 1);
    return [first, clamp((from + length - start) / size, 0, 1) - first] as const;
  };
  const [x, width] = side(viewport.left, viewport.width, content.left, content.width);
  const [y, height] = side(viewport.top, viewport.height, content.top, content.height);
  return { x, y, width, height };
}

/**
 * How far to move the point a page scales `zoom` times about, so that what sits at `at` on
 * screen comes to `to`. Moving that point by one moves everything by `1 - zoom`.
 */
export const originShift = (at: number, to: number, zoom: number) => (at - to) / (zoom - 1);

/** A pan kept within reach: the picture's edges never come in past the stage's. */
export function clampPan(pan: { x: number; y: number }, stage: Size, content: Size) {
  const most = (contentSide: number, stageSide: number) => Math.max(0, (contentSide - stageSide) / 2);
  const x = most(content.width, stage.width);
  const y = most(content.height, stage.height);
  // Adding 0 turns a -0 into 0.
  return { x: clamp(pan.x, -x, x) + 0, y: clamp(pan.y, -y, y) + 0 };
}
