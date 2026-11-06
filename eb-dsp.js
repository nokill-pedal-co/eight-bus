(function EB_DSP(sampleRate, AudioWorkletProcessor, registerProcessor) {
const SR = sampleRate;
const TAU = Math.PI * 2;
const NS = 8;
const TBL = 4096;
const SINE = new Float32Array(TBL + 1);
for (let i = 0; i <= TBL; i++) SINE[i] = Math.sin(TAU * i / TBL);
function sin1(ph) { ph -= Math.floor(ph); const x = ph * TBL; const i = x | 0; return SINE[i] + (SINE[i + 1] - SINE[i]) * (x - i); }
function blep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}
let seed = 90210;
function rnd() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2147483648 - 1; }
function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }

const T = { OSC: 0, FM: 1, STRING: 2, NOISE: 3, KICK: 4, SNARE: 5, HAT: 6, FILTER: 7, DELAY: 8, LFO: 9 };
const SCALES = [[0, 2, 3, 5, 7, 8, 10], [0, 2, 4, 5, 7, 9, 11], [0, 3, 5, 7, 10], [0, 2, 3, 5, 7, 9, 10], [0, 2, 3, 7, 8], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]];
const RATIOS = [0.5, 1, 1.5, 2, 3, 4, 5, 7, 9];

function knobNote(v, root, scale) {
  const s = SCALES[scale], n = Math.round(clamp(v, 0, 1) * s.length * 4), oct = Math.floor(n / s.length);
  return 36 + root + 12 * oct + s[n % s.length];
}
function snap(note, root, scale) {
  const s = SCALES[scale], rel = note - root, oct = Math.floor(rel / 12), pc = rel - oct * 12;
  let best = s[0], bd = 99;
  for (const d of s.concat(s[0] + 12)) { const dist = Math.abs(d - pc); if (dist < bd) { bd = dist; best = d; } }
  return root + oct * 12 + best;
}

class Line {
  constructor(n) { this.b = new Float32Array(n); this.n = n; this.w = 0; }
  write(x) { this.b[this.w] = x; if (++this.w === this.n) this.w = 0; }
  read(d) { let r = this.w - d; while (r < 0) r += this.n; const i = r | 0, f = r - i, j = i + 1 === this.n ? 0 : i + 1; return this.b[i] + (this.b[j] - this.b[i]) * f; }
  readInt(d) { let r = this.w - d; if (r < 0) r += this.n; return this.b[r]; }
  clear() { this.b.fill(0); this.w = 0; }
}

class Cell {
  constructor(i) {
    this.i = i; this.type = T.OSC; this.a = 0.5; this.b = 0.3; this.c = 0;
    this.lvl = 0; this.lvlS = 0; this.mute = false; this.solo = false;
    this.atk = 0.1; this.dec = 0.5; this.send = 0.2;
    this.mode = 0; this.steps = 16; this.pulses = 4; this.rot = 0; this.armed = false;
    this.env = 0; this.envS = 0; this.gate = false; this.keyNote = 60; this.ord = 0;
    this.ph = 0; this.ph2 = 0; this.ic1 = 0; this.ic2 = 0; this.lp = 0; this.x1 = 0; this.t = 1e9; this.burst = 0; this.vel = 1;
    this.hatPh = new Float64Array(6); this.shVal = 0; this.shT = 0; this.driftV = 0;
    this.str = null; this.dly = null; this.dT = SR * 0.3;
    this.out = 0; this.mod = 0; this.modS = 0; this.peak = 0; this.flash = 0; this.dcIn = 0;
    this.inc = 0.01; this.inc2 = 0.01; this.g = 0.1; this.k = 1; this.a1 = 1; this.a2 = 0; this.a3 = 0; this.fb = 0.9; this.s = 0.3; this.N = 100; this.index = 1; this.dA = 0.01; this.dD = 0.999; this.mix = 0;
  }
  trigger(vel) {
    this.vel = vel; this.flash = 1;
    switch (this.type) {
      case T.KICK: case T.SNARE: case T.HAT: this.t = 0; break;
      case T.STRING: this.burst = Math.round(SR / Math.max(this.inc * SR, 20)); this.env = 1; this.envS = 2; break;
      case T.LFO: this.ph = 0; break;
      default: this.envS = 1;
    }
  }
  block(n, G) {
    const kS = 1 - Math.exp(-n / (0.006 * SR));
    const target = this.mute ? 0 : this.lvl * this.lvl;
    this.lvlS += (target - this.lvlS) * kS;
    this.modS += (this.mod - this.modS) * kS;
    this.dA = 1 / (0.001 * Math.pow(1000, this.atk) * SR);
    this.dD = Math.exp(-4 / (0.01 * Math.pow(500, this.dec) * SR));
    let note;
    if (this.armed) note = this.keyNote + Math.round((this.a - 0.5) * 4) * 12;
    else note = knobNote(this.a, G.root, G.scale);
    let p = note + this.modS * 12;
    if (G.snap) p = snap(Math.round(p), G.root, G.scale);
    p += G.bend;
    const hz = 440 * Math.pow(2, (p - 69) / 12);
    const t = this.type;
    if (t === T.OSC) this.inc = Math.min(hz, SR * 0.45) / SR;
    else if (t === T.FM) { this.inc = Math.min(hz, SR * 0.45) / SR; this.inc2 = Math.min(hz * RATIOS[clamp(Math.round(this.b * 8), 0, 8)], SR * 0.45) / SR; this.index = this.c * this.c * 8; }
    else if (t === T.STRING) {
      if (!this.str) this.str = new Line(4096);
      const bright = clamp(0.15 + this.b * 0.85, 0, 1);
      this.s = 0.5 - 0.45 * bright;
      const f = Math.max(hz, 20);
      this.inc = f / SR;
      this.N = Math.max(2, SR / f - this.s);
      const T60 = 0.3 * Math.pow(100, this.c);   // 0.3 .. 30 s
      this.fb = Math.exp(-6.9 / (f * T60));     // loss per period, not per sample
    } else if (t === T.NOISE || t === T.FILTER) {
      const fc = clamp(40 * Math.pow(400, this.a) * Math.pow(2, this.modS * 4), 20, SR * 0.45);
      const g = Math.tan(Math.PI * fc / SR);
      this.k = 2 - 1.97 * this.b; this.a1 = 1 / (1 + g * (g + this.k)); this.a2 = g * this.a1; this.a3 = g * this.a2;
    } else if (t === T.KICK) this.inc = (30 * Math.pow(4, this.a) * Math.pow(2, this.modS)) / SR;
    else if (t === T.SNARE) this.inc = (120 * Math.pow(3, this.a) * Math.pow(2, this.modS)) / SR;
    else if (t === T.DELAY) { if (!this.dly) this.dly = new Line(Math.ceil(SR * 2.6)); }
    else if (t === T.LFO) this.inc = (0.02 * Math.pow(2000, this.a) * Math.pow(2, this.modS * 3)) / SR;
  }
  tick(audio) {
    let y = 0;
    switch (this.type) {
      case T.OSC: {
        const dt = this.inc;
        let p = this.ph + dt; if (p >= 1) p -= 1; this.ph = p;
        let q = p + audio * 0.5; q -= Math.floor(q);
        // Wave knob crossfades sine > triangle > saw > square.
        const m = this.b * 3, seg = m < 1 ? 0 : m < 2 ? 1 : 2, f = m - seg;
        const tri = 4 * Math.abs(q - 0.5) - 1;
        if (seg === 0) y = sin1(q) * (1 - f) + tri * f;
        else {
          const saw = 2 * q - 1 - blep(q, dt);
          if (seg === 1) y = tri * (1 - f) + saw * f;
          else { let r = q - 0.5; if (r < 0) r += 1; y = saw * (1 - f) + ((q < 0.5 ? 1 : -1) + blep(q, dt) - blep(r, dt)) * f; }
        }
        if (this.c > 0.01) y = sin1(y * (0.25 + this.c * 1.5));
        y *= this.envAmp();
        break;
      }
      case T.FM: {
        let p = this.ph + this.inc; if (p >= 1) p -= 1; this.ph = p;
        let r = this.ph2 + this.inc2; if (r >= 1) r -= 1; this.ph2 = r;
        const mod = sin1(r + audio * 0.5) * this.index;
        y = sin1(p + mod / TAU) * this.envAmp();
        break;
      }
      case T.STRING: {
        let e = audio * 0.25;
        if (this.burst > 0) { this.burst--; this.lp += 0.5 * (rnd() - this.lp); e += this.lp * this.vel; }
        if (this.mode === 0 && !this.armed) { this.lp += 0.2 * (rnd() - this.lp); e += this.lp * 0.015; }   // bowed drone
        const o = this.str.read(this.N);
        const fil = (1 - this.s) * o + this.s * this.x1; this.x1 = o;
        this.str.write(Math.tanh(fil * this.fb + e));
        y = o * 1.4;
        if (this.mode === 0 && !this.armed) { /* drone rings */ } else y *= this.gateOnlyEnv();
        break;
      }
      case T.NOISE: {
        const w = rnd();
        this.lp += (0.03 + (1 - this.c) * 0.97) * (w - this.lp);
        const x = this.lp;
        const v3 = x - this.ic2, v1 = this.a1 * this.ic1 + this.a2 * v3, v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
        this.ic1 = Math.tanh(2 * v1 - this.ic1); this.ic2 = 2 * v2 - this.ic2;
        y = v2 * (1 + clamp(audio, -1, 1)) * this.envAmp();
        break;
      }
      case T.KICK: {
        if (this.t > SR * 6) break;
        const s = this.t / SR; this.t++;
        const dec = 0.05 + this.b * this.b * 1.2;
        const pitchEnv = 1 + (1 + this.c * 7) * Math.exp(-s / 0.025);
        this.ph += this.inc * pitchEnv; if (this.ph >= 1) this.ph -= 1;
        y = sin1(this.ph + audio * 0.25) * Math.exp(-s / dec) * this.vel;
        if (s < 0.004) y += rnd() * this.c * 0.5 * (1 - s / 0.004);
        y = Math.tanh(y * 1.6);
        break;
      }
      case T.SNARE: {
        if (this.t > SR * 3) break;
        const s = this.t / SR; this.t++;
        const dec = 0.03 + this.b * this.b * 0.5;
        this.ph += this.inc * (1 + 0.6 * Math.exp(-s / 0.012)); if (this.ph >= 1) this.ph -= 1;
        const body = sin1(this.ph + audio * 0.25) * Math.exp(-s / (dec * 0.6));
        const w = rnd(); this.lp += 0.6 * (w - this.lp);
        const n = (w - this.lp) * Math.exp(-s / dec);
        y = (body * (1 - this.c) + n * (0.4 + this.c * 1.2)) * this.vel;
        break;
      }
      case T.HAT: {
        if (this.t > SR * 3) break;
        const s = this.t / SR; this.t++;
        const dec = 0.012 + this.b * this.b * 0.7;
        const base = (250 + this.a * 500) / SR;
        const rat = [1, 1.483, 1.932, 2.546, 2.63, 3.897];
        let m = 0;
        for (let k = 0; k < 6; k++) { let ph = this.hatPh[k] + base * rat[k]; if (ph >= 1) ph -= 1; this.hatPh[k] = ph; m += ph < 0.5 ? 1 : -1; }
        const x = m / 6 * this.c + rnd() * (1 - this.c);
        const c = 0.15 + (1 - this.a) * 0.5;
        this.lp += c * (x - this.lp);
        y = (x - this.lp) * Math.exp(-s / dec) * this.vel * (1 + clamp(audio, -1, 1));
        break;
      }
      case T.FILTER: {
        const x = audio + (this.b > 0.7 ? rnd() * 1e-3 : 0);
        const v3 = x - this.ic2, v1 = this.a1 * this.ic1 + this.a2 * v3, v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
        this.ic1 = Math.tanh(2 * v1 - this.ic1); this.ic2 = Math.tanh(2 * v2 - this.ic2);
        const hp = x - this.k * v1 - v2;
        const c = this.c * 2;
        y = c < 1 ? v2 * (1 - c) + v1 * c : v1 * (2 - c) + hp * (c - 1);
        y = Math.tanh(y) * this.envAmp();
        break;
      }
      case T.DELAY: {
        const target = 0.02 * Math.pow(100, this.a) * Math.pow(2, this.modS) * SR;
        this.dT += (clamp(target, 8, this.dly.n - 4) - this.dT) * 0.0006;
        const o = this.dly.read(this.dT);
        this.lp += (0.05 + this.c * 0.95) * (o - this.lp);
        this.dly.write(Math.tanh(audio + this.lp * this.b * 1.05));
        y = o * this.envAmp();
        break;
      }
      case T.LFO: {
        let p = this.ph + this.inc; if (p >= 1) { p -= 1; this.shVal = rnd(); } this.ph = p;
        const z = this.b * 5, seg = Math.min(4, z | 0);
        const v = seg === 0 ? sin1(p) : seg === 1 ? 4 * Math.abs(p - 0.5) - 1 : seg === 2 ? 2 * p - 1 : seg === 3 ? (p < 0.5 ? 1 : -1) : this.shVal;
        y = v * (1 - this.c / 2) + this.c / 2;
        break;
      }
    }
    return y;
  }
  recover() {
    this.ic1 = this.ic2 = this.lp = this.x1 = this.dcIn = 0; this.ph = this.ph2 = 0;
    if (this.str) this.str.clear();
    if (this.dly) this.dly.clear();
  }
  // Level envelope for the sustained modules. Hold: always open. Pattern: attack/decay. Armed: attack/sustain/release.
  envAmp() {
    if (this.mode === 0 && !this.armed) { this.env += (1 - this.env) * 0.002; return this.env; }
    if (this.envS === 1) { this.env += this.dA; if (this.env >= 1) { this.env = 1; this.envS = 2; } }
    else if (this.envS === 2) { if (!(this.armed && this.gate)) this.env *= this.dD; }
    return this.env * this.vel;
  }
  gateOnlyEnv() {
    if (this.armed && !this.gate) this.env *= this.dD;
    return this.armed ? this.env : 1;
  }
}

const REV_BASE = [1031, 1327, 1523, 1733, 1949, 2179, 2411, 2689];

class EightBus extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cells = []; for (let i = 0; i < NS; i++) this.cells.push(new Cell(i));
    this.G = { tempo: 118, swing: 0, root: 9, scale: 0, snap: true, echo: 0.35, size: 0.5, master: 0.8, bend: 0, bendRange: 2 };
    this.cables = [];
    this.bendT = 0; this.bendS = 0;
    this.clock = 0; this.stepN = 0; this.ord = 0; this.blocks = 0;
    this.dL = new Line(Math.ceil(SR * 1.6)); this.dR = new Line(Math.ceil(SR * 1.6)); this.dlpL = 0; this.dlpR = 0;
    this.rl = REV_BASE.map(l => new Line(Math.ceil(l * SR / 48000 * 1.6) + 8));
    this.rlen = new Int32Array(8); this.rg = new Float64Array(8); this.rlp = new Float64Array(8); this.ro = new Float64Array(8);
    this.revKey = ''; this.dcL = 0; this.dcR = 0; this.dcLo = 0; this.dcRo = 0;
    this.audio = new Float64Array(NS); this.modIn = new Float64Array(NS);
    this.pan = [-0.55, 0.55, -0.35, 0.35, -0.15, 0.15, -0.7, 0.7];
    this.port.onmessage = e => this.msg(e.data);
  }
  msg(d) {
    switch (d.t) {
      case 'scene':
        d.cells.forEach((c, i) => this.setCell(i, c));
        this.cables = d.cables.slice();
        Object.assign(this.G, d.G);
        break;
      case 'cell': this.setCell(d.i, d.p); break;
      case 'cables': this.cables = d.cables.slice(); break;
      case 'G': Object.assign(this.G, d.G); break;
      case 'on': this.keyOn(d.note, d.vel); break;
      case 'off': this.keyOff(d.note); break;
      case 'bend': this.bendT = d.v; break;
      case 'hit': this.cells[d.i].trigger(1); break;
      case 'panic':
        for (const c of this.cells) { c.gate = false; c.env = 0; c.t = 1e9; c.ic1 = c.ic2 = 0; if (c.str) c.str.clear(); if (c.dly) c.dly.clear(); c.out = 0; }
        for (const l of [this.dL, this.dR, ...this.rl]) l.clear();
        break;
    }
  }
  setCell(i, p) {
    const c = this.cells[i];
    if (p.type != null && p.type !== c.type) { c.ic1 = c.ic2 = c.lp = c.x1 = 0; c.t = 1e9; c.env = 0; c.envS = 0; c.ph = c.ph2 = 0; }
    Object.assign(c, p);
    if (p.armed === false) c.gate = false;
  }
  keyOn(note, vel) {
    const armed = this.cells.filter(c => c.armed);
    if (!armed.length) return;
    let c = armed.find(x => x.gate && x.keyNote === note) || armed.find(x => !x.gate);
    if (!c) { c = armed[0]; for (const x of armed) if (x.ord < c.ord) c = x; }
    c.keyNote = note; c.gate = true; c.ord = ++this.ord; c.block(1, this.G); c.trigger(vel); c.gate = true;
  }
  keyOff(note) { for (const c of this.cells) if (c.armed && c.gate && c.keyNote === note) c.gate = false; }
  setReverb(size) {
    const key = size.toFixed(3); if (key === this.revKey) return; this.revKey = key;
    for (let j = 0; j < 8; j++) {
      const l = Math.round(REV_BASE[j] * SR / 48000 * (0.5 + size));
      this.rlen[j] = l; this.rg[j] = Math.pow(10, -3 * l / ((0.6 + size * 7) * SR));
    }
  }
  stepClock(n) {
    const G = this.G;
    this.clock -= n;
    if (this.clock > 0) return;
    const step = SR * 60 / G.tempo / 4;
    this.clock += step * (this.stepN & 1 ? 1 - G.swing * 0.6 : 1 + G.swing * 0.6);
    this.stepN++;
    for (const c of this.cells) {
      if (c.mode !== 1 || c.armed) continue;
      const ns = Math.max(1, c.steps), k = Math.min(c.pulses, ns);
      const i = (this.stepN - 1 + ns - (c.rot % ns)) % ns;
      if ((i * k) % ns < k && k > 0) c.trigger(0.9);
    }
  }
  process(inputs, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    const n = L.length, G = this.G, cells = this.cells, cables = this.cables;
    this.bendS += (this.bendT - this.bendS) * (1 - Math.exp(-n / (0.01 * SR)));
    G.bend = this.bendS * (G.bendRange || 2);
    this.stepClock(n);
    this.setReverb(G.size);

    // LFO cables are control signals into a strip's main parameter; everything else is audio into its input.
    const anySolo = cells.some(c => c.solo);
    const gains = this.pan.map(p => { const a = (p + 1) * Math.PI / 4; return [Math.cos(a), Math.sin(a)]; });
    this.modIn.fill(0);
    for (const c of cables) if (cells[c.s].type === T.LFO) this.modIn[c.d] += cells[c.s].out * c.a;
    for (let i = 0; i < NS; i++) { cells[i].mod = this.modIn[i]; cells[i].block(n, G); }
    const audio = this.audio;
    const dT = clamp(SR * 60 / G.tempo * 0.75, 1, this.dL.n - 2), ec = G.echo;
    const rl = this.rl, rlen = this.rlen, rg = this.rg, rlp = this.rlp, ro = this.ro;
    const master = G.master * G.master * 1.25;
    for (let s = 0; s < n; s++) {
      audio.fill(0);
      // Audio cables can reach 4x gain at the top: a feedback loop only sustains with gain above 1.
      for (let q = 0; q < cables.length; q++) { const c = cables[q], src = cells[c.s]; if (src.type !== T.LFO) audio[c.d] += src.out * c.a * c.a * 4; }
      let l = 0, r = 0, sp = 0;
      for (let i = 0; i < NS; i++) {
        const c = cells[i];
        // Inputs are AC-coupled like a real mixer's: without this, hot feedback loops latch at DC and go silent.
        c.dcIn += 0.002 * (audio[i] - c.dcIn);
        let raw = c.tick(audio[i] - c.dcIn);
        // Feedback patches can go anywhere. One bad value must not poison the matrix: reset that strip and carry on.
        if (!(raw > -8 && raw < 8)) { raw = 0; c.recover(); }
        const post = raw * c.lvlS;
        c.out = post;
        const ab = Math.abs(post); if (ab > c.peak) c.peak = ab;
        if (c.type !== T.LFO && (!anySolo || c.solo)) { l += post * gains[i][0]; r += post * gains[i][1]; sp += post * c.send; }
      }
      // space bus: ping-pong echo, then reverb
      const yl = this.dL.read(dT), yr = this.dR.read(dT);
      this.dlpL += 0.5 * (yr - this.dlpL); this.dlpR += 0.5 * (yl - this.dlpR);
      this.dL.write(sp * ec + this.dlpL * (0.25 + ec * 0.5)); this.dR.write(this.dlpR * (0.25 + ec * 0.5));
      const m = sp + yl * 0.7 + yr * 0.7;
      for (let j = 0; j < 8; j++) { rlp[j] += 0.65 * (rl[j].readInt(rlen[j]) - rlp[j]); ro[j] = rlp[j] * rg[j]; }
      const a0 = ro[0] + ro[1], a1 = ro[0] - ro[1], a2 = ro[2] + ro[3], a3 = ro[2] - ro[3];
      const a4 = ro[4] + ro[5], a5 = ro[4] - ro[5], a6 = ro[6] + ro[7], a7 = ro[6] - ro[7];
      const c0 = a0 + a2, c1 = a1 + a3, c2 = a0 - a2, c3 = a1 - a3, c4 = a4 + a6, c5 = a5 + a7, c6 = a4 - a6, c7 = a5 - a7;
      const h = 0.35355339, inj = m * 0.3;
      rl[0].write((c0 + c4) * h + inj); rl[1].write((c1 + c5) * h - inj); rl[2].write((c2 + c6) * h + inj); rl[3].write((c3 + c7) * h - inj);
      rl[4].write((c0 - c4) * h + inj); rl[5].write((c1 - c5) * h - inj); rl[6].write((c2 - c6) * h + inj); rl[7].write((c3 - c7) * h - inj);
      l += yl * 0.6 + (ro[0] + ro[2] + ro[4] + ro[6]) * 0.3;
      r += yr * 0.6 + (ro[1] + ro[3] + ro[5] + ro[7]) * 0.3;
      // block DC (feedback patches can drift) and limit
      this.dcL += 0.0008 * (l - this.dcL); this.dcR += 0.0008 * (r - this.dcR);
      L[s] = Math.tanh((l - this.dcL) * master);
      if (R !== L) R[s] = Math.tanh((r - this.dcR) * master);
    }
    if (++this.blocks % 8 === 0) {
      const meters = cells.map(c => { const p = c.peak; c.peak = 0; return p; });
      const flash = cells.map(c => { const f = c.flash; c.flash = 0; return f; });
      this.port.postMessage({ t: 'm', meters, flash, step: this.stepN });
    }
    return true;
  }
}
registerProcessor('eight-bus', EightBus);
})(sampleRate, AudioWorkletProcessor, registerProcessor);
