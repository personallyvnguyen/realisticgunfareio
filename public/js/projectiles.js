import { CONFIG } from './config.js';
import { clamp, angleDelta } from './math.js';

// Thrown frag grenade: arcs to where you aimed, bounces to a stop, cooks off.
export class Grenade {
  constructor(x, y, tx, ty, ownerId) {
    this.x = x; this.y = y; this.ownerId = ownerId;
    let dx = tx - x, dy = ty - y;
    let D = clamp(Math.hypot(dx, dy), 2, 32); // max throw range
    const len = Math.hypot(dx, dy) || 1;
    const speed = 17, t = D / speed;
    this.vx = (dx / len) * speed; this.vy = (dy / len) * speed;
    this.z = 1.4;
    this.vz = 0.5 * CONFIG.GRAVITY * t - this.z / t; // arc so it reaches the GROUND at the target
    this.fuse = 2.4; this.dead = false;
  }
  update(dt, game) {
    this.fuse -= dt;
    this.x += this.vx * dt; this.y += this.vy * dt;
    this.z += this.vz * dt - 0.5 * CONFIG.GRAVITY * dt * dt; this.vz -= CONFIG.GRAVITY * dt;
    if (this.z <= 0) { this.z = 0; this.vz *= -0.35; this.vx *= 0.4; this.vy *= 0.4; } // bounce & settle
    if (this.fuse <= 0) { game.explode(this.x, this.y, 5.5, 100, this.ownerId); this.dead = true; }
  }
}

// RPG rocket: flies fairly slow & straight, explodes on contact or at range.
export class Rocket {
  constructor(x, y, angle, w, ownerId) {
    this.x = x; this.y = y; this.angle = angle; this.w = w; this.ownerId = ownerId;
    this.vx = Math.cos(angle) * w.velocity; this.vy = Math.sin(angle) * w.velocity;
    this.traveled = 0; this.dead = false;
  }
  update(dt, game) {
    const nx = this.x + this.vx * dt, ny = this.y + this.vy * dt;
    this.traveled += Math.hypot(nx - this.x, ny - this.y);
    let hit = null;
    const fc = game.world.firstCoverHit(this.x, this.y, nx, ny);
    if (fc) hit = { x: this.x + (nx - this.x) * fc.t, y: this.y + (ny - this.y) * fc.t };
    if (!hit) for (const e of game.all) {
      if (!e.alive || e.inVehicle || e.id === this.ownerId) continue;
      if (Math.hypot(e.x - nx, e.y - ny) < e.r + 1.2) { hit = { x: nx, y: ny }; break; }
    }
    if (!hit) for (const v of game.vehicles) {
      if (!v.dead && Math.hypot(v.x - nx, v.y - ny) < v.radius) { hit = { x: nx, y: ny }; break; }
    }
    if (!hit && this.traveled > this.w.rangeMax) hit = { x: nx, y: ny };
    if (hit) { game.explode(hit.x, hit.y, this.w.explosion, this.w.damage, this.ownerId); this.dead = true; return; }
    this.x = nx; this.y = ny;
    if (Math.random() < 0.8) game.fx.impact(this.x, this.y, this.angle + Math.PI, '#9a9a9a'); // smoke trail
  }
}

// Stinger missile: guided — turns toward the nearest enemy aircraft and kills it.
export class Missile {
  constructor(x, y, angle, w, ownerId, game) {
    this.x = x; this.y = y; this.angle = angle; this.w = w; this.ownerId = ownerId;
    this.speed = w.velocity; this.traveled = 0; this.dead = false;
    this.target = null;
    // Lock the nearest hostile AIRCRAFT by the shooter's side: the player's Stinger
    // kills enemy drones; an enemy AA gunner's Stinger kills the player's drones.
    const shooter = game.findById ? game.findById(ownerId) : null;
    const enemyFired = shooter && shooter.team === 'enemy';
    const air = enemyFired
      ? (game.drones || []).filter((d) => d.type !== 'recon') // recon bird can't be locked
      : [...(game.enemyDrones || []), ...(game.enemyFpvs || [])];
    let bd = Infinity;
    for (const d of air) {
      if (d.dead) continue;
      const dd = Math.hypot(d.x - x, d.y - y);
      if (dd < bd) { bd = dd; this.target = d; }
    }
  }
  update(dt, game) {
    if (this.target && !this.target.dead) {
      const want = Math.atan2(this.target.y - this.y, this.target.x - this.x);
      this.angle += clamp(angleDelta(this.angle, want), -3.5 * dt, 3.5 * dt); // guided turn rate
    }
    this.x += Math.cos(this.angle) * this.speed * dt;
    this.y += Math.sin(this.angle) * this.speed * dt;
    this.traveled += this.speed * dt;
    if (Math.random() < 0.6) game.fx.impact(this.x, this.y, this.angle + Math.PI, '#dddddd');
    if (this.target && !this.target.dead && Math.hypot(this.target.x - this.x, this.target.y - this.y) < 2.5) {
      this.target.dead = true;
      game.explode(this.x, this.y, this.w.explosion, this.w.damage, this.ownerId);
      this.dead = true; return;
    }
    if (this.traveled > this.w.rangeMax || this.x < 0 || this.y < 0 || this.x > game.world.w || this.y > game.world.h) {
      game.explode(this.x, this.y, this.w.explosion, this.w.damage * 0.5, this.ownerId);
      this.dead = true;
    }
  }
}
