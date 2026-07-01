import { rand, TAU } from './math.js';

// Lightweight particle FX: muzzle flashes, impact sparks, blood, screen shake.
// Everything here is cosmetic and lives in world meters.

export class Effects {
  constructor() {
    this.parts = [];
    this.flashes = [];
    this.shake = 0;
  }

  addShake(a) { this.shake = Math.max(this.shake, a); }

  muzzle(x, y, angle, w, scale = 1) {
    this.flashes.push({ x, y, angle, life: 0.05, max: 0.05, size: (0.25 + w.caliber / 40) * scale });
    const n = Math.max(1, Math.floor((2 + w.caliber / 4) * scale));
    for (let i = 0; i < n; i++) {
      const a = angle + rand(-0.3, 0.3);
      const sp = rand(6, 16);
      this.parts.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: rand(0.05, 0.14), max: 0.14, size: rand(0.03, 0.07),
        color: '#ffd27a', drag: 6,
      });
    }
  }

  impact(x, y, angle, color) {
    // Sparks/debris spitting back off the surface.
    for (let i = 0; i < 7; i++) {
      const a = angle + Math.PI + rand(-1, 1);
      const sp = rand(3, 12);
      this.parts.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: rand(0.1, 0.3), max: 0.3, size: rand(0.02, 0.06),
        color: color || '#d8d2c0', drag: 7,
      });
    }
    // A dust puff — slow, spreading, fading. This is what you actually read at
    // distance, since the round itself is invisible in flight.
    for (let i = 0; i < 5; i++) {
      const a = rand(0, TAU);
      const sp = rand(0.4, 2.2);
      this.parts.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: rand(0.3, 0.65), max: 0.65, size: rand(0.08, 0.18),
        color: '#9c8f78', drag: 3,
      });
    }
  }

  blood(x, y, angle) {
    // Subtle — a small dark spray, not a bright splat. Hard to read at range.
    for (let i = 0; i < 4; i++) {
      const a = angle + rand(-0.5, 0.5);
      const sp = rand(1, 5);
      this.parts.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: rand(0.12, 0.3), max: 0.3, size: rand(0.03, 0.06),
        color: '#6e1818', drag: 6,
      });
    }
  }

  explosion(x, y, radius) {
    this.flashes.push({ x, y, angle: 0, life: 0.13, max: 0.13, size: radius * 0.6 });
    const n = 18 + Math.floor(radius * 2);
    for (let i = 0; i < n; i++) {
      const a = rand(0, TAU), sp = rand(2, radius * 3);
      this.parts.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: rand(0.3, 0.8), max: 0.8, size: rand(0.15, 0.5),
        color: i % 3 ? '#caa45a' : '#7a7066', drag: 3,
      });
    }
    for (let i = 0; i < 10; i++) { // dark smoke
      const a = rand(0, TAU), sp = rand(1, radius * 1.5);
      this.parts.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: rand(0.5, 1.1), max: 1.1, size: rand(0.3, 0.7),
        color: '#3a342c', drag: 2,
      });
    }
  }

  update(dt) {
    for (const p of this.parts) {
      p.life -= dt;
      const d = Math.max(0, 1 - p.drag * dt);
      p.vx *= d; p.vy *= d;
      p.x += p.vx * dt; p.y += p.vy * dt;
    }
    this.parts = this.parts.filter((p) => p.life > 0);

    for (const f of this.flashes) f.life -= dt;
    this.flashes = this.flashes.filter((f) => f.life > 0);

    this.shake = Math.max(0, this.shake - dt * 26);
  }

  draw(ctx) {
    for (const f of this.flashes) {
      const k = f.life / f.max;
      ctx.globalAlpha = k;
      ctx.fillStyle = '#fff2c0';
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.size * (0.6 + k), 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    for (const p of this.parts) {
      ctx.globalAlpha = Math.max(0, p.life / p.max);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}
