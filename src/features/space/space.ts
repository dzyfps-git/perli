import type { MapCell } from "../../api";

/**
 * Space: what fills a folder or the whole PC, seen through lenses. This file holds what can be
 * worked out without a screen: the tree, how old and how used each part is, and where each lens
 * puts things. Space.tsx draws it.
 */

/** One thing in Space: a folder, a file, a drive, This PC, or the many small things folded into one. */
export interface SpaceNode {
  /** The path in lowercase, which also names it across lenses. This PC is "pc". */
  id: string;
  /** "" for This PC and for the folded small things. */
  path: string;
  name: string;
  bytes: number;
  folder: boolean;
  /** When a file under it last changed, in milliseconds since 1970, or 0 with none. */
  newest: number;
  /** A file kind as fileKinds names it, "folder" when it holds nothing to tell by. */
  kind: string;
  depth: number;
  parent?: SpaceNode;
  kids: SpaceNode[];
  /** Bytes by the year files last changed, oldest first. */
  years: [number, number][];
  /** How many small things a folded node stands for. */
  folded?: number;
  /** A drive, or This PC. */
  place?: boolean;
}

/** The ID of This PC, which holds the drives. */
export const PC = "pc";
/** The biggest things right inside the root that get a node each in Brain. The rest fold into one. */
export const MOST_KIDS = 12;
/** The biggest things inside each of those that come along as a second ring. */
export const MOST_INNER = 8;

const FILETIME_TO_1970_MS = 11_644_473_600_000;
const DAY = 86_400_000;

/** FILETIME ticks to milliseconds since 1970. */
export const msOf = (ticks: number) => (ticks > 0 ? ticks / 10_000 - FILETIME_TO_1970_MS : 0);

export const idOf = (path: string) => path.toLowerCase();

export function joinPath(folder: string, name: string) {
  return folder.endsWith("\\") ? folder + name : `${folder}\\${name}`;
}

/** The folder an ID is in, by its text, or "" past a drive's root. */
export function upOne(id: string) {
  const bare = id.endsWith("\\") ? id.slice(0, -1) : id;
  const cut = bare.lastIndexOf("\\");
  if (cut < 0) return "";
  const up = bare.slice(0, cut);
  return up.endsWith(":") ? `${up}\\` : up;
}

/** True when `id` is `folder` or lies somewhere under it. Everything lies under This PC. */
export function isUnder(id: string, folder: string) {
  if (folder === PC) return true;
  if (id === folder) return true;
  return id.startsWith(folder.endsWith("\\") ? folder : `${folder}\\`);
}

/** A node for `cell` inside `parent`, with its inner cells as its own kids if it brings them. */
function nodeOf(cell: MapCell, parent: SpaceNode, kindOf: (cell: MapCell) => string, inner: number): SpaceNode {
  const path = joinPath(parent.path, cell.name);
  const node: SpaceNode = {
    id: idOf(path),
    path,
    name: cell.name,
    bytes: cell.bytes,
    folder: cell.folder,
    newest: msOf(cell.newest),
    kind: kindOf(cell),
    depth: parent.depth + 1,
    parent,
    kids: [],
    years: cell.years ?? [],
  };
  if (inner > 0 && cell.inner?.length) node.kids = biggest(cell.inner, inner).map((one) => nodeOf(one, node, kindOf, 0));
  return node;
}

const biggest = (cells: MapCell[], most: number) =>
  [...cells].sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name)).slice(0, most);

/** The many small things of `parent` past the biggest, as one node, or nothing if there are none. */
function foldedOf(cells: MapCell[], parent: SpaceNode): SpaceNode | undefined {
  if (cells.length === 0) return undefined;
  return {
    id: `${parent.id}\u0000more`,
    path: "",
    name: `${cells.length.toLocaleString("en-US")} more`,
    bytes: cells.reduce((sum, cell) => sum + cell.bytes, 0),
    folder: false,
    newest: Math.max(0, ...cells.map((cell) => msOf(cell.newest))),
    kind: "file",
    depth: parent.depth + 1,
    parent,
    kids: [],
    years: [],
    folded: cells.length,
  };
}

/** The tree of a folder from what the weigh found: its biggest parts, each with its biggest parts. */
export function folderTree(path: string, name: string, cells: MapCell[], kindOf: (cell: MapCell) => string, most = MOST_KIDS): SpaceNode {
  const root: SpaceNode = {
    id: idOf(path),
    path,
    name,
    bytes: cells.reduce((sum, cell) => sum + cell.bytes, 0),
    folder: true,
    newest: Math.max(0, ...cells.map((cell) => msOf(cell.newest))),
    kind: "folder",
    depth: 0,
    kids: [],
    years: [],
    place: /^[a-z]:\\$/i.test(path),
  };
  const sorted = biggest(cells, cells.length);
  root.kids = sorted.slice(0, most).map((cell) => nodeOf(cell, root, kindOf, MOST_INNER));
  const folded = foldedOf(sorted.slice(most), root);
  if (folded) root.kids.push(folded);
  return root;
}

/** This PC with its drives, each with the biggest things on it as last weighed, if it ever was. */
export function pcTree(
  drives: { path: string; name: string; used: number }[],
  weighed: Record<string, MapCell[]>,
  kindOf: (cell: MapCell) => string,
): SpaceNode {
  const root: SpaceNode = { id: PC, path: "", name: "This PC", bytes: 0, folder: true, newest: 0, kind: "folder", depth: 0, kids: [], years: [], place: true };
  root.kids = drives.map((drive) => {
    const node: SpaceNode = {
      id: idOf(drive.path),
      path: drive.path,
      name: drive.name || drive.path,
      bytes: drive.used,
      folder: true,
      newest: 0,
      kind: "folder",
      depth: 1,
      parent: root,
      kids: [],
      years: [],
      place: true,
    };
    const cells = weighed[idOf(drive.path)] ?? [];
    node.kids = biggest(cells, MOST_INNER).map((cell) => nodeOf(cell, node, kindOf, 0));
    node.newest = Math.max(0, ...cells.map((cell) => msOf(cell.newest)));
    return node;
  });
  root.bytes = root.kids.reduce((sum, drive) => sum + drive.bytes, 0);
  return root;
}

/** Every node of the tree, the root first. */
export function allNodes(root: SpaceNode): SpaceNode[] {
  const all: SpaceNode[] = [];
  const visit = (node: SpaceNode) => {
    all.push(node);
    node.kids.forEach(visit);
  };
  visit(root);
  return all;
}

/** How bright a part stays as it goes untouched: 1 today, down to half after two years. */
export function ageGlow(newest: number, now: number) {
  if (!newest) return 0.6;
  const days = Math.max(0, (now - newest) / DAY);
  return 1 - 0.5 * Math.min(1, Math.log1p(days) / Math.log1p(730));
}

/** Folders visited, by lowercase path: how often and when last, in milliseconds. */
export type Visits = Record<string, [count: number, last: number]>;

/** A visit counts half as much after two weeks, so a link fades when its folder is left alone. */
const HALF_LIFE_DAYS = 14;

/** How much each of `ids` gets used, from 0 to 1 for the most used: its own visits and those under it. */
export function useShares(ids: string[], visits: Visits, now: number): Map<string, number> {
  const weights = Object.entries(visits).map(([path, [count, last]]) => [path, count * 0.5 ** (Math.max(0, now - last) / DAY / HALF_LIFE_DAYS)] as const);
  const raw = new Map(ids.map((id) => [id, weights.reduce((sum, [path, weight]) => (isUnder(path, id) ? sum + weight : sum), 0)]));
  // The root holds every visit, so it would always be the most used; the rest are measured among themselves.
  const most = Math.max(0, ...ids.slice(1).map((id) => raw.get(id) ?? 0));
  return new Map(ids.map((id) => [id, most > 0 ? Math.min(1, (raw.get(id) ?? 0) / most) : 0]));
}

/** Where a node sits and how big it is, in pixels of the stage. */
export interface Spot {
  x: number;
  y: number;
  r: number;
}

export interface BrainLayout {
  spots: Map<string, Spot>;
  /** Parent and child, by ID. */
  links: [string, string][];
}

/** Room left beside the outermost nodes for their names. */
const LABEL_ROOM = 110;

/**
 * Brain: the root in the middle, its parts on a ring around it, each with its own parts close by
 * on the outside. Every part gets a slice of the ring as wide as it and its parts need. Nothing
 * here moves once placed, so the picture never jitters.
 */
export function brainLayout(root: SpaceNode, width: number, height: number): BrainLayout {
  const ring1 = root.kids;
  const most = Math.max(1, ...ring1.map((node) => node.bytes));
  const sizeOf = (node: SpaceNode, ring: number) => {
    const share = Math.sqrt(Math.max(0, node.bytes) / most);
    return ring === 1 ? 6 + share * 20 : 3 + share * 13;
  };
  const raw = new Map<string, Spot>([[root.id, { x: 0, y: 0, r: 10 }]]);
  const links: [string, string][] = [];
  const parentOf = new Map<string, string>();
  const radii = ring1.map((node) => sizeOf(node, 1));
  const needs = ring1.map((node, at) => radii[at] + 0.6 * node.kids.reduce((sum, kid) => sum + sizeOf(kid, 2), 0) + 12);
  const total = needs.reduce((sum, need) => sum + need, 0) || 1;
  const reach = Math.max(120, (radii.reduce((sum, radius) => sum + 2 * radius + 22, 0) / (2 * Math.PI)) * 1.1);
  // The first and biggest part sits at the top.
  let angle = -Math.PI / 2 - (needs[0] / total) * Math.PI;
  ring1.forEach((node, at) => {
    const wedge = (needs[at] / total) * 2 * Math.PI;
    const middle = angle + wedge / 2;
    angle += wedge;
    // Every other part a little further out, so the ring reads as grown rather than drawn.
    const out = reach * (at % 2 ? 1.07 : 0.97);
    const spot = { x: Math.cos(middle) * out, y: Math.sin(middle) * out, r: radii[at] };
    raw.set(node.id, spot);
    links.push([root.id, node.id]);
    parentOf.set(node.id, root.id);
    const spread = Math.min(wedge * 0.85, 1.5);
    node.kids.forEach((kid, k) => {
      const radius = sizeOf(kid, 2);
      const turn = node.kids.length === 1 ? middle : middle - spread / 2 + (spread * k) / (node.kids.length - 1);
      const away = spot.r + 14 + radius + (k % 2) * 8;
      raw.set(kid.id, { x: spot.x + Math.cos(turn) * away, y: spot.y + Math.sin(turn) * away, r: radius });
      links.push([node.id, kid.id]);
      parentOf.set(kid.id, node.id);
    });
  });
  untangle(raw, root.id);
  return { spots: fitted(raw, width, height, LABEL_ROOM, 1.5), links };
}

/** Pushes overlapping spots apart, the smaller giving way more. The root stays put. */
function untangle(spots: Map<string, Spot>, rootId: string, rounds = 60, gap = 5) {
  const list = [...spots.entries()].filter(([id]) => id !== rootId).map(([, spot]) => spot);
  const root = spots.get(rootId)!;
  for (let round = 0; round < rounds; round++) {
    let moved = false;
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const one = list[a];
        const two = list[b];
        let dx = two.x - one.x;
        let dy = two.y - one.y;
        let distance = Math.hypot(dx, dy);
        const least = one.r + two.r + gap;
        if (distance >= least) continue;
        if (distance < 0.01) {
          // Two on one point have no way to go, so each pair gets its own.
          dx = Math.cos(a + b);
          dy = Math.sin(a + b);
          distance = 1;
        }
        const push = (least - distance) / distance;
        const share = one.r / (one.r + two.r);
        one.x -= dx * push * (1 - share);
        one.y -= dy * push * (1 - share);
        two.x += dx * push * share;
        two.y += dy * push * share;
        moved = true;
      }
      // Nothing may sit on the root.
      const spot = list[a];
      const away = Math.hypot(spot.x - root.x, spot.y - root.y);
      const least = spot.r + root.r + gap * 3;
      if (away < least && away > 0.01) {
        spot.x = root.x + ((spot.x - root.x) / away) * least;
        spot.y = root.y + ((spot.y - root.y) / away) * least;
      }
    }
    if (!moved) break;
  }
}

/** The spots scaled to fit the stage with room beside them, and centered. */
function fitted(spots: Map<string, Spot>, width: number, height: number, room: number, most: number) {
  let [left, top, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const spot of spots.values()) {
    left = Math.min(left, spot.x - spot.r);
    right = Math.max(right, spot.x + spot.r);
    top = Math.min(top, spot.y - spot.r);
    bottom = Math.max(bottom, spot.y + spot.r);
  }
  const scale = Math.min(most, Math.max(0.2, (width - 2 * room) / Math.max(1, right - left)), Math.max(0.2, (height - 60) / Math.max(1, bottom - top)));
  const middleX = (left + right) / 2;
  const middleY = (top + bottom) / 2;
  return new Map(
    [...spots].map(([id, spot]) => [id, { x: width / 2 + (spot.x - middleX) * scale, y: height / 2 + (spot.y - middleY) * scale, r: Math.max(2.5, spot.r * scale) }]),
  );
}

/** A slice of a year in Layers: who it belongs to and how much they changed that year. */
export interface Brick {
  /** The owner's own ID in the year it has most, so it can melt from its node into its brick. */
  id: string;
  owner: string;
  year: number;
  bytes: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface YearRow {
  year: number;
  bytes: number;
  y: number;
  h: number;
}

/** Owners with a brick of their own in each year. The rest share one. */
const MOST_OWNERS = 5;

/**
 * Layers: a band for each year, oldest at the bottom, as thick as the bytes last changed that
 * year, each band split among the parts that hold them.
 */
export function layersLayout(parts: SpaceNode[], width: number, height: number): { bricks: Brick[]; rows: YearRow[] } {
  const byYear = new Map<number, Map<string, number>>();
  for (const part of parts) {
    for (const [year, bytes] of part.years) {
      const owners = byYear.get(year) ?? new Map<string, number>();
      owners.set(part.id, (owners.get(part.id) ?? 0) + bytes);
      byYear.set(year, owners);
    }
  }
  const years = [...byYear.keys()].sort((a, b) => a - b);
  if (years.length === 0) return { bricks: [], rows: [] };
  const sums = years.map((year) => [...byYear.get(year)!.values()].reduce((sum, bytes) => sum + bytes, 0));
  const total = sums.reduce((sum, bytes) => sum + bytes, 0) || 1;
  const gap = 3;
  const least = 6;
  const usable = Math.max(least * years.length, height * 0.76 - gap * (years.length - 1));
  const spare = Math.max(0, usable - least * years.length);
  const heights = sums.map((bytes) => least + (bytes / total) * spare);
  const fullHeight = heights.reduce((sum, one) => sum + one, 0) + gap * (years.length - 1);
  const left = 84;
  const right = width - 96;
  // The year each owner holds most in, where its brick takes the owner's own ID.
  const best = new Map<string, number>();
  for (const part of parts) {
    const top = [...part.years].sort((a, b) => b[1] - a[1])[0];
    if (top) best.set(part.id, top[0]);
  }
  const bricks: Brick[] = [];
  const rows: YearRow[] = [];
  // The newest year on top, the oldest at the bottom.
  let y = (height + fullHeight) / 2;
  years.forEach((year, at) => {
    const h = heights[at];
    y -= h;
    rows.push({ year, bytes: sums[at], y, h });
    const owners = [...byYear.get(year)!].sort((a, b) => b[1] - a[1]);
    const shown = owners.slice(0, MOST_OWNERS);
    const rest = owners.slice(MOST_OWNERS).reduce((sum, [, bytes]) => sum + bytes, 0);
    const slices: [string, number][] = rest > 0 ? [...shown, [`\u0000more@${year}`, rest]] : shown;
    const room = right - left - 2 * (slices.length - 1);
    let x = left;
    for (const [owner, bytes] of slices) {
      const w = Math.max(2, (bytes / sums[at]) * room);
      bricks.push({ id: best.get(owner) === year ? owner : `${owner}@${year}`, owner, year, bytes, x, y, w, h });
      x += w + 2;
    }
    y -= gap;
  });
  return { bricks, rows };
}

export interface TagStar {
  id: string;
  tag: number;
  count: number;
  x: number;
  y: number;
  r: number;
}

export interface Speck {
  id: string;
  path: string;
  tags: number[];
  x: number;
  y: number;
}

/** A number from a text that stays the same between runs, for placing things without randomness. */
export function hashOf(text: string) {
  let hash = 2166136261;
  for (let at = 0; at < text.length; at++) hash = Math.imul(hash ^ text.charCodeAt(at), 16777619);
  return hash >>> 0;
}

/**
 * Tags: each tag a star on a wide ring, each tagged file a speck drawn among the stars of its tags,
 * so a file with two tags sits between them.
 */
export function tagsLayout(
  tags: { id: number }[],
  files: { path: string; tags: number[] }[],
  width: number,
  height: number,
  most = 600,
): { stars: TagStar[]; specks: Speck[]; left: number } {
  const counts = new Map<number, number>(tags.map((tag) => [tag.id, 0]));
  for (const file of files) for (const tag of file.tags) if (counts.has(tag)) counts.set(tag, counts.get(tag)! + 1);
  const used = tags.filter((tag) => counts.get(tag.id)! > 0);
  const middleX = width / 2;
  const middleY = height / 2;
  const stars: TagStar[] = used.map((tag, at) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * at) / Math.max(1, used.length);
    const alone = used.length === 1;
    const count = counts.get(tag.id)!;
    return {
      id: `\u0000tag${tag.id}`,
      tag: tag.id,
      count,
      x: alone ? middleX : middleX + Math.cos(angle) * width * 0.32,
      y: alone ? middleY : middleY + Math.sin(angle) * height * 0.32,
      r: Math.min(22, 6 + Math.sqrt(count) * 3),
    };
  });
  const starOf = new Map(stars.map((star) => [star.tag, star]));
  const placed = files.filter((file) => file.tags.some((tag) => starOf.has(tag))).slice(0, most);
  const specks = placed.map((file) => {
    const own = file.tags.map((tag) => starOf.get(tag)).filter((star): star is TagStar => !!star);
    const x = own.reduce((sum, star) => sum + star.x, 0) / own.length;
    const y = own.reduce((sum, star) => sum + star.y, 0) / own.length;
    const hash = hashOf(file.path.toLowerCase());
    const angle = (hash % 6283) / 1000;
    const away = (own.length === 1 ? own[0].r : 0) + 10 + ((hash >>> 12) % 34);
    return { id: idOf(file.path), path: file.path, tags: file.tags, x: x + Math.cos(angle) * away, y: y + Math.sin(angle) * away };
  });
  return { stars, specks, left: Math.max(0, files.length - placed.length) };
}

/** The way from one node to another along the tree's links: up to where they meet, then down. */
export function route(from: string, to: string, parentOf: (id: string) => string | undefined): string[] {
  const upFrom = [from];
  for (let at = parentOf(from); at !== undefined; at = parentOf(at)) upFrom.push(at);
  const upTo = [to];
  for (let at = parentOf(to); at !== undefined; at = parentOf(at)) upTo.push(at);
  const meet = upFrom.find((id) => upTo.includes(id));
  if (meet === undefined) return [];
  return [...upFrom.slice(0, upFrom.indexOf(meet) + 1), ...upTo.slice(0, upTo.indexOf(meet)).reverse()];
}

/** The deepest of `shown` that holds `path`, or nothing if Space shows no part of it. */
export function nearestShown(path: string, shown: ReadonlySet<string>, rootId: string): string | undefined {
  let id = idOf(path);
  if (!isUnder(id, rootId)) return undefined;
  while (id && !shown.has(id)) {
    const up = upOne(id);
    if (up === id) break;
    id = up;
  }
  return id && shown.has(id) ? id : shown.has(rootId) ? rootId : undefined;
}

/** A step of an easing toward `target` that takes the same time at any frame rate. */
export const ease = (value: number, target: number, seconds: number, settle = 0.16) =>
  value + (target - value) * (1 - Math.exp(-seconds / settle));

/** Ages in words, as the hover card says them. */
export function agoText(newest: number, now: number) {
  if (!newest) return "never changed";
  const days = Math.floor(Math.max(0, now - newest) / DAY);
  if (days < 1) return "changed today";
  if (days < 2) return "changed yesterday";
  if (days < 31) return `changed ${days} days ago`;
  if (days < 365) {
    const months = Math.max(1, Math.round(days / 30.4));
    return `changed ${months} ${months === 1 ? "month" : "months"} ago`;
  }
  const years = Math.round(days / 365);
  return `changed ${years} ${years === 1 ? "year" : "years"} ago`;
}
