import { clamp } from './math.js';

// Procedural audio — no asset files. Every sound is synthesized from noise +
// oscillators via the Web Audio API, shaped per weapon class/caliber.
// Must be init()'d from a user gesture (the Deploy click) per browser policy.

class SoundEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noiseBuf = null;
  }

  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(this.ctx.destination);
    this.noiseBuf = this._noise(0.5);
  }

  _noise(seconds) {
    const n = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  // A gain stage feeding the master, optionally panned by screen position.
  _bus(vol, pan = 0) {
    const g = this.ctx.createGain();
    g.gain.value = vol;
    if (pan && this.ctx.createStereoPanner) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      g.connect(p); p.connect(this.master);
    } else {
      g.connect(this.master);
    }
    return g;
  }

  // Short filtered-noise burst (the building block for clicks/cracks).
  _burst(out, t, dur, freq, peak, type = 'lowpass') {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf; src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(out);
    src.start(t); src.stop(t + dur + 0.02);
  }

  _tone(out, t, dur, f0, f1, peak, type = 'triangle') {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(out);
    o.start(t); o.stop(t + dur + 0.02);
  }

  // ---- Gunshot: a sharp noise crack + a low muzzle "boom", tuned by gun ----
  shot(w, vol = 1, pan = 0, suppressed = false) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const cls = w.class;
    const big = w.caliber >= 11 || cls === 'Sniper';
    let dur = cls === 'Shotgun' ? 0.30 : big ? 0.34
      : cls === 'Rifle' || cls === 'LMG' ? 0.18 : 0.12;
    let crackFreq = cls === 'Shotgun' ? 2400 : big ? 1500
      : cls === 'Rifle' ? 5200 : cls === 'SMG' ? 4200 : 3200;
    const boom = big ? 85 : cls === 'Shotgun' ? 120
      : cls === 'Rifle' || cls === 'LMG' ? 150 : 210;

    const out = this._bus(vol, pan);
    if (suppressed) {
      // muffled: low thump, soft "pfft", no sharp crack
      this._burst(out, t, dur * 0.7, 900, 0.5, 'lowpass');
      this._tone(out, t, dur * 0.8, boom * 0.8, boom * 0.4, 0.5);
      return;
    }
    this._burst(out, t, dur, crackFreq, 1.0, 'lowpass');
    this._tone(out, t, dur * 0.9, boom, boom * 0.4, big ? 0.9 : 0.5);
    if (big) this._tone(out, t, dur, boom * 2.2, boom, 0.3, 'sawtooth'); // extra body
  }

  footstep(vol = 0.4, pan = 0) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, out = this._bus(vol, pan);
    this._burst(out, t, 0.06, 280, 0.7, 'lowpass');
  }

  boom(vol = 1, pan = 0) { // explosion / cannon
    if (!this.ctx) return;
    const t = this.ctx.currentTime, out = this._bus(vol, pan);
    this._burst(out, t, 0.5, 400, 1.0, 'lowpass');
    this._tone(out, t, 0.6, 90, 30, 0.9, 'sawtooth');
    this._tone(out, t, 0.4, 160, 50, 0.5, 'triangle');
  }

  empty() { // dry fire on an empty mag
    if (!this.ctx) return;
    const t = this.ctx.currentTime, out = this._bus(0.5);
    this._burst(out, t, 0.03, 5000, 0.6, 'highpass');
  }

  reload() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, out = this._bus(0.45);
    this._burst(out, t + 0.00, 0.04, 1800, 0.7);  // mag release
    this._burst(out, t + 0.18, 0.05, 1400, 0.8);  // mag seat
    this._burst(out, t + 0.40, 0.04, 2600, 0.7, 'highpass'); // charge
  }

  hit(headshot) { // your round connected
    if (!this.ctx) return;
    const t = this.ctx.currentTime, out = this._bus(0.5);
    this._tone(out, t, 0.06, headshot ? 1400 : 900, headshot ? 1700 : 700, 0.5, 'square');
    if (headshot) this._tone(out, t + 0.05, 0.07, 1900, 2200, 0.4, 'square');
  }

  crack(vol = 1, pan = 0) { // a round snapping past you (supersonic crack)
    if (!this.ctx) return;
    const t = this.ctx.currentTime, out = this._bus(vol, pan);
    this._burst(out, t, 0.045, 6500, 1.0, 'highpass');
    this._tone(out, t, 0.05, 1300, 280, 0.3, 'sawtooth');
  }

  hurt() { // you got hit
    if (!this.ctx) return;
    const t = this.ctx.currentTime, out = this._bus(0.6);
    this._tone(out, t, 0.18, 220, 90, 0.6, 'sawtooth');
    this._burst(out, t, 0.1, 700, 0.4);
  }

  kill() { // you killed someone
    if (!this.ctx) return;
    const t = this.ctx.currentTime, out = this._bus(0.4);
    this._tone(out, t, 0.08, 700, 760, 0.4, 'square');
    this._tone(out, t + 0.07, 0.12, 980, 1040, 0.4, 'square');
  }

  death() { // you died
    if (!this.ctx) return;
    const t = this.ctx.currentTime, out = this._bus(0.6);
    this._tone(out, t, 0.6, 300, 60, 0.6, 'sawtooth');
  }
}

export const Sound = new SoundEngine();
