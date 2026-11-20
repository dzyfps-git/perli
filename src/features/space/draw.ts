import { ease, hashOf, onShape, type SpaceNode } from "./space";

/** Draws Space on a canvas: things that ease from where they were to where a lens wants them. */

export type Rgb = [number, number, number];

export interface Palette {
  text: Rgb;
  muted: Rgb;
  /** The accent's three colors, start to end. */
  accent: [Rgb, Rgb, Rgb];
  surface: Rgb;
  dark: boolean;
  font: string;
}

const MONO = 'ui-monospace, "Cascadia Mono", Consolas, monospace';

/** What a lens wants a thing to be. */
export interface Aim {
  id: string;
  shape: "node" | "brick" | "star" | "speck";
  x: number;
  y: number;
  w: number;
  h: number;
  /** Corner rounding. Half the size makes a circle. */
  round: number;
  color: Rgb;
  /** How bright it stays with age, 0.5 to 1. */
  glow: number;
  /** A drive, This PC or the folder in the middle, ringed in the accent. */
  place?: boolean;
  label?: string;
  sub?: string;
  /** Which way the label goes: out to the right, the left, below, or inside. */
  side?: "right" | "left" | "below" | "inside";
  /** The label shows only on hover, focus or a find. */
  quiet?: boolean;
  /** Small specks orbit it, for the files inside. */
  dust?: boolean;
  /** Where a new thing grows from, by ID. */
  from?: string;
  node?: SpaceNode;
  /** What else a hover card needs, such as a brick's owner and year. */
  about?: { owner?: string; year?: number; bytes?: number; tag?: number; path?: string };
  /** A small picture shown inside a round node, as Twins does for photos. */
  image?: ImageBitmap;
}

export interface Thing extends Aim {
  now: { x: number; y: number; w: number; h: number; round: number; alpha: number; lit: number };
  alpha: number;
  seed: number;
}

export interface LinkAim {
  a: string;
  b: string;
  /** How much it is used, 0 to 1. */
  weight: number;
}

interface Link extends LinkAim {
  alpha: number;
  target: number;
  bend: number;
}

/** A row of Layers: its year to the left, its bytes to the right. */
export interface RowAim {
  key: string;
  left: string;
  right: string;
  y: number;
}

interface Row extends RowAim {
  alpha: number;
  target: number;
}

interface Comet {
  path: string[];
  /** A comet that falls in from above the stage, as a download does, starts here. */
  sky?: { x: number; y: number };
  start: number;
  seconds: number;
  /** It goes away, as to the Recycle Bin: it fades where it ends with no ripple. */
  away: boolean;
}

interface Ripple {
  id: string;
  start: number;
}

export interface Scene {
  things: Map<string, Thing>;
  links: Map<string, Link>;
  rows: Map<string, Row>;
  comets: Comet[];
  ripples: Ripple[];
  hover?: string;
  focus?: string;
  /** Things a find matched. The rest dim while it is set. */
  found?: ReadonlySet<string>;
  /** How much the Brain's drift and dust show, eased between lenses. */
  drift: number;
  driftTarget: number;
  /** Seconds since the scene began, for drift and comets. */
  time: number;
  /** Reduced motion is on: what changes shows at once, with no light sent along. */
  calm: boolean;
}

export const newScene = (): Scene => ({ things: new Map(), links: new Map(), rows: new Map(), comets: [], ripples: [], drift: 0, driftTarget: 0, time: 0, calm: false });

/** Sets where everything should go. Things not named fade away; new ones grow from where they came from. */
export function aim(scene: Scene, aims: Aim[], links: LinkAim[], rows: RowAim[], drift: boolean, calm: boolean) {
  scene.calm = calm;
  const wanted = new Set<string>();
  for (const one of aims) {
    wanted.add(one.id);
    const held = scene.things.get(one.id);
    if (held) {
      // Built anew, so nothing the old aim set and the new one leaves out stays behind.
      scene.things.set(one.id, { ...one, now: held.now, alpha: 1, seed: held.seed });
      continue;
    }
    const parent = one.from ? scene.things.get(one.from) : undefined;
    const start = parent && !calm ? { ...parent.now, w: 0, h: 0, round: 0, alpha: 0, lit: 0 } : { x: one.x, y: one.y, w: one.w, h: one.h, round: one.round, alpha: 0, lit: 0 };
    scene.things.set(one.id, { ...one, now: start, alpha: 1, seed: (hashOf(one.id) % 1000) / 100 });
  }
  for (const [id, thing] of scene.things) if (!wanted.has(id)) thing.alpha = 0;

  const linked = new Set<string>();
  for (const one of links) {
    const key = `${one.a}\u0001${one.b}`;
    linked.add(key);
    const held = scene.links.get(key);
    if (held) Object.assign(held, one, { target: 1 });
    else scene.links.set(key, { ...one, alpha: 0, target: 1, bend: hashOf(key) % 2 ? 1 : -1 });
  }
  for (const [key, link] of scene.links) if (!linked.has(key)) link.target = 0;

  const kept = new Set<string>();
  for (const one of rows) {
    kept.add(one.key);
    const held = scene.rows.get(one.key);
    if (held) Object.assign(held, one, { target: 1 });
    else scene.rows.set(one.key, { ...one, alpha: 0, target: 1 });
  }
  for (const [key, row] of scene.rows) if (!kept.has(key)) row.target = 0;
  scene.driftTarget = drift && !calm ? 1 : 0;
}

/** Moves everything a step of `seconds` toward where it is aimed. Answers whether anything still moves. */
export function step(scene: Scene, seconds: number, calm: boolean): boolean {
  scene.time += seconds;
  const settle = calm ? 0.0001 : 0.22;
  let moving = scene.comets.length > 0 || scene.ripples.length > 0;
  for (const [id, thing] of scene.things) {
    const now = thing.now;
    const lit = thing.id === scene.hover || thing.id === scene.focus ? 1 : 0;
    now.x = ease(now.x, thing.x, seconds, settle);
    now.y = ease(now.y, thing.y, seconds, settle);
    now.w = ease(now.w, thing.w, seconds, settle);
    now.h = ease(now.h, thing.h, seconds, settle);
    now.round = ease(now.round, thing.round, seconds, settle);
    now.alpha = ease(now.alpha, thing.alpha, seconds, calm ? 0.0001 : 0.18);
    now.lit = ease(now.lit, lit, seconds, calm ? 0.0001 : 0.1);
    const off =
      Math.abs(now.x - thing.x) + Math.abs(now.y - thing.y) + Math.abs(now.w - thing.w) + Math.abs(now.h - thing.h) + Math.abs(now.round - thing.round);
    // Close enough lands exactly, so a thing at rest never creeps a fraction of a pixel when the stage wakes.
    if (off < 0.05 && Math.abs(now.alpha - thing.alpha) < 0.005 && Math.abs(now.lit - lit) < 0.005) {
      Object.assign(now, { x: thing.x, y: thing.y, w: thing.w, h: thing.h, round: thing.round, alpha: thing.alpha, lit });
    } else {
      moving = true;
    }
    if (thing.alpha === 0 && now.alpha < 0.01) scene.things.delete(id);
  }
  for (const [key, link] of scene.links) {
    link.alpha = ease(link.alpha, link.target, seconds, calm ? 0.0001 : 0.25);
    if (Math.abs(link.alpha - link.target) < 0.005) link.alpha = link.target;
    else moving = true;
    if (link.target === 0 && link.alpha < 0.01) scene.links.delete(key);
  }
  for (const [key, row] of scene.rows) {
    row.alpha = ease(row.alpha, row.target, seconds, calm ? 0.0001 : 0.25);
    if (Math.abs(row.alpha - row.target) < 0.005) row.alpha = row.target;
    else moving = true;
    if (row.target === 0 && row.alpha < 0.01) scene.rows.delete(key);
  }
  scene.drift = ease(scene.drift, scene.driftTarget, seconds, 0.4);
  // Snapped to still, or what rests would sit a fraction of a pixel off where it last stopped.
  if (scene.driftTarget === 0 && scene.drift < 0.01) scene.drift = 0;
  return moving || scene.drift > 0.01;
}

const rgba = (color: Rgb, alpha: number) => `rgba(${color[0]},${color[1]},${color[2]},${Math.max(0, Math.min(1, alpha))})`;

/** Where a thing is drawn this moment, with the Brain's slow drift. */
function placeOf(scene: Scene, thing: Thing) {
  const drift = scene.drift * (thing.shape === "node" && !thing.place ? 1.6 : 0);
  return {
    x: thing.now.x + Math.sin(scene.time * 0.32 + thing.seed) * drift,
    y: thing.now.y + Math.cos(scene.time * 0.27 + thing.seed * 1.3) * drift,
  };
}

/** The middle of a link's curve, bowed a little to one side. */
function bowOf(a: { x: number; y: number }, b: { x: number; y: number }, bend: number) {
  return { x: (a.x + b.x) / 2 - (b.y - a.y) * 0.14 * bend, y: (a.y + b.y) / 2 + (b.x - a.x) * 0.14 * bend };
}

function onCurve(a: { x: number; y: number }, bow: { x: number; y: number }, b: { x: number; y: number }, t: number) {
  const u = 1 - t;
  return { x: u * u * a.x + 2 * u * t * bow.x + t * t * b.x, y: u * u * a.y + 2 * u * t * bow.y + t * t * b.y };
}

/** Sends light along `path` of IDs, or down from the sky into the one thing named. */
export function sendComet(scene: Scene, path: string[], away = false, sky?: { x: number; y: number }) {
  if (path.length === 0 || scene.calm) return;
  if (path.length === 1 && !sky) {
    scene.ripples.push({ id: path[0], start: scene.time });
    return;
  }
  scene.comets.push({ path, sky, start: scene.time, seconds: 0.55 + 0.45 * Math.max(1, path.length - 1), away });
}

/** A point along a comet's way, `t` from 0 to 1. */
function along(scene: Scene, comet: Comet, t: number) {
  const points = comet.path.map((id) => scene.things.get(id)).filter((thing): thing is Thing => !!thing).map((thing) => placeOf(scene, thing));
  if (comet.sky) points.unshift(comet.sky);
  if (points.length === 0) return undefined;
  if (points.length === 1) return points[0];
  const legs = points.length - 1;
  const at = Math.min(legs - 1e-6, t * legs);
  const leg = Math.floor(at);
  const a = points[leg];
  const b = points[leg + 1];
  const ids = comet.sky ? [undefined, ...comet.path] : comet.path;
  const link = scene.links.get(`${ids[leg]}\u0001${ids[leg + 1]}`) ?? scene.links.get(`${ids[leg + 1]}\u0001${ids[leg]}`);
  const bend = link ? (scene.links.has(`${ids[leg]}\u0001${ids[leg + 1]}`) ? link.bend : -link.bend) : 0;
  return onCurve(a, bowOf(a, b, bend), b, at - leg);
}

const smooth = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
}

/** Paints the scene as it is this moment. */
export function paint(context: CanvasRenderingContext2D, scene: Scene, palette: Palette, width: number, height: number) {
  context.clearRect(0, 0, width, height);
  const finding = !!scene.found;
  const dimOf = (id: string) => (finding && !scene.found!.has(id) ? 0.22 : 1);
  const places = new Map<string, { x: number; y: number }>();
  for (const [id, thing] of scene.things) places.set(id, placeOf(scene, thing));

  // Links first, under everything.
  for (const [key, link] of scene.links) {
    const a = places.get(link.a);
    const b = places.get(link.b);
    const far = scene.things.get(link.b);
    if (!a || !b || !far) continue;
    const lit = Math.max(scene.things.get(link.a)?.now.lit ?? 0, far.now.lit);
    const alpha = link.alpha * Math.min(far.now.alpha, scene.things.get(link.a)?.now.alpha ?? 1) * Math.min(dimOf(link.a), dimOf(link.b));
    const color = far.node && far.node.depth > 1 ? far.color : mix(palette.muted, palette.accent[0], 0.35);
    context.strokeStyle = rgba(color, (0.1 + 0.08 * far.glow + 0.32 * link.weight + 0.3 * lit) * alpha);
    context.lineWidth = 0.8 + 1.2 * link.weight + 0.4 * lit;
    const bow = bowOf(a, b, scene.links.get(key)!.bend);
    context.beginPath();
    context.moveTo(a.x, a.y);
    context.quadraticCurveTo(bow.x, bow.y, b.x, b.y);
    context.stroke();
  }

  // Dust: a few specks circling each folder of the second ring, for the files inside.
  if (scene.drift > 0.01) {
    for (const thing of scene.things.values()) {
      if (!thing.dust || thing.now.alpha < 0.05) continue;
      const place = places.get(thing.id)!;
      const count = 3 + (Math.floor(thing.seed * 10) % 4);
      for (let at = 0; at < count; at++) {
        const angle = thing.seed * 7 + at * 2.1 + scene.time * (0.12 + ((at * 37) % 10) / 60);
        const away = thing.now.w / 2 + 6 + ((at * 53) % 9);
        context.fillStyle = rgba(thing.color, 0.22 * thing.glow * thing.now.alpha * scene.drift * dimOf(thing.id));
        context.beginPath();
        context.arc(place.x + Math.cos(angle) * away, place.y + Math.sin(angle) * away * 0.82, 0.6 + ((at * 13) % 7) / 10, 0, Math.PI * 2);
        context.fill();
      }
    }
  }

  // Bigger things first, so small ones stay on top where a pointer can reach them.
  const order = [...scene.things.values()].sort((a, b) => b.now.w * b.now.h - a.now.w * a.now.h);
  // Specks come by the thousand and look alike, so those of one colour and strength share one path,
  // drawn on top of the rest.
  const dust = new Map<string, { color: Rgb; alpha: number; path: Path2D }>();
  for (const thing of order) {
    const { w, h, round, alpha, lit } = thing.now;
    if (alpha < 0.01 || w < 0.5 || h < 0.5) continue;
    const { x, y } = places.get(thing.id)!;
    const shown = alpha * dimOf(thing.id);
    const left = x - w / 2;
    const top = y - h / 2;
    const corner = Math.max(0, Math.min(round, w / 2, h / 2));
    const roundness = corner / Math.max(0.01, Math.min(w, h) / 2);
    const color = thing.color;
    const glow = thing.glow;

    if (thing.place || lit > 0.01) {
      const reach = Math.max(w, h) * 1.05 + 6;
      const halo = context.createRadialGradient(x, y, Math.min(w, h) * 0.3, x, y, reach);
      const tint = thing.place ? palette.accent[0] : color;
      halo.addColorStop(0, rgba(tint, (thing.place ? 0.07 : 0) + 0.08 * lit));
      halo.addColorStop(1, rgba(tint, 0));
      context.fillStyle = halo;
      context.globalAlpha = shown;
      context.beginPath();
      context.arc(x, y, reach, 0, Math.PI * 2);
      context.fill();
      context.globalAlpha = 1;
    }

    if (thing.shape === "speck") {
      const alpha = Math.round((0.75 + 0.25 * lit) * shown * 20) / 20;
      const key = `${color}|${alpha}`;
      let batch = dust.get(key);
      if (!batch) dust.set(key, (batch = { color, alpha, path: new Path2D() }));
      const radius = w / 2 + lit;
      batch.path.moveTo(x + radius, y);
      batch.path.arc(x, y, radius, 0, Math.PI * 2);
      continue;
    }

    context.beginPath();
    context.roundRect(left, top, w, h, corner);
    context.fillStyle = rgba(color, (thing.shape === "brick" ? 0.26 * glow : 0.05) + 0.05 * lit);
    context.globalAlpha = shown;
    context.fill();
    if (thing.place && "createConicGradient" in context) {
      const turning = context.createConicGradient(scene.time * 0.25 + thing.seed, x, y);
      turning.addColorStop(0, rgba(palette.accent[0], 1));
      turning.addColorStop(0.33, rgba(palette.accent[1], 1));
      turning.addColorStop(0.66, rgba(palette.accent[2], 1));
      turning.addColorStop(1, rgba(palette.accent[0], 1));
      context.strokeStyle = turning;
      context.lineWidth = 1.4;
      context.globalAlpha = shown * 0.85;
    } else {
      context.strokeStyle = rgba(color, (thing.shape === "brick" ? 0.45 : 0.55) * glow + 0.4 * lit);
      context.lineWidth = thing.shape === "star" ? 1.2 : 1 + 0.4 * lit;
    }
    context.stroke();
    context.globalAlpha = shown;
    if (thing.image) {
      // Cover-scaled into a circle just inside the ring.
      const image = thing.image;
      const radius = Math.min(w, h) / 2 - 1.5;
      const scale = Math.max((radius * 2) / image.width, (radius * 2) / image.height);
      if (radius > 1) {
        context.save();
        context.beginPath();
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.clip();
        context.drawImage(image, x - (image.width * scale) / 2, y - (image.height * scale) / 2, image.width * scale, image.height * scale);
        context.restore();
      }
    } else if (roundness > 0.5 && thing.shape !== "brick") {
      // The bright middle shows only while it is round; a brick has none.
      context.fillStyle = rgba(color, 0.9 * glow * (roundness - 0.5) * 2);
      context.beginPath();
      context.arc(x, y, Math.max(1.5, Math.min(w, h) * 0.1), 0, Math.PI * 2);
      context.fill();
    }
    context.globalAlpha = 1;
  }

  for (const { color, alpha, path } of dust.values()) {
    context.fillStyle = rgba(color, alpha);
    context.fill(path);
  }

  // Names over everything, never under a circle.
  for (const thing of order) {
    if (!thing.label || thing.now.alpha < 0.05) continue;
    const lit = thing.now.lit;
    const found = finding && scene.found!.has(thing.id);
    const show = thing.quiet ? Math.max(lit, found ? 1 : 0) : 1;
    if (show < 0.02) continue;
    const { x, y } = places.get(thing.id)!;
    const { w, h } = thing.now;
    const alpha = thing.now.alpha * show * dimOf(thing.id);
    const side = thing.side ?? "below";
    let lx = x;
    let ly = y + h / 2 + 15;
    context.textAlign = "center";
    if (side === "right") {
      lx = x + w / 2 + 8;
      ly = y + 1;
      context.textAlign = "left";
    } else if (side === "left") {
      lx = x - w / 2 - 8;
      ly = y + 1;
      context.textAlign = "right";
    } else if (side === "inside") {
      ly = y + (thing.sub ? -2 : 4);
    }
    context.font = `${thing.place && thing.node?.depth === 0 ? 13 : 12}px ${palette.font}`;
    context.fillStyle = rgba(palette.text, (0.78 + 0.22 * lit) * alpha);
    context.fillText(thing.label, lx, ly);
    if (thing.sub) {
      context.font = `11px ${MONO}`;
      context.fillStyle = rgba(palette.muted, 0.9 * alpha);
      context.fillText(thing.sub, lx, ly + 14);
    }
  }

  // The rows of Layers: each year on the left, its bytes on the right.
  for (const row of scene.rows.values()) {
    if (row.alpha < 0.02) continue;
    context.font = `11px ${MONO}`;
    context.fillStyle = rgba(palette.muted, 0.95 * row.alpha);
    context.textAlign = "right";
    context.fillText(row.left, 72, row.y + 4);
    context.textAlign = "left";
    context.fillText(row.right, width - 86, row.y + 4);
  }

  // Comets of light along the links, the accent's start at the head fading to its end in the tail.
  scene.comets = scene.comets.filter((comet) => {
    const t = (scene.time - comet.start) / comet.seconds;
    if (t >= 1) {
      const last = comet.path[comet.path.length - 1];
      if (!comet.away) scene.ripples.push({ id: last, start: scene.time });
      return false;
    }
    const head = smooth(Math.max(0, t));
    const fade = comet.away ? Math.min(1, (1 - t) * 3) : 1;
    for (let at = 16; at >= 0; at--) {
      const point = along(scene, comet, Math.max(0, head - at * 0.012));
      if (!point) return false;
      const near = 1 - at / 17;
      context.fillStyle = rgba(mix(palette.accent[2], palette.accent[0], near), 0.8 * near * near * fade);
      context.beginPath();
      context.arc(point.x, point.y, 0.6 + 2 * near, 0, Math.PI * 2);
      context.fill();
    }
    return true;
  });

  scene.ripples = scene.ripples.filter((ripple) => {
    const t = scene.time - ripple.start;
    const thing = scene.things.get(ripple.id);
    if (t > 1 || !thing) return false;
    const place = places.get(ripple.id)!;
    const grown = 1 - (1 - t) ** 3;
    context.strokeStyle = rgba(palette.accent[2], 0.4 * (1 - t));
    context.lineWidth = 1;
    context.beginPath();
    context.arc(place.x, place.y, Math.max(thing.now.w, thing.now.h) / 2 + grown * 16, 0, Math.PI * 2);
    context.stroke();
    return true;
  });
}

/**
 * The thing under a point, the smallest first. Each is hit only where it shows: a pill as a pill,
 * so a long thin band never reaches past its own ends. Only where nothing is, small things get a
 * little room around them.
 */
export function thingAt(scene: Scene, x: number, y: number): Thing | undefined {
  return hitAt(scene, x, y, false) ?? hitAt(scene, x, y, true);
}

function hitAt(scene: Scene, x: number, y: number, roomy: boolean): Thing | undefined {
  let best: Thing | undefined;
  let bestArea = Infinity;
  for (const thing of scene.things.values()) {
    if (thing.alpha === 0 || thing.now.alpha < 0.3) continue;
    const place = placeOf(scene, thing);
    const { w, h, round } = thing.now;
    const pad = roomy ? Math.max(0, 9 - Math.min(w, h) / 2) : 0;
    if (onShape(x - place.x, y - place.y, w, h, round, pad) && w * h < bestArea) {
      best = thing;
      bestArea = w * h;
    }
  }
  return best;
}

/** Where a thing is drawn now, for placing its hover card. */
export const whereIs = (scene: Scene, thing: Thing) => ({ ...placeOf(scene, thing), w: thing.now.w, h: thing.now.h });
