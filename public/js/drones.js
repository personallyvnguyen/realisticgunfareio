import { DRONES, CONFIG } from './config.js';
import { clamp, rand, angleDelta } from './math.js';

// A pilotable drone. You fly it from your body (which stays on the ground,
// exposed) — the drone's camera reveals enemies around it. Battery-limited.
//   bomber: hovers, drops grenades on what's below (click).
//   fpv:    fast one-way kamikaze, explodes on contact or command.
export class Drone {
  constructor(type, x, y, ownerId) {
    this.type = type;
    this.s = DRONES[type];
    this.x = x; this.y = y;
    this.vx = 0; this.vy = 0;
    this.angle = 0;
    this.hp = this.s.hp;
    this.battery = this.s.battery;
    this.bombs = this.s.bombs || 0;
    this.ownerId = ownerId;
    this.lastBomb = -999;
    this.dead = false;
  }

  update(dt, control, game) {
    if (this.dead) return;
    this.battery -= dt;

    const sp = this.s.speed;
    const mlen = Math.hypot(control.mx, control.my);
    const tvx = mlen ? (control.mx / mlen) * sp : 0;
    const tvy = mlen ? (control.my / mlen) * sp : 0;
    this.vx += (tvx - this.vx) * Math.min(1, 8 * dt);
    this.vy += (tvy - this.vy) * Math.min(1, 8 * dt);
    this.x = clamp(this.x + this.vx * dt, 2, game.world.w - 2);
    this.y = clamp(this.y + this.vy * dt, 2, game.world.h - 2);
    if (mlen) this.angle = Math.atan2(this.vy, this.vx);

    if (this.type === 'fpv') {
      let detonate = control.fire || control.detonate;
      if (!detonate) {
        for (const e of game.all) {
          if (!e.alive || e.id === this.ownerId || e.inVehicle) continue;
          if (e.team === 'enemy' && Math.hypot(e.x - this.x, e.y - this.y) < 1.6) { detonate = true; break; }
        }
        for (const v of game.vehicles) {
          if (!v.dead && Math.hypot(v.x - this.x, v.y - this.y) < v.radius) { detonate = true; break; }
        }
      }
      if (detonate) {
        game.explode(this.x, this.y, this.s.explodeRadius, this.s.explodeDmg, this.ownerId);
        this.dead = true; return;
      }
    } else { // bomber
      if (control.fire && this.bombs > 0 && game.time - this.lastBomb > 0.6) {
        this.lastBomb = game.time; this.bombs--;
        game.bombs.push(new Bomb(this.x, this.y, this.s.bombDmg, this.s.bombRadius, this.ownerId));
      }
    }

    if (this.battery <= 0 || this.hp <= 0) this.dead = true;
  }
}

// An enemy attack drone: flies in, drops a bomb on you, leaves. Shoot it down
// with a Stinger missile (or gunfire). A reason to carry anti-air.
export class EnemyDrone {
  constructor(x, y) {
    this.x = x; this.y = y; this.hp = 28; this.dead = false;
    // Altitude: higher drones fall longer, look smaller, and are harder to hit.
    this.alt = rand(28, 60);
    this.r = clamp(0.9 * (1 - this.alt / 150), 0.32, 0.9);
    this.angle = 0; this._t = 0;
    this.lastBomb = -999;
    this.bombs = 4 + Math.floor(rand(0, 4)); // a payload to expend before it leaves
  }
  update(dt, game) {
    if (this.dead) return;
    this._t += dt;
    const p = game.player;
    // Out of ordnance, or you're down → RTB to the NEAREST map edge (a clean, chase-
    // able exit, not a random dash off into space). Still shootable on the way out.
    if (this.bombs <= 0 || !p.alive) {
      const W = game.world.w, H = game.world.h;
      const toEdge = Math.min(this.x, W - this.x) < Math.min(this.y, H - this.y)
        ? [this.x < W - this.x ? -12 : W + 12, this.y]
        : [this.x, this.y < H - this.y ? -12 : H + 12];
      this.angle = Math.atan2(toEdge[1] - this.y, toEdge[0] - this.x);
      this.x += Math.cos(this.angle) * 18 * dt;
      this.y += Math.sin(this.angle) * 18 * dt;
      if (this.x < -8 || this.y < -8 || this.x > W + 8 || this.y > H + 8) this.dead = true;
      return;
    }
    // HOVER right over you (like a real grenade-dropping quad) with a tight little
    // weave, and keep dropping until it's out of bombs, shot down, or you're dead.
    const orbitR = 4;
    const d = Math.hypot(p.x - this.x, p.y - this.y);
    let tx, ty;
    if (d > orbitR + 4) { tx = p.x; ty = p.y; }              // close in overhead
    else { const oa = this._t * 1.2; tx = p.x + Math.cos(oa) * orbitR; ty = p.y + Math.sin(oa) * orbitR; }
    const mv = Math.atan2(ty - this.y, tx - this.x);
    this.x += Math.cos(mv) * 22 * dt;
    this.y += Math.sin(mv) * 22 * dt;
    this.angle = mv;
    // Bomb on a cadence, and LEAD you: the bomb is aimed to land where you'll be
    // when it finishes its fall (fixing the "it always lands late" miss).
    if (game.time - this.lastBomb > 2.8 && d < 42) {
      this.lastBomb = game.time; this.bombs--;
      const tFall = Math.sqrt(2 * this.alt / CONFIG.GRAVITY);
      // PREDICTIVE lead (0.8): it lands where you'd be if you held your line, so a
      // straight runner gets hit — but the impact is telegraphed on the ground, so
      // a change of direction still dodges it.
      const lx = p.x + (p.vx || 0) * tFall * 0.8, ly = p.y + (p.vy || 0) * tFall * 0.8;
      const b = new Bomb(this.x, this.y, 220, 6, 'enemyair', this.alt);
      b.vx = (lx - this.x) / tFall; b.vy = (ly - this.y) / tFall;
      b.tx = lx; b.ty = ly; // predicted impact (for the ground warning marker)
      game.bombs.push(b);
    }
  }
  damage(amount, game) {
    this.hp -= amount;
    if (this.hp <= 0) { this.dead = true; game.explode(this.x, this.y, 2.5, 25, 'self'); }
  }
}

// An enemy FPV kamikaze drone: races in low and FAST, homes on a target and
// detonates on contact — a one-way suicide munition. Fragile: shoot it down (or
// juke it — its turn rate is limited) before it reaches you.
export class EnemyFpv {
  constructor(x, y, target) {
    this.x = x; this.y = y; this.hp = 10; this.dead = false;
    this.r = 0.5; this.alt = 2.5; this.angle = 0;
    this.speed = 32;                 // fast closer
    this.target = target || null;
    this._t = 0; this._armed = 0.4;  // brief arming delay so it doesn't blow up on launch
  }
  _reacquire(game) {
    let tgt = null, bd = Infinity;
    for (const e of game.all) {
      if (!e.alive || e.inVehicle || e.team !== 'player') continue;
      const d = (e.x - this.x) ** 2 + (e.y - this.y) ** 2;
      if (d < bd) { bd = d; tgt = e; }
    }
    return tgt;
  }
  update(dt, game) {
    if (this.dead) return;
    this._t += dt;
    let tgt = this.target;
    if (!tgt || !tgt.alive || tgt.inVehicle) { tgt = this.target = this._reacquire(game); }
    if (!tgt) { if (this._t > 9) this.dead = true; return; } // no one to hit → fizzle out
    const want = Math.atan2(tgt.y - this.y, tgt.x - this.x);
    this.angle += clamp(angleDelta(this.angle, want), -3.2 * dt, 3.2 * dt); // limited turn → dodgeable
    this.x += Math.cos(this.angle) * this.speed * dt;
    this.y += Math.sin(this.angle) * this.speed * dt;
    if (this._t > this._armed) {
      if (Math.hypot(tgt.x - this.x, tgt.y - this.y) < 1.5) return this._detonate(game);
      for (const v of game.vehicles) {
        if (!v.dead && Math.hypot(v.x - this.x, v.y - this.y) < v.radius) return this._detonate(game);
      }
    }
    if (this.x < -8 || this.y < -8 || this.x > game.world.w + 8 || this.y > game.world.h + 8) this.dead = true;
  }
  _detonate(game) { game.explode(this.x, this.y, 4.0, 150, 'enemyfpv'); this.dead = true; }
  damage(amount, game) {
    this.hp -= amount;
    if (this.hp <= 0) { this.dead = true; game.explode(this.x, this.y, 2.0, 18, 'self'); }
  }
}

// A bomb/grenade dropped from a drone: it FALLS from the drone's altitude under
// gravity and detonates on impact — so the higher the drone, the longer the drop.
export class Bomb {
  constructor(x, y, dmg, radius, owner, alt = 6) {
    this.x = x; this.y = y; this.dmg = dmg; this.radius = radius; this.owner = owner;
    this.z = alt; this._alt0 = Math.max(1, alt); this.vz = 0; this.vx = 0; this.vy = 0; this.dead = false;
    this.tx = x; this.ty = y; // predicted impact point (for the ground warning marker)
  }
  update(dt, game) {
    this.vz -= CONFIG.GRAVITY * dt;
    this.z += this.vz * dt;
    this.x += this.vx * dt; // horizontal travel toward the led impact point
    this.y += this.vy * dt;
    if (this.z <= 0) {
      game.explode(this.x, this.y, this.radius, this.dmg, this.owner);
      this.dead = true;
    }
  }
}
