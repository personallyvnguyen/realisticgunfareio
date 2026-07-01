import { CONFIG } from './config.js';
import { World } from './world.js';
import { Combatant, Bot } from './entities.js';
import { Effects } from './effects.js';
import { DEFAULT_LOADOUT, WEAPON_BY_ID, isRifleRound } from './weapons.js';
import { ARMOR_BY_ID, SUPPORT, VEHICLE_WEAPONS } from './config.js';
import { Vehicle, Shell } from './vehicles.js';
import { Drone, Bomb, EnemyDrone, EnemyFpv } from './drones.js';
import { Rocket, Missile, Grenade } from './projectiles.js';
import { DRONES } from './config.js';
import { Sound } from './audio.js';
import { clamp, lerp, rand, pick, rad, angleDelta, TAU } from './math.js';

const BOT_NAMES = ['Volkov', 'Reyes', 'Tanaka', 'Mueller', 'Okafor', 'Petrov', 'Nguyen', 'Silva', 'Cole', 'Haas'];
const BOT_GUNS = ['ak47', 'm4a1', 'mp5', 'ar15', 'glock17'];
const BOT_ARMOR = ['none', 'soft', 'soft', 'plate3'];

export class Game {
  constructor(canvas, minimap, input) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.minimap = minimap;
    this.mctx = minimap.getContext('2d');
    this.input = input;

    this.world = new World();
    this.fx = new Effects();
    this.bullets = [];
    this.time = 0;
    this.zoom = CONFIG.ZOOM_DEFAULT;       // hipfire zoom (user scroll)
    this.renderZoom = CONFIG.ZOOM_DEFAULT; // smoothed zoom actually rendered
    this._opticZoom = 6;                   // current magnification of a variable (LPVO) optic
    this._effMag = 1;                      // effective optic magnification this frame
    this._recoil = { x: 0, y: 0 };         // reticle kick from firing (screen px), recovers
    this.cam = { x: this.world.w / 2, y: this.world.h / 2 };
    this.killfeed = [];
    this._eventBanner = null; // center-screen "ELIMINATED" / "KILLED BY" popup
    // Team deathmatch: no respawns. The match runs until one side is wiped out.
    this.matchOver = false;
    this.matchResult = null; // 'victory' | 'defeat'
    this.score = { player: 0, enemy: 0 };  // legit (cross-team) kills per side
    this.ff = { player: 0, enemy: 0 };     // friendly-fire kills per side
    this._deaths = 0;                       // times YOU have been dropped (you take over a mate)
    this._playerFF = 0;                     // teamkills YOU committed
    this._ffHeat = 0;                       // how obvious your friendly fire is (decays)
    this.squadRally = null;  // map-pinged rally point for your squad, or null
    this.running = false;
    this._aimSway = null;
    this._playerWasReloading = false;
    this.threats = [];   // directional incoming-fire markers
    this.corpses = [];   // bodies left on the ground
    this.loot = [];      // gear dropped on the ground
    this._lootTarget = null;
    this.vehicles = [];
    this.shells = [];
    this.drones = [];
    this.bombs = [];
    this.projectiles = [];   // rockets + guided missiles
    this.thrownGrenades = [];
    this.enemyDrones = [];
    this._nextEnemyDrone = 30; // seconds until the next hostile air threat
    this.enemyFpvs = [];
    this._nextEnemyFpv = 48;   // seconds until the first hostile kamikaze FPV
    this._nextEnemyStrike = 55; this._enemyStrike = null; // enemy calls fire on your force
    this.bomberReadyAt = 0; this.fpvReadyAt = 0;
    this._entering = null; // { vehicle, until } while climbing into a vehicle
    this.pings = [];     // radio ping markers
    this.uavUntil = 0; this.uavReadyAt = 0;
    this.strikeReadyAt = 0; this.strikePending = null;

    this.player = new Combatant('you', 'player', ['m4a1', 'glock17'], 'You', 'plate3');
    this._basePlayer = this.player; // canonical you (restored each deploy after any take-overs)
    const sp = this.world.randomSpawn();
    this.player.spawnAt(sp.x, sp.y);

    this.bots = [];
    for (let i = 0; i < CONFIG.BOT_COUNT; i++) this._spawnBot(i);

    this.squad = [];          // friendly AI teammates
    this.squadOrder = 'push'; // default: advance on the enemy ('follow'/'suppress'/'hold' via Y)
    this._squadCount = 0;      // number of fire-teams per side (set at deploy)

    for (const type of ['car', 'technical', 'tank']) {
      const s = this.world.randomSpawn(4);
      this.vehicles.push(new Vehicle(type, s.x, s.y));
    }

    this.all = [this.player, ...this.squad, ...this.bots];
    this._buildRack();
    this._cacheHud();
    this._wireMinimap();
    this._wireHudClicks();
  }

  // Click the HUD to control — every prompt is a button. Keys still work too.
  _wireHudClicks() {
    const on = (id, handler) => { const el = document.getElementById(id); if (el) el.addEventListener('click', handler); };
    // Ability chips fire their support option.
    on('abilities', (e) => {
      const el = e.target.closest('[data-act]'); if (!el || !this.running) return;
      const a = el.dataset.act, c = this.screenToWorld(this.canvas.width / 2, this.canvas.height / 2);
      if (a === 'uav') this._callUAV();
      else if (a === 'strike') this._callStrike(c.x, c.y);
      else if (a === 'bomber') this._toggleDrone('bomber');
      else if (a === 'fpv') this._toggleDrone('fpv');
      else if (a === 'ping') this._ping(c.x, c.y);
    });
    // Weapon rack slots switch weapon.
    on('weapons-rack', (e) => {
      const el = e.target.closest('[data-idx]'); if (!el || !this.running) return;
      this.player.switchTo(+el.dataset.idx);
    });
    // The ammo panel is a reload button (but the fire-selector chip keeps its job).
    on('ammo', (e) => {
      if (e.target.closest('#firemode')) return;
      if (this.running && !this.player.inVehicle) this.player.startReload(this.time);
    });
    // Click the squad readout to cycle the battalion order (same as Y).
    on('scale-readout', (e) => {
      if (!e.target.closest('[data-act="squad"]') || !this.squad.length) return;
      const orders = ['follow', 'push', 'suppress', 'hold'];
      this.squadOrder = orders[(orders.indexOf(this.squadOrder) + 1) % orders.length];
    });
    // Hold Tab for the scoreboard (kills, deaths, friendly fire).
    addEventListener('keydown', (e) => { if (e.key === 'Tab') { e.preventDefault(); this._showScore = true; } });
    addEventListener('keyup', (e) => { if (e.key === 'Tab') { e.preventDefault(); this._showScore = false; } });
  }

  _updateScoreboard() {
    const sb = this.hud && this.hud.scoreboard;
    if (!sb) return;
    if (!this._showScore) { sb.classList.add('hidden'); return; }
    sb.classList.remove('hidden');
    const teamP = this.all.filter((e) => e.team === 'player');
    const teamE = this.all.filter((e) => e.team === 'enemy');
    const aliveP = teamP.filter((e) => e.alive).length, aliveE = teamE.filter((e) => e.alive).length;
    const title = this.matchOver ? (this.matchResult === 'victory' ? 'VICTORY' : 'DEFEAT') : 'TEAM DEATHMATCH';
    const row = (label, a, b) => `<tr><td class="l">${a}</td><th>${label}</th><td class="r">${b}</td></tr>`;
    sb.innerHTML =
      `<div class="sb-title">${title}</div>` +
      `<table><tr><th class="you">YOUR BATTALION</th><th class="mid"></th><th class="foe">ENEMY</th></tr>` +
      row('standing', `${aliveP}/${teamP.length}`, `${aliveE}/${teamE.length}`) +
      row('kills', this.score.player, this.score.enemy) +
      row('team&nbsp;kills', this.ff.player, this.ff.enemy) +
      `</table>` +
      `<div class="sb-you">YOU &nbsp;·&nbsp; kills <b>${this.player.kills}</b> &nbsp; downed <b>${this._deaths}</b> &nbsp; teamkills <b>${this._playerFF || 0}</b></div>` +
      `<div class="sb-hint">hold Tab · click any HUD prompt to use it</div>`;
  }

  // Command your squad by pinging the minimap: left-click sets a rally point they
  // move to and hold; right-click (or clicking on yourself) recalls them to you.
  _wireMinimap() {
    const toWorld = (e) => {
      const S = this.minimap.width, rect = this.minimap.getBoundingClientRect();
      return {
        x: ((e.clientX - rect.left) / rect.width) * this.world.w,
        y: ((e.clientY - rect.top) / rect.height) * this.world.h,
      };
    };
    this.minimap.addEventListener('contextmenu', (e) => { e.preventDefault(); this.squadRally = null; });
    this.minimap.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (!this.squad.length) return;
      if (e.button === 2) { this.squadRally = null; return; }
      const w = toWorld(e);
      // Clicking near your own position cancels the rally (recall to you).
      this.squadRally = Math.hypot(w.x - this.player.x, w.y - this.player.y) < 18 ? null : w;
    });
  }

  _spawnBot(i) {
    const squadId = Math.floor(i / CONFIG.SQUAD_SIZE), slot = i % CONFIG.SQUAD_SIZE;
    // The last man of a fire-team is a specialist: a marksman/scout (DMR or Barrett)
    // or an anti-armor gunner with an RPG-7 — the AI's answer to your vehicles.
    const specialist = slot === CONFIG.SQUAD_SIZE - 1;
    const scout = specialist && squadId % 3 === 0; // marksman
    const at = specialist && squadId % 3 === 1;     // anti-armor: rifle + launcher
    const aa = specialist && squadId % 3 === 2;     // anti-air: rifle + Stinger
    const loadout = scout ? [i % 12 === 4 ? 'm82' : 'ar15']
      : at ? ['ak47', i % 2 ? 'at4' : 'rpg7']       // carries a rifle AND a launcher (heavy)
      : aa ? ['ak47', 'stinger']                    // rifle + shoulder-fired SAM
      : [pick(BOT_GUNS)];
    const bot = new Bot('bot' + i, loadout, BOT_NAMES[i % BOT_NAMES.length], scout ? 'soft' : pick(BOT_ARMOR));
    bot._squadId = squadId;
    bot._slot = slot;
    bot._isLeader = slot === 0; // fire-team leader; the rest follow
    bot._wantsVehicle = bot._isLeader && squadId < 10; // most fire-team leaders crew a rig
    bot._scout = scout;
    bot._at = at;
    bot._aa = aa;
    // Some of the enemy run suppressors — quieter shots that don't give their position
    // away as readily (a scout especially). So you can't always tell where fire's from.
    bot.suppressed = scout || i % 5 === 0;
    const sp = this.world.randomSpawn();
    bot.spawnAt(sp.x, sp.y);
    this.bots.push(bot);
    return bot;
  }

  // Deploy / redeploy the player and set up a fresh, FAIR, large-scale battle:
  // both sides are a battalion of `squadCount` fire-teams of SQUAD_SIZE each,
  // every team led by its own leader. Even numbers — you're the +1 commander.
  deployPlayer(loadoutIds, armorId, camoId, squadCount = 2) {
    const p = this.player = this._basePlayer; // restore the canonical you after take-overs
    // Leave any vehicle/drone you were crewing.
    p.inVehicle = false; p.vehicle = null; p.piloting = null; this._entering = null;
    if (loadoutIds && loadoutIds.length) p.setLoadout(loadoutIds);
    p.setArmor(armorId);
    if (camoId) p.setCamo(camoId);

    const SZ = CONFIG.SQUAD_SIZE;
    const perSide = Math.max(0, squadCount) * SZ; // units per battalion (even)
    this._squadCount = squadCount;
    const W = this.world.w, H = this.world.h;

    // TWO-SIDED DEPLOYMENT: each battalion forms up along its OWN edge (you on one
    // side, the enemy on the opposite side), concentrated in fire-teams, then both
    // advance to a front line. So you don't spawn into the middle of the enemy and
    // die — you start with your force and your vehicles, on your side of the field.
    const left = Math.random() < 0.5;                 // which edge you're on
    const yourX = left ? W * 0.13 : W * 0.87;
    const foeX = left ? W * 0.87 : W * 0.13;
    // Fan squads out along the edge (vertically), members clustered on their anchor.
    const nSq = Math.max(1, squadCount);
    const edgeY = (i) => H * (0.5 + (i - (nSq - 1) / 2) * (0.72 / Math.max(1, nSq - 1 || 1)));
    const near = (cx, cy, r, spread) => {
      const s = { x: clamp(cx + rand(-spread, spread), r + 3, W - r - 3), y: clamp(cy + rand(-spread, spread), r + 3, H - r - 3) };
      return s;
    };

    // You: on your side, center.
    const psp = near(yourX, H * 0.5, p.r, 30); p.spawnAt(psp.x, psp.y); this.world.resolve(p, p.r);

    // (Re)build your battalion: allies in fire-teams along your edge.
    const SQUAD_GUNS = ['m4a1', 'ak47', 'ar15'];
    this.squad = [];
    for (let i = 0; i < perSide; i++) {
      const sq = Math.floor(i / SZ), slot = i % SZ;
      const specialist = slot === SZ - 1;
      const scout = specialist && sq % 3 === 0;    // marksman
      const at = specialist && sq % 3 === 1;        // anti-armor: rifle + launcher
      const loadout = scout ? [i % 12 === 4 ? 'm82' : 'ar15']
        : at ? ['m4a1', i % 2 ? 'at4' : 'rpg7']
        : [pick(SQUAD_GUNS)];
      const b = new Bot('ally' + i, loadout, `Ally ${sq + 1}-${slot + 1}`, scout ? 'soft' : 'plate3', 'player');
      b._squadId = sq; b._slot = slot; b._isLeader = slot === 0; b._scout = scout; b._at = at;
      b._wantsVehicle = b._isLeader && sq < 10; // your fire-team leaders mount up too
      const a = near(yourX, edgeY(sq), b.r, 10); b.spawnAt(a.x, a.y); this.world.resolve(b, b.r);
      this.squad.push(b);
    }

    // Enemy battalion — formed up along the OPPOSITE edge. It fields a SLIGHTLY
    // LARGER force to make the fight fair against a human commander (you're worth
    // more than one bot: good aim, plus the take-over-a-mate chain). The AI-vs-AI
    // is even, so this edge is what keeps YOU from winning too easily.
    const foePerSide = perSide + Math.max(3, Math.round(perSide * CONFIG.ENEMY_EDGE));
    const foeSquads = Math.max(1, Math.ceil(foePerSide / SZ));
    const foeEdgeY = (i) => H * (0.5 + (i - (foeSquads - 1) / 2) * (0.72 / Math.max(1, foeSquads - 1 || 1)));
    while (this.bots.length < foePerSide) this._spawnBot(this.bots.length);
    if (this.bots.length > foePerSide) this.bots.length = foePerSide;
    for (const b of this.bots) {
      b.inVehicle = false; b.vehicle = null;
      const a = near(foeX, foeEdgeY(b._squadId), b.r, 10); b.spawnAt(a.x, a.y); this.world.resolve(b, b.r);
    }

    // Vehicles STAGED and ready — more of them at bigger battles, split evenly
    // between the two lines so both sides have armor and transport to crew.
    this.vehicles = [];
    const rigCycle = ['tank', 'technical', 'car', 'car', 'technical'];
    const nRigs = Math.min(16, 4 + squadCount); // Skirmish ~5 → Regiment 14
    for (let i = 0; i < nRigs; i++) {
      const type = rigCycle[i % rigCycle.length];
      const onYour = i % 2 === 0;
      const a = near(onYour ? yourX : foeX, edgeY(i % nSq) + rand(-45, 45), 4, 30);
      this.vehicles.push(new Vehicle(type, a.x, a.y));
    }
    this.matchOver = false; this.matchResult = null;
    this.score = { player: 0, enemy: 0 };
    this.ff = { player: 0, enemy: 0 }; this._deaths = 0; this._playerFF = 0; this._ffHeat = 0;
    this.killfeed = []; this.corpses = []; this.bullets = []; this.threats = [];
    this.shells = []; this.projectiles = []; this.bombs = []; this.enemyDrones = [];
    this.thrownGrenades = []; this._enemyStrike = null; this._nextEnemyStrike = rand(35, 60);
    this.enemyFpvs = []; this._nextEnemyFpv = rand(40, 75);
    this.loot = []; this.squadRally = null; this._eventBanner = null; this._freeLook = false;

    this.all = [this.player, ...this.squad, ...this.bots];
    // Starting strengths — so the after-action report can show how many each side
    // lost vs how many it started with.
    this._startForce = { player: 1 + this.squad.length, enemy: this.bots.length };
    this._buildRack();
  }

  findById(id) { return this.all.find((e) => e.id === id) || null; }

  // Who a round can hit: everyone but the shooter — FRIENDLY FIRE IS ON. Watch
  // your lanes; a stray round downrange doesn't care whose side you're on.
  targetsFor(ownerId, ownerTeam) {
    return this.all.filter((e) => e.id !== ownerId);
  }

  // Nearest enemy combatant a bot can see (opposite team, in the FOV cone, in
  // range reduced by the target's camo/stance/movement). For scale, only the
  // single closest in-cone candidate gets an (expensive) line-of-sight check.
  nearestEnemy(bot) {
    let best = null, bd = Infinity;
    const reach = bot.weapon.rangeMax * 0.7, half = rad(CONFIG.FOV_DEG / 2);
    for (const e of this.all) {
      if (e.team === bot.team || !e.alive || e.inVehicle) continue;
      const dx = e.x - bot.x, dy = e.y - bot.y, d2 = dx * dx + dy * dy;
      if (d2 >= bd) continue;
      const d = Math.sqrt(d2);
      const sd = e.stanceLevel > 1.5 ? 0.55 : e.stanceLevel > 0.5 ? 0.75 : 1;
      // Only someone DELIBERATELY playing dead reads as a body (you must be almost
      // on top of them). A target that merely went prone for cover is still
      // trackable — stance + stillness already make them harder to spot, so don't
      // double-penalize and blind the AI to anyone it just wounded.
      const feign = e._playDead ? 0.3 : 1;
      if (d > reach * e.camo.spot * (e.speedFrac > 0.12 ? 1 : 0.6) * sd * feign) continue;
      if (Math.abs(angleDelta(bot.angle, Math.atan2(dy, dx))) > half) continue;
      bd = d2; best = e;
    }
    if (best && !this.world.visible(bot.x, bot.y, best.x, best.y)) return null;
    return best;
  }

  // The living leader of a bot's own fire team (same team + squad), or null.
  squadLeader(bot) {
    const pool = bot.team === 'player' ? this.squad : this.bots;
    for (const b of pool) if (b._squadId === bot._squadId && b._isLeader && b.alive) return b;
    return null;
  }

  // Fire discipline: is a teammate (or you) standing in this shooter's line of
  // fire, anywhere between them and the target? If so the AI holds — soldiers don't
  // shoot through their own. The lane is checked the WHOLE way to the target, so a
  // marksman won't hose a mate 100 m downrange while aiming at someone at 200 m.
  friendlyBlockingFire(shooter, aimAng, aimDist) {
    const ca = Math.cos(aimAng), sa = Math.sin(aimAng);
    // Hold for a mate anywhere BETWEEN you and your target — right up to the target,
    // no artificial 90 m cap (that cap is why bots hosed teammates 90-150 m downrange
    // in big battles). Only worry about the stretch up to what you're shooting at, so
    // mates BEHIND the target don't freeze your fire.
    const maxD = Math.min((aimDist || 45) + 3, shooter.weapon.rangeMax || 300);
    for (const e of this.all) {
      if (e === shooter || e.team !== shooter.team || !e.alive || e.inVehicle) continue;
      const dx = e.x - shooter.x, dy = e.y - shooter.y;
      const df = dx * ca + dy * sa;
      if (df <= 0.5 || df > maxD) continue;               // in front, up to the target
      // The lane WIDENS with range to cover the aim-error / bullet-spread cone — a mate
      // a couple metres off the centreline at 120 m is still in real danger from a stray.
      const half = e.r + 1.4 + df * 0.03;
      if (Math.abs(-dx * sa + dy * ca) < half) return true;
    }
    return false;
  }

  // Would a rocket to this aim point catch your own in the blast? (launcher hold)
  friendlySplash(shooter, aimAng, aimDist) {
    const d = Math.min(aimDist || shooter.weapon.range || 100, 300);
    const ex = shooter.x + Math.cos(aimAng) * d, ey = shooter.y + Math.sin(aimAng) * d;
    const rr = (shooter.weapon.explosion || 6) + 2;
    for (const e of this.all) {
      if (e === shooter || e.team !== shooter.team || !e.alive || e.inVehicle) continue;
      if ((e.x - ex) ** 2 + (e.y - ey) ** 2 < rr * rr) return true;
    }
    return false;
  }

  // How far you can see — further when looking through a magnified optic.
  sightRange() {
    const p = this.player;
    return p.ads ? Math.min(950, CONFIG.SIGHT_RANGE + p.weapon.optic.mag * 30) : CONFIG.SIGHT_RANGE;
  }

  // Can the player see this point? (in the FOV cone, in range, line of sight)
  canSeePoint(x, y) {
    const p = this.player;
    const dx = x - p.x, dy = y - p.y;
    const r = this.sightRange();
    if (dx * dx + dy * dy > r * r) return false;
    if (Math.abs(angleDelta(p.angle, Math.atan2(dy, dx))) > rad(CONFIG.FOV_DEG / 2) + 0.06) return false;
    return this.world.visible(p.x, p.y, x, y);
  }
  canSeeEntity(e) { return this.canSeePoint(e.x, e.y); }

  _pushThreat(angle, strength) {
    this.threats.push({ angle, t: this.time, strength });
    if (this.threats.length > 12) this.threats.shift();
  }

  // An enemy round cracked past you — hear it, and feel its direction.
  // Loot by walking ONTO a body and pressing F — no loose items lie around to
  // give away that someone died. F takes the weapon first, then the armor.
  _updateLoot() {
    const p = this.player;
    this._lootTarget = null;
    if (!p.alive || p.inVehicle) { if (this.input.justPressed('g')) this._throwGrenade(); return; }
    let bd = 1.6 * 1.6, best = null;
    for (const k of this.corpses) {
      if (!k.gear) continue;
      const hasWeapon = k.gear.wid && k.gear.wid !== 'none';
      const hasArmor = k.gear.armorId && k.gear.armorId !== 'none' && k.gear.armorPoints > 3;
      if (!hasWeapon && !hasArmor) continue;
      const d = (k.x - p.x) ** 2 + (k.y - p.y) ** 2;
      if (d < bd) { bd = d; best = k; }
    }
    this._lootTarget = best;
    if (best && this.input.justPressed('f')) this._pickUp(best);
    if (this.input.justPressed('g')) this._throwGrenade(); // G throws a grenade
  }

  // Nearest body carrying a usable weapon, within range of a bot (for scavenging).
  _nearestArmedCorpse(bot, range) {
    let best = null, bd = range * range;
    for (const k of this.corpses) {
      if (!k.gear || !k.gear.wid || k.gear.wid === 'none') continue;
      const d = (k.x - bot.x) ** 2 + (k.y - bot.y) ** 2;
      if (d < bd) { bd = d; best = k; }
    }
    return best;
  }

  // A bot picks a weapon up off a body — its own empty gun stays on the corpse.
  _botScavenge(bot, corpse) {
    const g = corpse.gear;
    const dropped = bot.swapWeaponInSlot(g.wid, g.ammo);
    g.wid = dropped.id; g.ammo = dropped.ammo;
  }

  // Loot a body with F: if it's carrying a gun you ALREADY use, just take its
  // magazines (no point swapping to a duplicate). Otherwise take the weapon (your
  // old one stays on the body). If the gun's gone, take the armor.
  // Quick-loot the body in ONE press: grab its weapon (or top up your mags if you
  // already run that gun), AND take its armor if it beats what you're wearing. So you
  // strip a downed man's useful kit in a single F instead of pressing it repeatedly.
  _pickUp(k) {
    const p = this.player, g = k.gear;
    const msgs = [];
    if (g.wid && g.wid !== 'none') {
      if (p.carries(g.wid)) {
        const mags = p.addAmmo(g.wid, g.ammo);
        if (mags) msgs.push(`+${mags} mag${mags === 1 ? '' : 's'}`);
        g.ammo = null; g.wid = 'none'; // stripped its mags
      } else {
        const dropped = p.swapWeaponInSlot(g.wid, g.ammo);
        msgs.push(WEAPON_BY_ID[g.wid] ? WEAPON_BY_ID[g.wid].name : 'weapon');
        g.wid = dropped.id; g.ammo = dropped.ammo; // your old weapon is left on the body
        this._buildRack();
      }
    }
    // Take the armor only if it's better than yours (never downgrade yourself).
    if (g.armorId && g.armorId !== 'none' && g.armorPoints > (p.armorPoints || 0)) {
      const old = p.equipArmor(g.armorId, g.armorPoints);
      msgs.push('armor');
      g.armorId = old ? old.id : 'none';
      g.armorPoints = old ? old.points : 0;
    }
    if (msgs.length) this._lootMsg = { text: msgs.join(' · '), x: k.x, y: k.y, t: this.time };
    this._lootTarget = null;
  }

  _dropWeapon() {
    const d = this.player.dropCurrentWeapon();
    if (d) {
      this.loot.push({ kind: 'weapon', id: d.id, ammo: d.ammo, x: this.player.x, y: this.player.y, t: this.time });
      this._buildRack();
    }
  }

  // Generic damage (used by explosions, run-overs, airstrikes).
  damageEntity(target, dmg, attackerId, weaponName) {
    if (!target.alive) return;
    if (target === this.player && this._freeLook) return; // god mode: invulnerable while spectating
    target.hp -= dmg;
    target.lastDamage = this.time;
    target.lastAttackerId = attackerId;
    target.lastWeaponName = weaponName;
    if (target === this.player) this.fx.addShake(Math.min(10, dmg * 0.2));
    // You blasted a teammate (AT4 / RPG / grenade / running them over)? If they
    // survive it, they FEEL it and turn on you the same as taking your bullet.
    if (attackerId === 'you' && target !== this.player && target.team === 'player' && target.alive && '_coverUntil' in target) {
      const dx = this.player.x - target.x, dy = this.player.y - target.y;
      if (dx * dx + dy * dy < 55 * 55) {
        target._angryUntil = Math.max(target._angryUntil || 0, this.time + 6);
        target._alertAngle = Math.atan2(dy, dx); target._alertUntil = this.time + 4;
      }
    }
    if (target.hp <= 0) this._kill(target, attackerId, weaponName, false);
  }

  // Area blast: entities (falloff), cover (degrades/destroys), vehicles, fx.
  explode(x, y, radius, damage, ownerId) {
    const shock = radius * 2.5 + 9; // troops within the danger zone scatter & take cover
    for (const e of this.all) {
      if (!e.alive || e.inVehicle) continue;
      const d = Math.hypot(e.x - x, e.y - y);
      if (d < radius) this.damageEntity(e, damage * (1 - d / radius), ownerId, 'explosion');
      // Bots don't march mindlessly into explosives — a blast nearby makes them
      // break off, hit the dirt, and scatter OFF the impact (and disperse, so one
      // bomb doesn't wipe a whole column).
      else if (d < shock && '_scatterUntil' in e) {
        e._scatterUntil = this.time + rand(1.1, 1.8); // brief — dive clear, then back to it
        e._scatterX = x; e._scatterY = y;
        e._alertUntil = Math.max(e._alertUntil || 0, this.time + 4);
      }
    }
    for (const o of this.world.obstacles) {
      if (o.dead) continue;
      // Blasts breach cover hard — a tank shell punches through walls.
      if (Math.hypot(o.x + o.w / 2 - x, o.y + o.h / 2 - y) < radius + 1.5) this.world.damage(o, damage * 2);
    }
    for (const v of this.vehicles) {
      if (!v.dead && Math.hypot(v.x - x, v.y - y) < radius + v.radius) v.damage(damage * 0.7, ownerId, this);
    }
    this.fx.explosion(x, y, radius);
    const pd = Math.hypot(this.player.x - x, this.player.y - y);
    if (pd < radius * 3) this.fx.addShake(clamp(16 * (1 - pd / (radius * 3)), 0, 16));
    Sound.boom(clamp(1 - pd / 220, 0.12, 1), clamp((x - this.player.x) / 80, -1, 1));
  }

  onVehicleShot(v, cannon) {
    const d = Math.hypot(v.x - this.player.x, v.y - this.player.y);
    const vol = clamp(1 - d / 220, 0.1, 1), pan = clamp((v.x - this.player.x) / 80, -1, 1);
    if (cannon) Sound.boom(vol, pan);
    else Sound.shot(VEHICLE_WEAPONS.mg, vol * 0.9, pan, false);
  }

  // Enter the nearest empty vehicle, or dismount the current one.
  _toggleVehicle() {
    const p = this.player;
    if (p.inVehicle) { // dismount (instant)
      const v = p.vehicle;
      p.inVehicle = false; p.vehicle = null;
      p.x = v.x + Math.cos(v.angle + Math.PI / 2) * (v.radius + 1);
      p.y = v.y + Math.sin(v.angle + Math.PI / 2) * (v.radius + 1);
      this.world.resolve(p, p.r);
      // Hand the rig to the AI so it doesn't sit abandoned. If you bail from the wheel,
      // a gunner riding along slides across to drive and keeps it in the fight; if you
      // bail from the GUN (an ally was driving), just free the gun — they drive on and a
      // nearby ally re-mans it via _crewVehicle.
      if (v.driver === p) {
        v.driver = null; v.speed = 0; v.station = 'driver';
        if (v.gunner && v.gunner.alive) { v.driver = v.gunner; v.gunner = null; }
      } else if (v.gunner === p) {
        v.gunner = null;
      }
    } else if (this._entering) {
      this._entering = null; // cancel climbing in
    } else { // start climbing into the nearest empty vehicle — takes time
      let best = null, bd = 5 * 5;
      for (const v of this.vehicles) {
        if (v.dead || v.driver) continue;
        const d = (v.x - p.x) ** 2 + (v.y - p.y) ** 2;
        if (d < bd) { bd = d; best = v; }
      }
      if (best) this._entering = { v: best, until: this.time + best.s.enterTime };
    }
  }

  // Update EVERY vehicle each frame — player-crewed, AI-crewed, or idle. A driver
  // and a gunner can be different people (you drive, an ally works the gun; or an
  // enemy fire-team commandeers a rig), so control is assembled per-seat here.
  _updateVehicles(dt) {
    for (const v of this.vehicles) {
      if (v.dead) continue;
      // Free seats whose occupant died.
      if (v.driver && !v.driver.alive) { v.driver.inVehicle = false; v.driver.vehicle = null; v.driver = null; }
      if (v.gunner && !v.gunner.alive) { v.gunner.inVehicle = false; v.gunner.vehicle = null; v.gunner = null; }

      this._crewVehicle(v);                        // fill empty seats from nearby bots
      v.update(dt, this._vehicleControl(v), this);
      this._pinCrew(v);                            // ride along with the hull
    }
  }

  // Boarding: an ally jumps on YOUR gun; and EITHER side's fire-team commandeers an
  // idle rig (driver + gunner) — so your allies drive vehicles too, not just the enemy.
  _crewVehicle(v) {
    const armed = !!v.s.weapon;
    if (v.driver === this.player && armed && !v.gunner && v.station === 'driver') {
      const a = this._nearestFreeCrew(v, 'player', 4.5); // an ally mans your gun
      if (a) this._board(v, a, 'gunner');
    }
    if (!v.driver) {
      const d = this._nearestFreeCrew(v, 'enemy', 3.5) || this._nearestFreeCrew(v, 'player', 3.5);
      if (d) this._board(v, d, 'driver'); // whoever reaches it first takes the wheel
    }
    if (v.driver && v.driver !== this.player && armed && !v.gunner) {
      // Reach a trailing squadmate (they form up ~11-17 m out) so the gun gets
      // manned instead of the rig idling driverless-gunned — a mate runs up and jumps on.
      const g = this._nearestFreeCrew(v, v.driver.team, 14);
      if (g) this._board(v, g, 'gunner');
    }
  }

  _nearestFreeCrew(v, team, range) {
    let best = null, bd = range * range;
    for (const e of this.all) {
      if (e === this.player || e.team !== team || !e.alive || e.inVehicle) continue;
      const d = (e.x - v.x) ** 2 + (e.y - v.y) ** 2;
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  _board(v, bot, seat) {
    bot.inVehicle = true; bot.vehicle = v;
    if (seat === 'driver') v.driver = bot; else v.gunner = bot;
  }

  _vehicleControl(v) {
    const armed = !!v.s.weapon;
    const pIsDriver = v.driver === this.player;
    let drive = null, gun = null;

    if (pIsDriver) {
      if (!armed || v.station === 'driver') drive = this._playerDrive();
    } else if (v.driver) {
      drive = this._aiDrive(v);
    }

    if (armed) {
      if (pIsDriver && v.station === 'gunner') gun = this._playerGun(v);
      else if (v.gunner === this.player) gun = this._playerGun(v);
      else if (v.gunner) gun = this._aiGun(v);
    }
    return { drive, gun };
  }

  _playerDrive() {
    const i = this.input;
    return {
      throttle: (i.down('w') ? 1 : 0) - (i.down('s') ? 1 : 0),
      steer: (i.down('d') ? 1 : 0) - (i.down('a') ? 1 : 0),
    };
  }

  _playerGun(v) {
    const i = this.input, w = this.screenToWorld(i.mouse.x, i.mouse.y);
    return {
      turret: Math.atan2(w.y - v.y, w.x - v.x),
      aimDist: Math.hypot(w.x - v.x, w.y - v.y),
      fire: i.mouseDown, fireEdge: i.mouseClicked,
      coax: i.mouseDown,   // hold to rake with the coax; click lobs a cannon shell
    };
  }

  // AI at the wheel: close on the nearest foe, hold a fighting distance.
  _aiDrive(v) {
    const drv = v.driver;
    // COMBINED ARMS: nearest foe (to aim/close on) and nearest friendly foot troop
    // (its infantry screen). A tank that outruns its infantry gets RPG'd solo, so
    // it only presses the advance while foot troops are keeping pace alongside it.
    let tgt = null, bd = Infinity, footD = Infinity;
    for (const e of this.all) {
      if (!e.alive || e.inVehicle) continue;
      const d2 = (e.x - v.x) ** 2 + (e.y - v.y) ** 2;
      if (e.team !== drv.team) { if (d2 < bd) { bd = d2; tgt = e; } }
      else if (d2 < footD) footD = d2;
    }
    const d = tgt ? Math.sqrt(bd) : Infinity;
    const enemyClose = d < 45;           // an immediate fight — deal with it, don't wander off

    // DECIDE where to point. Situational: an armed rig with no gunner and no fight on
    // its hands drives BACK to fetch a crewmate for the gun (rather than roll in as a
    // rig that can't shoot) — but if the enemy's right there, it fights instead. It's
    // boarded automatically once it pulls within reach of a free mate.
    let desired, fetching = false, fetchD = 0;
    if (v.s.weapon && !v.gunner && !enemyClose) {
      const mate = this._nearestFreeCrew(v, drv.team, 140);
      if (mate) { fetching = true; fetchD = Math.hypot(mate.x - v.x, mate.y - v.y);
        desired = Math.atan2(mate.y - v.y, mate.x - v.x); }
    }
    if (!fetching) {
      if (!tgt) return { throttle: 0, steer: 0 };
      desired = Math.atan2(tgt.y - v.y, tgt.x - v.x);
    }
    const vax = Math.cos(v.angle), vay = Math.sin(v.angle);
    // Fight from a STANDOFF and stay ON THE INFANTRY LINE. A tank that charges past
    // its screen into RPG range gets brewed up — so it holds at gun range and only
    // creeps forward to keep pace as the infantry advance, never leading them in.
    const outOfAmmo = v.s.weapon === 'cannon' && v.rounds <= 0; // dry main gun → go ram
    const standoff = outOfAmmo ? 2 : !v.s.weapon ? 42 : v.s.weapon === 'cannon' ? 46 : 30;
    let infantryAhead = false; // is a friendly foot troop level-or-ahead toward the enemy?
    if (tgt && !fetching) {
      const fx = (tgt.x - v.x) / (d || 1), fy = (tgt.y - v.y) / (d || 1);
      for (const e of this.all) {
        if (e.team !== drv.team || e.inVehicle || !e.alive || e === drv || e === v.gunner) continue;
        const proj = (e.x - v.x) * fx + (e.y - v.y) * fy;      // forward of us toward the foe
        const off = Math.abs(-(e.x - v.x) * fy + (e.y - v.y) * fx);
        if (proj > -4 && off < 32) { infantryAhead = true; break; }
      }
    }

    // OBSTACLE AVOIDANCE: probe along the HEADING; if a wall/building is in the way,
    // swing around it (committed to one side) so the rig doesn't grind to a halt
    // nose-first against a building and sit there stuck. Look further when faster.
    const look = v.radius + 6 + Math.abs(v.speed) * 0.7;
    const wall = (a) => this.world.firstCoverHit(v.x, v.y, v.x + Math.cos(a) * look, v.y + Math.sin(a) * look);
    let wallAhead = false;
    if (wall(v.angle)) {
      wallAhead = true;
      if (v._steerBias === undefined) v._steerBias = 1;
      const offs = [0.5, 0.9, 1.4, 2.0];
      // COMMIT to one side (like the infantry steer) — while committed, only probe that
      // side, so the rig doesn't flip left/right every frame and jitter/loop in place.
      if (this.time < (v._avoidUntil || 0)) {
        const b = v._avoidSide; let found = false;
        for (const off of offs) if (!wall(v.angle + off * b)) { desired = v.angle + off * b; found = true; break; }
        if (!found) desired = v.angle + (Math.PI / 2) * b;
      } else {
        const b = v._steerBias; let found = false;
        for (const off of offs) {
          if (!wall(v.angle + off * b)) { desired = v.angle + off * b; v._avoidSide = b; found = true; break; }
          if (!wall(v.angle - off * b)) { desired = v.angle - off * b; v._steerBias = v._avoidSide = -b; found = true; break; }
        }
        if (!found) { desired = v.angle + (Math.PI / 2) * b; v._avoidSide = b; }
        v._avoidUntil = this.time + 1.2;
      }
    }

    // Don't plow through your own — if a friendly is on the road ahead, steer AROUND
    // them (and ease off the gas), instead of running your own people down.
    let avoid = 0, footBlock = false;
    for (const e of this.all) {
      if (e.team !== drv.team || e === drv || e === v.gunner || !e.alive || e.inVehicle) continue;
      const dx = e.x - v.x, dy = e.y - v.y, ahead = dx * vax + dy * vay;
      if (ahead < 0.3 || ahead > 16) continue;                 // only what's in front, close
      const lat = -dx * vay + dy * vax;                        // signed sideways offset
      if (Math.abs(lat) < v.radius + e.r + 1.6) {
        avoid += (lat >= 0 ? -1 : 1) * (1 - ahead / 16);       // swerve to the clear side
        if (ahead < 5) footBlock = true;                        // teammate right in front → crawl
      }
    }

    // STUCK RECOVERY: if the rig has throttle on but is barely moving, it's hung on
    // something the whiskers didn't clear — reverse out and swing hard for a moment.
    if (v._escapeUntil === undefined) v._escapeUntil = 0;
    if (this.time < v._escapeUntil) {
      const b = v._steerBias || 1;
      return { throttle: -0.6, steer: clamp(b, -1, 1) };       // back up and crank the wheel
    }

    // THROTTLE. Fight from the standoff; keep pace with the infantry line; never lead.
    let throttle;
    if (footBlock) throttle = 0.05;                            // don't crush own troops; nudge + steer past
    else if (fetching) throttle = fetchD < 8 ? 0 : 0.6;        // roll to a mate to pick up a gunner
    else if (wallAhead) throttle = 0.4;                        // ease down, let steering clear the wall
    else if (outOfAmmo) throttle = d > 5 ? 0.95 : 0.5;         // main gun dry → RAM the enemy down
    else if (d < standoff * 0.7) throttle = -0.5;              // too close → back off to standoff
    else if (d > standoff) throttle = infantryAhead ? 0.55 : 0.12; // keep pace; only creep if leading
    else throttle = 0;                                         // in the standoff band → hold & fire

    // Track whether we're actually making ground; if not (and we're trying to), start
    // an escape maneuver so we don't sit grinding on a corner.
    if (v._lastX !== undefined) {
      const moved = Math.hypot(v.x - v._lastX, v.y - v._lastY);
      if (Math.abs(throttle) > 0.25 && moved < 0.04) v._stuckT = (v._stuckT || 0) + 1 / 60;
      else v._stuckT = 0;
      if (v._stuckT > 0.6) { v._escapeUntil = this.time + 0.9; v._steerBias = (v._steerBias || 1) * -1; v._stuckT = 0; }
    }
    v._lastX = v.x; v._lastY = v.y;

    return { throttle, steer: clamp(angleDelta(v.angle, desired) * 2 + avoid * 1.8, -1, 1) };
  }

  // AI on the gun: lay the turret on the nearest visible foe and fire when bearing.
  _aiGun(v) {
    const gnr = v.gunner;
    const isCannon = v.s.weapon === 'cannon';
    const reach2 = (isCannon ? 320 : 170) ** 2;
    let tgt = null, bd = Infinity;
    // ARMOUR DUELS: engage enemy VEHICLES too (tank-vs-tank, technical-vs-technical).
    // A cannon takes on any rig and prioritises it (armour is the real threat, and the
    // cannon is what kills it); an MG can't scratch a small-arms-proof tank, so it
    // won't waste a belt on one — it only hoses light vehicles.
    for (const ev of this.vehicles) {
      if (ev.dead || ev === v) continue;
      const crew = ev.crewShooter && ev.crewShooter();
      if (!crew || crew.team === gnr.team) continue;
      if (!isCannon && ev.s.armorRifle >= 1) continue;
      const d = (ev.x - v.x) ** 2 + (ev.y - v.y) ** 2;
      if (d >= reach2 || !this.world.visible(v.x, v.y, ev.x, ev.y)) continue;
      const score = d * (isCannon ? 0.5 : 1);   // cannon: bias armour ahead of infantry
      if (score < bd) { bd = score; tgt = ev; }
    }
    let tgtIsInfantry = false;
    for (const e of this.all) {
      if (e.team === gnr.team || !e.alive || e.inVehicle) continue;
      const d = (e.x - v.x) ** 2 + (e.y - v.y) ** 2;
      if (d < bd && d < reach2) { bd = d; tgt = e; tgtIsInfantry = true; }
    }
    // No target → keep the gun trained FORWARD (over the bow), not left pointing
    // backwards while it drives. Traverse toward the hull heading.
    if (!tgt) return { turret: v.angle, fire: false, fireEdge: false, requireLaid: true };
    const turret = Math.atan2(tgt.y - v.y, tgt.x - v.x);
    const clear = this.world.visible(v.x, v.y, tgt.x, tgt.y);
    const aimDist = Math.hypot(tgt.x - v.x, tgt.y - v.y);
    // Don't fire THROUGH your own — hold if a friendly sits in the gun-target lane.
    const laneClear = !this._friendlyInLane(v, turret, aimDist, gnr.team);
    const fire = clear && laneClear;
    // Coax rakes only infantry (never wasted on armour) and only with a clear lane.
    return { turret, aimDist, fire, fireEdge: fire, requireLaid: true, coax: fire && tgtIsInfantry };
  }

  // Any friendly foot troop sitting in the gun→target lane? (so a vehicle doesn't
  // hose its own infantry screen). Checks a narrow cone out to the target range.
  _friendlyInLane(v, ang, range, team) {
    const ax = Math.cos(ang), ay = Math.sin(ang);
    for (const e of this.all) {
      if (e.team !== team || !e.alive || e.inVehicle || e === v.driver || e === v.gunner) continue;
      const dx = e.x - v.x, dy = e.y - v.y, along = dx * ax + dy * ay;
      if (along < 1 || along > range) continue;
      const lat = Math.abs(-dx * ay + dy * ax);
      if (lat < e.r + 1.4) return true;
    }
    return false;
  }

  _pinCrew(v) {
    for (const c of [v.driver, v.gunner]) {
      if (!c) continue;
      c.x = v.x; c.y = v.y; c.vx = 0; c.vy = 0;
      const gunning = c === v.gunner || (c === v.driver && v.station === 'gunner');
      c.angle = (v.s.weapon && gunning) ? v.turret : v.angle;
    }
  }

  // Launch / recall a drone you pilot from your (now exposed) body.
  _toggleDrone(type) {
    const p = this.player;
    if (p.piloting) { p.piloting.dead = true; p.piloting = null; return; } // recall/land
    if (p.inVehicle) return;
    const ready = type === 'bomber' ? this.bomberReadyAt : this.fpvReadyAt;
    if (this.time < ready) return;
    const d = new Drone(type, p.x + Math.cos(p.angle) * 2, p.y + Math.sin(p.angle) * 2, p.id);
    p.piloting = d; this.drones.push(d);
    if (type === 'bomber') this.bomberReadyAt = this.time + DRONES.bomber.cooldown;
    else this.fpvReadyAt = this.time + DRONES.fpv.cooldown;
  }

  _pilotDrone(dt) {
    const i = this.input, d = this.player.piloting, p = this.player;
    d.update(dt, {
      mx: (i.down('d') ? 1 : 0) - (i.down('a') ? 1 : 0),
      my: (i.down('s') ? 1 : 0) - (i.down('w') ? 1 : 0),
      fire: i.mouseDown, detonate: i.mouseClicked,
    }, this);
    // Resupply: fly the drone back over your own body to REARM bombs & RECHARGE
    // the battery — so you're never grounded by a short timer, just fly home.
    if (!d.dead && Math.hypot(d.x - p.x, d.y - p.y) < 3.5) {
      d.battery = Math.min(d.s.battery, d.battery + 30 * dt);
      if (d.type === 'bomber') d.bombs = d.s.bombs;
      d._resupply = true;
    } else d._resupply = false;
  }

  // UAV = a RECON drone you actually fly (like the bomber, but it can't be shot down
  // and drops nothing) — launch it, pilot it over the enemy with WASD, and everything
  // its wide camera passes over is revealed. U again (or N) recalls it.
  _callUAV() {
    const p = this.player;
    if (p.piloting) { p.piloting.dead = true; p.piloting = null; return; } // recall/land
    if (p.inVehicle) return;
    if (this.time < this.uavReadyAt) return;
    const d = new Drone('recon', p.x + Math.cos(p.angle) * 2, p.y + Math.sin(p.angle) * 2, p.id);
    p.piloting = d; this.drones.push(d);
    this.uavReadyAt = this.time + SUPPORT.UAV_COOLDOWN;
    Sound.crack(0.3, 0);
  }

  _callStrike(wx, wy) {
    if (this.time < this.strikeReadyAt || this.strikePending) return;
    const w = wx !== undefined ? { x: wx, y: wy } : this.screenToWorld(this.input.mouse.x, this.input.mouse.y);
    this.strikePending = { x: w.x, y: w.y, at: this.time + SUPPORT.STRIKE_DELAY };
    this.strikeReadyAt = this.time + SUPPORT.STRIKE_COOLDOWN;
    this.pings.push({ x: w.x, y: w.y, t: this.time, strike: true });
  }

  _ping(wx, wy) {
    const w = wx !== undefined ? { x: wx, y: wy } : this.screenToWorld(this.input.mouse.x, this.input.mouse.y);
    this.pings.push({ x: w.x, y: w.y, t: this.time });
    Sound.hit(false);
  }

  onNearMiss(bullet) {
    const owner = this.findById(bullet.ownerId);
    const ang = owner
      ? Math.atan2(owner.y - this.player.y, owner.x - this.player.x)
      : Math.atan2(-bullet.vy, -bullet.vx);
    Sound.crack(0.5, clamp(Math.sin(angleDelta(this.player.angle, ang)), -1, 1));
    this._pushThreat(ang, 0.7);
  }

  // --------------------------------------------------------- combat results
  applyDamage(target, bullet, distTraveled, region, hx, hy) {
    if (!target.alive) return;
    if (target === this.player && this._freeLook) return; // god mode: invulnerable while spectating
    const w = bullet.weapon;
    target.lastAttackerId = bullet.ownerId;
    target.lastWeaponName = w.name;
    target.lastDamage = this.time;
    this.fx.blood(hx, hy, bullet.angle);
    const youShot = bullet.ownerId === 'you';

    // Awareness: you feel which way fire came from; a hit bot turns to face it.
    const attacker = this.findById(bullet.ownerId);
    if (target === this.player && attacker) {
      this._pushThreat(Math.atan2(attacker.y - this.player.y, attacker.x - this.player.x), 1);
    }
    if (attacker && target !== this.player && '_coverUntil' in target) {
      // any hit bot (friend or foe) turns toward the shooter and drops to cover
      target._alertAngle = Math.atan2(attacker.y - target.y, attacker.x - target.x);
      target._alertUntil = this.time + 4;
      target._coverUntil = this.time + 3;
      // ...and the rest of the fire-team SEES a mate get hit and turns to face the
      // threat too — so shooting a squad from behind makes them look back, not just
      // march on obliviously.
      for (const m of this.all) {
        if (m === target || m.team !== target.team || !m.alive || m.inVehicle || !('_coverUntil' in m)) continue;
        if (Math.hypot(m.x - target.x, m.y - target.y) < 30) {
          m._alertAngle = Math.atan2(attacker.y - m.y, attacker.x - m.x);
          m._alertUntil = Math.max(m._alertUntil || 0, this.time + 4);
        }
      }
    }

    // Shoot a teammate and they FEEL it — they spin toward the shot and engage the
    // shooter, even from BEHIND (a wounded man turns around and finds you). Your
    // reputation (the squad-wide "he's a traitor" heat that blocks take-over) only
    // rises if it's plausibly identifiable — close, with line of sight to you.
    if (attacker === this.player && target !== this.player && target.team === this.player.team) {
      const dx = this.player.x - target.x, dy = this.player.y - target.y, dd = dx * dx + dy * dy;
      target._alertAngle = Math.atan2(dy, dx); target._alertUntil = this.time + 5; // flinch toward the shot
      const seesYou = this.world.visible(target.x, target.y, this.player.x, this.player.y);
      // If they can SEE who hit them — out to a long ~130 m — they turn and fight
      // BACK at you, not just die facing forward. Squadmates who can see you join in.
      if (dd < 130 * 130 && seesYou) {
        target._angryUntil = this.time + 6;
        for (const m of this.all) {
          if (m === target || m.team !== target.team || m === this.player || !m.alive || m.inVehicle) continue;
          if (Math.hypot(m.x - target.x, m.y - target.y) < 26
              && this.world.visible(m.x, m.y, this.player.x, this.player.y)) {
            m._angryUntil = this.time + 6;
            m._alertAngle = Math.atan2(this.player.y - m.y, this.player.x - m.x); m._alertUntil = this.time + 5;
          }
        }
        if (dd < 80 * 80) this._ffHeat = (this._ffHeat || 0) + 0.5;            // close enough to be sure → on your record
      }
    }

    // Range falloff (and penetration/ricochet already cut dmgScale).
    let dmg = w.damage * (bullet.dmgScale ?? 1);
    if (distTraveled > w.range) {
      const t = clamp((distTraveled - w.range) / (w.rangeMax - w.range), 0, 1);
      dmg *= lerp(1, 0.35, t);
    }

    // A central CNS hit ends it — pistol or rifle alike.
    if (region === 'head') {
      target.hp = 0;
      if (target === this.player) Sound.hurt();
      this._kill(target, bullet.ownerId, w.name, true);
      return;
    }

    if (region === 'limb') {
      dmg *= CONFIG.LIMB_DMG_MULT;
      target.bleed = Math.min(12, target.bleed + dmg * CONFIG.LIMB_BLEED);
      // A specific limb takes it — a fresh one, or aggravating one already wounded.
      const L = target.limb || (target.limb = { la: 0, ra: 0, ll: 0, rl: 0 });
      const part = Math.random() < 0.5
        ? (Math.random() < 0.5 ? 'll' : 'rl')   // a leg → limp (both → crippled)
        : (Math.random() < 0.5 ? 'la' : 'ra');  // an arm → shaky aim (both → can't aim)
      L[part] = Math.min(1, L[part] + CONFIG.WOUND_SEVERITY);
      target.legWound = clamp(L.ll + L.rl, 0, 1);
      target.armWound = clamp(L.la + L.ra, 0, 1.5);
    } else { // torso — vital, bleeds, and what body armor actually covers
      if (target.armorPoints > 0) {
        const red = isRifleRound(w) ? target.armor.vsRifle : target.armor.vsPistol;
        const absorbed = Math.min(dmg * red, target.armorPoints);
        target.armorPoints -= absorbed;
        dmg -= absorbed;
        // Behind-armor blunt trauma: the plate stops penetration, but the
        // impact still knocks the wind out of you (stamina hit + stagger).
        target.stamina = Math.max(0, target.stamina - absorbed * 1.5);
        if (target === this.player) this.fx.addShake(Math.min(6, absorbed * 0.3));
        // Plates don't last forever — every hit risks cracking it (a ceramic
        // plate is rated for a few stops), likelier the more worn it already is.
        const wear = 1 - target.armorPoints / target.armor.points;
        if (Math.random() < 0.05 + wear * 0.3) target.armorPoints = 0; // plate defeated
      }
      target.bleed = Math.min(14, target.bleed + dmg * CONFIG.TORSO_BLEED);
    }

    target.hp -= dmg;
    if (target === this.player) { Sound.hurt(); this.fx.addShake(Math.min(8, dmg * 0.25)); }

    if (target.hp <= 0) this._kill(target, bullet.ownerId, w.name, false);
  }

  _kill(target, killerId, weaponName, headshot) {
    target.alive = false;
    target.deaths++;
    target.bleed = 0; target.legWound = 0; target.armWound = 0;
    if (target.limb) target.limb = { la: 0, ra: 0, ll: 0, rl: 0 };
    // The body looks like any body (dead or playing dead) and carries its kit:
    // walk onto it and press F to take the gear. No loose items lie around.
    // What the body offers for looting: prefer a LAUNCHER it carried (an AT4/RPG off a
    // fallen AT gunner is the prize worth grabbing) with rounds left; otherwise the
    // weapon it was holding. So you can pick up a friendly's launcher, not just a rifle.
    let dropId = (target.loadout && target.loadout[target.slot]) || null;
    if (target.loadout && target.ammo) {
      const lch = target.loadout.find((id) => WEAPON_BY_ID[id] && WEAPON_BY_ID[id].projectile
        && target.ammo[id] && (target.ammo[id].loaded > 0 || target.ammo[id].spares.length > 0));
      if (lch) dropId = lch;
    }
    this.corpses.push({
      x: target.x, y: target.y, angle: target.angle, team: target.team, t: this.time,
      gear: {
        wid: dropId,
        ammo: (target.ammo && dropId) ? target.ammo[dropId] : null,
        armorId: (target.armor && target.armor.id) || 'none',
        armorPoints: target.armorPoints || 0,
      },
    });
    if (this.corpses.length > 40) this.corpses.shift();

    const killer = this.findById(killerId);
    const friendlyFire = killer && killer !== target && killer.team === target.team;
    if (killer && killer !== target) {
      const side = killer.team === 'player' ? 'player' : 'enemy';
      if (friendlyFire) { this.ff[side]++; if (killer === this.player) { this._playerFF = (this._playerFF || 0) + 1; this._noteTeamkill(target); } }
      else { killer.kills++; this.score[side]++; }
    }
    if (target === this.player) { Sound.death(); this._deaths++; }

    // Kill feed (team-deathmatch log): who killed whom, with what.
    this.killfeed.push({
      killer: killer && killer !== target ? killer.name : (killerId === 'enemyair' ? 'Air strike' : null),
      killerTeam: killer && killer !== target ? killer.team : 'enemy',
      victim: target.name,
      victimTeam: target.team,
      weapon: weaponName,
      headshot: !!headshot,
      ff: !!friendlyFire,
      t: this.time,
    });
    if (this.killfeed.length > 6) this.killfeed.shift();

    // Center-screen notification. If YOU go down but your squad is still in it,
    // you TAKE OVER a surviving teammate and fight on; only a total wipe is death.
    if (target === this.player) {
      const squadLeft = this.squad.some((a) => a.alive);
      const tookOver = this._takeOverAlly();
      const sub = tookOver ? `took over ${this.player.name}`
        : (this._ffHeat || 0) >= 1.4 && squadLeft ? 'your squad won’t follow a traitor'
        : squadLeft ? 'no one will take your orders'
        : 'no squad left';
      this._eventBanner = tookOver
        ? { text: 'DOWNED', sub, t: this.time, kind: 'death' }
        : { text: `KILLED BY ${killer && killer !== target ? killer.name : weaponName}`, sub, t: this.time, kind: 'death' };
    } else if (killer === this.player) {
      const km = Math.round(Math.hypot(target.x - killer.x, target.y - killer.y));
      this._eventBanner = friendlyFire
        ? { text: `TEAMKILL · ${target.name}`, sub: 'watch your lane', t: this.time, kind: 'death' }
        : { text: `ELIMINATED · ${target.name}`, sub: `${headshot ? 'headshot' : weaponName} · ${km} m`, t: this.time, kind: 'kill' };
    }

    this._checkMatchEnd();
  }

  // A teammate KNOWS it was you if they actually SAW it — body in view AND you in
  // their FOV/LOS. If not seen (a stray, or a bomb/grenade/airstrike that comes
  // from nowhere while you pilot from the rear), they can't tell YET. But casualties
  // from your own side's fire pile up: after a FEW, the survivors put it together
  // and turn — so drone/nade nearby and nobody's the wiser until you kill a few.
  _noteTeamkill(victim) {
    const you = this.player, half = rad(CONFIG.FOV_DEG / 2);
    let witnessed = false;
    for (const a of this.squad) {
      if (a === victim || !a.alive || a.inVehicle) continue;
      // Saw the body go down?
      if (Math.hypot(a.x - victim.x, a.y - victim.y) > 22 || !this.world.visible(a.x, a.y, victim.x, victim.y)) continue;
      // Can they see it was YOU? (you're near, in their FOV cone, in line of sight)
      const dx = you.x - a.x, dy = you.y - a.y;
      if (dx * dx + dy * dy > 42 * 42) continue;
      if (Math.abs(angleDelta(a.angle, Math.atan2(dy, dx))) > half) continue;
      if (!this.world.visible(a.x, a.y, you.x, you.y)) continue;
      a._angryUntil = this.time + 8; // they SAW you do it — they know
      witnessed = true;
    }
    // Caught in the act → big jump. Unseen → small, and it takes a FEW to add up.
    this._ffHeat = (this._ffHeat || 0) + (witnessed ? 1.5 : 0.6);
    if (!witnessed && this._ffHeat >= 1.6) { // ~3 unseen kills before they piece it together
      // Enough of their own have dropped — the survivors realize and turn on you.
      for (const a of this.squad) {
        if (a.alive && Math.hypot(a.x - victim.x, a.y - victim.y) < 34) a._angryUntil = this.time + 8;
      }
    }
  }

  // You hit one of your OWN (a crewed vehicle, or a wounding blast) — the crew and
  // nearby friends turn on you, and if it's plausibly identifiable it hits your
  // traitor record. Mirrors the infantry friendly-fire reaction for vehicles.
  _friendlyHitReaction(x, y) {
    const you = this.player;
    for (const a of this.all) {
      if (!a.alive || a.team !== you.team || a === you) continue;
      if ((a.x - x) ** 2 + (a.y - y) ** 2 > 45 * 45) continue;
      a._angryUntil = this.time + 6;
      a._alertAngle = Math.atan2(you.y - a.y, you.x - a.x);
      a._alertUntil = this.time + 4;
    }
    if ((x - you.x) ** 2 + (y - you.y) ** 2 < 45 * 45 && this.world.visible(x, y, you.x, you.y)) {
      this._ffHeat = (this._ffHeat || 0) + 0.5; // now it's on your record
    }
  }

  // When you're dropped, seize control of a surviving squadmate (chains until the
  // whole squad is gone → then it's a real defeat). But a TEAMKILLER's squad won't
  // follow them, and no one who's currently hostile to you will accept the handoff.
  _takeOverAlly() {
    // A KNOWN traitor's squad won't follow them — one witnessed kill, or enough
    // unseen casualties that the survivors have figured it out. A single clean/unseen
    // kill (heat 0.6) is still fine; you have to actually get caught or kill a few.
    if ((this._ffHeat || 0) >= 1.4) return false;
    const idx = this.squad.findIndex((a) => a.alive && a !== this.player && !(a._angryUntil > this.time));
    if (idx < 0) return false;
    const ally = this.squad.splice(idx, 1)[0]; // it's you now, not an AI teammate
    ally._angryUntil = 0; ally._playDead = false;
    this.player = ally;
    this.all = [this.player, ...this.squad, ...this.bots];
    this._buildRack();
    return true;
  }

  // Betrayal spreads: an angry teammate rallies mates who can see them ("he's a
  // traitor — kill him"). The more you've teamkilled, the longer the squad stays
  // hostile. Throttled so it's a cheap ripple, not an every-frame O(n²) sweep.
  _spreadAnger() {
    if (this.time < (this._nextAngerSpread || 0)) return;
    this._nextAngerSpread = this.time + 0.3;
    let anyAngry = false;
    for (const a of this.squad) if (a.alive && a._angryUntil > this.time) { anyAngry = true; break; }
    if (!anyAngry) return;
    const dur = 6 + Math.min(12, (this._playerFF || 0) * 3); // your reputation as a traitor
    for (const a of this.squad) {
      if (!a.alive || !(a._angryUntil > this.time)) continue;
      for (const b of this.squad) {
        if (b === a || !b.alive || b._angryUntil > this.time) continue;
        if (Math.hypot(b.x - a.x, b.y - a.y) < 18 && this.world.visible(a.x, a.y, b.x, b.y)) {
          b._angryUntil = this.time + dur;
        }
      }
    }
  }

  // Team deathmatch ends when one side has no one left standing.
  _checkMatchEnd() {
    if (this.matchOver) return;
    const playersLeft = this.all.some((e) => e.team === 'player' && e.alive);
    const enemiesLeft = this.all.some((e) => e.team === 'enemy' && e.alive);
    if (!enemiesLeft) { this.matchOver = true; this.matchResult = 'victory'; }
    else if (!playersLeft) { this.matchOver = true; this.matchResult = 'defeat'; }
  }

  onShot(shooter, w) {
    const supp = shooter.suppressed;
    if (shooter === this.player) {
      this.fx.addShake((0.4 + w.bloomPer * 0.5 + w.caliber * 0.04) * (supp ? 0.6 : 1));
      Sound.shot(w, supp ? CONFIG.SUPPRESS_VOL : 1, 0, supp);
      if (!supp) this.player._deafenUntil = this.time + CONFIG.DEAFEN_TIME; // your own muzzle blast
      // Recoil: the reticle climbs (and jitters sideways) per shot, then settles.
      const kick = (w.bloomPer + 0.5) * CONFIG.RECOIL_KICK_PX;
      this._recoil.y -= kick;
      this._recoil.x += (Math.random() - 0.5) * kick * 0.6;
      // Gunfire is loud: nearby bots hear it and turn to engage (suppressors
      // shrink how far it carries). This is what makes them shoot back.
      const heard = supp ? 30 : 95;
      for (const b of this.bots) {
        if (!b.alive) continue;
        if (Math.hypot(b.x - this.player.x, b.y - this.player.y) < heard) {
          b._alertAngle = Math.atan2(this.player.y - b.y, this.player.x - b.x);
          b._alertUntil = Math.max(b._alertUntil, this.time + 6);
        }
      }
    } else {
      const dx = shooter.x - this.player.x, dy = shooter.y - this.player.y;
      const d = Math.hypot(dx, dy);
      let vol = clamp(1 - d / 170, 0, 1) * (supp ? CONFIG.SUPPRESS_VOL : 1);
      if (this.time < this.player._deafenUntil) vol *= 0.3;
      if (vol > 0.03) Sound.shot(w, vol * 0.9, clamp(dx / 60, -1, 1), supp);
    }
  }

  onDryFire() { Sound.empty(); }

  // A bot lobs a grenade toward (tx,ty) — unless a teammate is in the blast.
  _botThrowGrenade(bot, tx, ty) {
    for (const e of this.all) {
      if (e === bot || e.team !== bot.team || !e.alive || e.inVehicle) continue;
      if ((e.x - tx) ** 2 + (e.y - ty) ** 2 < 7 * 7) return; // don't frag your own
    }
    this.thrownGrenades.push(new Grenade(bot.x, bot.y, tx, ty, bot.id));
  }

  spawnProjectile(kind, x, y, angle, w, ownerId) {
    if (kind === 'rocket') this.projectiles.push(new Rocket(x, y, angle, w, ownerId));
    else if (kind === 'missile') this.projectiles.push(new Missile(x, y, angle, w, ownerId, this));
  }

  _throwGrenade() {
    const p = this.player;
    if (p.grenades <= 0 || p.inVehicle || p.piloting || !p.alive) return;
    p.grenades--;
    const w = this.screenToWorld(this.input.mouse.x + this._recoil.x, this.input.mouse.y + this._recoil.y);
    this.thrownGrenades.push(new Grenade(p.x, p.y, w.x, w.y, p.id));
  }

  // --------------------------------------------------------------- controls
  _localControl() {
    const i = this.input, p = this.player;
    const W = this.canvas.width, H = this.canvas.height;
    const mapOpen = this._bigMap; // while the big map is up, clicks command the squad, not the gun
    const moveX = (i.down('d') ? 1 : 0) - (i.down('a') ? 1 : 0);
    const moveY = (i.down('s') ? 1 : 0) - (i.down('w') ? 1 : 0);
    const ads = i.rightDown && !mapOpen;
    // Recoil shifts the effective aim point (the reticle climbs as you fire).
    const mx = i.mouse.x + this._recoil.x, my = i.mouse.y + this._recoil.y;

    let aim, aimDist;
    if (ads) {
      // The scope magnifies wherever the cursor points in the main view, so it
      // reaches exactly as far as you can see — zoom OUT to engage further.
      const steady = this.screenToWorld(mx, my);
      const d = Math.hypot(steady.x - p.x, steady.y - p.y);
      const baseAng = Math.atan2(steady.y - p.y, steady.x - p.x);
      // Breathing sway is ANGULAR (waver grows with range, and the scope
      // magnifies it). Stance matters a LOT: standing offhand is wobbly, prone
      // is steady, and a deployed bipod is rock-solid.
      const tired = 1 - p.stamina / CONFIG.STAMINA_MAX;
      const steadiness = (p._stanceAcc || 1) * (p.bipod ? 0.2 : 1) * (1 + p.armWound * 1.1); // arm wounds wobble the hold
      const amp = (CONFIG.SWAY_BASE_RAD + CONFIG.SWAY_MOVE_RAD * p.speedFrac + CONFIG.SWAY_TIRED_RAD * tired) * steadiness;
      const t = this.time;
      const lat = ((Math.sin(t * 1.3) + 0.5 * Math.sin(t * 2.7)) / 1.5) * amp * d;
      const rng = ((Math.cos(t * 1.1) + 0.5 * Math.cos(t * 3.1)) / 1.5) * amp * d * 0.5;
      const ux = Math.cos(baseAng), uy = Math.sin(baseAng);
      const sway = { x: steady.x - uy * lat + ux * rng, y: steady.y + ux * lat + uy * rng };
      this._aimSteady = steady; // scope centers on the cursor's world point
      this._aimSway = sway;     // where rounds actually go + reticle (sway scales with range)
      aim = Math.atan2(sway.y - p.y, sway.x - p.x);
      aimDist = d;
    } else {
      this._aimSteady = null; this._aimSway = null;
      const w = this.screenToWorld(mx, my);
      aim = Math.atan2(w.y - p.y, w.x - p.x);
      aimDist = Math.hypot(w.x - p.x, w.y - p.y);
    }

    this._lastAimDist = aimDist;
    return {
      moveX, moveY, aim, aimDist,
      zeroHeight: this._zeroHeightForAim(aim), // aim at the center-mass of who you're pointing at (so prone is hittable)
      fire: i.mouseDown && !mapOpen,
      reload: i.justPressed('r'),
      sprint: i.down('shift'),
      walk: i.down('control'),
      ads,
    };
  }

  // Height a shooter aims at: the center mass of the nearest visible enemy along
  // the aim line (so a prone enemy is hit low), else standing chest height.
  _zeroHeightForAim(aim) {
    const p = this.player, ca = Math.cos(aim), sa = Math.sin(aim);
    let best = CONFIG.TARGET_HEIGHT, bestLat = 1.4;
    for (const e of this.bots) {
      if (!e.alive || e.inVehicle || !this.canSeeEntity(e)) continue;
      const dx = e.x - p.x, dy = e.y - p.y;
      const df = dx * ca + dy * sa;
      if (df < 1) continue;
      const lat = Math.abs(-dx * sa + dy * ca);
      if (lat < bestLat) { bestLat = lat; best = clamp(e.standHeight * 0.55, 0.25, 1.05); }
    }
    return best;
  }

  _handleMeta() {
    const i = this.input;
    if (i.weaponSlot !== null && i.weaponSlot <= this.player.loadout.length) {
      this.player.switchTo(i.weaponSlot - 1);
    }
    if (i.cycleWeapon) {
      const opt = this.player.weapon.optic;
      if (this.player.ads && opt.variable) { // scroll a variable scope to dial 1–6×
        this._opticZoom = clamp(this._opticZoom - i.cycleWeapon * 0.6, opt.magMin, opt.mag);
      } else {
        this.player.switchTo(this.player.slot + i.cycleWeapon);
      }
    }
    if (i.justPressed('v')) this.player.cycleFireMode();
    if (i.justPressed('t')) this.player.toggleSuppressor(this.time);
    if (i.justPressed('c')) this.player.setStance(this.player.stanceTarget === 1 ? 0 : 1); // crouch toggle
    if (i.justPressed('z')) this.player.setStance(this.player.stanceTarget === 2 ? 0 : 2); // prone toggle
    if (i.justPressed('e')) this._toggleVehicle();
    if (i.justPressed('u')) this._callUAV();
    if (i.justPressed('h')) this._callStrike();
    if (i.justPressed('x')) this._ping();
    if (i.justPressed('b')) this._toggleDrone('bomber');
    if (i.justPressed('n')) this._toggleDrone('fpv');
    if (i.justPressed('m')) this._bigMap = !this._bigMap; // open/close the big map
    if (i.justPressed('o')) { // god-mode free-look — fly the camera around and watch
      this._freeLook = !this._freeLook;
      if (this._freeLook) this._freeCam = { x: this.cam.x, y: this.cam.y };
    }
    // While the big map is open, a click orders the squad to that spot (not fire).
    if (this._bigMap && this.squad.length) {
      if (i.rightDown) this.squadRally = null; // recall
      else if (i.mouseClicked) {
        const W = this.canvas.width, H = this.canvas.height, S = Math.min(W, H) * 0.84;
        const ox = (W - S) / 2, oy = (H - S) / 2, mx = i.mouse.x, my = i.mouse.y;
        if (mx >= ox && mx <= ox + S && my >= oy && my <= oy + S) {
          const wx = ((mx - ox) / S) * this.world.w, wy = ((my - oy) / S) * this.world.h;
          this.squadRally = Math.hypot(wx - this.player.x, wy - this.player.y) < 18 ? null : { x: wx, y: wy };
        }
      }
    }
    if (i.justPressed('y') && this.squad.length) { // cycle squad orders
      const orders = ['follow', 'push', 'suppress', 'hold'];
      this.squadOrder = orders[(orders.indexOf(this.squadOrder) + 1) % orders.length];
    }
    if (i.justPressed(' ')) { // Space — swap your seat in an armed vehicle
      const v = this.player.vehicle, p = this.player;
      if (p.inVehicle && v && v.s.weapon) {
        const mate = v.driver === p ? v.gunner : v.driver; // your AI crewmate, if any
        if (mate && mate !== p) {
          // SWAP with your crewmate: you take the other seat, they take yours. So you
          // drive and they gun, then hit Space and you gun while THEY drive.
          if (v.driver === p) { v.driver = mate; v.gunner = p; }
          else { v.gunner = mate; v.driver = p; }
          v.station = 'driver';
        } else {
          // Solo crew — alternate between driving and manning the gun yourself.
          v.station = v.station === 'driver' ? 'gunner' : 'driver';
        }
      }
    }

    if (i.wheel) this.zoom = clamp(this.zoom * (i.wheel < 0 ? 1.12 : 0.89), CONFIG.ZOOM_MIN, CONFIG.ZOOM_MAX);
    if (i.justPressed('=') || i.justPressed('+')) this.zoom = clamp(this.zoom * 1.12, CONFIG.ZOOM_MIN, CONFIG.ZOOM_MAX);
    if (i.justPressed('-') || i.justPressed('_')) this.zoom = clamp(this.zoom * 0.89, CONFIG.ZOOM_MIN, CONFIG.ZOOM_MAX);
  }

  // ----------------------------------------------------------------- update
  update(dt) {
    this.time += dt;
    if (this._ffHeat > 0) this._ffHeat = Math.max(0, this._ffHeat - 0.11 * dt); // suspicion fades
    this._handleMeta();

    // Climbing into a vehicle takes time — you're standing there, exposed.
    if (this._entering) {
      const e = this._entering;
      if (e.v.dead || e.v.driver || !this.player.alive) this._entering = null;
      else if (this.time >= e.until) {
        e.v.driver = this.player; e.v.station = 'driver';
        this.player.inVehicle = true; this.player.vehicle = e.v;
        this._entering = null;
      }
    }

    if (this._freeLook) {
      /* god-mode spectating — you don't act and can't be hurt (see damage guards) */
    } else if (this.player.alive) {
      if (this._entering) { /* climbing in — idle & exposed */ }
      else if (this.player.piloting && !this.player.piloting.dead) {
        this._pilotDrone(dt); // body stands idle (and exposed) while you fly
      } else if (this.player.inVehicle && this.player.vehicle && !this.player.vehicle.dead) {
        /* your vehicle (and your seat in it) is driven in _updateVehicles */
      } else {
        if (this.player.piloting) this.player.piloting = null;
        if (this.player.inVehicle) { this.player.inVehicle = false; this.player.vehicle = null; }
        this.player.update(dt, this._localControl(), this);
      }
    }
    if (this.player.reloading && !this._playerWasReloading) Sound.reload();
    this._playerWasReloading = this.player.reloading;

    for (const b of this.bots) if (b.alive && !b.inVehicle) b.update(dt, b.think(dt, this), this);
    for (const b of this.squad) if (b.alive && !b.inVehicle) b.update(dt, b.think(dt, this), this); // friendly squad

    this._spreadAnger();      // betrayal spreads through the squad
    this._updateVehicles(dt); // player-crewed, AI-crewed, and idle vehicles

    // Hearing: nearby enemy footsteps (positional). Dulled right after you fire
    // unsuppressed (your own muzzle blast deafens you to quiet sounds).
    const pl = this.player;
    for (const b of this.bots) {
      if (!b.alive) continue;
      const sp = Math.hypot(b.vx, b.vy);
      if (sp < 1) continue;
      if (this.time < (b._nextStep || 0)) continue;
      b._nextStep = this.time + (sp > CONFIG.SPEED_RUN ? 0.3 : 0.5);
      const dx = b.x - pl.x, dy = b.y - pl.y, d = Math.hypot(dx, dy);
      if (d > CONFIG.FOOTSTEP_RANGE) continue;
      let vol = (1 - d / CONFIG.FOOTSTEP_RANGE) * 0.5;
      if (this.time < pl._deafenUntil) vol *= 0.2;
      Sound.footstep(vol, clamp(Math.sin(angleDelta(pl.angle, Math.atan2(dy, dx))), -1, 1));
    }

    // No respawns — team deathmatch. Once you're down, you're out for the match.

    // Bleeding: ongoing blood loss that can drop you after you break contact.
    // Wounds CLOT over time (the bleeding slows and stops) — but the blood/HP you
    // already lost never comes back. There is NO health regeneration: once you're
    // hurt you stay hurt for the match, once crippled you stay crippled. The only
    // "reset" is death → taking over a fresh squadmate, or redeploying.
    for (const e of this.all) {
      if (!e.alive || e.bleed <= 0) continue;
      e.hp -= e.bleed * dt;
      e.bleed = Math.max(0, e.bleed - CONFIG.CLOT_RATE * dt);
      if (e.hp <= 0) this._kill(e, e.lastAttackerId, e.lastWeaponName || 'bleeding', false);
    }

    // Bullets
    for (const b of this.bullets) b.update(dt, this);
    this.bullets = this.bullets.filter((b) => !b.dead);
    if (this.bullets.length > 1500) this.bullets.splice(0, this.bullets.length - 1500);

    // Tank shells
    for (const s of this.shells) s.update(dt, this);
    this.shells = this.shells.filter((s) => !s.dead);

    // Drones & dropped bombs
    this.drones = this.drones.filter((d) => !d.dead);
    for (const b of this.bombs) b.update(dt, this);
    this.bombs = this.bombs.filter((b) => !b.dead);

    // Rockets, guided missiles, thrown grenades
    for (const pr of this.projectiles) pr.update(dt, this);
    this.projectiles = this.projectiles.filter((pr) => !pr.dead);
    for (const g of this.thrownGrenades) g.update(dt, this);
    this.thrownGrenades = this.thrownGrenades.filter((g) => !g.dead);

    // Off-map enemy SUPPORT (air, kamikaze, artillery) only keeps coming while the
    // enemy still has a force in the fight — once you've wiped them out, their drones
    // and fire missions stop too (no one left to send them).
    const enemyLive = this.all.some((e) => e.team === 'enemy' && e.alive);

    // Hostile air: an enemy drone flies in every so often to bomb you.
    this._nextEnemyDrone -= dt;
    if (this._nextEnemyDrone <= 0 && this.enemyDrones.length < 2 && enemyLive) {
      this._nextEnemyDrone = rand(35, 70);
      const edge = pick([[0, rand(0, this.world.h)], [this.world.w, rand(0, this.world.h)],
        [rand(0, this.world.w), 0], [rand(0, this.world.w), this.world.h]]);
      this.enemyDrones.push(new EnemyDrone(edge[0], edge[1]));
    }
    for (const d of this.enemyDrones) d.update(dt, this);
    this.enemyDrones = this.enemyDrones.filter((d) => !d.dead);

    // Hostile FPV kamikaze: a suicide drone races in from the enemy edge and dives on
    // you (or a nearby ally/vehicle). Fast but fragile — gun it down, or juke it.
    this._nextEnemyFpv -= dt;
    if (this._nextEnemyFpv <= 0 && this.enemyFpvs.length < 2 && this.player.alive && enemyLive) {
      this._nextEnemyFpv = rand(30, 65);
      // Launch from the enemy's side of the field, aimed toward you.
      const fromTop = this.player.y > this.world.h / 2;
      const sx = clamp(this.player.x + rand(-40, 40), 2, this.world.w - 2);
      const sy = fromTop ? this.world.h - 2 : 2;
      // Occasionally pick a player-team vehicle as the juicier target instead of you.
      let tgt = this.player;
      const rigs = this.vehicles.filter((v) => !v.dead && v.driver && v.driver.team === 'player');
      if (rigs.length && Math.random() < 0.4) tgt = rigs[Math.floor(Math.random() * rigs.length)];
      this.enemyFpvs.push(new EnemyFpv(sx, sy, tgt));
    }
    for (const d of this.enemyFpvs) d.update(dt, this);
    this.enemyFpvs = this.enemyFpvs.filter((d) => !d.dead);

    // Hostile artillery: the enemy calls a fire mission onto your force every so
    // often — a warning marker lands first, then a salvo. Move off the ping.
    this._nextEnemyStrike -= dt;
    if (this._nextEnemyStrike <= 0 && !this._enemyStrike && this.player.alive && enemyLive) {
      this._nextEnemyStrike = rand(45, 85);
      const tx = clamp(this.player.x + rand(-18, 18), 4, this.world.w - 4);
      const ty = clamp(this.player.y + rand(-18, 18), 4, this.world.h - 4);
      this._enemyStrike = { x: tx, y: ty, at: this.time + SUPPORT.STRIKE_DELAY };
      this.pings.push({ x: tx, y: ty, t: this.time, strike: true });
    }
    if (this._enemyStrike && this.time >= this._enemyStrike.at) {
      const s = this._enemyStrike; this._enemyStrike = null;
      for (let i = 0; i < SUPPORT.STRIKE_SALVO; i++) {
        this.explode(s.x + rand(-SUPPORT.STRIKE_RADIUS, SUPPORT.STRIKE_RADIUS),
          s.y + rand(-SUPPORT.STRIKE_RADIUS, SUPPORT.STRIKE_RADIUS),
          SUPPORT.STRIKE_RADIUS * 0.6, SUPPORT.STRIKE_DAMAGE, 'enemyair');
      }
    }

    // Support: deliver a pending airstrike; age out ping markers.
    if (this.strikePending && this.time >= this.strikePending.at) {
      const s = this.strikePending; this.strikePending = null;
      for (let i = 0; i < SUPPORT.STRIKE_SALVO; i++) {
        this.explode(s.x + rand(-SUPPORT.STRIKE_RADIUS, SUPPORT.STRIKE_RADIUS),
          s.y + rand(-SUPPORT.STRIKE_RADIUS, SUPPORT.STRIKE_RADIUS),
          SUPPORT.STRIKE_RADIUS * 0.6, SUPPORT.STRIKE_DAMAGE, 'you');
      }
    }
    this.pings = this.pings.filter((p) => this.time - p.t < (p.strike ? SUPPORT.STRIKE_DELAY + 1 : SUPPORT.PING_TTL));

    this.corpses = this.corpses.filter((c) => this.time - c.t < CONFIG.CORPSE_TTL);
    this.loot = this.loot.filter((l) => this.time - l.t < CONFIG.CORPSE_TTL);
    this._updateLoot();
    this.fx.update(dt);

    // The MAIN view never zooms on ADS — it stays at your chosen scroll zoom so
    // you keep your surroundings. Magnification happens in the scope circle only.
    const opt = this.player.weapon.optic;
    this._effMag = opt.variable ? clamp(this._opticZoom, opt.magMin, opt.mag) : opt.mag;
    this.renderZoom += (this.zoom - this.renderZoom) * Math.min(1, CONFIG.ADS_ZOOM_EASE * dt);
    const rr = Math.exp(-CONFIG.RECOIL_RECOVER * dt); // reticle settles back after recoil
    this._recoil.x *= rr; this._recoil.y *= rr;

    // Free-look / god mode: pan a free camera around the map with WASD, snap the
    // rest with the big map — the whole battle is revealed and you take no damage.
    if (this._freeLook) {
      const i = this.input, sp = 60 * dt / Math.max(0.2, this.renderZoom);
      this._freeCam.x = clamp(this._freeCam.x + ((i.down('d') ? 1 : 0) - (i.down('a') ? 1 : 0)) * sp * 12, 0, this.world.w);
      this._freeCam.y = clamp(this._freeCam.y + ((i.down('s') ? 1 : 0) - (i.down('w') ? 1 : 0)) * sp * 12, 0, this.world.h);
      this.cam.x += (this._freeCam.x - this.cam.x) * (1 - Math.pow(0.0001, dt));
      this.cam.y += (this._freeCam.y - this.cam.y) * (1 - Math.pow(0.0001, dt));
      return;
    }

    // Camera: follow the drone while piloting; otherwise the player with a
    // little look-ahead toward the cursor (more while aiming, to see downrange).
    let tx, ty;
    const pdrone = this.player.piloting;
    if (this._entering) {
      tx = this._entering.v.x; ty = this._entering.v.y;
    } else if (pdrone && !pdrone.dead) {
      tx = pdrone.x; ty = pdrone.y;
    } else {
      // Main camera always follows you (downrange view lives in the scope circle).
      const w = this.screenToWorld(this.input.mouse.x, this.input.mouse.y);
      tx = this.player.x + (w.x - this.player.x) * 0.18;
      ty = this.player.y + (w.y - this.player.y) * 0.18;
    }
    const k = 1 - Math.pow(0.0001, dt);
    this.cam.x += (tx - this.cam.x) * k;
    this.cam.y += (ty - this.cam.y) * k;
  }

  // -------------------------------------------------------- transforms
  get ppm() { return CONFIG.PPM * this.renderZoom; }

  screenToWorld(sx, sy) {
    return {
      x: (sx - this.canvas.width / 2) / this.ppm + this.cam.x,
      y: (sy - this.canvas.height / 2) / this.ppm + this.cam.y,
    };
  }

  worldToScreen(wx, wy) {
    return {
      x: (wx - this.cam.x) * this.ppm + this.canvas.width / 2,
      y: (wy - this.cam.y) * this.ppm + this.canvas.height / 2,
    };
  }

  // ----------------------------------------------------------------- render
  render() {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#3a4029'; // daytime ground
    ctx.fillRect(0, 0, W, H);

    const shx = this.fx.shake ? rand(-1, 1) * this.fx.shake : 0;
    const shy = this.fx.shake ? rand(-1, 1) * this.fx.shake : 0;

    // MAIN view — your surroundings at your chosen zoom (never magnified by ADS).
    this._worldTransform(ctx, this.cam.x, this.cam.y, this.ppm, shx, shy);
    this._drawWorldContent(ctx);

    const piloting = this.player.piloting && !this.player.piloting.dead;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this._drawHaze(ctx);                                  // atmospheric distance haze
    // No screen-darkening fog: it's daylight, the whole map is visible. The
    // "fog of war" is purely that ENEMIES only appear when they're in your line
    // of sight (handled by canSeeEntity) — they pop into view from cover.

    // SCOPE — a magnified picture-in-picture circle (only a magnifying optic, on
    // foot). The rest of the screen stays normal so you keep peripheral context.
    const scoped = this.player.ads && this._effMag > 1 && this._aimSteady && !piloting && !this.player.inVehicle;
    if (scoped) this._drawScope(ctx);

    this._drawUAV(ctx);
    this._drawMarkers(ctx);
    this._drawDamageVignette(ctx);
    this._drawThreats(ctx);
    if (!scoped) this._drawReticle(ctx);                  // the scope draws its own reticle
    this._drawSelfMarker(ctx);
    this._drawScaleBar(ctx);
    this._drawMagInventory(ctx);
    this._drawReloadPrompt(ctx);
    this._drawBodyState(ctx);
    this._drawPilotHint(ctx);
    this._drawEventBanner(ctx);
    this._drawMatchBanner(ctx);

    this._drawMinimap();
    this._drawBigMap(ctx);
    if (this._freeLook) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = 'rgba(255,210,120,0.95)'; ctx.font = '600 15px system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('👁 FREE-LOOK (god mode) — WASD to pan · scroll to zoom · O to return', this.canvas.width / 2, 26);
      ctx.textAlign = 'left';
    }
    this._updateHud();
  }

  // Always be able to find yourself: when zoomed out enough that your body is
  // tiny, draw a cyan ring + facing chevron at your screen position.
  _drawSelfMarker(ctx) {
    const p = this.player;
    if (!p.alive || (p.piloting && !p.piloting.dead) || p.inVehicle) return;
    if (p.r * this.ppm > 9) return; // already big enough on screen
    const s = this.worldToScreen(p.x, p.y);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.strokeStyle = 'rgba(120,220,255,0.9)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(s.x, s.y, 10, 0, TAU); ctx.stroke();
    const a = p.angle;
    ctx.fillStyle = 'rgba(140,225,255,0.95)';
    ctx.beginPath();
    ctx.moveTo(s.x + Math.cos(a) * 16, s.y + Math.sin(a) * 16);
    ctx.lineTo(s.x + Math.cos(a + 2.6) * 9, s.y + Math.sin(a + 2.6) * 9);
    ctx.lineTo(s.x + Math.cos(a - 2.6) * 9, s.y + Math.sin(a - 2.6) * 9);
    ctx.closePath(); ctx.fill();
  }

  // A clear instruction/status panel (top-center) while you fly a drone.
  _drawPilotHint(ctx) {
    const d = this.player.piloting;
    if (!d || d.dead) return;
    const W = this.canvas.width, isB = d.type === 'bomber', isR = d.type === 'recon';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const bw = 540, bh = 64, x = W / 2 - bw / 2, y = 14;
    ctx.fillStyle = 'rgba(8,11,6,0.82)'; ctx.strokeStyle = 'rgba(255,180,90,0.55)'; ctx.lineWidth = 1;
    ctx.fillRect(x, y, bw, bh); ctx.strokeRect(x, y, bw, bh);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffd257'; ctx.font = '700 14px system-ui, sans-serif';
    ctx.fillText(`PILOTING ${d.s.name.toUpperCase()} — your body is on the ground, exposed`, W / 2, y + 19);
    ctx.fillStyle = '#cfe0d6'; ctx.font = '12px system-ui, sans-serif';
    ctx.fillText(isB
      ? 'WASD fly  ·  CLICK to drop a bomb  ·  fly back over your body to REARM  ·  B to recall'
      : isR
      ? 'WASD fly  ·  everything the camera passes over is REVEALED  ·  can’t be shot down  ·  U to recall'
      : 'WASD fly  ·  steer straight INTO a target  ·  CLICK to detonate  ·  N to recall', W / 2, y + 38);
    ctx.fillStyle = d._resupply ? '#ffd257' : '#9fe0c8'; ctx.font = '600 13px monospace';
    ctx.fillText(isB
      ? `🔋 ${Math.ceil(d.battery)}s    💣 ${d.bombs}/${d.s.bombs}${d._resupply ? '   REARMING…' : ''}`
      : `🔋 ${Math.ceil(d.battery)}s    ⟶ detonates on impact`, W / 2, y + 56);
    ctx.textAlign = 'left';
  }

  // A little body diagram (bottom-left, beside your vitals) showing WHERE you're
  // hurt and how bad — arms/legs redden as they take wounds, the torso tracks HP.
  _drawBodyState(ctx) {
    const p = this.player;
    if (!p.alive) return;
    const lb = p.limb || { la: 0, ra: 0, ll: 0, rl: 0 };
    const H = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.save();
    ctx.translate(326, H - 66);
    const skin = 'rgba(150,165,140,0.85)';
    const col = (w) => w > 0.05 ? `rgba(220,${Math.round(90 * (1 - Math.min(1, w)))},${Math.round(70 * (1 - Math.min(1, w)))},0.95)` : skin;
    ctx.lineCap = 'round';
    // torso — color by HP (green→red), pulses red while bleeding
    const hpFrac = clamp(p.hp / p.maxHp, 0, 1);
    ctx.strokeStyle = p.bleed > 0.3 ? 'rgba(210,60,50,0.95)'
      : `rgba(${Math.round(210 - 150 * hpFrac)},${Math.round(70 + 110 * hpFrac)},80,0.9)`;
    ctx.lineWidth = 9; ctx.beginPath(); ctx.moveTo(0, -6); ctx.lineTo(0, 14); ctx.stroke();
    ctx.fillStyle = skin; ctx.beginPath(); ctx.arc(0, -15, 5, 0, TAU); ctx.fill(); // head
    ctx.lineWidth = 4;
    ctx.strokeStyle = col(lb.la); ctx.beginPath(); ctx.moveTo(-1, -2); ctx.lineTo(-12, 10); ctx.stroke();
    ctx.strokeStyle = col(lb.ra); ctx.beginPath(); ctx.moveTo(1, -2); ctx.lineTo(12, 10); ctx.stroke();
    ctx.strokeStyle = col(lb.ll); ctx.beginPath(); ctx.moveTo(-1, 14); ctx.lineTo(-7, 31); ctx.stroke();
    ctx.strokeStyle = col(lb.rl); ctx.beginPath(); ctx.moveTo(1, 14); ctx.lineTo(7, 31); ctx.stroke();

    // Stance + movement readout: a compass arrow (the avatar faces UP = forward) and
    // labels, so you can read your own posture and whether you're advancing, backing
    // up, strafing, or sprinting at a glance.
    const spd = Math.hypot(p.vx || 0, p.vy || 0);
    const cxA = -34, cyA = 6;
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cxA, cyA, 11, 0, TAU); ctx.stroke();
    let mv = 'STILL';
    if (spd > 0.25) {
      const rel = angleDelta(p.angle, Math.atan2(p.vy, p.vx)); // movement vs facing
      const a = Math.abs(rel);
      mv = p._sprinting ? 'SPRINT' : a < 0.8 ? 'ADVANCE' : a > 2.35 ? 'BACKPEDAL' : 'STRAFE';
      ctx.strokeStyle = '#ffd257'; ctx.lineWidth = 2.5; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(cxA, cyA);
      ctx.lineTo(cxA + Math.sin(rel) * 9, cyA - Math.cos(rel) * 9); ctx.stroke();
    }
    const stance = p.stanceLevel > 1.5 ? 'PRONE' : p.stanceLevel > 0.5 ? 'CROUCH' : 'STANDING';
    ctx.textAlign = 'left'; ctx.font = '600 10px system-ui, sans-serif';
    ctx.fillStyle = '#9fe0c8'; ctx.fillText(stance, 20, 2);
    ctx.fillStyle = '#cfe0d6'; ctx.fillText(mv, 20, 15);
    ctx.restore();
  }

  // Brief center-screen popup when you kill (green) or get killed (red).
  _drawEventBanner(ctx) {
    const b = this._eventBanner;
    if (!b) return;
    const age = this.time - b.t, TTL = 2.6;
    if (age > TTL) { this._eventBanner = null; return; }
    const W = this.canvas.width, H = this.canvas.height;
    const fade = clamp(1 - (age - (TTL - 0.6)) / 0.6, 0, 1); // hold, then fade out
    const rise = Math.min(1, age / 0.18);                    // quick pop-in
    const y = H * 0.34 - 6 + (1 - rise) * 10;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.textAlign = 'center';
    ctx.globalAlpha = fade;
    ctx.fillStyle = b.kind === 'kill' ? '#7bd88f' : '#ff5d5d';
    ctx.font = '700 34px system-ui, sans-serif';
    ctx.fillText(b.text, W / 2, y);
    if (b.sub) {
      ctx.fillStyle = 'rgba(220,230,220,0.75)';
      ctx.font = '500 15px system-ui, sans-serif';
      ctx.fillText(b.sub, W / 2, y + 22);
    }
    ctx.globalAlpha = 1; ctx.textAlign = 'left';
  }

  // Big centered banner when the team deathmatch is decided.
  // Big, unmissable center-screen prompt when your gun runs dry — so you're never
  // left clicking an empty weapon wondering why nothing's happening.
  _drawReloadPrompt(ctx) {
    const p = this.player;
    if (!p.alive || p.inVehicle || (p.piloting && !p.piloting.dead)) return;
    if (p.mag > 0 || p.reloading) return;              // still have rounds, or already reloading
    const W = this.canvas.width, H = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.textAlign = 'center';
    const y = H * 0.62;
    const pulse = 0.6 + 0.4 * Math.sin(this.time * 6);
    if (p.magsLeft > 0) {
      ctx.fillStyle = `rgba(255,180,70,${pulse})`;
      ctx.font = '700 30px system-ui, sans-serif';
      ctx.fillText('RELOAD', W / 2, y);
      ctx.fillStyle = 'rgba(255,210,140,0.9)'; ctx.font = '600 16px system-ui, sans-serif';
      ctx.fillText('press  R', W / 2, y + 24);
    } else {
      ctx.fillStyle = `rgba(255,90,80,${pulse})`;
      ctx.font = '700 28px system-ui, sans-serif';
      ctx.fillText('OUT OF AMMO', W / 2, y);
      ctx.fillStyle = 'rgba(255,150,140,0.9)'; ctx.font = '600 16px system-ui, sans-serif';
      ctx.fillText('loot a body (F) or switch weapon (Q)', W / 2, y + 24);
    }
    ctx.textAlign = 'left';
  }

  _drawMatchBanner(ctx) {
    if (!this.matchOver) return;
    const W = this.canvas.width, H = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const win = this.matchResult === 'victory';
    const sf = this._startForce || { player: 1, enemy: 1 };
    const aliveP = this.all.filter((e) => e.team === 'player' && e.alive).length;
    const aliveE = this.all.filter((e) => e.team === 'enemy' && e.alive).length;
    const lostP = Math.max(0, sf.player - aliveP), lostE = Math.max(0, sf.enemy - aliveE);
    const p = this.player;

    const bh = 340;
    ctx.fillStyle = 'rgba(6,9,6,0.82)'; ctx.fillRect(0, H / 2 - bh / 2, W, bh);
    ctx.textAlign = 'center';
    ctx.fillStyle = win ? '#7bd88f' : '#ff5d5d';
    ctx.font = '700 66px system-ui, sans-serif';
    ctx.fillText(win ? 'VICTORY' : 'DEFEAT', W / 2, H / 2 - bh / 2 + 78);
    ctx.font = '600 17px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(220,230,220,0.75)';
    ctx.fillText('AFTER-ACTION REPORT', W / 2, H / 2 - bh / 2 + 108);

    // Row-by-row comparison: [ your value | metric | enemy value ].
    const colY = H / 2 - 44, lh = 30;
    ctx.save(); ctx.translate(0, colY);
    ctx.textAlign = 'center'; ctx.font = '700 18px system-ui, sans-serif';
    ctx.fillStyle = '#6fd0ff'; ctx.fillText('YOUR FORCE', W / 2 - 120, -32);
    ctx.fillStyle = 'rgba(200,214,200,0.6)'; ctx.font = '600 13px system-ui, sans-serif'; ctx.fillText('vs', W / 2, -32);
    ctx.fillStyle = '#ff7a6b'; ctx.font = '700 18px system-ui, sans-serif'; ctx.fillText('ENEMY FORCE', W / 2 + 120, -32);
    const rows = [
      ['committed', sf.player, sf.enemy, '#e6efe6'],
      // "killed" = kills that side INFLICTED: your column = enemies you dropped (their
      // losses), enemy column = your men they dropped (your losses).
      ['killed', lostE, lostP, '#ffca8a'],
      ['still standing', aliveP, aliveE, '#8fe0a0'],
    ];
    rows.forEach((r, i) => {
      const yy = i * lh;
      ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(200,214,200,0.65)'; ctx.font = '500 14px system-ui, sans-serif';
      ctx.fillText(r[0], W / 2, yy);
      ctx.font = '700 19px system-ui, sans-serif'; ctx.fillStyle = r[3];
      ctx.textAlign = 'right'; ctx.fillText(String(r[1]), W / 2 - 62, yy); // your value
      ctx.textAlign = 'left'; ctx.fillText(String(r[2]), W / 2 + 62, yy);  // enemy value
    });
    // Your personal line.
    ctx.textAlign = 'center'; ctx.fillStyle = '#cfe0d6'; ctx.font = '600 17px system-ui, sans-serif';
    const tk = this._playerFF || 0;
    ctx.fillText(`You: ${p.kills || 0} kills · ${p.deaths || 0} death${p.deaths === 1 ? '' : 's'}${tk ? ` · ${tk} friendly` : ''}`,
      W / 2, 3 * lh + 24);
    ctx.restore();

    ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(220,230,220,0.7)';
    ctx.font = '500 16px system-ui, sans-serif';
    ctx.fillText('press Esc to redeploy for a new match', W / 2, H / 2 + bh / 2 - 22);
    ctx.textAlign = 'left';
  }

  _worldTransform(ctx, camx, camy, ppm, shx = 0, shy = 0) {
    const W = this.canvas.width, H = this.canvas.height;
    ctx.setTransform(ppm, 0, 0, ppm, W / 2 + shx - camx * ppm, H / 2 + shy - camy * ppm);
  }

  // Draw the whole world at whatever camera/zoom is currently set (this.cam,
  // this.ppm). Used for both the main view and the scope view.
  _drawWorldContent(ctx) {
    this._drawGround(ctx);
    this._drawObstacles(ctx);
    this._drawCorpses(ctx);
    this._drawLoot(ctx);
    this._drawVehicles(ctx);
    this._drawVehiclePrompt(ctx);
    this.fx.draw(ctx);
    this._drawBullets(ctx);
    this._drawShells(ctx);
    this._drawBombs(ctx);
    const piloting = this.player.piloting && !this.player.piloting.dead;
    for (const e of this.all) {
      if (e.inVehicle) continue;
      if (e === this.player || e.team === 'player') { this._drawCombatant(ctx, e); continue; } // you + allies always shown
      // UAV recon reveals the whole enemy force through the fog — so zoom out and
      // watch them move. (Free-look reveals everything; piloting uses drone sight.)
      const vis = this._freeLook || this.time < this.uavUntil || (piloting
        ? Math.hypot(e.x - this.player.piloting.x, e.y - this.player.piloting.y) < this.player.piloting.s.sight
        : this.canSeeEntity(e));
      if (vis) { if (!this._freeLook) e._spottedUntil = this.time + 4; this._drawCombatant(ctx, e); }
    }
    this._drawDrones(ctx);
    this._drawEnemyDrones(ctx);
    this._drawProjectiles(ctx);
    this._drawGrenades(ctx);
  }

  _drawProjectiles(ctx) {
    for (const pr of this.projectiles) {
      ctx.save(); ctx.translate(pr.x, pr.y); ctx.rotate(pr.angle);
      ctx.fillStyle = pr.w.projectile === 'missile' ? '#e8e8e8' : '#caa45a';
      ctx.fillRect(-0.6, -0.13, 1.2, 0.26);
      ctx.fillStyle = '#ffcf6a'; ctx.beginPath(); ctx.arc(-0.6, 0, 0.2, 0, TAU); ctx.fill();
      ctx.restore();
    }
  }

  _drawGrenades(ctx) {
    for (const g of this.thrownGrenades) {
      ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.beginPath(); ctx.arc(g.x, g.y, 0.17, 0, TAU); ctx.fill();
      ctx.fillStyle = '#3c4a2a'; ctx.beginPath(); ctx.arc(g.x, g.y - g.z * 0.3, 0.15, 0, TAU); ctx.fill();
    }
  }

  _drawEnemyDrones(ctx) {
    for (const d of this.enemyDrones) {
      if (d.dead) continue;
      const sc = (d.r || 0.85) / 0.9; // higher-flying drones render smaller
      // Faint ground shadow, offset by altitude — a cue to how high it is.
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.beginPath(); ctx.arc(d.x, d.y + (d.alt || 0) * 0.05, 0.7 * sc, 0, TAU); ctx.fill();
      ctx.save(); ctx.translate(d.x, d.y); ctx.rotate(d.angle); ctx.scale(sc, sc);
      ctx.fillStyle = '#a23b3b'; ctx.fillRect(-0.4, -0.4, 0.8, 0.8);
      ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 0.05;
      for (const [ox, oy] of [[-0.55, -0.55], [0.55, -0.55], [-0.55, 0.55], [0.55, 0.55]]) {
        ctx.beginPath(); ctx.arc(ox, oy, 0.28, 0, TAU); ctx.stroke();
      }
      ctx.restore();
    }
    // FPV kamikaze drones — small, fast, low, with a motion streak and a warning ring.
    for (const d of this.enemyFpvs) {
      if (d.dead) continue;
      ctx.fillStyle = 'rgba(0,0,0,0.2)';
      ctx.beginPath(); ctx.arc(d.x, d.y + 0.15, 0.45, 0, TAU); ctx.fill();
      // streak trailing the heading
      ctx.strokeStyle = 'rgba(255,90,60,0.5)'; ctx.lineWidth = 0.18;
      ctx.beginPath(); ctx.moveTo(d.x, d.y);
      ctx.lineTo(d.x - Math.cos(d.angle) * 1.6, d.y - Math.sin(d.angle) * 1.6); ctx.stroke();
      ctx.save(); ctx.translate(d.x, d.y); ctx.rotate(d.angle);
      ctx.fillStyle = '#ff5a3c'; ctx.beginPath();
      ctx.moveTo(0.5, 0); ctx.lineTo(-0.35, 0.3); ctx.lineTo(-0.35, -0.3); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(255,220,120,0.7)'; ctx.lineWidth = 0.06;
      for (const [ox, oy] of [[-0.3, -0.35], [0.25, -0.35], [-0.3, 0.35], [0.25, 0.35]]) {
        ctx.beginPath(); ctx.arc(ox, oy, 0.2, 0, TAU); ctx.stroke();
      }
      ctx.restore();
    }
  }

  // The optic view: a magnified TOP-DOWN circle at the cursor — the same
  // overhead view, just zoomed (10× shows a 50 m target as if 5 m), so you keep
  // your bearings. The rest of the screen stays normal for peripheral context.
  _drawScope(ctx) {
    const W = this.canvas.width, H = this.canvas.height;
    // The optic magnifies at its true power (so distant targets are still big
    // enough to engage). PERSPECTIVE is then layered on per-target: a body is
    // sized by its ANGULAR size, so the farther it is from you the smaller it
    // renders — near targets fill the glass, far ones are small (see _drawCombatant).
    const effMag = this._effMag;
    const sPpm = CONFIG.PPM * effMag;             // absolute magnification
    const rS = Math.min(W, H) * 0.23;
    const scx = clamp(this.input.mouse.x, rS + 14, W - rS - 14);
    const scy = clamp(this.input.mouse.y, rS + 14, H - rS - 14);
    // Center the scope on the cursor's world point (the aim point).
    const scopeCam = {
      x: this._aimSteady.x - (scx - W / 2) / sPpm,
      y: this._aimSteady.y - (scy - H / 2) / sPpm,
    };

    const savedCam = this.cam, savedRZ = this.renderZoom;
    this.cam = scopeCam; this.renderZoom = effMag;  // this.ppm getter → CONFIG.PPM*effMag = sPpm
    // Angular-size POV: objects scale by their distance FROM YOU (the reference is
    // the aim distance, so a target at the point of aim is "true" size).
    this._scopePov = { x: this.player.x, y: this.player.y, ref: Math.max(10, this._lastAimDist) };
    ctx.save();
    ctx.beginPath(); ctx.arc(scx, scy, rS, 0, TAU); ctx.clip();
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#3a4029'; ctx.fillRect(0, 0, W, H);
    this._worldTransform(ctx, scopeCam.x, scopeCam.y, sPpm);
    this._drawWorldContent(ctx);
    ctx.restore();
    this._scopePov = null;
    this.cam = savedCam; this.renderZoom = savedRZ;

    // Reticle (point of impact) — sway drifts it; the drift grows with range.
    const rx = (this._aimSway.x - scopeCam.x) * sPpm + W / 2;
    const ry = (this._aimSway.y - scopeCam.y) * sPpm + H / 2;
    ctx.save();
    ctx.beginPath(); ctx.arc(scx, scy, rS, 0, TAU); ctx.clip();
    ctx.strokeStyle = 'rgba(15,15,15,0.85)'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(scx - rS, ry); ctx.lineTo(scx + rS, ry);
    ctx.moveTo(rx, scy - rS); ctx.lineTo(rx, scy + rS);
    ctx.stroke();
    ctx.fillStyle = 'rgba(200,40,40,0.9)'; ctx.beginPath(); ctx.arc(rx, ry, 2, 0, TAU); ctx.fill();
    ctx.restore();

    ctx.strokeStyle = 'rgba(8,10,6,0.96)'; ctx.lineWidth = 12;
    ctx.beginPath(); ctx.arc(scx, scy, rS + 6, 0, TAU); ctx.stroke();
    ctx.fillStyle = 'rgba(255,210,120,0.9)'; ctx.font = '12px monospace'; ctx.textAlign = 'center';
    ctx.fillText(`${this._lastAimDist.toFixed(0)} m · ${effMag % 1 ? effMag.toFixed(1) : effMag}×`, scx, scy + rS + 20);
  }

  _drawGround(ctx) {
    const tl = this.screenToWorld(0, 0);
    const br = this.screenToWorld(this.canvas.width, this.canvas.height);
    const g = CONFIG.GRID_METERS;
    const x0 = Math.floor(tl.x / g) * g, x1 = Math.ceil(br.x / g) * g;
    const y0 = Math.floor(tl.y / g) * g, y1 = Math.ceil(br.y / g) * g;

    ctx.lineWidth = 1 / this.ppm;
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.beginPath();
    for (let x = x0; x <= x1; x += g) { ctx.moveTo(x, tl.y); ctx.lineTo(x, br.y); }
    for (let y = y0; y <= y1; y += g) { ctx.moveTo(tl.x, y); ctx.lineTo(br.x, y); }
    ctx.stroke();

    ctx.lineWidth = 0.4;
    ctx.strokeStyle = 'rgba(123,216,143,0.25)';
    ctx.strokeRect(0, 0, this.world.w, this.world.h);
  }

  _drawObstacles(ctx) {
    for (const o of this.world.obstacles) {
      if (o.dead) continue; // shot to rubble — gone
      const m = o.mat;
      if (o.matKey === 'brush') { // concealment: translucent, no hard edge
        ctx.globalAlpha = 0.5; ctx.fillStyle = m.color;
        ctx.fillRect(o.x, o.y, o.w, o.h); ctx.globalAlpha = 1;
        continue;
      }
      ctx.fillStyle = m.color;
      ctx.fillRect(o.x, o.y, o.w, o.h);
      if (o.maxHp > 0 && o.hp < o.maxHp) { // darken as it degrades
        ctx.globalAlpha = (1 - o.hp / o.maxHp) * 0.55;
        ctx.fillStyle = '#000';
        ctx.fillRect(o.x, o.y, o.w, o.h);
        ctx.globalAlpha = 1;
      }
      ctx.lineWidth = 0.05;
      // low cover (you can shoot over it) reads with a light rim; tall cover dark
      ctx.strokeStyle = m.height < 1.5 ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.4)';
      ctx.strokeRect(o.x, o.y, o.w, o.h);
    }
  }

  _drawBullets(ctx) {
    // Ordinary rounds are invisible in flight — you read fights by muzzle
    // flashes and impacts. Only tracer rounds and big .50-class slugs show.
    for (const b of this.bullets) {
      const big = b.weapon.caliber >= 12;            // .50-class slugs you can glimpse
      const tracer = b.tracer && !CONFIG.DAYLIGHT;   // tracers wash out in daylight
      if (!tracer && !big) continue;
      const len = Math.min(2.4, Math.hypot(b.vx, b.vy) * 0.013);
      const sp = Math.hypot(b.vx, b.vy) || 1;
      const tx = b.x - (b.vx / sp) * len, ty = b.y - (b.vy / sp) * len;
      ctx.lineCap = 'round';
      ctx.lineWidth = Math.max(CONFIG.TRACER_MIN_PX / this.ppm, b.r * 2);
      ctx.strokeStyle = b.weapon.tracer;
      ctx.globalAlpha = b.tracer ? 0.9 : 0.4;
      ctx.beginPath();
      ctx.moveTo(tx, ty); ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  _drawCombatant(ctx, e) {
    if (!e.alive) return;
    const isYou = e === this.player;
    const r = e.r;
    // Camouflaged enemies fade with distance — ghillie at range is a ghost.
    if (!isYou) {
      const d = Math.hypot(e.x - this.player.x, e.y - this.player.y);
      ctx.globalAlpha = clamp(1 - (1 - e.camo.spot) * (d / this.sightRange()), e.camo.spot * 0.4, 1);
    }

    // Inside the scope, ANGULAR SIZE: scale each body by its distance from you, so
    // a target at the aim point is "true" size and anything farther renders smaller.
    let sc = 1;
    if (this._scopePov) {
      const pd = Math.hypot(e.x - this._scopePov.x, e.y - this._scopePov.y);
      sc = clamp(this._scopePov.ref / Math.max(3, pd), 0.3, 3);
    }

    // Weapon barrel (also shows facing, since hit zones are concentric).
    const w = e.weapon;
    ctx.save();
    ctx.translate(e.x, e.y);
    ctx.rotate(e.angle);
    ctx.scale(sc, sc);
    ctx.fillStyle = '#23271d';
    ctx.fillRect(r * 0.4, -0.07, Math.max(0.35, w.barrel), 0.14);
    ctx.restore();

    // Concentric hit zones, clearly shrunk by stance so you can read posture:
    // standing full, crouch ~0.74, prone ~0.48 (smaller + lower profile).
    // Colour by side: you cyan, allies teal, enemies red.
    const rr = r * (1 - 0.52 * clamp((e.stanceLevel || 0) / 2, 0, 1)) * sc;
    const col = isYou ? ['#6fd0ff', '#4aa9d6', '#cdefff']
      : e.team === 'player' ? ['#54b89e', '#3f8f7c', '#bfeede']
      : ['#ff7a6b', '#d65a4c', '#ffd23a'];
    ctx.beginPath(); ctx.fillStyle = col[0]; ctx.arc(e.x, e.y, rr, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.fillStyle = col[1]; ctx.arc(e.x, e.y, rr * CONFIG.ZONE_TORSO, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.fillStyle = col[2]; ctx.arc(e.x, e.y, rr * CONFIG.ZONE_HEAD, 0, TAU); ctx.fill();

    // Your own armor band (so you can read your own plate at a glance). No
    // floating health bars or names on enemies — you read them by behavior,
    // posture and blood, not a HUD overlay.
    if (isYou && e.armorPoints > 0) {
      ctx.lineWidth = 0.06; ctx.strokeStyle = 'rgba(220,230,255,0.5)';
      ctx.beginPath(); ctx.arc(e.x, e.y, rr * 0.86, 0, TAU); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  _drawReticle(ctx) {
    const p = this.player;
    if (p.ads) {
      const a = this._aimSway ? this.worldToScreen(this._aimSway.x, this._aimSway.y) : this.input.mouse;
      const x = a.x, y = a.y;
      const mag = p.weapon.optic.mag;
      ctx.strokeStyle = 'rgba(255,80,80,0.9)';
      ctx.lineWidth = 1;
      if (mag >= 4) { ctx.beginPath(); ctx.arc(x, y, 16, 0, TAU); ctx.stroke(); }
      ctx.beginPath();
      const g = mag >= 4 ? 5 : 8, L = mag >= 4 ? 22 : 16;
      ctx.moveTo(x - g - L, y); ctx.lineTo(x - g, y);
      ctx.moveTo(x + g, y); ctx.lineTo(x + g + L, y);
      ctx.moveTo(x, y - g - L); ctx.lineTo(x, y - g);
      ctx.moveTo(x, y + g); ctx.lineTo(x, y + g + L);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,80,80,0.95)';
      ctx.fillRect(x - 1, y - 1, 2, 2);
      { // range to where you're aiming
        const wm = this.screenToWorld(x, y);
        ctx.fillStyle = 'rgba(255,210,120,0.9)';
        ctx.font = '12px monospace'; ctx.textAlign = 'center';
        ctx.fillText(`${Math.hypot(wm.x - p.x, wm.y - p.y).toFixed(0)} m`, x, y + (mag >= 4 ? 34 : 24));
      }
      return;
    }
    // Hipfire crosshair — it's your CONE OF UNCERTAINTY projected onto the target,
    // so it opens up the further out you aim (a 2° group is centimetres at 3 m but
    // metres at 100 m) and tightens to a fine point up close. A scoped weapon from
    // the hip is wild, so it blows out and turns red: "scope me".
    const { x, y } = this.input.mouse;
    const optMag = p.weapon.optic.mag;
    const hipOptic = (optMag - 1) * CONFIG.HIPFIRE_OPTIC_PEN;
    const spreadDeg = p.weapon.spread * CONFIG.HIPFIRE_MULT + hipOptic + p.bloom + CONFIG.MOVE_SPREAD_MAX * p.speedFrac
      + CONFIG.ARM_SPREAD_MAX * p.armWound + CONFIG.BREATH_SPREAD_MAX * (1 - p.stamina / CONFIG.STAMINA_MAX);
    const rx = (p.piloting && !p.piloting.dead) ? p.piloting.x : p.x;
    const ry = (p.piloting && !p.piloting.dead) ? p.piloting.y : p.y;
    const wm = this.screenToWorld(x, y);
    const aimDist = Math.hypot(wm.x - rx, wm.y - ry);
    // Group radius at the aim distance, in screen px (grows with range).
    const cone = clamp(aimDist * Math.tan(rad(spreadDeg)) * this.ppm, 2.5, 300);
    const gap = 3 + cone, len = 6 + cone * 0.2;
    ctx.strokeStyle = optMag > 1 ? 'rgba(255,80,80,0.9)' : 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x - gap - len, y); ctx.lineTo(x - gap, y);
    ctx.moveTo(x + gap, y); ctx.lineTo(x + gap + len, y);
    ctx.moveTo(x, y - gap - len); ctx.lineTo(x, y - gap);
    ctx.moveTo(x, y + gap); ctx.lineTo(x, y + gap + len);
    ctx.stroke();
    // Faint ring showing where rounds could land at this range.
    if (cone > 6) {
      ctx.strokeStyle = optMag > 1 ? 'rgba(255,80,80,0.28)' : 'rgba(255,255,255,0.22)';
      ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(x, y, cone, 0, TAU); ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillRect(x - 1, y - 1, 2, 2);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '11px monospace'; ctx.textAlign = 'center';
    ctx.fillText(`${aimDist.toFixed(0)} m`, x, y + gap + len + 12);
  }

  _drawScopeOverlay(ctx) {
    if (!this.player.ads) return;
    const strength = clamp((this.player.weapon.optic.mag - 1) / 9, 0, 1);
    if (strength <= 0.01) return;
    const W = this.canvas.width, H = this.canvas.height, cx = W / 2, cy = H / 2;
    const r0 = Math.min(W, H) * (0.5 - 0.18 * strength);
    const r1 = Math.max(W, H) * 0.75;
    const g = ctx.createRadialGradient(cx, cy, r0, cx, cy, r1);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${0.85 * strength})`);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }

  _drawDamageVignette(ctx) {
    const p = this.player;
    let v = (1 - clamp(p.hp / p.maxHp, 0, 1)) * 0.55;
    if (p.bleed > 0) v = Math.max(v, 0.2);
    if (!p.alive) v = Math.max(v, 0.5);
    if (v < 0.02) return;
    const W = this.canvas.width, H = this.canvas.height;
    const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.7);
    g.addColorStop(0, 'rgba(120,0,0,0)');
    g.addColorStop(1, `rgba(150,0,0,${v})`);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }

  // A map-style scale bar so you can read real distances at the current zoom.
  _drawScaleBar(ctx) {
    const candidates = [1, 2, 5, 10, 20, 50, 100, 200, 500];
    const targetPx = 170;
    let meters = candidates[0];
    for (const m of candidates) if (m * this.ppm <= targetPx) meters = m;
    const px = meters * this.ppm;
    const W = this.canvas.width, H = this.canvas.height;
    const x0 = W / 2 - px / 2, y = H - 52;

    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x0, y - 5); ctx.lineTo(x0, y + 5);
    ctx.moveTo(x0, y); ctx.lineTo(x0 + px, y);
    ctx.moveTo(x0 + px, y - 5); ctx.lineTo(x0 + px, y + 5);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = '12px monospace'; ctx.textAlign = 'center';
    ctx.fillText(`${meters} m  (grid = ${CONFIG.GRID_METERS} m)`, x0 + px / 2, y - 9);
  }

  // Fog of war: darken everything, then carve out the visible cone — a fan of
  // rays from the player, clipped by walls, within the field of view.
  // Atmospheric perspective: distant things wash out into a dusty haze. Since
  // the camera sits near you, screen edges ≈ far away — and it's hazier the
  // more zoomed out you are (you're seeing farther).
  _drawHaze(ctx) {
    const W = this.canvas.width, H = this.canvas.height;
    const strength = clamp(0.2 / this.renderZoom, 0.05, 0.4);
    const cx = W / 2, cy = H / 2;
    const g = ctx.createRadialGradient(cx, cy, Math.min(W, H) * 0.16, cx, cy, Math.max(W, H) * 0.62);
    g.addColorStop(0, 'rgba(176,186,170,0)');
    g.addColorStop(1, `rgba(176,186,170,${strength})`);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }

  _drawFog(ctx) {
    const p = this.player, W = this.canvas.width, H = this.canvas.height;
    const rays = CONFIG.VISION_RAYS, fov = rad(CONFIG.FOV_DEG), half = fov / 2;
    const R = this.sightRange();

    // Build the visible cone (rays clipped by sight-blockers), then darken only
    // the area OUTSIDE it via an even-odd clip — the cone stays fully visible.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    const c = this.worldToScreen(p.x, p.y);
    ctx.moveTo(c.x, c.y);
    for (let i = 0; i <= rays; i++) {
      const a = p.angle - half + fov * (i / rays);
      const bx = p.x + Math.cos(a) * R, by = p.y + Math.sin(a) * R;
      let t = this.world.rayHitVision(p.x, p.y, bx, by);
      if (t === null) t = 1;
      const s = this.worldToScreen(p.x + (bx - p.x) * t, p.y + (by - p.y) * t);
      ctx.lineTo(s.x, s.y);
    }
    ctx.closePath();
    ctx.clip('evenodd');                 // clip = whole screen MINUS the cone
    ctx.fillStyle = `rgba(20,24,15,${CONFIG.FOG_DARK})`;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  // Directional incoming-fire markers around the screen edge.
  _drawThreats(ctx) {
    this.threats = this.threats.filter((t) => this.time - t.t < CONFIG.THREAT_TTL);
    const W = this.canvas.width, H = this.canvas.height;
    const cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.33;
    for (const th of this.threats) {
      const age = (this.time - th.t) / CONFIG.THREAT_TTL;
      const x = cx + Math.cos(th.angle) * R, y = cy + Math.sin(th.angle) * R;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(th.angle + Math.PI / 2);
      ctx.globalAlpha = (1 - age) * th.strength;
      ctx.fillStyle = '#ff4d4d';
      ctx.beginPath();
      ctx.moveTo(0, -13); ctx.lineTo(10, 7); ctx.lineTo(-10, 7); ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  // "[E] get in" prompt when you're on foot next to an enterable vehicle, plus a
  // one-liner on how to crew it. While climbing in, show the timed progress.
  _drawVehiclePrompt(ctx) {
    const p = this.player;
    if (!p.alive || p.inVehicle || (p.piloting && !p.piloting.dead)) return;
    // Already climbing into one → show the countdown over that vehicle.
    if (this._entering) {
      const v = this._entering.v;
      const left = Math.max(0, this._entering.until - this.time);
      ctx.fillStyle = 'rgba(255,210,120,0.95)';
      ctx.font = '0.7px monospace'; ctx.textAlign = 'center';
      ctx.fillText(`climbing in… ${left.toFixed(1)}s  (E to cancel)`, v.x, v.y - v.radius - 0.5);
      return;
    }
    let best = null, bd = 6 * 6;
    for (const v of this.vehicles) {
      if (v.dead || v.driver) continue;
      const d = (v.x - p.x) ** 2 + (v.y - p.y) ** 2;
      if (d < bd) { bd = d; best = v; }
    }
    if (!best) return;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.font = '0.72px monospace';
    ctx.fillText(`[E] get in — ${best.s.name}`, best.x, best.y - best.radius - 0.7);
    ctx.fillStyle = 'rgba(210,222,200,0.6)'; ctx.font = '0.48px monospace';
    ctx.fillText(best.s.weapon ? 'WASD drive · Space to man the gun (or an ally will)' : 'WASD drive', best.x, best.y - best.radius - 0.2);
  }

  _drawLoot(ctx) {
    // Brief "+N mags" confirmation after a scavenge.
    const m = this._lootMsg;
    if (m && this.time - m.t < 1.2) {
      ctx.fillStyle = `rgba(180,235,190,${clamp(1 - (this.time - m.t) / 1.2, 0, 1)})`;
      ctx.font = '0.6px monospace'; ctx.textAlign = 'center';
      ctx.fillText(m.text, m.x, m.y - 1.1 - (this.time - m.t));
    }
    // No loose items on the ground — you can't spot a death from afar. The only
    // cue is a small prompt when you're standing right on a body with gear.
    const k = this._lootTarget;
    if (!k) return;
    const g = k.gear;
    let label;
    if (g.wid && g.wid !== 'none') {
      label = this.player.carries(g.wid)
        ? `take ammo · ${WEAPON_BY_ID[g.wid].name}` // you already have this gun
        : `take ${WEAPON_BY_ID[g.wid].name}`;
    } else {
      label = `take ${ARMOR_BY_ID[g.armorId].name}`;
    }
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.font = '0.62px monospace'; ctx.textAlign = 'center';
    ctx.fillText(`[F] ${label}`, k.x, k.y - 0.7);
  }

  // Visual magazine inventory, stacked down the RIGHT EDGE of the screen (out of the
  // way of the weapon-info panel) — the top bar is your loaded mag, the rest are
  // spares, each a fill bar of the rounds it holds. Read your ammo at a glance.
  _drawMagInventory(ctx) {
    const p = this.player;
    if (!p.alive || p.inVehicle || (p.piloting && !p.piloting.dead)) return;
    const a = p._ammo, cap = p.weapon.mag;
    const mags = [a.loaded, ...a.spares];
    const total = mags.length;
    const W = this.canvas.width, H = this.canvas.height;
    const bw = 48, bh = 9, gap = 4;
    const x = W - bw - 18;
    const blockH = total * (bh + gap);
    const y0 = clamp(H / 2 - blockH / 2, 90, H - blockH - 120);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(200,214,200,0.75)'; ctx.font = '600 11px system-ui, sans-serif';
    const totalRounds = mags.reduce((s, m) => s + m, 0);
    ctx.fillText(`MAGS ${total} · ${totalRounds} rds`, x + bw, y0 - 7);
    for (let i = 0; i < total; i++) {
      const yy = y0 + i * (bh + gap), f = clamp(mags[i] / cap, 0, 1);
      ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(x, yy, bw, bh);
      ctx.fillStyle = i === 0 ? (mags[0] > 0 ? '#7bd88f' : '#7a3a3a') : '#9aa88d';
      ctx.fillRect(x, yy, bw * f, bh);
      ctx.strokeStyle = i === 0 ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.2)';
      ctx.lineWidth = 1; ctx.strokeRect(x, yy, bw, bh);
    }
  }

  _drawVehicles(ctx) {
    for (const v of this.vehicles) {
      ctx.save(); ctx.translate(v.x, v.y); ctx.rotate(v.angle);
      ctx.fillStyle = v.dead ? '#2a2a26' : v.s.color;
      ctx.fillRect(-v.s.w / 2, -v.s.h / 2, v.s.w, v.s.h);
      ctx.lineWidth = 0.08; ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.strokeRect(-v.s.w / 2, -v.s.h / 2, v.s.w, v.s.h);
      if (!v.dead && v.hp < v.maxHp) {
        ctx.globalAlpha = (1 - v.hp / v.maxHp) * 0.5; ctx.fillStyle = '#000';
        ctx.fillRect(-v.s.w / 2, -v.s.h / 2, v.s.w, v.s.h); ctx.globalAlpha = 1;
      }
      ctx.restore();
      if (!v.dead && v.s.weapon) {
        ctx.save(); ctx.translate(v.x, v.y); ctx.rotate(v.turret);
        ctx.fillStyle = '#3a4030'; ctx.beginPath(); ctx.arc(0, 0, v.s.h * 0.38, 0, TAU); ctx.fill();
        ctx.fillStyle = '#23271d';
        const bl = v.s.weapon === 'cannon' ? VEHICLE_WEAPONS.cannon.barrel : 1.5;
        ctx.fillRect(0, -0.12, bl, 0.24);
        ctx.restore();
      }
    }
  }

  _drawShells(ctx) {
    ctx.fillStyle = '#ffcf8a';
    for (const s of this.shells) { ctx.beginPath(); ctx.arc(s.x, s.y, 0.2, 0, TAU); ctx.fill(); }
  }

  _drawBombs(ctx) {
    for (const b of this.bombs) {
      const z = b.z || 0;
      // TELEGRAPH: a red danger ring at the predicted impact, with an inner circle
      // that closes in as the bomb falls — so you can see where NOT to be and dodge.
      const frac = clamp(z / (b._alt0 || 1), 0, 1); // 1 high → 0 about to land
      const tx = b.tx != null ? b.tx : b.x, ty = b.ty != null ? b.ty : b.y;
      ctx.strokeStyle = `rgba(255,60,50,${0.5 + 0.4 * (1 - frac)})`; ctx.lineWidth = 0.12;
      ctx.beginPath(); ctx.arc(tx, ty, b.radius, 0, TAU); ctx.stroke();
      ctx.beginPath(); ctx.arc(tx, ty, b.radius * frac, 0, TAU); ctx.stroke(); // closing marker
      // Shrinking ground shadow directly below; the bomb drawn lifted by height.
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.beginPath(); ctx.arc(b.x, b.y, 0.18 + z * 0.006, 0, TAU); ctx.fill();
      ctx.fillStyle = '#2a2a2a';
      ctx.beginPath(); ctx.arc(b.x, b.y - z * 0.05, 0.2, 0, TAU); ctx.fill();
    }
  }

  _drawDrones(ctx) {
    for (const d of this.drones) {
      if (d.dead) continue;
      ctx.strokeStyle = 'rgba(0,0,0,0.22)'; ctx.lineWidth = 0.04; // ground shadow
      ctx.beginPath(); ctx.arc(d.x, d.y, 0.7, 0, TAU); ctx.stroke();
      ctx.save(); ctx.translate(d.x, d.y); ctx.rotate(d.angle);
      ctx.fillStyle = d.type === 'fpv' ? '#e08a8a' : '#8fd0a0';
      ctx.fillRect(-0.32, -0.32, 0.64, 0.64);
      ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 0.05;
      for (const [ox, oy] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) {
        ctx.beginPath(); ctx.arc(ox, oy, 0.26, 0, TAU); ctx.stroke();
      }
      ctx.restore();
    }
  }

  _drawUAV(ctx) { // recon: red diamonds over living enemies while the UAV is up
    if (this.time >= this.uavUntil) return;
    ctx.fillStyle = 'rgba(255,90,90,0.9)';
    for (const b of this.bots) {
      if (!b.alive || b.inVehicle) continue;
      const s = this.worldToScreen(b.x, b.y);
      ctx.beginPath();
      ctx.moveTo(s.x, s.y - 7); ctx.lineTo(s.x + 6, s.y); ctx.lineTo(s.x, s.y + 7); ctx.lineTo(s.x - 6, s.y);
      ctx.closePath(); ctx.fill();
    }
  }

  _drawMarkers(ctx) { // radio pings + inbound airstrike
    ctx.font = '12px monospace'; ctx.textAlign = 'center';
    for (const m of this.pings) {
      const s = this.worldToScreen(m.x, m.y);
      if (m.strike) {
        const left = this.strikePending ? Math.max(0, this.strikePending.at - this.time) : 0;
        ctx.strokeStyle = 'rgba(255,80,80,0.9)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(s.x, s.y, 14, 0, TAU); ctx.stroke();
        ctx.fillStyle = 'rgba(255,80,80,0.9)';
        ctx.fillText(left > 0 ? `STRIKE ${left.toFixed(1)}s` : 'IMPACT', s.x, s.y - 18);
      } else {
        ctx.fillStyle = 'rgba(120,200,255,0.9)';
        ctx.beginPath();
        ctx.moveTo(s.x, s.y - 9); ctx.lineTo(s.x + 5, s.y + 4); ctx.lineTo(s.x - 5, s.y + 4);
        ctx.closePath(); ctx.fill();
      }
    }
  }

  _drawCorpses(ctx) {
    // A body is drawn EXACTLY like a living combatant — same circle, same gun.
    // You can't tell dead from alive (or playing dead) at a glance; only that it
    // isn't moving or shooting. They lie where they fell.
    const R = CONFIG.PLAYER_RADIUS;
    const piloting = this.player.piloting && !this.player.piloting.dead;
    for (const c of this.corpses) {
      // A body is only visible when you're actually looking at it — same as a
      // living person. Killing leaves no marker you can see from across the map.
      const vis = this._freeLook || (piloting
        ? Math.hypot(c.x - this.player.piloting.x, c.y - this.player.piloting.y) < this.player.piloting.s.sight
        : this.canSeePoint(c.x, c.y));
      if (!vis) continue;
      const isYou = c.team === 'player';
      // Dead indicator-ish: a real corpse slowly pools blood beneath it. A living
      // body playing dead does NOT — so a growing dark pool is your only tell, and
      // only up close where you can actually see it (a faker looks identical bar this).
      const pool = clamp((this.time - c.t) * 0.22 + 0.22, 0.22, R * 1.7);
      ctx.beginPath(); ctx.fillStyle = 'rgba(90,12,12,0.5)';
      ctx.ellipse(c.x, c.y, pool, pool * 0.72, c.angle, 0, TAU); ctx.fill();
      ctx.save(); ctx.translate(c.x, c.y); ctx.rotate(c.angle);
      ctx.fillStyle = '#23271d'; ctx.fillRect(R * 0.4, -0.07, 0.55, 0.14); // gun still in hand
      ctx.restore();
      ctx.beginPath(); ctx.fillStyle = isYou ? '#6fd0ff' : '#ff7a6b'; ctx.arc(c.x, c.y, R, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.fillStyle = isYou ? '#4aa9d6' : '#d65a4c'; ctx.arc(c.x, c.y, R * CONFIG.ZONE_TORSO, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.fillStyle = isYou ? '#cdefff' : '#ffd23a'; ctx.arc(c.x, c.y, R * CONFIG.ZONE_HEAD, 0, TAU); ctx.fill();
    }
  }

  _drawMinimap() {
    const c = this.mctx, S = this.minimap.width;
    c.clearRect(0, 0, S, S);
    this._drawMapContent(c, 0, 0, S);
  }

  // The big tactical map (toggle with M) — the whole battlefield, filling most of
  // the screen; click it to rally your squad.
  _drawBigMap(ctx) {
    if (!this._bigMap) return;
    const W = this.canvas.width, H = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = 'rgba(4,6,3,0.72)'; ctx.fillRect(0, 0, W, H);
    const S = Math.min(W, H) * 0.84, ox = (W - S) / 2, oy = (H - S) / 2;
    ctx.fillStyle = 'rgba(12,16,9,0.96)'; ctx.fillRect(ox, oy, S, S);
    ctx.strokeStyle = 'rgba(123,216,143,0.45)'; ctx.lineWidth = 2; ctx.strokeRect(ox, oy, S, S);
    this._drawMapContent(ctx, ox, oy, S);
    ctx.fillStyle = '#cfe0d6'; ctx.font = '600 15px system-ui, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('TACTICAL MAP — click to rally squad · right-click to recall · M to close', W / 2, oy - 12);
    ctx.textAlign = 'left';
  }

  // Draw map content into any 2D context, at (ox,oy) filling an S×S box. Shared by
  // the corner minimap and the full-screen map so they stay in sync.
  _drawMapContent(c, ox, oy, S) {
    const sx = S / this.world.w, sy = S / this.world.h, m = S / 180; // marker scale vs minimap
    const X = (wx) => ox + wx * sx, Y = (wy) => oy + wy * sy;
    for (const o of this.world.obstacles) {
      if (o.dead) continue;
      c.fillStyle = o.mat.cover ? 'rgba(190,200,170,0.45)' : 'rgba(90,150,80,0.30)';
      c.fillRect(X(o.x), Y(o.y), Math.max(1, o.w * sx), Math.max(1, o.h * sy));
    }
    c.fillStyle = 'rgba(150,40,40,0.6)';
    for (const k of this.corpses) c.fillRect(X(k.x) - m, Y(k.y) - m, 2 * m, 2 * m);
    for (const v of this.vehicles) {
      if (v.dead) continue;
      c.fillStyle = '#caa45a'; c.fillRect(X(v.x) - 2 * m, Y(v.y) - 2 * m, 4 * m, 4 * m);
    }
    // Enemies: UAV paints all; otherwise only spotted contacts (fading).
    if (this.time < this.uavUntil) {
      c.fillStyle = '#ff5a5a';
      for (const b of this.bots) if (b.alive) c.fillRect(X(b.x) - 1.5 * m, Y(b.y) - 1.5 * m, 3 * m, 3 * m);
    } else {
      for (const b of this.bots) {
        if (!b.alive || !(b._spottedUntil > this.time)) continue;
        const fade = clamp((b._spottedUntil - this.time) / 4, 0, 1);
        c.fillStyle = `rgba(255,80,80,${0.35 + 0.5 * fade})`;
        c.fillRect(X(b.x) - 1.5 * m, Y(b.y) - 1.5 * m, 3 * m, 3 * m);
      }
    }
    const tl = this.screenToWorld(0, 0), br = this.screenToWorld(this.canvas.width, this.canvas.height);
    c.strokeStyle = 'rgba(255,255,255,0.3)'; c.lineWidth = m;
    c.strokeRect(X(tl.x), Y(tl.y), (br.x - tl.x) * sx, (br.y - tl.y) * sy);
    if (this.squadRally) {
      const rx = X(this.squadRally.x), ry = Y(this.squadRally.y);
      c.strokeStyle = '#ffd257'; c.lineWidth = 1.5 * m;
      c.beginPath(); c.arc(rx, ry, 4 * m, 0, TAU); c.stroke();
      c.beginPath(); c.moveTo(rx - 6 * m, ry); c.lineTo(rx + 6 * m, ry);
      c.moveTo(rx, ry - 6 * m); c.lineTo(rx, ry + 6 * m); c.stroke();
    }
    c.fillStyle = '#54b89e';
    for (const a of this.squad) if (a.alive) c.fillRect(X(a.x) - 1.5 * m, Y(a.y) - 1.5 * m, 3 * m, 3 * m);
    const px = X(this.player.x), py = Y(this.player.y);
    c.strokeStyle = '#6fd0ff'; c.lineWidth = 1.5 * m;
    c.beginPath(); c.moveTo(px, py); c.lineTo(px + Math.cos(this.player.angle) * 9 * m, py + Math.sin(this.player.angle) * 9 * m); c.stroke();
    c.fillStyle = '#6fd0ff'; c.beginPath(); c.arc(px, py, 2.5 * m, 0, TAU); c.fill();
    // Your cursor / aim point on the map — a white crosshair where you're pointing, so
    // you can see it relative to your position and the contacts.
    const aim = this.screenToWorld(this.input.mouse.x, this.input.mouse.y);
    const ax = X(clamp(aim.x, 0, this.world.w)), ay = Y(clamp(aim.y, 0, this.world.h));
    c.strokeStyle = 'rgba(255,255,255,0.8)'; c.lineWidth = m;
    c.beginPath();
    c.moveTo(ax - 3.5 * m, ay); c.lineTo(ax + 3.5 * m, ay);
    c.moveTo(ax, ay - 3.5 * m); c.lineTo(ax, ay + 3.5 * m);
    c.stroke();
  }

  // --------------------------------------------------------------- HUD (DOM)
  _cacheHud() {
    const $ = (id) => document.getElementById(id);
    this.hud = {
      healthfill: $('healthfill'), healthtext: $('healthtext'),
      stamfill: $('stamfill'), armor: $('armor'),
      weaponname: $('weaponname'), optic: $('optic'), firemode: $('firemode'),
      mag: $('mag'), reserve: $('reserve'), magcount: $('magcount'),
      reloadbar: $('reloadbar'), reloadfill: $('reloadfill'),
      scale: $('scale-readout'), killfeed: $('killfeed'), abilities: $('abilities'), scoreboard: $('scoreboard'),
      status: $('status'), rack: $('weapons-rack'),
    };
    if (this.hud.firemode) this.hud.firemode.onclick = () => this.player.cycleFireMode();
  }

  _buildRack() {
    const rack = document.getElementById('weapons-rack');
    rack.innerHTML = '';
    this.player.loadout.forEach((id, idx) => {
      const w = WEAPON_BY_ID[id];
      const el = document.createElement('div');
      el.className = 'slot';
      el.dataset.idx = idx;
      el.innerHTML = `<span class="n">${idx + 1}</span>${w.name}`;
      rack.appendChild(el);
    });
  }

  _updateHud() {
    const p = this.player, h = this.hud, w = p.weapon;

    const hpPct = clamp(p.hp / p.maxHp, 0, 1) * 100;
    h.healthfill.style.width = hpPct + '%';
    h.healthfill.style.background = p.hp > 50 ? 'linear-gradient(90deg,#4caf6a,#7bd88f)'
      : p.hp > 25 ? 'linear-gradient(90deg,#c9a23a,#ffcc66)' : 'linear-gradient(90deg,#a33,#ff5d5d)';
    h.healthtext.textContent = Math.max(0, Math.ceil(p.hp));

    h.stamfill.style.width = clamp(p.stamina / CONFIG.STAMINA_MAX, 0, 1) * 100 + '%';

    h.armor.textContent = p.armor.points > 0
      ? `🛡 ${p.armor.name} · ${Math.ceil(p.armorPoints)} · ${p.encumbrance.toFixed(1)}kg`
      : `🛡 ${p.armor.name} · ${p.encumbrance.toFixed(1)}kg`;

    h.weaponname.textContent = `${w.name} · ${w.class}`;
    h.optic.textContent = p.ads
      ? `${w.optic.name} — ${w.optic.variable ? this._effMag.toFixed(1) : w.optic.mag}×`
      : w.optic.name;
    h.firemode.textContent = p.fireModeSel.toUpperCase();
    h.firemode.classList.toggle('safe', p.fireModeSel === 'safe');
    h.mag.textContent = p.mag;
    h.reserve.textContent = p.reserve;
    h.magcount.textContent = p.magsLeft > 0 ? `${p.magsLeft} mag${p.magsLeft > 1 ? 's' : ''}` : 'last mag';

    if (p.inVehicle && p.vehicle) { // override the weapon panel while crewing
      const v = p.vehicle;
      const station = v.s.weapon ? (v.station === 'driver' ? 'DRIVER' : 'GUNNER') : 'DRIVER';
      const ally = v.gunner ? ` · ${v.gunner.name} on gun` : '';
      h.weaponname.textContent = `${v.s.name} · ${station}${ally}`;
      h.optic.textContent = v.s.weapon === 'cannon' ? `cannon · ${v.rounds} rds`
        : v.s.weapon === 'mg' ? 'mounted MG' : 'unarmed';
      h.firemode.textContent = v.fuel > 0 ? 'CREW' : 'NO FUEL';
      h.mag.textContent = Math.max(0, Math.ceil(v.hp));
      h.reserve.textContent = `fuel ${Math.ceil(v.fuel)}`;
      h.magcount.textContent = v.gunner ? 'E: exit (ally gunning)'
        : v.s.weapon ? 'Space: station · E: exit' : 'E: exit';
    } else if (p.piloting && !p.piloting.dead) { // ...or flying a drone
      const d = p.piloting;
      h.weaponname.textContent = `${d.s.name} — PILOTING`;
      h.optic.textContent = d.type === 'fpv'
        ? 'FPV kamikaze · one-way'
        : `bombs ${d.bombs}/${d.s.bombs}${d._resupply ? ' · REARMING' : ''}`;
      h.firemode.textContent = d._resupply ? 'RESUPPLY' : 'FLYING';
      h.firemode.classList.toggle('safe', false);
      h.mag.textContent = Math.max(0, Math.ceil(d.battery));
      h.reserve.textContent = `bat ${Math.ceil(d.s.battery)}`;
      h.magcount.textContent = (d.type === 'bomber' ? 'B' : 'N') + ': recall/land';
    }

    if (p.reloading) {
      h.reloadbar.classList.add('active');
      h.reloadfill.style.width = p.reloadProgress(this.time) * 100 + '%';
    } else h.reloadbar.classList.remove('active');

    const metersAcross = (this.canvas.width / this.ppm).toFixed(0);
    // Live headcount — your team standing vs theirs (team deathmatch).
    const aliveP = this.all.filter((e) => e.team === 'player' && e.alive).length;
    const aliveE = this.all.filter((e) => e.team === 'enemy' && e.alive).length;
    const squad = this.squad.length
      ? ` &nbsp;·&nbsp; <span class="sq-order" data-act="squad" title="click (or Y) to change order">squad ${this.squad.filter((s) => s.alive).length}/${this.squad.length} ${this.squadOrder.toUpperCase()}${this.squadRally ? ' →RALLY' : ''}</span>`
      : '';
    h.scale.innerHTML =
      `<span style="color:#7fe0c0">◈ ${aliveP}</span> vs <span style="color:#ff7a6a">${aliveE}</span>` +
      ` &nbsp;·&nbsp; 🧨 ${p.grenades} &nbsp;·&nbsp; ${metersAcross}m${squad}` +
      ` &nbsp;·&nbsp; <span style="opacity:.55">Tab: scores</span>`;

    // Ability / support prompts — always on screen so you know what's ready, the
    // key to fire it, and roughly how it's used.
    if (h.abilities) {
      const t = this.time;
      const cd = (readyAt) => (t < readyAt ? `${Math.ceil(readyAt - t)}s` : 'READY');
      const cls = (readyAt) => (t < readyAt ? 'cool' : 'ready');
      // Compact chips: key + name + state. The how-to lives in the hover tooltip
      // so the panel stays small and out of the way.
      const row = (act, key, name, how, state, klass) =>
        `<div class="ab ${klass}" data-act="${act}" title="${name} — ${how} · press ${key} or click"><kbd>${key}</kbd>` +
        `<span class="nm">${name}</span><span class="st">${state}</span></div>`;
      const flying = p.piloting && !p.piloting.dead;
      const rows = [];
      rows.push(flying && p.piloting.type === 'recon'
        ? row('uav', 'U', 'UAV', 'flying recon · reveals all it sees', `${Math.ceil(p.piloting.battery)}s`, 'active')
        : row('uav', 'U', 'UAV', 'fly a recon drone (can’t be shot down)', cd(this.uavReadyAt), cls(this.uavReadyAt)));
      rows.push(this.strikePending
        ? row('strike', 'H', 'Airstrike', 'salvo inbound…', 'INBOUND', 'active')
        : row('strike', 'H', 'Airstrike', 'aim, then call — salvo on cursor', cd(this.strikeReadyAt), cls(this.strikeReadyAt)));
      rows.push(flying && p.piloting.type === 'bomber'
        ? row('bomber', 'B', 'Bomber', p.piloting._resupply ? 'REARMING at base' : 'click drops · fly home to rearm', `${p.piloting.bombs}💣 ${Math.ceil(p.piloting.battery)}s`, 'active')
        : row('bomber', 'B', 'Bomber', 'fly WASD, drop bombs, fly home to refill', cd(this.bomberReadyAt), cls(this.bomberReadyAt)));
      rows.push(flying && p.piloting.type === 'fpv'
        ? row('fpv', 'N', 'FPV', 'ram a target · click detonates', `${Math.ceil(p.piloting.battery)}s`, 'active')
        : row('fpv', 'N', 'FPV', 'kamikaze — fly it into a target', cd(this.fpvReadyAt), cls(this.fpvReadyAt)));
      rows.push(row('ping', 'X', 'Ping', 'mark a spot on the map', 'READY', 'ready'));
      h.abilities.innerHTML = rows.join('');
    }

    // Kill feed — recent kills across the battlefield (fades after a few seconds).
    if (h.killfeed) {
      const rows = this.killfeed.filter((k) => this.time - k.t < 8).slice(-5).reverse();
      h.killfeed.innerHTML = rows.map((k) => {
        const kc = k.killerTeam === 'player' ? '#7fe0c0' : '#ff7a6a';
        const vc = k.victimTeam === 'player' ? '#7fe0c0' : '#ff7a6a';
        const kn = k.killer ? `<b style="color:${kc}">${k.killer}</b>` : '';
        const mark = k.ff ? '⚠' : k.headshot ? '🎯' : '▸';
        const sep = k.killer ? ` <span style="opacity:.6">${mark}</span> ` : '';
        const tk = k.ff ? ` <small style="color:#ffb454">TK</small>` : '';
        return `<div><span class="k">${kn}${sep}<b style="color:${vc}">${k.victim}</b>${tk}` +
          `<small style="opacity:.5"> · ${k.weapon}</small></span></div>`;
      }).join('');
    }

    const st = [];
    if (p.bleed > 0.3) st.push('<span class="bleed">BLEEDING</span>');
    const lb = p.limb || { la: 0, ra: 0, ll: 0, rl: 0 };
    const legsHit = (lb.ll > 0.05 ? 1 : 0) + (lb.rl > 0.05 ? 1 : 0);
    const armsHit = (lb.la > 0.05 ? 1 : 0) + (lb.ra > 0.05 ? 1 : 0);
    if (legsHit >= 2) st.push('<span class="bleed">BOTH LEGS — CRAWLING</span>');
    else if (legsHit === 1) st.push('<span class="wound">LEG HIT — slowed</span>');
    if (armsHit >= 2) st.push('<span class="bleed">BOTH ARMS — CAN’T AIM</span>');
    else if (armsHit === 1) st.push('<span class="wound">ARM HIT — shaky aim</span>');
    if (p.stamina < 20) st.push('<span class="tired">WINDED</span>');
    if (this.enemyDrones.some((d) => !d.dead)) st.push('<span class="bleed">INCOMING AIR</span>');
    if (this.enemyFpvs.some((d) => !d.dead)) st.push('<span class="bleed">FPV INBOUND</span>');
    if (p.stanceLevel > 1.5) st.push('<span class="tired">PRONE</span>');
    else if (p.stanceLevel > 0.5) st.push('<span class="tired">CROUCH</span>');
    if (p.bipod) st.push('<span class="tired">BIPOD</span>');
    if (this._entering) st.push('<span class="wound">CLIMBING IN…</span>');
    if (p._suppressChangeEnd > this.time) st.push('<span class="tired">SUPP…</span>');
    else if (p.suppressed) st.push('<span class="tired">SUPP</span>');
    h.status.innerHTML = st.join(' ');

    for (const el of h.rack.children) el.classList.toggle('active', +el.dataset.idx === p.slot);

    this._updateScoreboard();
  }
}
