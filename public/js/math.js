// Small math/geometry toolkit. All inputs are in world meters unless noted.

export const TAU = Math.PI * 2;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const rad = (deg) => (deg * Math.PI) / 180;
export const deg = (r) => (r * 180) / Math.PI;

export function dist2(ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  return dx * dx + dy * dy;
}
export function dist(ax, ay, bx, by) {
  return Math.sqrt(dist2(ax, ay, bx, by));
}

// Random helpers
export const rand = (a, b) => a + Math.random() * (b - a);
export const randInt = (a, b) => Math.floor(rand(a, b + 1));
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Shortest signed angular difference from a to b, in (-PI, PI].
export function angleDelta(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/**
 * Earliest intersection of a moving point (segment A->B) with a circle.
 * Used for bullets so fast rounds can't tunnel through targets.
 * Returns t in [0,1] of first contact, or null.
 */
export function segmentCircle(ax, ay, bx, by, cx, cy, r) {
  const dx = bx - ax, dy = by - ay;
  const fx = ax - cx, fy = ay - cy;
  const a = dx * dx + dy * dy;
  if (a === 0) return fx * fx + fy * fy <= r * r ? 0 : null;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;
  let disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  disc = Math.sqrt(disc);
  const t1 = (-b - disc) / (2 * a);
  const t2 = (-b + disc) / (2 * a);
  if (t1 >= 0 && t1 <= 1) return t1;
  if (t2 >= 0 && t2 <= 1) return t2; // started inside the circle
  return null;
}

/**
 * Earliest intersection of segment A->B with an axis-aligned box.
 * Box given as {x, y, w, h} (top-left origin). Returns t in [0,1] or null.
 */
export function segmentAABB(ax, ay, bx, by, box) {
  const dx = bx - ax, dy = by - ay;
  let tmin = 0, tmax = 1;
  const xmin = box.x, xmax = box.x + box.w;
  const ymin = box.y, ymax = box.y + box.h;

  for (const [p, d, lo, hi] of [
    [ax, dx, xmin, xmax],
    [ay, dy, ymin, ymax],
  ]) {
    if (Math.abs(d) < 1e-9) {
      if (p < lo || p > hi) return null; // parallel & outside slab
    } else {
      let t1 = (lo - p) / d;
      let t2 = (hi - p) / d;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  return tmin;
}

/**
 * Entry and exit parameters of segment A->B through an AABB.
 * Returns {t0, t1} (both in [0,1]) or null if it misses. Used to push a
 * penetrating round out the far side of soft cover.
 */
export function segmentAABBRange(ax, ay, bx, by, box) {
  const dx = bx - ax, dy = by - ay;
  let tmin = 0, tmax = 1;
  for (const [p, d, lo, hi] of [
    [ax, dx, box.x, box.x + box.w],
    [ay, dy, box.y, box.y + box.h],
  ]) {
    if (Math.abs(d) < 1e-9) {
      if (p < lo || p > hi) return null;
    } else {
      let t1 = (lo - p) / d, t2 = (hi - p) / d;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  return { t0: tmin, t1: tmax };
}

/**
 * Push a circle (cx,cy,r) out of an AABB if overlapping.
 * Returns the corrected {x, y} center (closest-feature resolution).
 */
export function resolveCircleAABB(cx, cy, r, box) {
  const nx = clamp(cx, box.x, box.x + box.w);
  const ny = clamp(cy, box.y, box.y + box.h);
  const dx = cx - nx, dy = cy - ny;
  const d2 = dx * dx + dy * dy;

  if (d2 > r * r) return null; // no overlap

  if (d2 > 1e-9) {
    // Center is outside the box but within r of an edge/corner: push along normal.
    const d = Math.sqrt(d2);
    return { x: nx + (dx / d) * r, y: ny + (dy / d) * r };
  }

  // Center is inside the box: eject along the shallowest axis.
  const left = cx - box.x, right = box.x + box.w - cx;
  const top = cy - box.y, bottom = box.y + box.h - cy;
  const m = Math.min(left, right, top, bottom);
  if (m === left) return { x: box.x - r, y: cy };
  if (m === right) return { x: box.x + box.w + r, y: cy };
  if (m === top) return { x: cx, y: box.y - r };
  return { x: cx, y: box.y + box.h + r };
}
