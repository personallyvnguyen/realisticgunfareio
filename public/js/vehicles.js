import { VEHICLES, VEHICLE_WEAPONS } from './config.js';
import { rand, rad, clamp, angleDelta, TAU } from './math.js';
import { Bullet } from './entities.js';
import { Sound } from './audio.js';

// A drivable vehicle: heavy, momentum-driven, armored. Body heading and turret
// aim are independent (drive one way, shoot another). Small arms barely scratch
// armor; cannons and airstrikes are what kill it.
export class Vehicle {
  constructor(type, x, y) {
    this.type = type;
    this.s = VEHICLES[type];
    this.x = x; this.y = y;
    this.angle = rand(0, TAU);   // body heading
    this.turret = this.angle;    // weapon facing
    this.speed = 0;
    this.hp = this.s.hp;
    this.maxHp = this.s.hp;
    this.dead = false;
    this.radius = Math.max(this.s.w, this.s.h) / 2;
    this.driver = null;
    this.lastShot = -999;
    this.reloadUntil = 0;
    this.mgAmmo = this.s.weapon === 'mg' ? VEHICLE_WEAPONS.mg.mag : 0;
    this.fuel = this.s.fuel;
    this.station = 'driver';   // which seat a SOLO crew (you) is manning
    this.gunner = null;        // a second crew member on the gun (AI ally/enemy)
    this.rounds = this.s.weapon === 'cannon' ? this.s.rounds : 0;
  }

  // Who fires from this vehicle right now (the gunner if crewed, else the driver).
  crewShooter() { return this.gunner || this.driver; }

  damage(amount, attackerId, game) {
    if (this.dead) return;
    // Shot up a rig crewed by your OWN side — the crew and nearby friends realize a
    // traitor's hitting them and turn on you (same reckoning as shooting a man).
    const crew = this.crewShooter();
    if (crew && crew.team === 'player' && attackerId === game.player.id && game._friendlyHitReaction) {
      game._friendlyHitReaction(this.x, this.y);
    }
    this.hp -= amount;
    if (this.hp <= 0) {
      this.dead = true;
      game.explode(this.x, this.y, this.radius + 3, 120, attackerId);
      for (const c of [this.driver, this.gunner]) {
        if (!c) continue;
        c.inVehicle = false; c.vehicle = null;
        game.damageEntity(c, 999, attackerId, 'vehicle destroyed');
      }
      this.driver = null; this.gunner = null;
    }
  }

  // control = { drive: {throttle, steer} | null, gun: {turret, fire, fireEdge,
  // aimDist, requireLaid} | null } — the game assembles it from whoever mans each
  // seat, so a driver and a gunner can operate at the same time.
  update(dt, control, game) {
    if (this.dead || !control) return;
    const armed = !!this.s.weapon;
    const drive = control.drive, gun = control.gun;

    // Throttle / momentum — only when a driver mans the wheel, and only with fuel.
    if (drive && this.fuel > 0 && drive.throttle !== 0) {
      const tgt = drive.throttle > 0 ? drive.throttle * this.s.maxSpeed : drive.throttle * this.s.reverse;
      this.speed += clamp(tgt - this.speed, -this.s.accel * dt, this.s.accel * dt);
    } else {
      this.speed *= Math.max(0, 1 - 2.0 * dt);
    }
    if (drive) {
      const auth = clamp(Math.abs(this.speed) / 4, 0, 1) * Math.sign(this.speed || 1);
      this.angle += drive.steer * this.s.turn * dt * auth;
    }
    if (Math.abs(this.speed) > 1) this.fuel = Math.max(0, this.fuel - this.s.fuelUse * dt);

    this.x += Math.cos(this.angle) * this.speed * dt;
    this.y += Math.sin(this.angle) * this.speed * dt;
    const before = { x: this.x, y: this.y };
    game.world.resolve(this, this.radius * 0.7);
    if (Math.hypot(this.x - before.x, this.y - before.y) > 0.05) this.speed *= 0.3; // rammed something

    if (Math.abs(this.speed) > 3) { // run people over / send them diving clear
      const sh = this.crewShooter();
      const oid = sh ? sh.id : 'vehicle', crewTeam = sh ? sh.team : null;
      // A HUMAN behind the wheel can plow through anyone — including their own team
      // (a genuine TK). AI drivers only crush the enemy and steer around their own.
      const playerDriven = this.driver === game.player;
      const vax = Math.cos(this.angle), vay = Math.sin(this.angle);
      for (const e of game.all) {
        if (!e.alive || e === this.driver || e === this.gunner || e.inVehicle) continue;
        const dd = Math.hypot(e.x - this.x, e.y - this.y);
        // Crush the enemy always; crush your OWN team only if a human is driving.
        if (dd < this.radius + e.r && Math.abs(this.speed) > 4 && (e.team !== crewTeam || playerDriven)) {
          game.damageEntity(e, Math.abs(this.speed) * 5, oid, 'run over');
        } else if (dd < this.radius + 11 && '_scatterUntil' in e && e.team !== crewTeam) {
          // A charging hostile vehicle — DIVE to the side, out of its path. Flee to
          // whichever side you're already on (pick one if dead-centre); the scatter
          // point is set just to the OTHER side so there's always a clear lateral escape.
          const rx = e.x - this.x, ry = e.y - this.y, along = rx * vax + ry * vay;
          if (along > -this.radius) { // in front of / alongside us
            let lateral = -rx * vay + ry * vax;
            const side = Math.abs(lateral) < 0.4 ? (e._steerBias || 1) : Math.sign(lateral);
            const footx = this.x + vax * along, footy = this.y + vay * along;
            e._scatterUntil = Math.max(e._scatterUntil, game.time + 1.8);
            e._scatterX = footx + vay * side;  // perp unit is (-vay, vax); offset to the far side
            e._scatterY = footy - vax * side;
          }
        }
      }
    }

    // The gun works when a gunner mans it. The turret traverses at a limited rate.
    if (armed && gun) {
      const tt = this.s.turretTurn || 3;
      this.turret += clamp(angleDelta(this.turret, gun.turret), -tt * dt, tt * dt);
      const laid = !gun.requireLaid || Math.abs(angleDelta(this.turret, gun.turret)) < 0.06;
      if (this.s.weapon === 'mg' && gun.fire && laid) this._fireMG(game);
      if (this.s.weapon === 'cannon' && gun.fireEdge && laid) this._fireCannon(game, gun.aimDist || 60);
      // Coaxial MG rakes infantry between main-gun rounds — but only when the target's
      // an infantry-range foe (not wasted on armour) and the lane's clear of your own.
      if (this.s.coax && gun.fire && laid && gun.coax) this._fireCoax(game);
    }
  }

  _fireCoax(game) {
    const w = VEHICLE_WEAPONS.coax, now = game.time;
    if (now - (this._lastCoax || 0) < 60 / w.rpm) return;
    this._lastCoax = now;
    const m = this._muzzle(0.9);
    const s = (Math.random() + Math.random() - 1) * rad(w.spread);
    const sh = this.crewShooter();
    const owner = sh ? sh.id : 'veh', team = sh ? sh.team : 'player';
    game.bullets.push(new Bullet(m.x, m.y, this.turret + s, w, owner, team, false, 120));
    game.fx.muzzle(m.x, m.y, this.turret, w);
  }

  _muzzle(extra = 0.6) {
    const off = this.s.w / 2 + extra;
    return { x: this.x + Math.cos(this.turret) * off, y: this.y + Math.sin(this.turret) * off };
  }

  _fireMG(game) {
    const w = VEHICLE_WEAPONS.mg, now = game.time;
    if (now - this.lastShot < 60 / w.rpm) return;
    if (this.mgAmmo <= 0) {
      if (now > this.reloadUntil && this.reloadUntil < now) this.reloadUntil = now + w.reload;
      if (now < this.reloadUntil) return;
      this.mgAmmo = w.mag;
    }
    this.lastShot = now; this.mgAmmo--;
    const m = this._muzzle(0.8);
    const s = (Math.random() + Math.random() - 1) * rad(w.spread);
    const sh = this.crewShooter();
    const owner = sh ? sh.id : 'veh', team = sh ? sh.team : 'player';
    game.bullets.push(new Bullet(m.x, m.y, this.turret + s, w, owner, team, false, 120));
    game.fx.muzzle(m.x, m.y, this.turret, w);
    game.onVehicleShot(this, false);
  }

  _fireCannon(game, range) {
    const w = VEHICLE_WEAPONS.cannon, now = game.time;
    if (now < this.reloadUntil || this.rounds <= 0) return;
    this.reloadUntil = now + w.reload;
    this.rounds--;
    const m = this._muzzle(w.barrel * 0.4);
    const sh = this.crewShooter();
    const owner = sh ? sh.id : 'veh';
    game.shells.push(new Shell(m.x, m.y, this.turret, w, owner, range));
    game.fx.muzzle(m.x, m.y, this.turret, { caliber: 30 }, 2.0);
    game.fx.addShake(9);
    game.onVehicleShot(this, true);
  }

  reloadFrac(now) {
    if (this.s.weapon !== 'cannon') return 1;
    const w = VEHICLE_WEAPONS.cannon;
    return clamp(1 - (this.reloadUntil - now) / w.reload, 0, 1);
  }
}

// Tank shell: flies straight, explodes on contact (area damage + destruction).
export class Shell {
  constructor(x, y, angle, w, ownerId, range = 200) {
    this.x = x; this.y = y;
    this.vx = Math.cos(angle) * w.velocity;
    this.vy = Math.sin(angle) * w.velocity;
    this.angle = angle; this.w = w; this.ownerId = ownerId;
    this.range = clamp(range, 6, 450); // detonates at the ranged distance
    this.traveled = 0; this.dead = false;
  }

  update(dt, game) {
    const nx = this.x + this.vx * dt, ny = this.y + this.vy * dt;
    const seg = Math.hypot(nx - this.x, ny - this.y);

    let hit = null;
    const fc = game.world.firstCoverHit(this.x, this.y, nx, ny);
    if (fc) hit = { x: this.x + (nx - this.x) * fc.t, y: this.y + (ny - this.y) * fc.t };

    if (!hit) {
      for (const e of game.all) {
        if (!e.alive || e.inVehicle || e.id === this.ownerId) continue;
        if (Math.hypot(e.x - nx, e.y - ny) < e.r + 1.5) { hit = { x: nx, y: ny }; break; }
      }
    }
    if (!hit && game.vehicles) {
      for (const v of game.vehicles) {
        if (v.dead || v === game.findById?.(this.ownerId)?.vehicle) continue;
        if (Math.hypot(v.x - nx, v.y - ny) < v.radius + 1) { hit = { x: nx, y: ny }; break; }
      }
    }

    this.traveled += seg;
    if (!hit && this.traveled >= this.range) hit = { x: nx, y: ny }; // lands where you ranged it

    if (hit) {
      game.explode(hit.x, hit.y, this.w.explosion, this.w.damage, this.ownerId);
      this.dead = true;
      return;
    }
    this.x = nx; this.y = ny;
  }
}
