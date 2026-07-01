import { Input } from './input.js';
import { Game } from './game.js';
import { Sound } from './audio.js';
import { WEAPONS, WEAPON_BY_ID, roundWeight } from './weapons.js';
import { ARMOR, CAMO, CONFIG } from './config.js';

const canvas = document.getElementById('game');
const minimap = document.getElementById('minimap');

// Canvas buffer == CSS pixels, so input (CSS px), screenToWorld and the
// reticle all share one coordinate space. Simple and correct.
function resize() {
  canvas.width = innerWidth;
  canvas.height = innerHeight;
}
resize();
addEventListener('resize', resize);

const input = new Input(canvas);
const game = new Game(canvas, minimap, input);

// ---- Loadout selection (deploy screen) ----
const sel = { mode: 'sp', primary: 'm4a1', secondary: 'glock17', launcher: 'none', armor: 'plate3', camo: 'none', battle: 2 };
// Game mode. Single-player (vs AI) is the focus; online multiplayer is on the roadmap.
const modeOpts = [
  { id: 'sp', name: 'Single-player' },
  { id: 'mp', name: 'Multiplayer', disabled: true },
];
function modeLabel(o) {
  return o.disabled ? `${o.name}<small>in development</small>` : `${o.name}<small>vs AI battalions</small>`;
}
// Heavy weapon you can sling ALONGSIDE your rifle — real weight, so it slows you.
const launcherOpts = [
  { id: 'none', name: 'None' },
  { id: 'rpg7', name: 'RPG-7' },
  { id: 'at4', name: 'AT4' },
  { id: 'javelin', name: 'Javelin' },
  { id: 'stinger', name: 'Stinger' },
];
function launcherLabel(o) {
  if (o.id === 'none') return `None<small>rifle + sidearm only</small>`;
  const w = WEAPON_BY_ID[o.id];
  return `${w.name}<small>${w.weight}kg · anti-${o.id === 'stinger' ? 'air' : 'armor'}</small>`;
}
// Battle scale: BOTH sides field the same battalion — N fire-teams of 5, each led
// by its own leader — so every fight is a FAIR, even, large-scale engagement.
const SQ = 5;
const battleOpts = [
  { id: 1, name: 'Skirmish' },
  { id: 2, name: 'Platoon' },
  { id: 4, name: 'Company' },
  { id: 6, name: 'Battalion' },
  { id: 10, name: 'Regiment' },
  { id: 20, name: 'Brigade' },
  { id: 40, name: 'Division', heavy: true }, // ~640 troops — spectacle scale, may slow down
];
function battleLabel(o) {
  const perSide = o.id * SQ;
  const you = 1 + perSide;
  const foe = perSide + Math.max(3, Math.round(perSide * CONFIG.ENEMY_EDGE)); // enemy edge vs a human
  const note = o.heavy ? ' · heavy' : '';
  return `${o.name}<small>${o.id} squads · you ${you} v ${foe} enemy${note}</small>`;
}
const primaries = WEAPONS.filter((w) => w.class !== 'Pistol');
const secondaries = WEAPONS.filter((w) => w.class === 'Pistol');

function weaponLabel(w) {
  const opt = w.optic.mag > 1 ? `${w.optic.mag}×` : '1×';
  return `${w.name}<small>${w.mag}rd · ${w.weight}kg · ${opt}</small>`;
}
function weaponTitle(w) {
  return `${w.class} · ${w.caliber}mm · ${w.velocity} m/s · ${w.fireMode} · ${w.optic.name}`;
}
function armorLabel(a) {
  const prot = a.id === 'none' ? 'no protection'
    : a.vsRifle >= 0.6 ? 'stops rifle'
    : a.vsPistol >= 0.8 ? 'stops pistol' : 'minimal';
  return `${a.name}<small>${a.weight}kg · ${prot}</small>`;
}
function camoLabel(c) {
  const hide = c.spot >= 1 ? 'easy to spot' : c.spot >= 0.6 ? 'harder to spot' : 'very hard to spot';
  return `${c.name}<small>${c.weight}kg · ${hide}</small>`;
}

function buildGroup(containerId, items, key, label, title) {
  const c = document.getElementById(containerId);
  c.innerHTML = '';
  for (const it of items) {
    const b = document.createElement('button');
    b.className = 'ldopt' + (sel[key] === it.id ? ' selected' : '');
    b.dataset.id = it.id;
    b.innerHTML = label(it);
    if (title) b.title = title(it);
    if (it.disabled) {                       // e.g. Multiplayer — shown but not selectable yet
      b.classList.add('disabled');
      b.style.opacity = '0.45'; b.style.cursor = 'not-allowed';
      b.title = 'In development — single-player is the focus right now';
      c.appendChild(b);
      continue;
    }
    b.onclick = () => {
      sel[key] = it.id;
      for (const x of c.children) x.classList.toggle('selected', x === b); // compare elements, not string/number ids
      updateCarry();
    };
    c.appendChild(b);
  }
}

// A weapon's mass including all the ammo you haul for it — a full combat load of
// mags is real weight (a rifle's ~12 mags add ~4 kg), so it shows here.
function gunKg(id) {
  const w = WEAPON_BY_ID[id];
  return w.weight + (w.mag + w.reserve) * roundWeight(w);
}
function updateCarry() {
  const kg = gunKg(sel.primary) + gunKg(sel.secondary)
    + (sel.launcher !== 'none' ? gunKg(sel.launcher) : 0)
    + ARMOR.find((a) => a.id === sel.armor).weight + CAMO.find((c) => c.id === sel.camo).weight;
  document.getElementById('carry').textContent = `Carry weight: ${kg.toFixed(1)} kg`;
}

buildGroup('sel-mode', modeOpts, 'mode', modeLabel);
buildGroup('sel-primary', primaries, 'primary', weaponLabel, weaponTitle);
buildGroup('sel-secondary', secondaries, 'secondary', weaponLabel, weaponTitle);
buildGroup('sel-launcher', launcherOpts, 'launcher', launcherLabel);
buildGroup('sel-armor', ARMOR, 'armor', armorLabel);
buildGroup('sel-camo', CAMO, 'camo', camoLabel);
buildGroup('sel-squad', battleOpts, 'battle', battleLabel);
updateCarry();

// ---- Game loop ----
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (game.running) game.update(dt);
  game.render();
  input.endFrame();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---- Deploy / redeploy ----
const overlay = document.getElementById('overlay');
function deploy() {
  const loadout = sel.launcher !== 'none' ? [sel.primary, sel.secondary, sel.launcher] : [sel.primary, sel.secondary];
  game.deployPlayer(loadout, sel.armor, sel.camo, sel.battle);
  overlay.classList.add('hidden');
  game.running = true;
  last = performance.now();
  Sound.init(); // AudioContext must be created from a user gesture
}
document.getElementById('play').addEventListener('click', deploy);

// Esc reopens the loadout screen (pauses); changing kit means a fresh deploy —
// you can't swap armor or guns mid-fight.
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && game.running) {
    game.running = false;
    overlay.classList.remove('hidden');
  }
});

// In-game controls reference: the ? button or the / key.
const helpPanel = document.getElementById('help-panel');
const toggleHelp = () => helpPanel.classList.toggle('hidden');
document.getElementById('help-btn').addEventListener('click', toggleHelp);
addEventListener('keydown', (e) => {
  if (e.key === '/' || e.key === '?') { e.preventDefault(); toggleHelp(); }
});
