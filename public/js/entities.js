import { CONFIG, ARMOR_BY_ID, CAMO_BY_ID } from './config.js';
import {
  WEAPON_BY_ID, bulletRadius, shotInterval, muzzleOffset, roundWeight,
} from './weapons.js';
import { clamp, rand, pick, lerp, rad, dist, angleDelta, segmentAABBRange, TAU } from './math.js';

// Closest point on segment A->B to point C. Returns {t, d2} where t is the
// projection parameter in [0,1] and d2 the squared distance at that point.
function closestOnSegment(ax, ay, bx, by, cx, cy) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((cx - ax) * dx + (cy - ay) * dy) / len2;
  t = clamp(t, 0, 1);
  const px = ax + dx * t, py = ay + dy * t;
  const ex = cx - px, ey = cy - py;
  return { t, d2: ex * ex + ey * ey };
}

// Interpolate within a per-stance array by a fractional stance level (0..2).
function lerpArr(arr, x) {
  const i = clamp(Math.floor(x), 0, arr.length - 2);
  return lerp(arr[i], arr[i + 1], clamp(x - i, 0, 1));
}
const bipodCapable = (w) => w.class === 'LMG' || w.class === 'Sniper' || w.class === 'Rifle';

// ---------------------------------------------------------------------------
// Bullet — a point projectile moving in real m/s, collided by raycast so even
// an 880 m/s round can't skip past a target between frames. Most rounds are
// invisible in flight (you see impacts); `tracer` marks the rare visible ones.
// ---------------------------------------------------------------------------
export class Bullet {
  constructor(x, y, angle, weapon, ownerId, ownerTeam, tracer = false, zeroDist = 60, zeroHeight = CONFIG.TARGET_HEIGHT) {
    this.x = x; this.y = y;
    this.vx = Math.cos(angle) * weapon.velocity;
    this.vy = Math.sin(angle) * weapon.velocity;
    this.angle = angle;
    this.weapon = weapon;
    this.r = bulletRadius(weapon);
    this.ownerId = ownerId;
    this.ownerTeam = ownerTeam;
    this.tracer = tracer;
    this.dmgScale = 1;            // reduced by penetration / ricochet
    this.traveled = 0;
    this.dead = false;
    this._whizzed = false;

    // 2.5D ballistics: a height (z) above the ground and vertical velocity,
    // launched so the round crosses the AIMED height at the zero distance (the
    // shooter aims at the target's center mass — low for a prone target).
    this.z = CONFIG.EYE_HEIGHT;
    const tz = Math.max(0.03, clamp(zeroDist, 10, weapon.rangeMax) / weapon.velocity);
    this.vz = (zeroHeight - CONFIG.EYE_HEIGHT + 0.5 * CONFIG.GRAVITY * tz * tz) / tz;
  }

  update(dt, game) {
    const nx = this.x + this.vx * dt;
    const ny = this.y + this.vy * dt;
    const znext = this.z + this.vz * dt - 0.5 * CONFIG.GRAVITY * dt * dt;
    const segLen = Math.hypot(nx - this.x, ny - this.y);
    const zAt = (t) => lerp(this.z, znext, t);

    // --- Cover (bullet-blocking) terrain hit, honoring height (clears low cover) ---
    let coverT = Infinity, coverHit = null;
    const fc = game.world.firstCoverHit(this.x, this.y, nx, ny);
    if (fc && zAt(fc.t) <= fc.o.mat.height) { coverT = fc.t; coverHit = fc.o; }

    // --- Earliest entity hit ---
    // If you're aiming at someone inside your weapon's EFFECTIVE range, you hit
    // them — no fiddly "the round sailed 20 cm over your head" whiffs. Height only
    // starts to matter past effective range, where real drop makes a round land
    // short or sail overhead. (Cover height is handled separately, above.)
    const gateRange = Math.max(CONFIG.POINT_BLANK, this.weapon.range || 0);
    let hitT = Infinity, hitEnt = null, hitD2 = 0;
    for (const e of game.targetsFor(this.ownerId, this.ownerTeam)) {
      if (!e.alive || e.inVehicle) continue; // someone in a vehicle is shielded by it
      const c = closestOnSegment(this.x, this.y, nx, ny, e.x, e.y);
      const reach = e.r + this.r;
      if (c.d2 <= reach * reach && c.t < hitT && c.t <= coverT) {
        const zh = zAt(c.t);
        const inEffective = this.traveled + segLen * c.t < gateRange;
        if (inEffective || (zh >= 0 && zh <= (e.standHeight || CONFIG.STAND_HEIGHT))) {
          hitT = c.t; hitEnt = e; hitD2 = c.d2;
        }
      } else if (c.d2 <= (e.r + 1.8) ** 2 && e.team !== this.ownerTeam && '_coverUntil' in e && (e._alertUntil || 0) < game.time + 1) {
        // A round CRACKED PAST a bot (didn't hit) — it looks back down the round's
        // path, so fire from behind/at range makes them turn to face the shooter.
        e._alertAngle = this.angle + Math.PI; e._alertUntil = game.time + 3;
      }
    }

    // --- Vehicles block & absorb rounds (armor cuts small-arms damage hard) ---
    let vehT = Infinity, vehHit = null;
    if (game.vehicles) for (const v of game.vehicles) {
      if (v.dead) continue;
      const c = closestOnSegment(this.x, this.y, nx, ny, v.x, v.y);
      if (c.d2 <= (v.radius + this.r) ** 2 && c.t < vehT) { vehT = c.t; vehHit = v; }
    }

    // --- Enemy aircraft can be hit by gunfire too (low-flying drones + FPVs) ---
    let droneT = Infinity, droneHit = null;
    const airTargets = this.ownerTeam === 'enemy' ? null
      : [...(game.enemyDrones || []), ...(game.enemyFpvs || [])];
    if (airTargets) for (const d of airTargets) {
      if (d.dead) continue;
      const c = closestOnSegment(this.x, this.y, nx, ny, d.x, d.y);
      if (c.d2 <= (d.r + this.r) ** 2 && c.t < droneT) { droneT = c.t; droneHit = d; }
    }

    // --- Enemy fire can knock down the player's PILOTED drone (bomber/FPV) ---
    let pdroneT = Infinity, pdroneHit = null;
    if (game.drones && this.ownerTeam !== 'player') for (const d of game.drones) {
      if (d.dead || d.type === 'recon') continue; // the recon bird flies too high to hit
      // A racing FPV quad is a much smaller, harder target than a hovering bomber.
      const dr = d.type === 'fpv' ? 0.4 : 0.78;
      const c = closestOnSegment(this.x, this.y, nx, ny, d.x, d.y);
      if (c.d2 <= (dr + this.r) ** 2 && c.t < pdroneT) { pdroneT = c.t; pdroneHit = d; }
    }

    // --- Ground impact (round dropped to earth) ---
    let groundT = Infinity;
    if (znext <= 0) groundT = this.z / (this.z - znext);

    // Resolve the earliest event.
    const firstT = Math.min(hitT, coverT, groundT, vehT, droneT, pdroneT);
    if (droneHit && droneT === firstT && droneT <= 1) {
      droneHit.damage(this.weapon.damage * this.dmgScale, game);
      game.fx.impact(lerp(this.x, nx, droneT), lerp(this.y, ny, droneT), this.angle, '#cccccc');
      this.dead = true;
      return;
    }
    if (pdroneHit && pdroneT === firstT && pdroneT <= 1) {
      pdroneHit.hp -= this.weapon.damage * this.dmgScale;
      if (pdroneHit.hp <= 0) pdroneHit.dead = true;
      game.fx.impact(lerp(this.x, nx, pdroneT), lerp(this.y, ny, pdroneT), this.angle, '#cccccc');
      this.dead = true;
      return;
    }
    if (vehHit && vehT === firstT && vehT <= 1) {
      const hx = lerp(this.x, nx, vehT), hy = lerp(this.y, ny, vehT);
      const rifle = this.weapon.class === 'Rifle' || this.weapon.class === 'LMG' || this.weapon.class === 'Sniper';
      const red = rifle ? vehHit.s.armorRifle : vehHit.s.armorPistol;
      vehHit.damage(this.weapon.damage * this.dmgScale * (1 - red), this.ownerId, game);
      game.fx.impact(hx, hy, this.angle, vehHit.s.color);
      this.dead = true;
      return;
    }
    if (hitEnt && hitT === firstT) {
      const hx = lerp(this.x, nx, hitT), hy = lerp(this.y, ny, hitT);
      // How far off-centre the round struck decides limb vs body. A body hit is
      // USUALLY torso; a CNS/head instant-kill is a lucky central strike (more
      // likely the more centred you are) — so it isn't automatic even point-blank.
      const rf = Math.sqrt(hitD2) / hitEnt.r;
      let region;
      if (rf > CONFIG.ZONE_TORSO) region = 'limb';
      else if (Math.random() < CONFIG.HEAD_CHANCE * (1 - rf)) region = 'head';
      else region = 'torso';
      game.applyDamage(hitEnt, this, this.traveled + segLen * hitT, region, hx, hy);
      this.dead = true;
      return;
    }
    if (coverHit && coverT === firstT && coverT <= 1) {
      this._hitCover(coverHit, coverT, nx, ny, znext, game);
      return;
    }
    if (groundT === firstT && groundT <= 1) {
      const gx = lerp(this.x, nx, groundT), gy = lerp(this.y, ny, groundT);
      game.fx.impact(gx, gy, this.angle, '#9c8f78'); // dust where it lands
      this.dead = true;
      return;
    }

    // Near miss: an enemy round cracking past the player at body height.
    if (!this._whizzed && game.player.alive && !game.player.inVehicle && this.ownerTeam !== game.player.team) {
      const cm = closestOnSegment(this.x, this.y, nx, ny, game.player.x, game.player.y);
      const near = CONFIG.NEARMISS_R + this.r;
      if (cm.d2 <= near * near && zAt(cm.t) < 2.4) { this._whizzed = true; game.onNearMiss(this); }
    }

    this.x = nx; this.y = ny; this.z = znext;
    this.vz -= CONFIG.GRAVITY * dt;
    this.traveled += segLen;

    if (this.traveled >= this.weapon.rangeMax ||
        this.x < 0 || this.y < 0 || this.x > game.world.w || this.y > game.world.h) {
      this.dead = true;
    }
  }

  _hitCover(o, t, nx, ny, znext, game) {
    const hx = lerp(this.x, nx, t), hy = lerp(this.y, ny, t);
    const big = this.weapon.caliber >= 12; // .50-class punches hard cover
    game.world.damage(o, this.weapon.damage * this.dmgScale * (big ? 2.5 : 1));
    game.fx.impact(hx, hy, this.angle, o.mat.color);

    const passable = o.dead; // we just shot it to rubble — round carries through
    const pen = o.mat.pen;

    // Soft cover (wood/sandbag) and .50 through hard cover: penetrate, lose punch.
    if (passable || pen === 'soft' || (pen === 'stop' && big)) {
      const r = segmentAABBRange(this.x, this.y, hx + this.vx * 1e-4, hy + this.vy * 1e-4, o);
      this.dmgScale *= (1 - (passable ? 0.15 : o.mat.loss));
      if (this.dmgScale < 0.1 && !passable) { this.x = hx; this.y = hy; this.dead = true; return; }
      // Exit out the far side and keep flying.
      const exitT = r ? Math.min(1, r.t1 + 0.02) : t + 0.02;
      this.x = this.x + (nx - this.x) * exitT;
      this.y = this.y + (ny - this.y) * exitT;
      this.z = lerp(this.z, znext, exitT);
      return;
    }

    // Hard cover: ricochet off at a grazing angle, otherwise stop.
    const n = this._faceNormal(o, hx, hy);
    const vlen = Math.hypot(this.vx, this.vy) || 1;
    const incidence = Math.acos(clamp(Math.abs((this.vx * n.x + this.vy * n.y) / vlen), 0, 1));
    if (incidence > rad(CONFIG.RICOCHET_ANGLE) && !big) {
      const dot = this.vx * n.x + this.vy * n.y;
      this.vx -= 2 * dot * n.x; this.vy -= 2 * dot * n.y;
      this.angle = Math.atan2(this.vy, this.vx);
      this.dmgScale *= 0.5;
      this.x = hx + n.x * 0.05; this.y = hy + n.y * 0.05;
      game.fx.impact(hx, hy, this.angle, '#ffd27a');
      return;
    }
    this.x = hx; this.y = hy; this.dead = true; // absorbed
  }

  _faceNormal(o, hx, hy) {
    const eps = 0.05;
    if (Math.abs(hx - o.x) < eps) return { x: -1, y: 0 };
    if (Math.abs(hx - (o.x + o.w)) < eps) return { x: 1, y: 0 };
    if (Math.abs(hy - o.y) < eps) return { x: 0, y: -1 };
    return { x: 0, y: 1 };
  }
}

// ---------------------------------------------------------------------------
// Combatant — shared body + weapon handling for the player and the bots.
// Movement/aim/fire intent is supplied each frame as a `control` object, so
// the same class serves a human (input-driven) or a bot (AI-driven).
//
// Ammo is modeled as discrete MAGAZINES, not a loose round pool: each weapon
// has a loaded mag plus a queue of spare mags. Reloading swaps the mag — a
// half-empty mag is stowed (not merged), and empty mags are dropped.
// ---------------------------------------------------------------------------
export class Combatant {
  constructor(id, team, loadout, name, armorId = 'plate3') {
    this.id = id;
    this.team = team;
    this.name = name;
    this.r = CONFIG.PLAYER_RADIUS;
    this.maxHp = CONFIG.PLAYER_HP;

    this.x = 0; this.y = 0;
    this.vx = 0; this.vy = 0;
    this.angle = 0;
    this.hp = this.maxHp;
    this.alive = true;
    this.respawnAt = 0;
    this.lastDamage = -999;
    this.kills = 0;
    this.deaths = 0;
    this.speedFrac = 0;
    this.ads = false;

    // Stance (0 stand, 1 crouch, 2 prone), bipod, suppressor, hearing.
    this.stanceTarget = 0;
    this.stanceLevel = 0;
    this.standHeight = CONFIG.STAND_HEIGHT;
    this.suppressed = false;
    this.bipod = false;
    this._proneStill = 0;
    this._stanceAcc = 1;
    this._deafenUntil = 0;
    this.inVehicle = false;
    this.vehicle = null;
    this.piloting = null;   // a drone you're flying (your body stays on the ground)
    this.camoId = 'none';
    this.camo = CAMO_BY_ID.none;
    this._suppressChangeEnd = 0;
    this._suppressPending = false;
    this.grenades = 3;

    // Stamina
    this.stamina = CONFIG.STAMINA_MAX;
    this._sprinting = false;
    this._lastExert = -999;

    // Armor
    this.armorId = armorId;
    this.armor = ARMOR_BY_ID[armorId];
    this.armorPoints = this.armor.points;

    // Wounds — per limb (left/right arm, left/right leg). legWound/armWound are
    // aggregates derived from these; both legs hit ≫ one leg, both arms ≫ one.
    this.bleed = 0;
    this.legWound = 0;
    this.armWound = 0;
    this.limb = { la: 0, ra: 0, ll: 0, rl: 0 };
    this.lastAttackerId = null;
    this.lastWeaponName = '';

    // Weapons / ammo
    this.loadout = loadout.slice();
    this.slot = 0;
    this.ammo = {};
    this.refillAmmo();
    this.bloom = 0;
    this.lastShot = -999;
    this.reloading = false;
    this.reloadEnd = 0;
    this.reloadStart = 0;
    this._prevFire = false;
    this._rounds = 0;
    this.fireModeSel = this.weapon.fireMode; // safe | semi | burst | auto | pump | bolt
    this._burstLeft = 0;
  }

  cycleFireMode() {
    const modes = ['safe', ...this.weapon.fireModes];
    const i = modes.indexOf(this.fireModeSel);
    this.fireModeSel = modes[(i + 1) % modes.length];
    this._burstLeft = 0;
  }

  get weapon() { return WEAPON_BY_ID[this.loadout[this.slot]]; }
  get _ammo() { return this.ammo[this.loadout[this.slot]]; }
  get mag() { return this._ammo.loaded; }                                   // rounds in the loaded mag
  get reserve() { return this._ammo.spares.reduce((s, n) => s + n, 0); }    // rounds across spare mags
  get magsLeft() { return this._ammo.spares.length; }                       // number of spare mags

  get encumbrance() { // kg — guns + armor + camo + the ammo you're carrying
    let kg = this.armor.weight + this.camo.weight;
    for (const id of this.loadout) {
      const w = WEAPON_BY_ID[id];
      kg += w.weight;
      const a = this.ammo[id];
      if (a) kg += (a.loaded + a.spares.reduce((s, n) => s + n, 0)) * roundWeight(w);
    }
    return kg;
  }

  refillAmmo() {
    this.ammo = {};
    for (const id of this.loadout) {
      const w = WEAPON_BY_ID[id];
      const spareCount = Math.max(0, Math.round(w.reserve / w.mag));
      this.ammo[id] = { loaded: w.mag, spares: Array(spareCount).fill(w.mag) };
    }
  }

  setLoadout(ids) {
    this.loadout = ids.slice();
    this.slot = 0;
    this.refillAmmo();
    this.reloading = false;
    this.bloom = 0;
    this.fireModeSel = this.weapon.fireMode;
    this._burstLeft = 0;
  }

  spawnAt(x, y) {
    this.x = x; this.y = y; this.vx = this.vy = 0;
    this.hp = this.maxHp; this.alive = true;
    this.bloom = 0; this.reloading = false; this.ads = false;
    this.stamina = CONFIG.STAMINA_MAX;
    this.armorPoints = this.armor.points;
    this.bleed = 0; this.legWound = 0; this.armWound = 0;
    this.limb = { la: 0, ra: 0, ll: 0, rl: 0 };
    this.grenades = 3;
    this.refillAmmo();
  }

  setArmor(id) {
    this.armorId = id;
    this.armor = ARMOR_BY_ID[id];
    this.armorPoints = this.armor.points;
  }

  setStance(t) { this.stanceTarget = t; }
  setCamo(id) { this.camoId = id; this.camo = CAMO_BY_ID[id]; }
  toggleSuppressor(now) {
    if (this._suppressChangeEnd > now) return;
    this._suppressChangeEnd = now + CONFIG.SUPPRESS_SWAP_TIME;
    this._suppressPending = !this.suppressed;
  }

  // ---- Looting / dropping gear ----
  dropCurrentWeapon() {
    if (this.loadout.length <= 1) return null; // never go empty-handed
    const id = this.loadout[this.slot];
    const ammo = this.ammo[id];
    this.loadout.splice(this.slot, 1);
    delete this.ammo[id];
    this.slot = Math.min(this.slot, this.loadout.length - 1);
    this.fireModeSel = this.weapon.fireMode; this._burstLeft = 0; this.reloading = false;
    return { id, ammo };
  }

  // Put a looted weapon (with its mags) into the current slot; return the old one.
  swapWeaponInSlot(id, ammoState) {
    const oldId = this.loadout[this.slot];
    const oldAmmo = this.ammo[oldId];
    this.loadout[this.slot] = id;
    if (oldId !== id) delete this.ammo[oldId];
    this.ammo[id] = ammoState || { loaded: WEAPON_BY_ID[id].mag, spares: [] };
    this.fireModeSel = this.weapon.fireMode; this._burstLeft = 0; this.reloading = false;
    return { id: oldId, ammo: oldAmmo };
  }

  // Whether you carry a weapon that uses this mag (so you can scavenge its ammo).
  carries(id) { return this.loadout.includes(id) && !!this.ammo[id]; }

  // Scavenge magazines for a gun you already carry — the loaded mag and every
  // spare become spare mags in your reserve. Returns how many mags you took.
  addAmmo(id, src) {
    const a = this.ammo[id];
    if (!a || !src) return 0;
    let mags = 0;
    if (src.loaded > 0) { a.spares.push(src.loaded); mags++; }
    for (const m of (src.spares || [])) if (m > 0) { a.spares.push(m); mags++; }
    return mags;
  }

  equipArmor(id, points) {
    const old = { id: this.armorId, points: this.armorPoints };
    this.setArmor(id);
    if (points != null) this.armorPoints = points;
    return old;
  }

  switchTo(slot) {
    slot = ((slot % this.loadout.length) + this.loadout.length) % this.loadout.length;
    if (slot === this.slot) return;
    this.slot = slot;
    this.reloading = false;
    this.bloom = 0;
    this.fireModeSel = this.weapon.fireMode;
    this._burstLeft = 0;
  }

  startReload(now) {
    const a = this._ammo, w = this.weapon;
    if (this.reloading || a.spares.length === 0 || a.loaded >= w.mag) return;
    this.reloading = true;
    this.reloadStart = now;
    this.reloadEnd = now + w.reload;
  }

  _finishReload() {
    // Swap magazines — loose rounds don't merge into a full mag. The old mag
    // (if it still holds rounds) is stowed at the back; empty mags are dropped.
    const a = this._ammo;
    if (a.spares.length > 0) {
      const incoming = a.spares.shift();
      const old = a.loaded;
      a.loaded = incoming;
      if (old > 0) a.spares.push(old);
    }
    this.reloading = false;
  }

  reloadProgress(now) {
    if (!this.reloading) return 0;
    return clamp((now - this.reloadStart) / (this.reloadEnd - this.reloadStart), 0, 1);
  }

  update(dt, control, game) {
    const now = game.time;
    if (!this.alive) return;
    this.ads = !!control.ads;
    this._aimDist = control.aimDist || this.weapon.range; // where this gun is zeroed
    this._zeroHeight = control.zeroHeight || CONFIG.TARGET_HEIGHT; // height aimed at

    // Stance transition — lower stances are slower but steadier and present a
    // lower profile (rounds pass overhead, low cover protects you).
    if (this.stanceLevel !== this.stanceTarget) {
      const s = Math.sign(this.stanceTarget - this.stanceLevel);
      this.stanceLevel += s * CONFIG.STANCE_RATE * dt;
      if ((s > 0) === (this.stanceLevel > this.stanceTarget)) this.stanceLevel = this.stanceTarget;
    }
    this.standHeight = lerpArr(CONFIG.STANCE_HEIGHT, this.stanceLevel);
    this._stanceAcc = lerpArr(CONFIG.STANCE_ACC, this.stanceLevel);
    const stanceSpeed = lerpArr(CONFIG.STANCE_SPEED, this.stanceLevel);

    // --- Stamina & sprint gating ---
    let mx = control.moveX, my = control.moveY;
    const mlen = Math.hypot(mx, my);
    const moving = mlen > 0;
    const extraKg = Math.max(0, this.encumbrance - CONFIG.LOAD_FREE_KG);

    let sprinting = false;
    if (control.sprint && !this.ads && moving && this.stanceTarget === 0) {
      sprinting = this._sprinting ? this.stamina > 0 : this.stamina > CONFIG.STAMINA_SPRINT_MIN;
    }
    this._sprinting = sprinting;

    // All movement costs stamina — sprint most, jog some, walk a little. Load
    // adds to it (fully when sprinting). You only recover standing still.
    let drain = 0;
    if (sprinting) {
      drain = CONFIG.STAMINA_SPRINT_DRAIN + CONFIG.STAMINA_LOAD_DRAIN * extraKg; // load only taxes sprint
    } else if (moving && !control.walk) {
      drain = CONFIG.STAMINA_JOG_DRAIN; // jogging is nearly free; walking & standing recover
    }
    if (this.ads) drain += CONFIG.ADS_STAMINA_DRAIN; // holding the gun up tires you
    // A leg wound is what really gasses you out — moving on it burns stamina fast
    // (so an unhurt soldier runs a long time, a hit one is quickly winded).
    if ((sprinting || (moving && !control.walk)) && this.legWound > 0.05) {
      drain += CONFIG.STAMINA_WOUND_DRAIN * this.legWound;
    }
    if (drain > 0) {
      this.stamina = Math.max(0, this.stamina - drain * dt);
      this._lastExert = now;
    } else if (now - this._lastExert > CONFIG.STAMINA_REGEN_DELAY) {
      this.stamina = Math.min(CONFIG.STAMINA_MAX, this.stamina + CONFIG.STAMINA_REGEN * dt);
    }

    // --- Movement ---
    const gait = control.walk ? CONFIG.SPEED_WALK : sprinting ? CONFIG.SPEED_SPRINT : CONFIG.SPEED_RUN;
    const loadMult = Math.max(CONFIG.LOAD_SLOW_MIN, 1 - extraKg * CONFIG.LOAD_SLOW_PER_KG);
    // Both legs hit and you're reduced to a crawl — one leg is a bad limp.
    const crippled = this.limb && this.limb.ll > 0.3 && this.limb.rl > 0.3;
    const legMult = Math.max(0.12, 1 - CONFIG.LEG_SLOW_MAX * this.legWound) * (crippled ? 0.3 : 1);
    const speed = gait * loadMult * (this.ads ? CONFIG.ADS_SLOW : 1) * legMult * stanceSpeed;

    if (moving) {
      mx /= mlen; my /= mlen;
      // Backpedalling/strafing relative to where you're facing is slower.
      const dot = mx * Math.cos(this.angle) + my * Math.sin(this.angle);
      const dirMult = dot > 0.35 ? 1 : dot < -0.35 ? CONFIG.BACKPEDAL_MULT : CONFIG.STRAFE_MULT;
      const sp = speed * dirMult;
      const tvx = mx * sp, tvy = my * sp;
      this.vx += (tvx - this.vx) * Math.min(1, CONFIG.ACCEL * dt);
      this.vy += (tvy - this.vy) * Math.min(1, CONFIG.ACCEL * dt);
    } else {
      const f = Math.max(0, 1 - CONFIG.FRICTION * dt);
      this.vx *= f; this.vy *= f;
    }
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    game.world.resolve(this, this.r);
    this.speedFrac = clamp(Math.hypot(this.vx, this.vy) / CONFIG.SPEED_SPRINT, 0, 1);

    // Bipod: prone + stationary + a bipod-capable weapon → rock-steady.
    if (this.stanceLevel > 1.5 && bipodCapable(this.weapon) && this.speedFrac < 0.03) {
      if (!this._proneStill) this._proneStill = now;
      this.bipod = now - this._proneStill > 0.4;
    } else { this._proneStill = 0; this.bipod = false; }

    // --- Aim (rate-limited by stance — you can't whip around prone) & recoil ---
    const turnRate = lerpArr(CONFIG.STANCE_TURN, this.stanceLevel) * (this.bipod ? 0.5 : 1);
    this.angle += clamp(angleDelta(this.angle, control.aim), -turnRate * dt, turnRate * dt);
    this.bloom = Math.max(0, this.bloom - this.weapon.bloomRecover * dt);

    // Suppressor attach/detach finishes after its timer.
    if (this._suppressChangeEnd && now >= this._suppressChangeEnd) {
      this.suppressed = this._suppressPending;
      this._suppressChangeEnd = 0;
    }

    // --- Wound recovery ---
    this.legWound = Math.max(0, this.legWound - CONFIG.WOUND_DECAY * dt);
    this.armWound = Math.max(0, this.armWound - CONFIG.WOUND_DECAY * dt);

    // --- Reload ---
    if (this.reloading && now >= this.reloadEnd) this._finishReload();
    if (control.reload) this.startReload(now);

    // --- Fire (respects the selected fire mode / safety) ---
    const w = this.weapon;
    const a = this._ammo;
    const mode = this.fireModeSel;
    const edge = control.fire && !this._prevFire;
    const ready = now - this.lastShot >= shotInterval(w);

    if (mode === 'safe') {
      if (edge && this === game.player) game.onDryFire();        // safety on: just a click
    } else if (this.reloading || this._suppressChangeEnd > now) {
      /* hands busy: reloading or changing the suppressor */
    } else if (a.loaded === 0) {
      if (edge && this === game.player) game.onDryFire(); // empty: just a click — press R to reload
    } else {
      if (mode === 'burst' && edge) this._burstLeft = Math.min(CONFIG.BURST_COUNT, a.loaded);
      const wantShot = mode === 'auto' ? control.fire
        : mode === 'burst' ? this._burstLeft > 0
        : edge; // semi / pump / bolt — one per trigger pull
      if (wantShot && ready) {
        this._fire(game, now);
        if (mode === 'burst') this._burstLeft = Math.max(0, this._burstLeft - 1);
      }
    }
    this._prevFire = control.fire;
  }

  _fire(game, now) {
    const w = this.weapon;
    const a = this._ammo;
    a.loaded--;
    this.lastShot = now;
    this._rounds++;

    // Launchers fire a rocket/missile instead of bullets.
    if (w.projectile) {
      const off = muzzleOffset(w, this.r);
      const mx = this.x + Math.cos(this.angle) * off, my = this.y + Math.sin(this.angle) * off;
      game.spawnProjectile(w.projectile, mx, my, this.angle, w, this.id, this.team);
      game.fx.muzzle(mx, my, this.angle, { caliber: 30 }, 1.8);
      game.onShot(this, w);
      return;
    }

    // Tracer ammo is mixed into belts/mags — roughly every 5th auto round.
    const tracer = auto4(w) && this._rounds % 5 === 0;

    // The AI shoulders its weapon and shoots AIMED (like you on right-click), not
    // from the hip — its miss comes from human aim error/convergence in think(),
    // not a permanently wild hip cone. That's why it can now shoot as well as you.
    const aimed = this.ads || this !== game.player;
    const adsFactor = aimed ? CONFIG.ADS_ACCURACY : CONFIG.HIPFIRE_MULT;
    const moveSpread = CONFIG.MOVE_SPREAD_MAX * this.speedFrac * (aimed ? 0.5 : 1);
    const breath = CONFIG.BREATH_SPREAD_MAX * (1 - this.stamina / CONFIG.STAMINA_MAX);
    const stanceMult = this._stanceAcc * (this.bipod ? CONFIG.BIPOD_ACC : 1);
    // A scoped gun fired from the hip is wild — you can't use the optic un-aimed.
    const hipOptic = aimed ? 0 : (w.optic.mag - 1) * CONFIG.HIPFIRE_OPTIC_PEN;
    const totalSpread = (w.spread * adsFactor + hipOptic + this.bloom + moveSpread
      + CONFIG.ARM_SPREAD_MAX * this.armWound + breath) * stanceMult;

    const off = muzzleOffset(w, this.r);
    const mx = this.x + Math.cos(this.angle) * off;
    const my = this.y + Math.sin(this.angle) * off;

    for (let i = 0; i < w.pellets; i++) {
      const s = (Math.random() + Math.random() - 1) * rad(totalSpread); // gaussian-ish
      game.bullets.push(new Bullet(mx, my, this.angle + s, w, this.id, this.team, tracer, this._aimDist, this._zeroHeight));
    }

    this.bloom = Math.min(w.bloomMax, this.bloom + w.bloomPer);
    game.fx.muzzle(mx, my, this.angle, w, this.suppressed ? 0.35 : 1);
    game.onShot(this, w);
  }
}

const auto4 = (w) => w.fireMode === 'auto';

// ---------------------------------------------------------------------------
// Bot — produces a `control` each frame from simple sense/aim/move AI.
// ---------------------------------------------------------------------------
export class Bot extends Combatant {
  constructor(id, loadout, name, armorId, team = 'enemy') {
    super(id, team, loadout, name, armorId);
    this.friendly = team === 'player';
    this._slot = 0; // formation slot index (friendlies)
    this.wander = { x: 0, y: 0, until: 0 };
    this.seenSince = -1;
    this.burstUntil = 0;
    this.restUntil = 0;
    this.strafeDir = pick([-1, 1]);
    this.strafeFlip = 0;
    this._alertAngle = 0;
    this._alertUntil = 0;
    this._posture = pick([0, 0, 0, 1, 1, 2]); // most stand, some crouch, a few go prone & hold
    this._coverUntil = 0; // dropped to prone when recently shot at
    // Personal formation offsets so a squad spreads out (not shoulder to shoulder).
    this._formJit = rand(-0.4, 0.4);   // angular offset in formation (radians)
    this._formR = rand(0.85, 1.45);    // personal spacing multiplier
    this._steerBias = pick([-1, 1]);   // which way it prefers to sidestep an obstacle
    this._playDead = false;            // feigning death to ambush
    this._playDeadUntil = 0;
    this._feignCd = 0;                 // cooldown before it can feign again
    this._scatterUntil = 0;            // taking cover / fleeing a nearby explosion
    this._scatterX = 0; this._scatterY = 0;
  }

  // Local obstacle avoidance: deflect a desired heading to clear solid cover just
  // ahead, sweeping outward to find a gap/doorway. Not full pathfinding — enough
  // to stop bots grinding into a wall and to walk them out through openings.
  _steer(game, ang) {
    // Look further ahead when moving fast, so a walking wall of a building is seen
    // in time to swing around it — a short probe let leaders wedge into corners.
    const probe = 5.0 + this.speedFrac * 3;
    const clear = (a) => !game.world.firstCoverHit(
      this.x, this.y, this.x + Math.cos(a) * probe, this.y + Math.sin(a) * probe);
    if (clear(ang)) { this._steerCommit = 0; return ang; }         // open ahead → straight
    const now = game.time;
    const offs = [0.5, 0.9, 1.4, 2.0, 2.6];
    // COMMIT to ONE side while going around something (real people pick left OR right
    // and hold it). Crucially, while committed we ONLY probe that side — otherwise the
    // "try the other side" branch keeps flipping the choice every frame and the unit
    // oscillates in place, never clearing the wall (the "stuck in a weird loop" bug).
    if (now < (this._steerCommit || 0)) {
      const b = this._steerSide;
      for (const off of offs) if (clear(ang + off * b)) return ang + off * b;
      return ang + (Math.PI / 2) * b;                              // still boxed → slide along the wall
    }
    // Fresh decision: probe both sides, take the first gap, and lock that side in.
    const b = this._steerBias;
    for (const off of offs) {
      if (clear(ang + off * b)) { this._steerSide = b; this._steerCommit = now + 1.4; return ang + off * b; }
      if (clear(ang - off * b)) { this._steerBias = this._steerSide = -b; this._steerCommit = now + 1.4; return ang - off * b; }
    }
    this._steerSide = b; this._steerCommit = now + 1.4;            // boxed → commit a side, slide along
    return ang + (Math.PI / 2) * b;
  }

  // The nearest NON-INFANTRY threat this bot can see & reach — a hostile drone or a
  // hostile (enemy-crewed) vehicle. Bots engage whatever is killing their team, not
  // just other riflemen: shoot down drones, hose the technical bearing down on you.
  _threat(game) {
    const half = rad(CONFIG.FOV_DEG / 2), reach = this.weapon.rangeMax * 0.55;
    const cand = [];
    // The player's piloted drone is a hostile aircraft to the enemy; enemy drones/FPVs
    // are hostile aircraft to your allies. Aircraft have no .radius (that's how the
    // targeting below tells "heard overhead" from a ground vehicle).
    // (A recon UAV flies too high to engage — enemies don't bother with it.)
    if (!this.friendly && game.player.piloting && !game.player.piloting.dead
      && game.player.piloting.type !== 'recon') cand.push(game.player.piloting);
    if (this.friendly) {
      if (game.enemyDrones) for (const d of game.enemyDrones) if (!d.dead) cand.push(d);
      if (game.enemyFpvs) for (const d of game.enemyFpvs) if (!d.dead) cand.push(d);
    }
    const haveAT = this._at || !!this.weapon.projectile; // an RPG/launcher in hand
    if (game.vehicles) for (const v of game.vehicles) {
      if (v.dead) continue;
      const crew = v.crewShooter && v.crewShooter();
      if (!crew || crew.team === this.team) continue;
      // Don't waste small arms on a tank you literally cannot scratch — only the
      // anti-armor gunner engages a small-arms-proof rig. Light vehicles: anyone.
      if (v.s.armorRifle >= 1 && !haveAT) continue;
      cand.push(v);
    }
    let best = null, bd = reach * reach;
    for (const t of cand) {
      const dx = t.x - this.x, dy = t.y - this.y, dd = dx * dx + dy * dy;
      if (dd >= bd) continue;
      // An aircraft buzzing/bombing overhead is HEARD from any direction when close —
      // no facing cone, no line-of-sight needed (it's above the cover). So a bot being
      // bombed looks up and shoots back instead of ignoring the drone behind its head.
      const heardOverhead = t.radius === undefined && dd < 48 * 48;
      if (!heardOverhead) {
        if (Math.abs(angleDelta(this.angle, Math.atan2(dy, dx))) > half) continue;
        if (!game.world.visible(this.x, this.y, t.x, t.y)) continue;
      }
      bd = dd; best = t;
    }
    return best;
  }

  think(dt, game) {
    const c = { moveX: 0, moveY: 0, aim: this.angle, fire: false, reload: false, sprint: false, walk: false, ads: false };
    if (!this.alive) return c;

    const now = game.time;
    let w = this.weapon; // may change below if an AT gunner brings up the launcher

    // Run the weapon on auto/burst so the AI actually lays down fire in a
    // firefight (a human would too) — not one round per trigger pull. The
    // burst scheduler keeps it to short, controlled bursts.
    if (this.fireModeSel === 'safe' || this.fireModeSel === 'semi') {
      if (w.fireModes.includes('auto')) this.fireModeSel = 'auto';
      else if (w.fireModes.includes('burst')) this.fireModeSel = 'burst';
    }

    // Feigning death: lie still (prone), no fire, until an enemy strays close —
    // then spring the ambush (or give it up after a while).
    if (this._playDead) {
      this.stanceTarget = 2;
      let closest2 = Infinity;
      for (const e of game.all) {
        if (e.team === this.team || !e.alive || e.inVehicle) continue;
        const dd = (e.x - this.x) ** 2 + (e.y - this.y) ** 2;
        if (dd < closest2) closest2 = dd;
      }
      if (closest2 < 8 * 8 || now > this._playDeadUntil) {
        this._playDead = false; this._feignCd = now + 22; // pop up and fight
      } else {
        return c; // hold — motionless body
      }
    }

    if (this.mag === 0 && this.magsLeft > 0) c.reload = true;

    // Bone dry? Scavenge a weapon off a nearby body — a fallen mate or a dead foe.
    if (this.mag === 0 && this.magsLeft === 0) {
      const corpse = game._nearestArmedCorpse(this, 24);
      if (corpse) {
        const d = dist(this.x, this.y, corpse.x, corpse.y);
        if (d < 1.6) game._botScavenge(this, corpse); // grab it and fight on
        else {
          const a = Math.atan2(corpse.y - this.y, corpse.x - this.x);
          c.aim = a; c.moveX = Math.cos(a); c.moveY = Math.sin(a);
          if (d > 6) c.sprint = true;
          return c;
        }
      }
    }
    this.stanceTarget = 0;
    if (now < this._coverUntil) this.stanceTarget = 2; // hit recently → prone for cover

    // Instinct / self-preservation: if the player is close and pointing their gun
    // right AT you, you get wary — CONTINUOUSLY, every frame they keep it on you.
    if (this.friendly && game.player.alive && game.player !== this && !game.player.inVehicle) {
      const pl = game.player, dx = this.x - pl.x, dy = this.y - pl.y, dd = dx * dx + dy * dy;
      if (dd < 13 * 13 && Math.abs(angleDelta(pl.angle, Math.atan2(dy, dx))) < 0.22) {
        // Only SUS if there's no reason to be pointing here — i.e. no enemy ahead of
        // you along your aim (if you're aiming past them at a hostile, that's fine).
        const ca = Math.cos(pl.angle), sa = Math.sin(pl.angle);
        let enemyAhead = false;
        for (const e of game.all) {
          if (e.team === pl.team || !e.alive || e.inVehicle) continue;
          const ex = e.x - pl.x, ey = e.y - pl.y, along = ex * ca + ey * sa;
          if (along > 2 && along < 140 && Math.abs(-ex * sa + ey * ca) < 7) { enemyAhead = true; break; }
        }
        // …and even then they only clock it SOMETIMES (a beat, not instantly).
        if (!enemyAhead && (now < (this._spooked || 0) || Math.random() < 0.035)) this._spooked = now + 1.2;
      }
    }

    // Turn on the player: because they friendly-fired you (angry), OR pure instinct
    // because they're aiming a gun at you point-blank (wary). This holds as long as
    // the condition keeps refreshing — it's continuous, not a one-off flinch.
    const hostile = now < (this._angryUntil || 0);
    const wary = now < (this._spooked || 0);
    if (this.friendly && (hostile || wary) && game.player.alive && game.player !== this) {
      const t = game.player, d = dist(this.x, this.y, t.x, t.y);
      c.aim = Math.atan2(t.y - this.y, t.x - this.x);
      c.aimDist = d; c.zeroHeight = clamp(t.standHeight * 0.55, 0.25, 1.05);
      this._alertUntil = now + 2;
      const perp = c.aim + Math.PI / 2 * this.strafeDir;
      c.moveX = Math.cos(perp) + (d < 14 ? -Math.cos(c.aim) : 0);
      c.moveY = Math.sin(perp) + (d < 14 ? -Math.sin(c.aim) : 0);
      if (now > this.restUntil) { this.burstUntil = now + rand(0.25, 0.6); this.restUntil = this.burstUntil + rand(0.5, 1.1); }
      // If you actually wronged them → they shoot at any range. On pure instinct →
      // they fire back only when you're close AND clearly menacing (aimed in / shooting).
      const menacing = t.ads || now - t.lastShot < 0.6;
      const canFire = this.mag > 0 && (hostile || (d < 8 && menacing));
      c.fire = canFire && now < this.burstUntil;
      return c;
    }

    // Engage the nearest enemy this bot can actually see (any opposite team). The
    // O(n) scan per bot is the dominant cost in huge (division-scale) battles, so
    // RE-ACQUIRE only ~8×/s, staggered per bot — a target holds fine for a tenth of a
    // second, and the bot still aims/moves/fires at it smoothly every frame. If the
    // held target dies or mounts up, re-scan immediately.
    let target = this._cachedEnemy;
    if (!target || !target.alive || target.inVehicle || now >= (this._retargetAt || 0)) {
      target = this._cachedEnemy = game.nearestEnemy(this);
      if (this._retargetJit === undefined) this._retargetJit = Math.random() * 0.08;
      this._retargetAt = now + 0.1 + this._retargetJit;
    }
    const threat = this._threat(game); // a drone/vehicle threat (bombing you, etc.)
    // Keep fighting riflemen by default — only PEEL OFF for a threat that's right on
    // top of you (immediate), or, for an anti-armor gunner, an enemy vehicle (their
    // job). Otherwise engage the drone/vehicle only when there's no rifleman to
    // shoot. This stops one loitering drone from freezing the whole enemy line.
    let dThreat = null;
    if (threat) {
      const td = (threat.x - this.x) ** 2 + (threat.y - this.y) ** 2;
      const isVeh = threat.radius !== undefined; // vehicles carry a .radius
      // A hostile DRONE overhead is a shared air threat — bots within ~48 m look up
      // and hose it (so the squad being bombed shoots back at your drone). Kept local
      // so one loitering drone doesn't freeze the whole line. Vehicles: point-blank
      // only, or if you're the anti-armor gunner.
      const range = isVeh ? 22 : 48;
      if (!target || td < range * range || (this._at && isVeh)) { dThreat = threat; target = null; }
    }

    // Specialist with a launcher: bring the tube up for the right threat.
    //  · AT gunner — a vehicle (always), or a cluster of infantry / a distant target
    //    at a safe standoff (real RPG gunners bust groups & cover, not just tanks).
    //  · AA gunner — an enemy AIRCRAFT (the player's drone) → Stinger it.
    if ((this._at || this._aa) && this.loadout.length > 1 && !this.reloading) {
      const li = this.loadout.findIndex((id) => WEAPON_BY_ID[id].projectile);
      const ri = this.loadout.findIndex((id) => !WEAPON_BY_ID[id].projectile);
      const lid = li >= 0 ? this.loadout[li] : null;
      const am = lid ? this.ammo[lid] : null;
      const rocketsLeft = am ? (am.loaded || 0) + am.spares.length : 0;
      let wantLauncher = this._aa
        ? rocketsLeft > 0 && !!(dThreat && dThreat.battery !== undefined) // an aircraft
        : !!(dThreat && dThreat.radius !== undefined);                    // a vehicle
      if (!this._aa && !wantLauncher && rocketsLeft > 0 && target && now > (this._atSalvoCd || 0)) {
        // CONSERVE rockets for armour: hold back one per live enemy vehicle on the
        // field, and only spend the surplus on infantry. Lots of vehicles early → they
        // stay AT-focused; once the armour's gone they'll happily rocket foot troops.
        let foeVehicles = 0;
        for (const v of game.vehicles) {
          if (v.dead) continue;
          const crew = v.crewShooter && v.crewShooter();
          if (crew && crew.team !== this.team) foeVehicles++;
        }
        if (rocketsLeft > foeVehicles) {                          // surplus beyond the armour reserve
          const dt2 = (target.x - this.x) ** 2 + (target.y - this.y) ** 2;
          if (dt2 > 18 * 18 && dt2 < 170 * 170) {                 // safe standoff, in range
            let cluster = 0;                                       // enemies bunched at the aim point
            for (const e of game.all) {
              if (!e.alive || e.inVehicle || e.team === this.team) continue;
              if ((e.x - target.x) ** 2 + (e.y - target.y) ** 2 < 7 * 7) cluster++;
            }
            if (cluster >= 2 || dt2 > 55 * 55) {                   // a group, or a lone target at distance
              wantLauncher = true;
              this._atSalvoCd = now + rand(7, 13);                 // then lower it and rifle again
            }
          }
        }
      }
      if (rocketsLeft <= 0) wantLauncher = false;
      const want = wantLauncher && li >= 0 ? li : ri;
      if (want >= 0 && want !== this.slot) { this.switchTo(want); w = this.weapon; }
    }

    if (target) {
      if (this.seenSince < 0) this.seenSince = now;
      this._alertUntil = now + 4;
      // Call it out: an ally who sees an enemy marks it on the shared map so the
      // whole squad (and you) can see the contact for a few seconds.
      if (this.friendly) target._spottedUntil = now + 4;
      const toAng = Math.atan2(target.y - this.y, target.x - this.x);
      this._alertAngle = toAng;
      const d = dist(this.x, this.y, target.x, target.y);
      c.aimDist = d;

      // Wounded and pressed? An enemy bot MIGHT drop and feign death to ambush —
      // but rarely, so they don't take themselves out of the fight en masse.
      if (!this.friendly && now > this._feignCd && this.hp < this.maxHp * 0.28 && d < 22 && Math.random() < 0.0022) {
        this._playDead = true; this._playDeadUntil = now + rand(6, 14);
        this.stanceTarget = 2; return c;
      }

      // Cook off a grenade at a target in the mid-range danger zone (cover-buster).
      if (this.grenades > 0 && now > (this._nadeCd || 0) && d > 9 && d < 30 && Math.random() < 0.005) {
        this.grenades--; this._nadeCd = now + rand(6, 12);
        game._botThrowGrenade(this, target.x, target.y);
      }

      c.zeroHeight = clamp(target.standHeight * 0.55, 0.25, 1.05); // aim center mass (low if prone)
      // Lead a moving target by the round's time-of-flight. A slow rocket needs a
      // fuller lead than a rifle round, or it lands behind a moving target.
      const tof = d / w.velocity;
      const leadK = w.projectile ? 1.0 : 0.8;
      const px = target.x + (target.vx || 0) * tof * leadK;
      const py = target.y + (target.vy || 0) * tof * leadK;
      const toAim = Math.atan2(py - this.y, px - this.x);
      // Aim CONVERGES the longer it holds the target (acquire → range → steady),
      // and worsens while the bot itself is moving — a settled shooter is deadly.
      const settle = clamp((now - this.seenSince) / 1.1, 0, 1);
      const err = rad(CONFIG.BOT_AIM_ERROR * (1 - 0.6 * settle)) * (0.5 + this.speedFrac);
      c.aim = toAim + (Math.random() - 0.5) * 2 * err;

      if (now > this.strafeFlip) { this.strafeDir *= -1; this.strafeFlip = now + rand(0.7, 1.8); }
      const perp = toAng + Math.PI / 2 * this.strafeDir;
      let mvx = Math.cos(perp), mvy = Math.sin(perp);
      // The assaulting side CLOSES the distance (a real push), not just plinks from a
      // long standoff — it holds a tighter fighting range and keeps pressing forward,
      // so a numerically superior attacker actually advances onto you.
      const aggressive = !this.friendly || game.squadOrder === 'push';
      const ideal = w.range * (aggressive ? 0.42 : 0.6);
      const towards = d > ideal ? (aggressive ? 1 : 0.25)
        : d < ideal * 0.5 ? -1 : (aggressive ? 0.25 : 0);   // keep leaning in even in the band
      mvx += Math.cos(toAng) * towards; mvy += Math.sin(toAng) * towards;
      c.moveX = mvx; c.moveY = mvy;

      // Friendly posture depends on your order: HOLD/SUPPRESS = prone & firm,
      // FOLLOW = fight from cover near you, PUSH = press the attack.
      if (this.friendly) {
        const o = game.squadOrder;
        if (o === 'hold' || o === 'suppress') { this.stanceTarget = 2; c.moveX *= 0.15; c.moveY *= 0.15; }
        else if (o === 'follow') {
          if (this._posture === 0) this.stanceTarget = 1;
          const anc = game.squadRally || game.player;
          // Long leash — fight your own fight, only peel back if you drift far.
          if (dist(this.x, this.y, anc.x, anc.y) > 48) {
            const a = Math.atan2(anc.y - this.y, anc.x - this.x);
            c.moveX = Math.cos(a); c.moveY = Math.sin(a);
          }
        }
      }
      if (this._posture > 0) { this.stanceTarget = this._posture; c.moveX *= 0.2; c.moveY *= 0.2; }
      // Marksman/scout: hold and shoot from a steady prone (bipod), don't charge in.
      if (this._scout) { this.stanceTarget = 2; c.moveX *= 0.05; c.moveY *= 0.05; }

      const reacted = now - this.seenSince > CONFIG.BOT_REACTION;
      if (reacted && this.mag > 0) {
        if (now > this.restUntil) { this.burstUntil = now + rand(0.3, 0.7); this.restUntil = this.burstUntil + rand(0.4, 1.0); }
        // A rocket loosed mid-turn flies wide — hold it until the tube is on target.
        const laid = !w.projectile || Math.abs(angleDelta(this.angle, c.aim)) < 0.05;
        c.fire = laid && now < this.burstUntil;
      }
    } else if (dThreat) {
      // No ground target, but a hostile vehicle/drone is the threat — engage it, and
      // LEAD it by the round's time-of-flight so a slow rocket meets a moving tank
      // instead of trailing behind it (why enemy RPGs were "mostly missing"). Vehicles
      // carry no vx/vy, so derive it from heading × speed.
      const ddT = dist(this.x, this.y, dThreat.x, dThreat.y);
      const tvx = dThreat.vx !== undefined ? dThreat.vx
        : dThreat.speed !== undefined ? Math.cos(dThreat.angle) * dThreat.speed : 0;
      const tvy = dThreat.vy !== undefined ? dThreat.vy
        : dThreat.speed !== undefined ? Math.sin(dThreat.angle) * dThreat.speed : 0;
      const tofT = ddT / (w.velocity || 400);
      const leadT = w.projectile ? 1.0 : 0.85;
      const lxT = dThreat.x + tvx * tofT * leadT, lyT = dThreat.y + tvy * tofT * leadT;
      c.aim = Math.atan2(lyT - this.y, lxT - this.x);
      c.aimDist = ddT; c.zeroHeight = 1.0;
      this._alertUntil = now + 3;
      // Hold the shot until the launcher is actually laid on the lead.
      const laidT = !w.projectile || Math.abs(angleDelta(this.angle, c.aim)) < 0.05;
      if (now > this.restUntil) { this.burstUntil = now + rand(0.3, 0.6); this.restUntil = this.burstUntil + rand(0.4, 0.9); }
      c.fire = this.mag > 0 && laidT && now < this.burstUntil;
    } else if (this.friendly) {
      this.seenSince = -1;
      // Your fire-team leaders mount up in an idle rig too (like the enemy does).
      let veh = null;
      if (this._wantsVehicle) {
        let vd = 130 * 130;
        for (const v of game.vehicles) {
          if (v.dead || v.driver) continue;
          const d2 = (v.x - this.x) ** 2 + (v.y - this.y) ** 2;
          if (d2 < vd) { vd = d2; veh = v; }
        }
      }
      if (veh) {
        const a = Math.atan2(veh.y - this.y, veh.x - this.x);
        c.aim = a; c.moveX = Math.cos(a); c.moveY = Math.sin(a);
        if (dist(this.x, this.y, veh.x, veh.y) > 10) c.sprint = true;
      } else {
        // Battalion hierarchy: squad LEADERS take your battalion order; squad
        // MEMBERS stick to their own leader (not to you directly).
        const ldr = !this._isLeader ? game.squadLeader(this) : null;
        if (ldr) this._trailLeader(c, game, ldr);
        else this._follow(c, game); // leaders (and any orphaned ally) obey the order
      }
    } else if (now < this._alertUntil) {
      this.seenSince = -1;
      c.aim = this._alertAngle;
      c.moveX = Math.cos(this._alertAngle); c.moveY = Math.sin(this._alertAngle);
    } else {
      this.seenSince = -1;
      // A designated crew bot makes for the nearest idle vehicle to commandeer it.
      let veh = null;
      if (this._wantsVehicle) {
        let vd = 130 * 130;
        for (const v of game.vehicles) {
          if (v.dead || v.driver) continue;
          const d2 = (v.x - this.x) ** 2 + (v.y - this.y) ** 2;
          if (d2 < vd) { vd = d2; veh = v; }
        }
      }
      // Squad cohesion: followers trail their fire-team leader (so a side moves
      // as organized squads); leaders (and lone bots) roam toward the fight.
      const ldr = !this._isLeader ? game.squadLeader(this) : null;
      if (veh) {
        const a = Math.atan2(veh.y - this.y, veh.x - this.x);
        c.aim = a; c.moveX = Math.cos(a); c.moveY = Math.sin(a);
        if (dist(this.x, this.y, veh.x, veh.y) > 10) c.sprint = true;
      } else if (ldr) {
        this._trailLeader(c, game, ldr);
      } else {
        if (now > this.wander.until || dist(this.x, this.y, this.wander.x, this.wander.y) < 3) {
          let tx, ty;
          if (!this.friendly && game.player.alive) {
            // ADVANCE on the enemy's MAIN BODY (your force concentrates on you), so
            // the whole enemy battalion masses on the same axis in a broad assault
            // line — not each squad peeling to a different target and losing piecemeal.
            tx = game.player.x + rand(-70, 70);
            ty = game.player.y + rand(-70, 70);
          } else {
            const p = game.world.randomSpawn(this.r); tx = p.x; ty = p.y;
          }
          this.wander.x = clamp(tx, 2, game.world.w - 2);
          this.wander.y = clamp(ty, 2, game.world.h - 2);
          this.wander.until = now + rand(3, 7);
        }
        const ang = Math.atan2(this.wander.y - this.y, this.wander.x - this.x);
        c.aim = ang; c.moveX = Math.cos(ang); c.moveY = Math.sin(ang);
      }
    }

    // Under explosives: break off and sprint OFF the impact (and disperse) instead
    // of mindlessly marching into a bombing run. They keep returning fire as they go.
    if (now < this._scatterUntil) {
      this.stanceTarget = 0; // run out of the beaten zone, don't crawl
      const ax = this.x - this._scatterX, ay = this.y - this._scatterY, al = Math.hypot(ax, ay) || 1;
      c.moveX = ax / al; c.moveY = ay / al; c.sprint = true;
    }

    // Fire discipline — never shoot through your own; check the whole lane to the
    // target. And a LAUNCHER (RPG) holds if a mate is in its blast radius at the
    // impact point (so RPG gunners stop nuking their own massed troops).
    if (c.fire && game.friendlyBlockingFire(this, c.aim, c.aimDist)) c.fire = false;
    if (c.fire && this.weapon.projectile && game.friendlySplash(this, c.aim, c.aimDist)) c.fire = false;

    // Dispersion — infantry keep spacing; they don't flock like a flock of birds.
    // Nudge away from any teammate crowding within ~4 m (skip when holding prone).
    // This all-teammate scan is another O(n) per bot, so cache the nudge and refresh
    // it ~8×/s (staggered) — spacing drifts slowly, the lag is invisible.
    if (this.stanceTarget < 2) {
      if (now >= (this._dispAt || 0)) {
        let sx = 0, sy = 0;
        for (const e of game.all) {
          if (e === this || e.team !== this.team || !e.alive || e.inVehicle) continue;
          const dx = this.x - e.x, dy = this.y - e.y, d2 = dx * dx + dy * dy;
          if (d2 < 16 && d2 > 0.05) { const inv = 1 / Math.sqrt(d2); sx += dx * inv; sy += dy * inv; }
        }
        this._dispX = sx; this._dispY = sy;
        this._dispAt = now + 0.12 + (this._retargetJit || 0);
      }
      c.moveX += (this._dispX || 0) * 0.7; c.moveY += (this._dispY || 0) * 0.7;
    }

    // Obstacle avoidance — steer the final heading around walls / into doorways.
    const ml = Math.hypot(c.moveX, c.moveY);
    if (ml > 0.05) {
      const desired = Math.atan2(c.moveY, c.moveX);
      const a = this._steer(game, desired);
      if (a !== desired) { c.moveX = Math.cos(a) * ml; c.moveY = Math.sin(a) * ml; }
    }
    return c;
  }

  // Friendly squad movement/behaviour when there's no enemy in sight — driven
  // by your order (Y): follow · push · suppress · hold.
  _follow(c, game) {
    const p = game.player, o = game.squadOrder, now = game.time;
    // Map ping: an ordered rally point becomes the squad's anchor instead of you.
    const anchor = game.squadRally || p;

    if (o === 'hold') { this.stanceTarget = 2; c.aim = p.angle; return; } // go firm & prone

    if (o === 'suppress') { // go prone and rake the lane you're pointing down
      this.stanceTarget = 2;
      const ax = p.x + Math.cos(p.angle) * 100, ay = p.y + Math.sin(p.angle) * 100;
      c.aim = Math.atan2(ay - this.y, ax - this.x); c.aimDist = 100;
      if (this.mag > 0) {
        if (now > this.restUntil) { this.burstUntil = now + rand(0.4, 0.8); this.restUntil = this.burstUntil + rand(0.7, 1.3); }
        c.fire = now < this.burstUntil;
      }
      return;
    }

    if (o === 'push') { // advance on the nearest enemy to flush them out
      let near = null, bd = Infinity;
      for (const e of game.all) {
        if (e.team === this.team || !e.alive || e.inVehicle) continue;
        const d = dist(this.x, this.y, e.x, e.y);
        if (d < bd) { bd = d; near = e; }
      }
      const tx = near ? near.x : p.x + Math.cos(p.angle) * 22;
      const ty = near ? near.y : p.y + Math.sin(p.angle) * 22;
      const a = Math.atan2(ty - this.y, tx - this.x);
      c.aim = a; c.moveX = Math.cos(a); c.moveY = Math.sin(a);
      return;
    }

    // FOLLOW: fire-team LEADERS fan out around the battalion axis (you, or a
    // pinged rally point), each squad taking its own sector tens of metres out.
    // Their members trail them — so the whole battalion moves as organized squads.
    const nSq = Math.max(1, game._squadCount || 1);
    const ang = p.angle + Math.PI + (this._squadId - (nSq - 1) / 2) * 0.7 + this._formJit;
    const fd = (16 + (this._squadId % 3) * 9) * this._formR;
    const fx = anchor.x + Math.cos(ang) * fd, fy = anchor.y + Math.sin(ang) * fd;
    const d = dist(this.x, this.y, fx, fy);
    if (d > 5) { // bigger dead-zone → squads settle into their sectors, not on a point
      const a = Math.atan2(fy - this.y, fx - this.x);
      c.aim = a; c.moveX = Math.cos(a); c.moveY = Math.sin(a);
      if (d > 22) c.sprint = true;
    } else {
      c.aim = p.angle;
    }
  }

  // Trail your fire-team leader in a wide, jittered wedge. Shared by both sides,
  // so every squad on the field moves as a group behind its own leader.
  _trailLeader(c, game, ldr) {
    // Friendly members mirror the battalion posture when you order HOLD/SUPPRESS.
    if (this.friendly && (game.squadOrder === 'hold' || game.squadOrder === 'suppress')) {
      this.stanceTarget = 2;
    }
    const fa = ldr.angle + Math.PI + (this._slot - 2) * 0.55 + this._formJit;
    const rr = (11 + (this._slot % 3) * 6) * this._formR;
    const fx = ldr.x + Math.cos(fa) * rr, fy = ldr.y + Math.sin(fa) * rr;
    const d = dist(this.x, this.y, fx, fy);
    if (d > 3.5) {
      const a = Math.atan2(fy - this.y, fx - this.x);
      c.aim = a; c.moveX = Math.cos(a); c.moveY = Math.sin(a);
      if (d > 18) c.sprint = true;
    } else {
      c.aim = ldr.angle;
    }
  }
}
