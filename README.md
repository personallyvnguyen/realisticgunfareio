# realisticgunfare.io

A top-down `.io` shooter where everything is sized and timed like the real
world. Real firearms, real magazines, real muzzle velocities, real human
proportions, real wounding. Single-player vs bots today; the code is structured
so the same physics can run authoritatively on the server for multiplayer.

**💬 Community:** [Join us on Discord](https://discord.gg/bf2ddyRBZa)

## Run it

No dependencies. You need Node ≥ 16.

```bash
npm start
# → open http://localhost:3000
```

(`npm start` runs `node server/server.js`, a tiny zero-dependency static server.
The whole game is in `/public`.)

## Deploy screen

Before each life you pick a **loadout**, because you can't carry an armory:

- **Primary** (rifle / SMG / LMG / shotgun / sniper)
- **Sidearm** (pistol)
- **Body armor** (or none)
- **Camo** (none / woodland / ghillie) — better camo makes you much harder to
  spot, especially when still or prone, but ghillie is heavy
- **Squad** (up to **16 AI allies**) — teammates who fight in a **wide, dispersed
  screen** (tens of metres of spacing, each with their own stand-off, never
  shoulder-to-shoulder) and **fight their own fight** on a long leash rather than
  glued to you. They **steer around walls and out through doorways** instead of
  grinding into a corner. `Y` cycles their order: **FOLLOW** (stay near you) ·
  **PUSH** (advance) · **SUPPRESS** (go prone and rake the lane you're pointing
  down) · **HOLD** (get down and hold position). **Command them on the map**:
  left-click the minimap to drop a **rally point** they move to and hold;
  right-click (or click on yourself) to recall them to you.

**Fair, even, team deathmatch — no respawns.** Pick a **battle size** at deploy
(Skirmish · Platoon · Company · Battalion · **Regiment**) and **both sides field
the identical force** — the same number of **5-man fire-teams, each led by its own
leader**. The AI-vs-AI is even, but **you're a human** — worth far more than one bot (better
aim, plus the take-over-a-mate chain), so the **enemy fields ~25% more units** to
keep it a real fight: **6 v 8** at Skirmish up to **51 v 63** at Regiment. You have
to *earn* the win, not coast it. Fight until **one side is wiped out** — then
**VICTORY / DEFEAT** and `Esc` redeploys. (Tune the handicap with `ENEMY_EDGE` in
`config.js` — raise it if you still win too easily, lower it if it's brutal.)

**Two-sided battlefield.** Each battalion **forms up along its own edge** of the
map — you and your squads on one side, the enemy massed on the opposite side, with
**vehicles staged and ready** on each line — then both advance to a **front line**.
So you don't spawn scattered into the middle of the enemy and die; you start with
your force, on your side, and fight toward them. (This is also what makes big
fights *fair* — both sides are concentrated, so it's a real clash, not your massed
squad rolling up scattered singles.)

- **When you're dropped, you take over a surviving squadmate** and fight on — it
  chains through your whole battalion; only a *total* wipe is a real defeat.
- **Friendly fire is on** — and it happens in the fog of war. A teammate only
  knows it was **you** if they actually **see you do it** (body in view *and* you in
  their FOV/LOS). Drop someone **cleanly, from range, or unseen** and nobody's the
  wiser — that includes a **drone strike or grenade** while you pilot/lob from the
  rear: they can't tell *yet*. But casualties from your own side pile up, and after
  you **kill a few** the survivors **piece it together and turn on you**. Get
  **caught in the act** and they turn instantly; the anger **spreads**, and a
  **known traitor's squad won't let them take over** on death.
- **Point your gun at a nearby ally and they react on instinct** — but only if
  there's **no enemy ahead** to justify the muzzle, and even then only *sometimes*.
  And **shoot a teammate and they feel it** — a wounded ally **spins around and
  engages you even from behind**. A clean, unseen one-shot is the only way to get
  away with it. **Teamkills are tracked separately** (they don't score).
- Hold **`Tab`** for the **scoreboard**: standing headcount, kills, and teamkills
  per side, plus your personal kills / times-downed / teamkills. A **kill feed**
  logs who dropped whom (⚠ marks a teamkill), and a center-screen banner calls
  your kills and your death.

Everything you select has real **weight** that slows you down, shown live as
*Carry weight*. You commit to a kit when you deploy — there's no swapping armor
or guns mid-fight. Press **Esc** in-game to return here and redeploy.

## Controls

| Action | Key |
| --- | --- |
| Move | `W` `A` `S` `D` |
| Sprint (drains stamina) | `Shift` |
| Walk (steadier aim) | `Ctrl` |
| Shoot | `Left Click` |
| Aim down sights / scope | `Right Click` |
| Reload (swaps magazine) | `R` |
| Fire selector (safe/semi/burst/auto) | `V` (or click it on the HUD) |
| Crouch / Prone | `C` / `Z` |
| Toggle suppressor | `T` |
| Loot gear / Throw grenade | `F` / `G` |
| Enter / exit vehicle | `E` |
| Squad order (follow/push/suppress/hold) | `Y` |
| Squad rally / recall | Left-click / right-click the **minimap** or **big map** |
| Open big tactical map | `M` (click it to rally your squad) |
| UAV recon / Airstrike / Ping | `U` / `H` / `X` |
| Bomber drone / FPV kamikaze | `B` / `N` (fly WASD, click to drop/detonate) |
| Switch primary / sidearm | `1` `2`, `Q`, or scroll |
| Zoom (scroll); ADS adds smooth scope zoom by the optic | `+` / `−` or `Ctrl`+scroll |
| Re-pick loadout | `Esc` |

**The HUD is clickable** — so you don't have to memorize everything. The
bottom-left **ability panel** shows every support option with its key, a one-line
how-to and a **READY / cooldown** state, and each chip is a **button**; you can
also click the **weapon cards** to switch, the **ammo panel** to reload, the
**fire-selector** chip to change mode, the **squad readout** to change order, and
the **minimap** to rally your squad. Press `/` (or the **?** button, bottom-left)
for the full **Field Manual**.

While driving: `W`/`S` throttle, `A`/`D` steer, mouse aims the turret, click to fire.
A tank needs a driver **and** a gunner, so when you drive an armed vehicle a nearby
**ally climbs on the gun** and engages while you maneuver (you're locked to the
wheel until they dismount). Enemy fire-teams do the same — some make for an **idle
rig and crew it** against you, so an unmanned tank is a threat waiting to happen.

## The realism model

The golden rule: **the simulation thinks in meters and seconds.** Pixels exist
only at render time, via `PPM` (pixels-per-meter) and camera zoom. All tuning
lives in [`public/js/config.js`](public/js/config.js).

**Scale & movement**
- A human is a **0.5 m** footprint. Gaits are real: walk 1.4, jog 4.5, sprint 7 m/s.
- Sprinting burns **stamina**; run dry and you drop to a jog until it recovers.
- Carried **weight** (every gun in your loadout + armor) reduces top speed.

**Ballistics** ([`weapons.js`](public/js/weapons.js))
- Bullets fly at true **muzzle velocity** (AK-47 715 m/s, M4 880, AR-15 975).
  That's fast enough to cross meters per frame, so collision is a **raycast**
  from each round's old to new position — it can't tunnel through a target.
- Real magazines, reload times, fire modes and calibers.
- **Aim at someone inside your weapon's effective range and you hit them** — no
  "the round sailed 20 cm over your head" whiffs. Height only starts to matter
  *past* effective range, where real **drop** makes a round land short or overhead.
- Damage falls off past each weapon's effective range.
- **You don't see rounds in flight** — only muzzle flashes, impact dust, and the
  occasional tracer (~every 5th automatic round) or a big .50-class slug.

**Wounding** ([`game.js → applyDamage`](public/js/game.js)) — where a round lands
on the body decides the wound:
- 🔴 **Torso (most body hits)** → full damage + **bleeding**; this is what armor covers.
- 🟡 **Head / CNS** → instant kill, any caliber — but it's a **lucky central
  strike, not automatic**. A centre-of-mass hit is *usually* torso, so even
  point-blank you don't headshot everyone; it's a chance that rises the more
  centered you are.
- ⚪ **Limbs (a graze off the edge)** → ~40% damage, and hit a **specific limb**,
  which has a real effect: **legs slow your movement** (one leg = a limp, **both
  legs = a crawl**) and **arms wreck your aim** (one arm = the reticle/scope gets
  shaky, **both arms and you basically can't aim** — big spread, wobbling optic).
  A **body diagram** by your vitals shows exactly which limbs are hit, and the
  status line spells out the effect (`LEG HIT — slowed`, `ARM HIT — shaky aim`).

**There is no health regeneration.** HP only ever goes *down* — damage and
bleeding lower it, wounds **clot** (the bleeding stops) but the HP you lost never
comes back, and limb wounds never heal. Once you're hurt you stay hurt for the
match; once crippled, crippled. Your only "reset" is going down and **taking over a
fresh squadmate**, or redeploying. (Stamina *does* recover — that's breathing, not
blood.)

Explosions are lethal up close — a **drone bomb** is a near-certain kill on a
direct or close hit. So pistols usually take several torso hits (like real life);
rifles drop faster;
the Barrett and point-blank shotgun are one-shot. There are **no floating health
bars or names** over enemies — you read them by behavior and blood.

**Magazines** — modeled as discrete mags, not a loose round pool. Reloading
**swaps** the magazine: a half-empty mag is stowed (not merged into a full one),
empty mags are dropped. Reload at 5/30 and that 5-round mag comes back around
later.

**Body armor** ([`config.js → ARMOR`](public/js/config.js)) — real levels:
- *IIIA Soft* — stops handgun rounds well, rifle rounds poorly. Light.
- *Level III / IV plates* — stop rifle rounds; heavier.
- Protects the torso only, has durability that drains as it absorbs hits.

**Optics & aiming** — each gun wears its real sight: irons, Aimpoint/Kobra red
dots (1×), **ACOG 4×**, **LPVO 1-6×**, **Leupold 10×** on the Barrett. Your
**crosshair is your cone of fire** — it opens up with range, sway, movement and
fatigue (a faint ring shows where rounds could land at that distance) and tightens
to a fine point up close. **Point-blank, you hit exactly where you point** (the
barrel's right there); at range the group matters. Hip fire (default) is **very
inaccurate**. Right-click to aim down sights: the gun comes
up to your eye and the view focuses in (even a 1× sight), magnified optics
**look downrange** (reach scales with the optic — a 10× reaches ~10× further),
spread tightens dramatically, you slow down, and **breathing sway** sets in —
worse while moving, winded, or on high magnification. The scope magnifies at the
optic's true power (so distant targets are still big enough to engage), and layers
**angular size** on top: each body is sized by **how far it is from you**, so a
target at your point of aim is "true" size and **anything farther renders smaller**
— near fills the glass, far shrinks, just like a real optic.

**Cover, concealment & ballistics** — terrain has real material behavior:
- **Cover** (concrete, steel, sandbags, wood) stops bullets; **concealment**
  (brush) blocks line of sight but *not* rounds. They're different things.
- Cover has **height**: low crates and sandbags can be **shot over** (and you
  can hide a prone body behind them).
- Cover is **destructible** — keep shooting wood/sandbags and they degrade to
  rubble ("swiss cheese") and become passable; .50-class rounds punch through.
- **Penetration** (rounds pass through soft cover losing punch) and **ricochet**
  (hard surfaces deflect grazing rounds) both happen.
- **Ballistic arc:** rounds fly at a height, are **zeroed to where you aim**,
  and **drop** with gravity — at long range an off-zero shot lands short (dust
  on the ground) or sails overhead. A 4×+ scope shows a range readout.

**Stances & weapon handling**
- **Stand / crouch / prone** (`C`/`Z`) — going down takes time, but lowers your
  profile (rounds pass overhead, low cover protects you), slows you, and makes
  you much steadier. Prone with an LMG/rifle/sniper auto-deploys a **bipod** for
  rock-steady fire.
- **Fire selector** (`V`): safe / semi / burst / auto per each gun's real spec.
- **Suppressor** (`T`): quieter, less flash — and firing **unsuppressed
  deafens you** briefly so you can't hear footsteps.

**Loot & gear** — **there are no loose items on the ground to give a death away.**
Every body (enemy *or* your own fallen squadmate) still carries its kit — walk
**onto** the body and press `F` to take it. If the body's gun is one **you already
carry**, `F` just **scavenges its magazines** into your reserve (no point swapping
to a duplicate) — the realistic way to resupply off a fallen mate with the same
rifle. Otherwise `F` takes the weapon (your old one stays on the body), then the
armor. The only cue is a small prompt when you're right on top of a body — you have
to check bodies up close, you can't spot loot from range. Mags show as fill-bars.

**Vehicles** — drivable rigs **staged on both sides' lines** (`E` to enter), more
of them at bigger battles: utility trucks, MG technicals, and main battle tanks.
A **tank is fully small-arms proof** — rifle and MG rounds do *nothing* to it — so
it takes an **RPG/AT4, a cannon shell, a drone bomb, an airstrike, or a ramming
vehicle** to kill (a couple of rocket hits does it). The AI crews vehicles too:
enemy (and your) fire-team leaders **mount up with a gunner**, and both sides field
**anti-armor gunners** carrying a **rifle *and* a launcher** who switch to the tube
for a vehicle. Tanks carry a big ready rack (45 rounds) and won't run dry on fuel.
It's **combined arms**: a lone tank that outruns its screen gets RPG'd solo (a
handful of hits kills it), so AI vehicles **advance *with* their infantry** — keep
your own armor escorted too. A vehicle only crushes the **enemy** under its tracks,
never its own. They're heavy and momentum-driven; the turret aims independently of
the heading. Small arms barely scratch a tank's armor — it takes an RPG, a cannon,
another vehicle, or an airstrike.
The tank cannon fires explosive shells; light vehicles fall to sustained fire.

**Heavy weapons** — pick the **RPG-7** or **FIM-92 Stinger** as your primary at
deploy, or throw a **frag grenade** (`G`, arcs to your cursor) — everyone carries
a few. The RPG fires an explosive rocket; the **Stinger is a guided missile** that
locks onto **enemy attack drones** that periodically fly in to bomb you (you can
also shoot them down with gunfire). Watch for the **INCOMING AIR** warning.

Enemy **attack drones** fly in at **altitude** and **hover right over you** (like a
real grenade-dropping quad), weaving and **dropping bombs on a cadence** until they
run out of payload, get shot down, or you die. Each bomb **partially leads you**,
and its impact point is **telegraphed on the ground** — a red danger ring with an
inner circle that closes in as the bomb falls — so you can **see where it'll land
and dodge** (juke out of the ring, break line, or kill the drone). The higher the drone, the **longer the bomb falls** and the **smaller
and harder to hit** it is (Stinger lock-on or gunfire — watch the **INCOMING AIR**
warning). A direct or close bomb is a **one-shot kill**.

**Drones** — `B` launches a **bomber quadcopter** you fly (WASD) to drop grenades
(click) on what's below; `N` launches an **FPV kamikaze** you fly straight into a
target to detonate. You pilot from your body, which stays on the ground **exposed**
while you fly. The battery lasts a good while, and you're never grounded by a short
timer: **fly the drone back over your own body to rearm bombs and recharge** its
battery, then head back out. While flying, a **top-center panel spells out the
controls** and shows live **battery / bombs / rearm status**; the drone's camera
reveals the area around it (no fog while flying).

**Support** — `U` calls a **UAV** that **reveals the whole enemy force through the
fog** for ~22 s (their bodies *and* red diamonds/minimap dots — **zoom out to watch
them move and maneuver**); short cooldown, so it's your reliable recon.
`H` calls an **airstrike** on where you're aiming (a few seconds out, then a salvo
of explosions); `X` drops a **radio ping** marker.

A permanent **ability panel** (bottom-left) always shows each support option, its
key, a one-line how-to, and whether it's **READY** or counting down — so you're
never guessing what's off cooldown.

**No hit confirmation** — you don't get a hitmarker or a kill chime. A body on the
ground might be dead — or **playing dead**: a badly wounded enemy can **drop and
feign death**, going still and prone so you (and the AI) read them as a corpse and
walk past — then **spring an ambush** when you stray too close. Your only tell is
that a *real* corpse slowly **pools blood** beneath it and a faker doesn't, and
even that only reads up close where you can see it. You never get told that the
specific enemy *you* shot is down. The match **kill feed** and **team score** are a
battlefield log, not a live confirmation your last shot connected. The HUD also
shows a **live headcount** — your team standing vs theirs.

**Vision & awareness** — this is a tactical sim, not a god's-eye arena:
- You only see a **field-of-view cone** in the direction you're facing, clipped
  by walls and range. Behind you is dark. **Turn to check your flanks.**
- **Bots have FOV too**, so you can flank them — and they turn to face incoming
  fire. There's **no enemy radar** — but your **squad shares contacts**: an enemy
  you *or an ally* actually sees gets **called out on the minimap** as a red blip
  that fades after a few seconds (a UAV paints *all* of them for its duration).
- **Zoom out** to read the battlefield — when your body gets small a cyan **ring +
  facing chevron** marks you so you never lose yourself.
- **`O` — free-look / god mode:** detach the camera and **fly around the whole map**
  (WASD to pan, scroll to zoom) to watch the battle; the fog lifts and you take no
  damage while spectating. `O` again to drop back into your body.
- **The AI shoots like you do** — it shoulders the weapon and fires *aimed* (not
  from the hip), runs auto/burst to lay down fire, **leads** moving targets, and
  its aim **converges** the longer it holds you (snap acquisition → deadly once
  settled). Break contact, use cover, and keep moving.
- **Designated marksmen / scouts** on both sides carry **scoped DMRs (AR-15 6×)**
  and the odd **Barrett (14×)** — they hold from prone and **reach out to snipe
  you and your squad at long range**, so watch the treelines, not just your front.
- **They react to what's happening**, not march mindlessly: a **blast nearby makes
  them break off, sprint clear and disperse** (you can't just bomb a column that
  ignores it), they **dive out of the way of a charging vehicle**, and when a
  squadmate gets hit **the whole fire-team turns to face the threat** — so shooting
  a squad from behind makes them **look back**, not shrug it off.
- **They react to incoming fire** — a round **cracking past** makes a bot turn and
  look back down its path, so raking a squad **from behind or at range** gets them
  to wheel around and find you, not march on oblivious.
- **They engage whatever is killing them** — not just other riflemen, and it takes
  **priority**: a **drone right overhead** (obviously bombing them) or a rig bearing
  down gets shot at *over* a rifleman further off. Your drone can't loiter with
  impunity when it's plainly the threat.
- **The AI crews vehicles too** — most enemy fire-team leaders **mount up** in the
  staged rigs (with a gunner), so armor is a two-way threat, not your private
  advantage.
- **Enemies shoot down your drones** — your piloted bomber/FPV can be knocked out
  of the air by ground fire, and enemy attack drones hunt you from above. Air is
  contested for both sides.
- You can't see rounds in flight, but a hit or a near miss shows a **directional
  marker** pointing where it came from, with a panned supersonic *crack*.
- Bodies stay on the ground where they fell.

### Honest approximations

- True calibers (9 mm) are sub-pixel, so tracers get a minimum render width
  while keeping real size for collision.
- A real eye sees kilometers; the view defaults to ~50 m across (scroll to zoom).
- Damage is tuned to a 100 HP body, not literal terminal ballistics.
- **Height is collapsed.** Top-down is a plan view, so there's no literal
  "aim up/down." Where you hit on a body is modeled by the concentric zones
  (aim at center for a head/CNS hit). Shooting over/under cover would need a
  discrete stance + cover-height layer — see the roadmap.

## Project layout

```
server/server.js     static server (+ home for the future multiplayer loop)
public/index.html    canvas, HUD, deploy/loadout screen
public/js/
  config.js          all tuning constants + armor table
  weapons.js         real firearm + optic data
  math.js            vectors, raycasts, collision
  world.js           arena generation, line-of-sight, collision queries
  entities.js        Combatant (player + bots), Bot AI, Bullet, magazines
  effects.js         muzzle flashes, impact dust, blood, screen shake
  audio.js           procedural sound (no asset files)
  game.js            update loop, camera, ADS/scopes, rendering, HUD, scoring
  input.js           keyboard / mouse
  main.js            bootstrap, loadout selector, RAF loop
```

## Roadmap

Built so far: real ballistics with **drop & zeroing**, **wounding/bleeding** with
locational damage, **weight & stamina**, **body armor** (with behind-armor blunt
trauma), **discrete magazines**, real **optics** with downrange ADS & sway, a
**fire selector**, **stances + bipods**, **suppressors & footstep hearing**,
**destructible cover / concealment / penetration / ricochet**, **loot & gear**,
**fog-of-war FOV** with directional fire awareness, procedural audio, and
loadout selection.

Also built: **vehicles** (truck/technical/tank, drive + turret + cannon + run-over),
**support** (UAV recon, airstrikes, radio pings), **camouflage**, and an
**explosion/destruction** system.

Still on deck:

- **Multiplayer:** authoritative server tick + client prediction (physics is
  already in real units and isolated for server reuse).
- Ongoing tuning from playtest feedback.
