import { CONFIG, MATERIALS } from './config.js';
import { rand, randInt, segmentAABB, resolveCircleAABB, clamp, dist2 } from './math.js';

// The arena. Obstacles have a MATERIAL that decides whether they stop bullets
// (cover) and/or sight (conceal), how tall they are (rounds clear low cover),
// and how much punishment they take before turning to rubble.

export class World {
  constructor() {
    this.w = CONFIG.WORLD_W;
    this.h = CONFIG.WORLD_H;
    this.obstacles = [];
    this._generate();
  }

  _generate() {
    const M = 14;
    // Scale terrain with the map area so a bigger arena stays as dense, not empty.
    const D = (this.w * this.h) / (500 * 500);
    const n = (base) => Math.max(1, Math.round(base * D));

    // Concrete compounds (tall hard cover) with a doorway.
    for (let i = 0; i < n(8); i++) {
      const bw = rand(16, 34), bh = rand(16, 34);
      this._building(rand(M, this.w - bw - M), rand(M, this.h - bh - M), bw, bh);
    }

    // Shipping containers / vehicles — tall steel hard cover.
    for (let i = 0; i < n(18); i++) {
      const horiz = Math.random() < 0.5;
      const w = horiz ? rand(6, 12) : rand(2.4, 3);
      const h = horiz ? rand(2.4, 3) : rand(6, 12);
      this._box(rand(M, this.w - w - M), rand(M, this.h - h - M), w, h, 'steel');
    }

    // Wooden crates — LOW (shoot over them) and penetrable/breakable.
    for (let i = 0; i < n(36); i++) {
      const s = rand(0.9, 1.8);
      this._box(rand(M, this.w - s - M), rand(M, this.h - s - M), s, s, 'wood');
    }

    // Sandbag walls — low soft cover.
    for (let i = 0; i < n(16); i++) {
      const horiz = Math.random() < 0.5;
      const w = horiz ? rand(3, 6) : rand(0.8, 1.1);
      const h = horiz ? rand(0.8, 1.1) : rand(3, 6);
      this._box(rand(M, this.w - w - M), rand(M, this.h - h - M), w, h, 'sandbag');
    }

    // Brush — concealment only: blocks sight, not bullets or movement.
    for (let i = 0; i < n(30); i++) {
      const s = rand(1.6, 3.4);
      this._box(rand(M, this.w - s - M), rand(M, this.h - s - M), s, s, 'brush');
    }

    // Keep the central spawn reasonably clear of hard cover.
    const cx = this.w / 2, cy = this.h / 2;
    this.obstacles = this.obstacles.filter(
      (o) => !o.mat.cover || dist2(o.x + o.w / 2, o.y + o.h / 2, cx, cy) > 12 * 12
    );
  }

  _box(x, y, w, h, matKey) {
    const mat = MATERIALS[matKey];
    this.obstacles.push({ x, y, w, h, matKey, mat, hp: mat.hp, maxHp: mat.hp, dead: false });
  }

  _building(x, y, w, h) {
    const t = 0.6, door = 3.5, side = randInt(0, 3);
    if (side === 0) {
      const g = rand(x + 1, x + w - door - 1);
      this._box(x, y, g - x, t, 'concrete'); this._box(g + door, y, x + w - (g + door), t, 'concrete');
    } else this._box(x, y, w, t, 'concrete');
    if (side === 1) {
      const g = rand(x + 1, x + w - door - 1);
      this._box(x, y + h - t, g - x, t, 'concrete'); this._box(g + door, y + h - t, x + w - (g + door), t, 'concrete');
    } else this._box(x, y + h - t, w, t, 'concrete');
    if (side === 2) {
      const g = rand(y + 1, y + h - door - 1);
      this._box(x, y, t, g - y, 'concrete'); this._box(x, g + door, t, y + h - (g + door), 'concrete');
    } else this._box(x, y, t, h, 'concrete');
    if (side === 3) {
      const g = rand(y + 1, y + h - door - 1);
      this._box(x + w - t, y, t, g - y, 'concrete'); this._box(x + w - t, g + door, t, y + h - (g + door), 'concrete');
    } else this._box(x + w - t, y, t, h, 'concrete');
  }

  // Movement: blocked only by solid (cover) obstacles still standing.
  resolve(p, r) {
    p.x = clamp(p.x, r, this.w - r);
    p.y = clamp(p.y, r, this.h - r);
    for (const o of this.obstacles) {
      if (!o.mat.cover || o.dead) continue;
      const fix = resolveCircleAABB(p.x, p.y, r, o);
      if (fix) { p.x = fix.x; p.y = fix.y; }
    }
  }

  // Line of sight: blocked by anything that conceals (cover OR brush) standing.
  visible(ax, ay, bx, by) {
    const nx = Math.min(ax, bx), xx = Math.max(ax, bx), ny = Math.min(ay, by), xy = Math.max(ay, by);
    for (const o of this.obstacles) {
      if (!o.mat.conceal || o.dead) continue;
      if (o.x > xx || o.x + o.w < nx || o.y > xy || o.y + o.h < ny) continue; // broad-phase reject
      if (segmentAABB(ax, ay, bx, by, o) !== null) return false;
    }
    return true;
  }

  // Earliest sight-blocker along a ray (for the fog-of-war polygon).
  rayHitVision(ax, ay, bx, by) {
    let best = null;
    const nx = Math.min(ax, bx), xx = Math.max(ax, bx), ny = Math.min(ay, by), xy = Math.max(ay, by);
    for (const o of this.obstacles) {
      if (!o.mat.conceal || o.dead) continue;
      if (o.x > xx || o.x + o.w < nx || o.y > xy || o.y + o.h < ny) continue;
      const t = segmentAABB(ax, ay, bx, by, o);
      if (t !== null && (best === null || t < best)) best = t;
    }
    return best;
  }

  // Earliest bullet-blocking (cover) obstacle along a ray: { o, t } or null.
  firstCoverHit(ax, ay, bx, by) {
    let best = null;
    const nx = Math.min(ax, bx), xx = Math.max(ax, bx), ny = Math.min(ay, by), xy = Math.max(ay, by);
    for (const o of this.obstacles) {
      if (!o.mat.cover || o.dead) continue;
      if (o.x > xx || o.x + o.w < nx || o.y > xy || o.y + o.h < ny) continue;
      const t = segmentAABB(ax, ay, bx, by, o);
      if (t !== null && (best === null || t < best.t)) best = { o, t };
    }
    return best;
  }

  damage(o, dmg) {
    if (o.maxHp <= 0) return;          // indestructible-by-design (brush has 0)
    o.hp -= dmg;
    if (o.hp <= 0) o.dead = true;      // shot to rubble — now passable & see-through
  }

  randomSpawn(r = CONFIG.PLAYER_RADIUS) {
    for (let tries = 0; tries < 200; tries++) {
      const p = { x: rand(r + 2, this.w - r - 2), y: rand(r + 2, this.h - r - 2) };
      let ok = true;
      for (const o of this.obstacles) {
        if (!o.mat.cover || o.dead) continue;
        if (resolveCircleAABB(p.x, p.y, r + 0.6, o)) { ok = false; break; }
      }
      if (ok) return p;
    }
    return { x: this.w / 2, y: this.h / 2 };
  }
}
