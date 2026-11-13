/** Where the circles of the disk map go: sized by what they hold, and nudged until none overlap. */

export interface Spot {
  x: number;
  y: number;
}

/** Smaller than this, the melting filter eats a circle whole. */
const MIN_RADIUS = 8;
/** How strongly each step draws a circle to the middle, as a share of the way there. */
const PULL = 0.02;
const PUSH_ROUNDS = 4;

/** A radius for each of `bytes`, so that a circle's area follows its bytes and all of them cover `share` of the stage. */
export function radiiOf(bytes: number[], width: number, height: number, share = 0.45) {
  const total = bytes.reduce((sum, one) => sum + one, 0);
  if (total <= 0) return bytes.map(() => MIN_RADIUS);
  const scale = Math.sqrt((width * height * share) / (Math.PI * total));
  const most = Math.min(width, height) / 2 - 4;
  return bytes.map((one) => Math.min(most, Math.max(MIN_RADIUS, Math.sqrt(one) * scale)));
}

/** Where circle `index` starts: on a spiral out from the middle, so the biggest are innermost. */
export function startSpot(index: number, width: number, height: number): Spot {
  const angle = index * 2.4;
  const reach = 8 * Math.sqrt(index);
  return { x: width / 2 + Math.cos(angle) * reach, y: height / 2 + Math.sin(angle) * reach };
}

/**
 * One step of settling, which moves `spots` in place: each circle is drawn to the middle, pushed
 * off any it overlaps, and kept on the stage. Answers with the furthest any circle moved.
 */
export function relax(spots: Spot[], radii: number[], width: number, height: number, gap = 4) {
  const before = spots.map(({ x, y }) => ({ x, y }));
  for (const spot of spots) {
    spot.x += (width / 2 - spot.x) * PULL;
    spot.y += (height / 2 - spot.y) * PULL;
  }
  // A push on one pair moves others back together, so a few rounds settle more than one.
  for (let round = 0; round < PUSH_ROUNDS; round++) {
    for (let a = 0; a < spots.length; a++) for (let b = a + 1; b < spots.length; b++) {
      let dx = spots[b].x - spots[a].x;
      let dy = spots[b].y - spots[a].y;
      let apart = Math.hypot(dx, dy);
      const wanted = radii[a] + radii[b] + gap;
      if (apart >= wanted) continue;
      if (apart < 0.01) {
        // Two on one point have no way to go, so each pair gets its own.
        dx = Math.cos(a + b);
        dy = Math.sin(a + b);
        apart = 1;
      }
      const push = (wanted - apart) / apart;
      // The smaller one gives way more.
      const share = radii[a] / (radii[a] + radii[b]);
      spots[a].x -= dx * push * (1 - share);
      spots[a].y -= dy * push * (1 - share);
      spots[b].x += dx * push * share;
      spots[b].y += dy * push * share;
    }
  }
  let moved = 0;
  spots.forEach((spot, at) => {
    spot.x = Math.max(radii[at], Math.min(width - radii[at], spot.x));
    spot.y = Math.max(radii[at], Math.min(height - radii[at], spot.y));
    moved = Math.max(moved, Math.hypot(spot.x - before[at].x, spot.y - before[at].y));
  });
  return moved;
}
