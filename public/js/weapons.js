// Real firearms, real numbers. Stats sourced from manufacturer/mil specs.
//
//   caliber      bullet diameter in mm (→ true projectile radius)
//   velocity     muzzle velocity in m/s
//   mag/reserve  rounds in magazine / rounds carried spare
//   reload       seconds for a full reload
//   rpm          cyclic rate for auto; practical max cadence for semi/bolt/pump
//   fireMode     'auto' | 'semi' | 'pump' | 'bolt'
//   damage       per projectile, against 100 HP (tuned, not literal ft-lbs)
//   range        meters of full damage; falls off to ~35% by rangeMax
//   spread       base accuracy cone half-angle, degrees
//   bloomPer     spread added per shot (recoil); recovers at bloomRecover deg/s
//   pellets      projectiles per trigger pull (shotguns)
//   barrel       barrel length (m) — sets where the muzzle sits
//   weight       kg, loaded (drives encumbrance / stamina)
//   optic        the sight mounted on it: { name, mag } — mag is true zoom

export const WEAPONS = [
  {
    id: 'glock17', name: 'Glock 17', class: 'Pistol',
    caliber: 9.0, velocity: 375, mag: 17, reserve: 119, reload: 2.1,
    rpm: 320, fireMode: 'semi', damage: 22, range: 50, rangeMax: 120,
    spread: 1.0, bloomPer: 1.4, bloomRecover: 9, bloomMax: 6,
    pellets: 1, barrel: 0.114, weight: 0.9, tracer: '#ffd27a',
    optic: { name: 'Iron sights', mag: 1 },
  },
  {
    id: 'deagle', name: 'Desert Eagle', class: 'Pistol',
    caliber: 12.7, velocity: 470, mag: 7, reserve: 56, reload: 2.6,
    rpm: 180, fireMode: 'semi', damage: 55, range: 55, rangeMax: 130,
    spread: 1.3, bloomPer: 3.5, bloomRecover: 7, bloomMax: 9,
    pellets: 1, barrel: 0.152, weight: 2.0, tracer: '#ffb24a',
    optic: { name: 'Iron sights', mag: 1 },
  },
  {
    id: 'mp5', name: 'H&K MP5', class: 'SMG',
    caliber: 9.0, velocity: 400, mag: 30, reserve: 300, reload: 2.6,
    rpm: 800, fireMode: 'auto', damage: 20, range: 60, rangeMax: 140,
    spread: 1.1, bloomPer: 0.9, bloomRecover: 11, bloomMax: 7,
    pellets: 1, barrel: 0.225, weight: 3.0, tracer: '#ffd27a',
    optic: { name: 'Aimpoint red dot', mag: 1 },
  },
  {
    id: 'ak47', name: 'AK-47', class: 'Rifle',
    caliber: 7.62, velocity: 715, mag: 30, reserve: 330, reload: 2.5,
    rpm: 600, fireMode: 'auto', damage: 38, range: 120, rangeMax: 300,
    spread: 1.4, bloomPer: 1.5, bloomRecover: 8, bloomMax: 10,
    pellets: 1, barrel: 0.415, weight: 4.3, tracer: '#ff9a3a',
    optic: { name: 'Kobra red dot', mag: 1 },
  },
  {
    id: 'm4a1', name: 'M4A1', class: 'Rifle',
    caliber: 5.56, velocity: 880, mag: 30, reserve: 330, reload: 2.3,
    rpm: 750, fireMode: 'auto', damage: 30, range: 150, rangeMax: 400,
    spread: 0.85, bloomPer: 1.1, bloomRecover: 10, bloomMax: 8,
    pellets: 1, barrel: 0.368, weight: 3.4, tracer: '#aef0c0',
    optic: { name: 'ACOG 4×', mag: 4 },
  },
  {
    id: 'ar15', name: 'AR-15', class: 'Rifle',
    caliber: 5.56, velocity: 975, mag: 30, reserve: 330, reload: 2.3,
    rpm: 400, fireMode: 'semi', damage: 33, range: 180, rangeMax: 450,
    spread: 0.55, bloomPer: 1.0, bloomRecover: 12, bloomMax: 6,
    pellets: 1, barrel: 0.508, weight: 3.1, tracer: '#aef0c0',
    optic: { name: 'LPVO 1–6×', mag: 6, variable: true, magMin: 1 },
  },
  {
    id: 'm249', name: 'M249 SAW', class: 'LMG',
    caliber: 5.56, velocity: 915, mag: 100, reserve: 600, reload: 6.5,
    rpm: 800, fireMode: 'auto', damage: 28, range: 160, rangeMax: 500,
    spread: 1.8, bloomPer: 1.3, bloomRecover: 7, bloomMax: 14,
    pellets: 1, barrel: 0.521, weight: 10.0, tracer: '#ff7a3a',
    optic: { name: 'Iron sights', mag: 1 },
  },
  {
    id: 'm870', name: 'Remington 870', class: 'Shotgun',
    caliber: 8.4, velocity: 400, mag: 7, reserve: 63, reload: 4.0,
    rpm: 70, fireMode: 'pump', damage: 12, range: 18, rangeMax: 45,
    spread: 4.5, bloomPer: 0, bloomRecover: 10, bloomMax: 0,
    pellets: 9, barrel: 0.470, weight: 3.6, tracer: '#ffe08a',
    optic: { name: 'Bead sight', mag: 1 },
  },
  {
    id: 'm82', name: 'Barrett M82', class: 'Sniper',
    caliber: 12.7, velocity: 853, mag: 10, reserve: 60, reload: 3.6,
    rpm: 55, fireMode: 'semi', damage: 95, range: 350, rangeMax: 900,
    spread: 0.08, bloomPer: 6, bloomRecover: 5, bloomMax: 6,
    pellets: 1, barrel: 0.737, weight: 14.0, tracer: '#ff5d5d',
    optic: { name: 'Leupold 3–14×', mag: 14, variable: true, magMin: 3 },
  },
];

// Launchers — fire a guided/explosive projectile instead of bullets.
WEAPONS.push(
  {
    id: 'rpg7', name: 'RPG-7', class: 'Launcher',
    caliber: 85, velocity: 115, mag: 1, reserve: 3, reload: 4.5,
    rpm: 30, fireMode: 'semi', damage: 320, range: 200, rangeMax: 500,
    spread: 1.4, bloomPer: 0, bloomRecover: 5, bloomMax: 0,
    pellets: 1, barrel: 0.95, weight: 7.0, tracer: '#ffcf8a',
    optic: { name: 'Iron sights', mag: 1 }, projectile: 'rocket', explosion: 6.0,
  },
  {
    id: 'at4', name: 'AT4', class: 'Launcher',
    caliber: 84, velocity: 290, mag: 1, reserve: 2, reload: 5.0,
    rpm: 25, fireMode: 'semi', damage: 360, range: 250, rangeMax: 550,
    spread: 1.0, bloomPer: 0, bloomRecover: 5, bloomMax: 0,
    pellets: 1, barrel: 1.0, weight: 6.7, tracer: '#ffcf8a',
    optic: { name: 'Iron sights', mag: 1 }, projectile: 'rocket', explosion: 5.5,
  },
  {
    id: 'javelin', name: 'FGM-148 Javelin', class: 'Launcher',
    caliber: 127, velocity: 160, mag: 1, reserve: 2, reload: 7.0,
    rpm: 12, fireMode: 'semi', damage: 440, range: 400, rangeMax: 2000,
    spread: 0.25, bloomPer: 0, bloomRecover: 5, bloomMax: 0,
    pellets: 1, barrel: 1.1, weight: 11.2, tracer: '#ffffff',
    optic: { name: 'CLU 4×', mag: 4 }, projectile: 'rocket', explosion: 5.5, // top-attack AT
  },
  {
    id: 'stinger', name: 'FIM-92 Stinger', class: 'Launcher',
    caliber: 70, velocity: 220, mag: 1, reserve: 2, reload: 6.0,
    rpm: 20, fireMode: 'semi', damage: 90, range: 600, rangeMax: 1000,
    spread: 0.4, bloomPer: 0, bloomRecover: 5, bloomMax: 0,
    pellets: 1, barrel: 1.5, weight: 15.2, tracer: '#ffffff',
    optic: { name: 'Iron sights', mag: 1 }, projectile: 'missile', explosion: 4.0,
  },
);

export const WEAPON_BY_ID = Object.fromEntries(WEAPONS.map((w) => [w.id, w]));
export const DEFAULT_LOADOUT = WEAPONS.map((w) => w.id);

// Real selectable fire modes per gun. SAFE is prepended universally at the
// selector. Guns not listed only offer their single inherent mode.
const FIRE_MODES = {
  mp5: ['semi', 'burst', 'auto'],
  ak47: ['semi', 'auto'],
  m4a1: ['semi', 'auto'],
};
for (const w of WEAPONS) w.fireModes = FIRE_MODES[w.id] || [w.fireMode];

// True projectile radius in meters from caliber (mm).
export const bulletRadius = (w) => w.caliber / 1000 / 2;

// Seconds between shots given the cyclic / practical rate.
export const shotInterval = (w) => 60 / w.rpm;

// Where the muzzle sits, in meters from the body center along the aim vector.
export const muzzleOffset = (w, playerRadius) => playerRadius + w.barrel * 0.55 + 0.15;

// Rifle-class rounds vs handgun-class — armor behaves very differently to each.
export const isRifleRound = (w) => w.class === 'Rifle' || w.class === 'LMG' || w.class === 'Sniper';

// Mass of a single loaded round (kg). Carried ammo adds real weight — the more
// magazines you haul, the slower you move (and you lighten as you fire).
export const roundWeight = (w) => {
  if (w.class === 'Sniper') return 0.115;     // .50 BMG is a brick
  if (w.caliber >= 12) return 0.020;          // .50 AE
  if (w.class === 'Shotgun') return 0.045;    // 12-gauge shells
  if (w.caliber >= 7) return 0.016;           // 7.62
  return 0.012;                               // 9mm / 5.56
};
