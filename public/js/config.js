// Global tuning. The golden rule: the simulation thinks in METERS and
// SECONDS. Pixels exist only at render time, via PPM and the camera zoom.

export const CONFIG = {
  // ---- Scale ----
  PPM: 24,            // base pixels per meter at zoom = 1
  ZOOM_MIN: 0.1,      // zoom way out: ~500 m across — most of the map
  ZOOM_MAX: 2.2,      // hipfire zoom-in: ~24 m across
  ZOOM_DEFAULT: 1.0,
  ADS_ZOOM_MAX: 14,   // scopes can zoom well past the hipfire clamp

  // ---- World (meters) ----
  WORLD_W: 850,
  WORLD_H: 850,

  // ---- Human body (meters) ----
  PLAYER_RADIUS: 0.25,   // 0.5 m footprint, shoulder-ish
  PLAYER_HP: 100,

  // ---- Movement (m/s) — real human gaits ----
  SPEED_WALK: 1.4,       // holding Ctrl: a brisk walk (~5 km/h)
  SPEED_RUN: 5.0,        // default: a steady run (~18 km/h)
  SPEED_SPRINT: 8.0,     // flat-out sprint (fit human ~8 m/s; Bolt ~10)
  ACCEL: 28,             // m/s^2, how fast you reach target velocity
  FRICTION: 18,          // m/s^2 deceleration when no input
  MOVE_SPREAD_MAX: 4.5,  // extra aim spread (deg) at full speed
  RECOIL_KICK_PX: 4.0,   // per-shot reticle climb (px), scaled by the gun's recoil
  RECOIL_RECOVER: 9,     // how fast the reticle settles back (per second)
  BACKPEDAL_MULT: 0.5,   // you move much slower backwards than where you face
  STRAFE_MULT: 0.78,     // and a little slower sideways
  HIPFIRE_OPTIC_PEN: 2.0, // extra hipfire spread (deg) per magnification — scoped guns are wild un-aimed

  // ---- Aiming down sights ----
  ADS_SLOW: 0.5,          // move-speed multiplier while scoped
  ADS_ACCURACY: 0.30,     // base-spread multiplier while aiming (much tighter)
  ADS_ZOOM_PER_MAG: 0.4,  // smooth zoom-in per point of optic magnification (1× = none)
  ADS_ZOOM_EASE: 7,       // how fast the scope zoom eases in/out (lower = smoother)
  HIPFIRE_MULT: 2.8,      // hip fire is far less accurate than aimed fire

  // ---- Encumbrance: carried weight (gun + armor) slows you ----
  LOAD_FREE_KG: 4.0,         // weight up to here is "free"
  LOAD_SLOW_PER_KG: 0.012,   // fraction of speed lost per kg over free load
  LOAD_SLOW_MIN: 0.55,       // never slower than 55% of base

  // ---- Stamina ----
  // All movement costs stamina (sprint most, jog some, walk a little); you only
  // recover standing still. Being winded makes you breathe hard → shaky aim.
  STAMINA_MAX: 100,
  STAMINA_SPRINT_DRAIN: 1.3,  // /s while sprinting — a fit soldier sprints ~75s at light load
  STAMINA_JOG_DRAIN: 0.15,    // /s jogging — negligible; you can move all day
  STAMINA_WALK_DRAIN: 0,      // walking recovers (counts as rest)
  STAMINA_LOAD_DRAIN: 0.28,   // extra /s per kg over free load (full when sprinting)
  STAMINA_REGEN: 18,          // /s — recover quickly when not sprinting
  STAMINA_REGEN_DELAY: 0.5,   // s before recovery kicks in
  STAMINA_SPRINT_MIN: 8,      // need this much to *start* a sprint
  ADS_STAMINA_DRAIN: 0.7,     // /s — holding the gun up at the shoulder tires your arms
  STAMINA_WOUND_DRAIN: 2.6,   // /s EXTRA when a leg is hit — THIS is what gasses you out
  BREATH_SPREAD_MAX: 2.0,     // extra aim spread (deg) when fully winded

  // ---- Scope/aim sway — ANGULAR (radians). Positional waver = angle × range,
  //      so it barely moves up close but drifts a lot far out (and the scope
  //      magnifies it). Steady when still & rested; bad when moving/winded.
  SWAY_BASE_RAD: 0.0012,
  SWAY_MOVE_RAD: 0.011,      // added at full movement
  SWAY_TIRED_RAD: 0.009,     // added at zero stamina

  // ---- Wounding model (concentric top-down zones, fraction of radius) ----
  ZONE_HEAD: 0.30,           // (legacy) center fraction — see HEAD_CHANCE
  ZONE_TORSO: 0.62,          // mid ring = torso/vitals → full damage + bleed
  // (outside ZONE_TORSO = a limb/graze)
  // A centre-of-mass hit is USUALLY torso; a head/CNS instant-kill is a lucky
  // central strike, NOT automatic — so point-blank isn't a guaranteed headshot.
  HEAD_CHANCE: 0.16,         // chance a solid centre hit is a lethal CNS/head shot
  LIMB_DMG_MULT: 0.4,        // limbs far less lethal than center mass
  TORSO_BLEED: 0.09,         // bleed rate (hp/s) added per torso hit, ~damage
  LIMB_BLEED: 0.04,
  CLOT_RATE: 0.22,           // hp/s^2 the bleed decays (wounds clot over time)
  LEG_SLOW_MAX: 0.55,        // max move-speed loss from a fresh leg wound (both legs → crawl)
  ARM_SPREAD_MAX: 9.0,       // max extra aim spread (deg) from an arm wound (both arms → can't aim)
  WOUND_SEVERITY: 0.6,       // severity added per limb hit (0..1, capped at 1)
  WOUND_DECAY: 0.0,          // a leg hit is a leg hit — wounds DON'T heal in the field
  // NO health regeneration: HP only ever goes DOWN. Damage and bleeding lower it;
  // wounds clot (bleeding stops) but lost HP never returns. Hurt stays hurt.

  // ---- Fire control ----
  BURST_COUNT: 3,            // rounds per burst in BURST mode

  // ---- Stances (0 = stand, 1 = crouch, 2 = prone) ----
  STANCE_RATE: 2.0,                  // stance levels changed per second (going prone ~1s)
  STANCE_HEIGHT: [1.9, 1.15, 0.45],  // body height (z-gate for being hit; lower = harder)
  STANCE_SPEED: [1.0, 0.28, 0.12],   // crouch-walk ~1.4 m/s, prone crawl ~0.6 m/s (realistic)
  STANCE_ACC: [1.0, 0.45, 0.22],     // spread multiplier — crouch much steadier, prone steadiest
  STANCE_TURN: [22, 9, 4],           // aim turn rate (rad/s) — can't whip around prone/crouched
  BIPOD_ACC: 0.3,                    // extra spread multiplier when bipod deployed
  BIPOD_SWAY: 0.25,                  // sway multiplier with bipod down
  SUPPRESS_SWAP_TIME: 2.5,           // seconds to screw a suppressor on/off (can't fire meanwhile)

  // ---- Suppressor / hearing ----
  SUPPRESS_VOL: 0.35,        // shot loudness when suppressed (vs 1.0)
  DEAFEN_TIME: 0.7,          // s your hearing is dulled after an unsuppressed shot
  FOOTSTEP_RANGE: 24,        // m within which you can hear footsteps

  // ---- Bots ----
  BOT_COUNT: 60,             // a large enemy force, organized into fire teams
  SQUAD_SIZE: 5,             // bots per squad (1 leader + followers)
  BOT_REACTION: 0.28,        // seconds before a bot reacts to seeing you
  BOT_AIM_ERROR: 3.0,        // degrees of aim jitter at first sighting (converges tighter as it holds you)
  ENEMY_EDGE: 1.2,           // enemy fields ~2.2× the player's per-side count (Regiment: 110 v 50). A skilled human who also chain-takes-over allies (never really dies) is worth a lot, so the line outnumbers you to stay a fight (raise = harder)

  // ---- Vision / fog of war ----
  // You (and the bots) only see a cone in your facing direction, clipped by
  // walls and range. Behind you is dark — so flanking actually works.
  FOV_DEG: 130,              // clear field-of-view cone (degrees)
  SIGHT_RANGE: 600,          // daylight: you see far — fog hides flanks & behind cover, not distance
  FOG_DARK: 0.55,            // daytime haze over unseen areas (enemies are culled regardless)
  VISION_RAYS: 100,          // rays cast to carve the visible-area polygon
  NEARMISS_R: 2.2,           // m — an enemy round this close "cracks" past you
  THREAT_TTL: 2.4,           // s a directional incoming-fire marker lingers

  // ---- Ballistic arc (a top-down 2.5D: rounds have a height & drop) ----
  GRAVITY: 9.81,             // m/s^2
  EYE_HEIGHT: 1.5,           // muzzle/sight height a round launches from (m)
  TARGET_HEIGHT: 1.15,       // height the zero crosses (center mass)
  STAND_HEIGHT: 1.9,         // top of a standing body — rounds above this fly overhead
  POINT_BLANK: 9,            // within this range you hit where you point (height gate waived)
  SCOPE_REF_DIST: 50,        // scope shows true mag at this range; farther = smaller (angular size)
  RICOCHET_ANGLE: 65,        // incidence (deg from normal) past which hard surfaces deflect
  SCOPE_FOV_DEG: 26,         // total eye FOV through a 1× optic; divided by magnification

  // ---- Rendering ----
  TRACER_MIN_PX: 1.5,        // bullets are sub-pixel at true caliber; floor it
  GRID_METERS: 5,            // ground grid spacing for a sense of scale & motion
  DAYLIGHT: true,            // daytime map → tracers wash out (set false for a night map)
  CORPSE_TTL: 60,            // seconds a body lingers on the ground
};

// Drivable vehicles. Real-ish: heavy, momentum-driven, armored. Small arms
// barely scratch a tank; cannons & airstrikes are what kill armor.
// enterTime: seconds to climb in (you're exposed meanwhile). fuel/fuelUse:
// finite fuel that drains while driving. rounds: finite cannon ammo. Armed
// vehicles need a crew — solo you man one station at a time (drive OR gun).
export const VEHICLES = {
  car: {
    name: 'Utility Truck', maxSpeed: 26, accel: 14, reverse: 9, turn: 2.0,
    hp: 620, armorPistol: 0.5, armorRifle: 0.25, w: 4.6, h: 2.0, weapon: null, color: '#5a6a4a',
    enterTime: 1.0, fuel: 300, fuelUse: 0.18,
  },
  technical: {
    name: 'Technical (MG)', maxSpeed: 22, accel: 12, reverse: 8, turn: 1.8,
    hp: 720, armorPistol: 0.5, armorRifle: 0.3, w: 4.9, h: 2.1, weapon: 'mg', color: '#6a5a3a',
    enterTime: 1.4, fuel: 300, fuelUse: 0.18, turretTurn: 2.2,
  },
  tank: {
    name: 'Main Battle Tank', maxSpeed: 11, accel: 6, reverse: 4, turn: 0.9,
    // Fully small-arms PROOF (armor 1.0 → bullets do zero), but a couple of RPG/AT4
    // hits, a cannon shell, an airstrike, a drone bomb, or a ramming vehicle kills it.
    hp: 820, armorPistol: 1, armorRifle: 1, w: 7.0, h: 3.4, weapon: 'cannon', coax: true, color: '#46503a',
    enterTime: 2.8, fuel: 500, fuelUse: 0.14, rounds: 45, turretTurn: 0.5, // big ready rack, slow traverse
  },
};
// Vehicle-mounted weapons.
export const VEHICLE_WEAPONS = {
  mg: { name: 'Mounted MG', caliber: 12.7, velocity: 900, rpm: 600, damage: 30, spread: 1.4, range: 220, rangeMax: 600, tracer: '#ff7a3a', bloomPer: 0.6, bloomRecover: 9, bloomMax: 6, pellets: 1, barrel: 1.0, mag: 100, reserve: 900, reload: 6, fireMode: 'auto', class: 'LMG', optic: { name: 'iron', mag: 1 } },
  cannon: { name: 'Cannon', velocity: 320, reload: 3.6, damage: 250, explosion: 6.5, caliber: 120, barrel: 4 },
  // Coaxial 7.62 — a tank's answer to infantry, raking between main-gun rounds.
  coax: { name: 'Coax MG', caliber: 7.62, velocity: 840, rpm: 700, damage: 26, spread: 1.1, range: 180, rangeMax: 500, tracer: '#ffce6a', bloomPer: 0, bloomRecover: 9, bloomMax: 0, pellets: 1, barrel: 0.6, class: 'LMG', optic: { name: 'iron', mag: 1 } },
};

// Pilotable drones. You fly them from your body (which stays on the ground,
// exposed). The drone's camera reveals the area around it. Battery-limited.
export const DRONES = {
  // Batteries last a good while; fly back over your own body to REARM & RECHARGE.
  // A dropped bomb is heavy ordnance — a direct or close hit is a near-certain kill.
  bomber: { name: 'Bomber Quad', speed: 17, hp: 40, battery: 80, bombs: 8, bombDmg: 220, bombRadius: 6, cooldown: 14, sight: 42 },
  fpv: { name: 'FPV Kamikaze', speed: 33, hp: 22, battery: 26, explodeDmg: 170, explodeRadius: 6, cooldown: 10, sight: 36 },
  // Recon bird: fly it around for eyes-on — no weapons, flies high so it CAN'T be shot
  // down, wide camera. Long battery. Pure reconnaissance.
  recon: { name: 'Recon UAV', speed: 24, hp: 99999, battery: 120, bombs: 0, cooldown: 16, sight: 68 },
};

// Support abilities.
export const SUPPORT = {
  UAV_DURATION: 22, UAV_COOLDOWN: 20,
  STRIKE_DELAY: 3.5, STRIKE_COOLDOWN: 45, STRIKE_RADIUS: 9, STRIKE_DAMAGE: 150, STRIKE_SALVO: 5,
  PING_TTL: 6,
};

// Obstacle materials. cover = stops/blocks bullets & movement; conceal = blocks
// line of sight; height (m) lets rounds pass over low cover; hp = durability
// (degrades to rubble — "swiss cheese"); pen = how a round behaves on contact.
//   pen: 'stop'  hard, stops normal rounds (only .50-class punches through)
//        'soft'  penetrable, round passes losing 'loss' fraction of damage
export const MATERIALS = {
  concrete: { cover: true, conceal: true, height: 3.0, hp: 900, pen: 'stop', loss: 0.5, color: '#3c4636' },
  steel:    { cover: true, conceal: true, height: 2.6, hp: 1200, pen: 'stop', loss: 0.6, color: '#4a5340' },
  wood:     { cover: true, conceal: true, height: 1.1, hp: 90,  pen: 'soft', loss: 0.45, color: '#5b5236' },
  sandbag:  { cover: true, conceal: true, height: 1.1, hp: 450, pen: 'soft', loss: 0.75, color: '#6b6448' },
  brush:    { cover: false, conceal: true, height: 1.6, hp: 0,  pen: 'none', loss: 0,   color: '#2f4124' },
};

export const WORLD_BOX = { x: 0, y: 0, w: CONFIG.WORLD_W, h: CONFIG.WORLD_H };

// Body armor. Reduction is fractional and caliber-dependent: soft armor stops
// handgun rounds well but rifle rounds poorly; plates flip that. `points` is
// durability — absorbed damage drains it; once gone the plate is defeated.
export const ARMOR = [
  { id: 'none',   name: 'No Armor',        weight: 0,   vsPistol: 0,    vsRifle: 0,    points: 0 },
  { id: 'soft',   name: 'IIIA Soft Vest',  weight: 3.5, vsPistol: 0.85, vsRifle: 0.15, points: 120 },
  { id: 'plate3', name: 'Level III Plate', weight: 6.0, vsPistol: 0.90, vsRifle: 0.60, points: 160 },
  { id: 'plate4', name: 'Level IV Plate',  weight: 9.8, vsPistol: 0.95, vsRifle: 0.85, points: 220 },
];
export const ARMOR_BY_ID = Object.fromEntries(ARMOR.map((a) => [a.id, a]));

// Camouflage: `spot` is how easily others detect you (lower = harder to see,
// especially when still). Ghillie is best but heavy. You pick it at deploy.
export const CAMO = [
  { id: 'none', name: 'No Camo', spot: 1.0, weight: 0 },
  { id: 'woodland', name: 'Woodland', spot: 0.6, weight: 0.6 },
  { id: 'ghillie', name: 'Ghillie Suit', spot: 0.32, weight: 2.8 },
];
export const CAMO_BY_ID = Object.fromEntries(CAMO.map((c) => [c.id, c]));
