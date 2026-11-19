import type { MapCell, Tag, TaggedFile } from "../../api";
import { formatSize } from "../../ui/format";
import { hueOf, kindOf, type Kind } from "../filelist/fileKinds";
import { paint, sendComet, step, whereIs, type Aim, type LinkAim, type Palette, type Rgb, type RowAim, type Scene } from "./draw";
import { packed } from "./pack";
import type { Pulse } from "./pulses";
import { ageGlow, allNodes, brainLayout, layersLayout, nearestShown, route, tagsLayout, type SpaceNode } from "./space";

/** What each lens wants drawn, built from the tree and the palette. */

export type Lens = "brain" | "cells" | "layers" | "tags";
export const LENSES: { id: Lens; name: string }[] = [
  { id: "brain", name: "Brain" },
  { id: "cells", name: "Cells" },
  { id: "layers", name: "Layers" },
  { id: "tags", name: "Tags" },
];

/** The kind a cell shows: a file by its name, a folder by what fills it most. */
export function kindOfCell(cell: MapCell): string {
  if (!cell.folder) return kindOf(cell.name, false);
  const top = cell.exts[0]?.[0];
  return top === undefined ? "folder" : top ? kindOf(`x.${top}`, false) : "file";
}

const probe = document.createElement("canvas");
probe.width = probe.height = 1;
const probing = probe.getContext("2d", { willReadFrequently: true })!;
const colors = new Map<string, Rgb>();

/** Any CSS color, `var()` and `light-dark()` too, as red, green and blue. */
export function cssRgb(css: string): Rgb {
  const known = colors.get(css);
  if (known) return known;
  const span = document.createElement("span");
  span.style.cssText = `position:absolute;visibility:hidden;color:${css}`;
  document.body.append(span);
  const resolved = getComputedStyle(span).color;
  span.remove();
  probing.clearRect(0, 0, 1, 1);
  probing.fillStyle = "#808080";
  probing.fillStyle = resolved;
  probing.fillRect(0, 0, 1, 1);
  const [red, green, blue] = probing.getImageData(0, 0, 1, 1).data;
  const rgb: Rgb = [red, green, blue];
  // Theme colors change with the theme, so only fixed ones are kept.
  if (!css.includes("var(")) colors.set(css, rgb);
  return rgb;
}

export function readPalette(): Palette {
  const text = cssRgb("var(--text)");
  return {
    text,
    muted: cssRgb("var(--text-muted)"),
    accent: [cssRgb("var(--accent-start)"), cssRgb("var(--accent)"), cssRgb("var(--accent-end)")],
    surface: cssRgb("var(--surface)"),
    dark: text[0] * 0.3 + text[1] * 0.59 + text[2] * 0.11 > 128,
    font: getComputedStyle(document.documentElement).getPropertyValue("--font").trim() || "Segoe UI, sans-serif",
  };
}

const darkScheme = matchMedia("(prefers-color-scheme: dark)");
export const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

/** Hears when the theme or the accent changes. Answers how to stop. */
export function watchPalette(hear: (palette: Palette) => void) {
  const changed = () => hear(readPalette());
  const theme = new MutationObserver(changed);
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-accent", "style"] });
  darkScheme.addEventListener("change", changed);
  return () => {
    theme.disconnect();
    darkScheme.removeEventListener("change", changed);
  };
}

/**
 * Draws `scene` on `canvas` while anything in it moves, and rests when nothing does. `fps` caps
 * the frames for a small view that should cost little.
 */
export function sceneLoop(canvas: HTMLCanvasElement, scene: Scene, palette: () => Palette, fps?: number) {
  const context = canvas.getContext("2d");
  const gap = fps ? 1000 / fps - 2 : 0;
  let frame = 0;
  let last = 0;
  let width = 0;
  let height = 0;
  const tick = (time: number) => {
    if (time - last < gap) {
      frame = requestAnimationFrame(tick);
      return;
    }
    const seconds = Math.min(0.05, Math.max(0, (time - last) / 1000));
    last = time;
    const moving = step(scene, seconds, reducedMotion.matches);
    if (context) paint(context, scene, palette(), width, height);
    frame = moving ? requestAnimationFrame(tick) : 0;
  };
  const kick = () => {
    if (frame || !context || !width) return;
    last = performance.now() - 16;
    frame = requestAnimationFrame(tick);
  };
  return {
    kick,
    /** Sizes the canvas in CSS pixels, sharp at the screen's own density. */
    resize(nextWidth: number, nextHeight: number) {
      [width, height] = [nextWidth, nextHeight];
      const ratio = devicePixelRatio || 1;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context?.setTransform(ratio, 0, 0, ratio, 0, 0);
      kick();
    },
    stop() {
      cancelAnimationFrame(frame);
      frame = 0;
    },
  };
}

/** Sends a pulse's light through what Brain shows: along the links from where it came to where it went. */
export function pulseIn(scene: Scene, pulse: Pulse, rootId: string, brain: boolean, width: number) {
  const shown = new Set([...scene.things.values()].filter((thing) => thing.alpha > 0).map((thing) => thing.id));
  const to = pulse.to ? nearestShown(pulse.to, shown, rootId) : undefined;
  const from = pulse.from.map((folder) => nearestShown(folder, shown, rootId)).find((id) => id !== undefined);
  const parentOf = (id: string) => scene.things.get(id)?.from;
  if (!brain) {
    const where = to ?? from;
    if (where) sendComet(scene, [where]);
  } else if (pulse.away && from) {
    sendComet(scene, route(from, rootId, parentOf), true);
  } else if (to && from) {
    sendComet(scene, to === from ? [to] : route(from, to, parentOf));
  } else if (to) {
    sendComet(scene, [to], false, skyOver(scene, to, width));
  }
}

/** Above the stage over `id`, where things that come from outside fall in from. */
export function skyOver(scene: Scene, id: string, width: number) {
  const thing = scene.things.get(id);
  return { x: thing ? whereIs(scene, thing).x : width / 2, y: -12 };
}

/** A kind's color, as its icon wears it. Folders that hold nothing to tell by take the accent. */
export function kindRgb(kind: string, palette: Palette): Rgb {
  if (kind === "folder") return palette.accent[1];
  const hue = hueOf(kind as Kind);
  if (hue === undefined) return palette.muted;
  return cssRgb(palette.dark ? `oklch(0.82 0.11 ${hue})` : `oklch(0.52 0.15 ${hue})`);
}

export interface Drawn {
  aims: Aim[];
  links: LinkAim[];
  rows: RowAim[];
  /** Things a lens couldn't fit, said under the stage. */
  left: number;
}

export function brainAims(tree: SpaceNode, width: number, height: number, palette: Palette, use: Map<string, number>, now: number): Drawn {
  const { spots, links } = brainLayout(tree, width, height);
  const middle = spots.get(tree.id)!;
  const aims = allNodes(tree).map((node): Aim => {
    const spot = spots.get(node.id)!;
    const first = node.depth === 0;
    return {
      id: node.id,
      shape: "node",
      x: spot.x,
      y: spot.y,
      w: spot.r * 2,
      h: spot.r * 2,
      round: spot.r,
      color: node.folded ? palette.muted : kindRgb(node.kind, palette),
      glow: first || node.place ? 1 : ageGlow(node.newest, now),
      place: first || node.place,
      label: node.name,
      sub: node.bytes > 0 || node.depth > 0 ? formatSize(node.bytes) : undefined,
      side: first ? "below" : spot.x >= middle.x ? "right" : "left",
      quiet: node.depth >= 2,
      dust: node.depth === 2 && node.folder,
      from: node.parent?.id,
      node,
    };
  });
  return { aims, links: links.map(([a, b]) => ({ a, b, weight: use.get(b) ?? 0 })), rows: [], left: 0 };
}

/** The circles that fit before they get too small to see. */
export const MOST_CELLS = 70;

export function cellsAims(tree: SpaceNode, width: number, height: number, palette: Palette, now: number): Drawn {
  const nodes = tree.kids.filter((node) => !node.folded);
  const { spots, radii } = packed(
    nodes.map((node) => node.bytes),
    width,
    height,
  );
  const aims = nodes.map((node, at): Aim => {
    const r = radii[at];
    const named = r >= 30;
    return {
      id: node.id,
      shape: "node",
      x: spots[at].x,
      y: spots[at].y,
      w: r * 2,
      h: r * 2,
      round: r,
      color: kindRgb(node.kind, palette),
      glow: ageGlow(node.newest, now),
      label: node.name,
      sub: named ? formatSize(node.bytes) : undefined,
      side: "inside",
      quiet: !named,
      node,
    };
  });
  return { aims, links: [], rows: [], left: tree.kids.find((node) => node.folded)?.folded ?? 0 };
}

export function layersAims(tree: SpaceNode, width: number, height: number, palette: Palette): Drawn {
  const parts = tree.kids.filter((node) => !node.folded);
  const byId = new Map(parts.map((node) => [node.id, node]));
  const { bricks, rows } = layersLayout(parts, width, height);
  const aims = bricks.map((brick): Aim => {
    const owner = byId.get(brick.owner);
    return {
      id: brick.id,
      shape: "brick",
      x: brick.x + brick.w / 2,
      y: brick.y + brick.h / 2,
      w: brick.w,
      h: brick.h,
      round: Math.min(4, brick.h / 2),
      color: owner ? kindRgb(owner.kind, palette) : palette.muted,
      glow: 1,
      label: owner?.name ?? "Everything else",
      quiet: true,
      side: "inside",
      node: owner,
      about: { year: brick.year, bytes: brick.bytes },
    };
  });
  return {
    aims,
    links: [],
    rows: rows.map((row) => ({ key: String(row.year), left: String(row.year), right: formatSize(row.bytes), y: row.y + row.h / 2 })),
    left: 0,
  };
}

export function tagsAims(tags: Tag[], files: TaggedFile[], width: number, height: number, palette: Palette): Drawn {
  const { stars, specks, left } = tagsLayout(tags, files, width, height);
  const named = new Map(tags.map((tag) => [tag.id, tag]));
  const aims: Aim[] = stars.map((star) => {
    const tag = named.get(star.tag)!;
    return {
      id: star.id,
      shape: "star",
      x: star.x,
      y: star.y,
      w: star.r * 2,
      h: star.r * 2,
      round: star.r,
      color: cssRgb(`var(--tag-${tag.color})`),
      glow: 1,
      label: tag.name,
      sub: `${star.count.toLocaleString()} ${star.count === 1 ? "file" : "files"}`,
      side: star.x >= width / 2 ? "right" : "left",
      about: { tag: star.tag },
    };
  });
  for (const speck of specks) {
    const name = speck.path.slice(speck.path.lastIndexOf("\\") + 1);
    aims.push({
      id: speck.id,
      shape: "speck",
      x: speck.x,
      y: speck.y,
      w: 5,
      h: 5,
      round: 2.5,
      color: kindRgb(kindOf(name, false), palette),
      glow: 1,
      label: name,
      quiet: true,
      side: "below",
      about: { path: speck.path },
    });
  }
  return { aims, links: [], rows: [], left };
}
