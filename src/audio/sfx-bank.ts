/**
 * Sound-effect recipes, rendered once into AudioBuffers by an OfflineAudioContext (no sample files). The
 * live graph then plays them through pooled voices: one buffer source per hit, nothing synthesised per frame.
 */
import { impulseResponse, noise, rng } from './dsp';

export type SfxId =
  | 'crash-concrete'
  | 'crash-wood'
  | 'crash-metal'
  | 'crash-grass'
  | 'crash-water'
  | 'tick-1'
  | 'tick-2'
  | 'tick-3'
  | 'bump'
  | 'chime'
  | 'chime-sector'
  | 'stinger-lap'
  | 'stinger-best'
  | 'beep'
  | 'go'
  | 'arm'
  | 'disarm'
  | 'batt-low'
  | 'batt-crit'
  | 'oob'
  | 'inbounds'
  | 'ui-hover'
  | 'ui-select'
  | 'ui-back'
  | 'respawn'
  | 'bird-1'
  | 'bird-2'
  | 'bird-3'
  | 'horn-1'
  | 'horn-2'
  | 'siren'
  | 'cowbell-1'
  | 'cowbell-2'
  | 'church-bell'
  | 'tractor'
  | 'wings'
  | 'bleat';

/** Rendered on start: everything the flight and menus need. */
export const CORE_SFX: readonly SfxId[] = [
  'crash-concrete', 'crash-wood', 'crash-metal', 'crash-grass', 'crash-water', 'tick-1', 'tick-2', 'tick-3', 'bump', 'chime', 'chime-sector',
  'stinger-lap', 'stinger-best', 'beep', 'go', 'arm', 'disarm', 'batt-low', 'batt-crit', 'oob', 'inbounds', 'ui-hover', 'ui-select', 'ui-back', 'respawn',
];
/** Rendered with the level that uses them (ambience one-shots and loops). */
export const AMBIENT_SFX: readonly SfxId[] = ['bird-1', 'bird-2', 'bird-3', 'horn-1', 'horn-2', 'siren', 'cowbell-1', 'cowbell-2', 'church-bell', 'tractor', 'wings', 'bleat'];
/** Rendered with a level that has living-world sources (car horns, flocks taking off, herds). */
export const LIFE_SFX: readonly SfxId[] = ['horn-1', 'horn-2', 'wings', 'cowbell-1', 'cowbell-2', 'bleat'];

interface Kit {
  ctx: BaseAudioContext;
  out: AudioNode;
  /** reverb send (a short room baked into stingers / chimes) */
  wet: AudioNode;
  noise: AudioBuffer;
  r: () => number;
}

// --- primitives ------------------------------------------------------------------------------------------------

function env(p: AudioParam, t: number, peak: number, attack: number, decay: number): void {
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + attack);
  p.setTargetAtTime(0, t + attack, decay / 4);
}

function tone(k: Kit, type: OscillatorType, f: number, t: number, peak: number, attack: number, decay: number, to?: number, glideT = 0.05, dest: AudioNode = k.out): OscillatorNode {
  const o = k.ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f, t);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t + glideT);
  const g = k.ctx.createGain();
  env(g.gain, t, peak, attack, decay);
  o.connect(g).connect(dest);
  o.start(t);
  o.stop(t + attack + decay * 1.6 + 0.02);
  return o;
}

function hiss(k: Kit, t: number, type: BiquadFilterType, f: number, q: number, peak: number, attack: number, decay: number, sweepTo?: number, dest: AudioNode = k.out): void {
  const s = k.ctx.createBufferSource();
  s.buffer = k.noise;
  const b = k.ctx.createBiquadFilter();
  b.type = type;
  b.frequency.setValueAtTime(f, t);
  if (sweepTo) b.frequency.exponentialRampToValueAtTime(sweepTo, t + attack + decay);
  b.Q.value = q;
  const g = k.ctx.createGain();
  env(g.gain, t, peak, attack, decay);
  s.connect(b).connect(g).connect(dest);
  s.start(t, k.r() * (k.noise.duration - 1.5));
  s.stop(t + attack + decay * 1.6 + 0.02);
}

/** Modal (inharmonic partial) strike: metal, bells, cowbells. */
function modal(k: Kit, t: number, f0: number, ratios: readonly number[], decays: readonly number[], peak: number, dest: AudioNode = k.out): void {
  ratios.forEach((r, i) => tone(k, 'sine', f0 * r, t, (peak / (i + 1)) * (i === 0 ? 1 : 0.9), 0.001, decays[i] ?? decays[decays.length - 1]!, undefined, 0.05, dest));
}

function debris(k: Kit, t: number, n: number, spread: number, peak: number, lo = 2500, hi = 6500): void {
  for (let i = 0; i < n; i++) {
    const dt = Math.pow(k.r(), 1.6) * spread;
    hiss(k, t + 0.02 + dt, 'bandpass', lo + k.r() * (hi - lo), 4, peak * (1 - dt / spread) * (0.5 + 0.5 * k.r()), 0.0008, 0.012 + k.r() * 0.02);
  }
}

function thump(k: Kit, t: number, f0: number, f1: number, peak: number, decay: number): void {
  tone(k, 'sine', f0, t, peak, 0.002, decay, f1, decay * 0.7);
}

// --- recipes ---------------------------------------------------------------------------------------------------

type Recipe = { len: number; render: (k: Kit) => void; wet?: number };

const crashCore = (k: Kit, t: number): void => {
  thump(k, t, 130, 42, 0.85, 0.32);
  hiss(k, t, 'bandpass', 2400, 0.9, 0.55, 0.001, 0.07);
  hiss(k, t, 'highpass', 5000, 0.7, 0.25, 0.0005, 0.03);
  debris(k, t, 9, 0.55, 0.35);
};

const RECIPES: Record<SfxId, Recipe> = {
  'crash-concrete': {
    len: 1.2,
    wet: 0.25,
    render: (k) => {
      crashCore(k, 0);
      hiss(k, 0, 'highpass', 1600, 0.8, 0.45, 0.001, 0.12);
      hiss(k, 0.01, 'bandpass', 1100, 1.2, 0.3, 0.004, 0.28, 700); // grit scrape
    },
  },
  'crash-wood': {
    len: 1.1,
    wet: 0.2,
    render: (k) => {
      crashCore(k, 0);
      for (const [f, d] of [[210, 0.28], [470, 0.18], [830, 0.12]] as const) hiss(k, 0, 'bandpass', f, 14, 0.9, 0.001, d);
      thump(k, 0, 180, 120, 0.4, 0.2);
    },
  },
  'crash-metal': {
    len: 2.2,
    wet: 0.3,
    render: (k) => {
      crashCore(k, 0);
      modal(k, 0, 410, [1, 2.76, 5.4, 8.93, 13.3], [1.4, 0.9, 0.5, 0.3, 0.2], 0.22);
      hiss(k, 0, 'bandpass', 4200, 3, 0.25, 0.001, 0.25);
    },
  },
  'crash-grass': {
    len: 1.1,
    wet: 0.05,
    render: (k) => {
      thump(k, 0, 95, 38, 0.8, 0.28);
      hiss(k, 0, 'lowpass', 700, 0.7, 0.45, 0.002, 0.2);
      hiss(k, 0.01, 'bandpass', 3200, 0.6, 0.28, 0.03, 0.4); // rustle
      debris(k, 0, 5, 0.4, 0.18, 1500, 3500);
    },
  },
  'crash-water': {
    len: 1.6,
    wet: 0.1,
    render: (k) => {
      thump(k, 0, 180, 70, 0.55, 0.25);
      hiss(k, 0, 'bandpass', 600, 0.8, 0.7, 0.006, 0.55, 2600);
      hiss(k, 0.05, 'highpass', 3000, 0.7, 0.18, 0.05, 0.6);
      for (let i = 0; i < 16; i++) {
        const t = 0.06 + Math.pow(k.r(), 1.3) * 0.9;
        const f = 280 + k.r() * 700;
        tone(k, 'sine', f, t, 0.08 * (1 - t), 0.002, 0.04 + k.r() * 0.03, f * 2.6, 0.05);
      }
    },
  },
  'tick-1': { len: 0.12, render: (k) => tick(k, 3800, 3) },
  'tick-2': { len: 0.12, render: (k) => tick(k, 4600, 2) },
  'tick-3': { len: 0.12, render: (k) => tick(k, 3200, 4) },
  bump: {
    len: 0.35,
    render: (k) => {
      thump(k, 0, 110, 60, 0.6, 0.12);
      hiss(k, 0, 'lowpass', 900, 0.7, 0.3, 0.001, 0.06);
      hiss(k, 0, 'bandpass', 2600, 2, 0.15, 0.001, 0.02);
    },
  },
  chime: {
    len: 1.6,
    wet: 0.35,
    render: (k) => {
      bell(k, 0, 1318.5, 0.32);
      bell(k, 0.065, 1975.5, 0.22);
      tone(k, 'sine', 5274, 0.065, 0.025, 0.002, 0.4);
    },
  },
  'chime-sector': {
    len: 2,
    wet: 0.4,
    render: (k) => {
      [1318.5, 1661.2, 1975.5, 2637].forEach((f, i) => bell(k, i * 0.055, f, 0.25 - i * 0.03));
    },
  },
  'stinger-lap': { len: 3, wet: 0.45, render: (k) => fanfare(k, false) },
  'stinger-best': { len: 4, wet: 0.5, render: (k) => fanfare(k, true) },
  beep: {
    len: 0.4,
    wet: 0.15,
    render: (k) => {
      const lpf = k.ctx.createBiquadFilter();
      lpf.frequency.value = 3500;
      lpf.connect(k.out);
      tone(k, 'square', 880, 0, 0.16, 0.003, 0.17, undefined, 0.05, lpf);
      tone(k, 'sine', 880, 0, 0.25, 0.003, 0.2);
    },
  },
  go: {
    len: 1.2,
    wet: 0.3,
    render: (k) => {
      const lpf = k.ctx.createBiquadFilter();
      lpf.frequency.value = 5000;
      lpf.connect(k.out);
      tone(k, 'square', 1760, 0, 0.16, 0.003, 0.65, undefined, 0.05, lpf);
      tone(k, 'sine', 1760, 0, 0.25, 0.003, 0.7);
      tone(k, 'sine', 880, 0, 0.2, 0.003, 0.6);
      hiss(k, 0, 'highpass', 6000, 0.7, 0.08, 0.002, 0.5);
    },
  },
  arm: { len: 0.6, render: (k) => esc(k, [1046.5, 1318.5, 1568]) },
  disarm: { len: 0.5, render: (k) => esc(k, [1568, 1046.5]) },
  'batt-low': {
    len: 0.5,
    render: (k) => {
      for (const t of [0, 0.16]) buzzer(k, t, 0.09);
    },
  },
  'batt-crit': {
    len: 0.7,
    render: (k) => {
      for (const t of [0, 0.11, 0.22, 0.33]) buzzer(k, t, 0.06);
    },
  },
  oob: {
    len: 0.7,
    render: (k) => {
      const lpf = k.ctx.createBiquadFilter();
      lpf.frequency.value = 2400;
      lpf.connect(k.out);
      tone(k, 'sawtooth', 920, 0, 0.12, 0.005, 0.16, undefined, 0.05, lpf);
      tone(k, 'sawtooth', 620, 0.2, 0.12, 0.005, 0.22, undefined, 0.05, lpf);
    },
  },
  inbounds: { len: 0.4, render: (k) => void tone(k, 'triangle', 620, 0, 0.18, 0.004, 0.18, 1240, 0.12) },
  'ui-hover': { len: 0.08, render: (k) => void tone(k, 'sine', 2350, 0, 0.11, 0.001, 0.025) },
  'ui-select': {
    len: 0.3,
    wet: 0.15,
    render: (k) => {
      tone(k, 'triangle', 1180, 0, 0.2, 0.002, 0.06);
      tone(k, 'triangle', 1770, 0.05, 0.2, 0.002, 0.1);
      hiss(k, 0, 'highpass', 7000, 0.7, 0.04, 0.001, 0.02);
    },
  },
  'ui-back': {
    len: 0.3,
    wet: 0.1,
    render: (k) => {
      tone(k, 'triangle', 1500, 0, 0.18, 0.002, 0.06);
      tone(k, 'triangle', 1000, 0.05, 0.18, 0.002, 0.1);
    },
  },
  respawn: {
    len: 0.8,
    wet: 0.3,
    render: (k) => {
      hiss(k, 0, 'bandpass', 400, 1.4, 0.35, 0.3, 0.2, 3200);
      tone(k, 'sine', 300, 0, 0.12, 0.25, 0.25, 900, 0.35);
    },
  },
  'bird-1': { len: 1.4, render: (k) => bird(k, 5, 3600, 1.4) },
  'bird-2': { len: 1.4, render: (k) => bird(k, 3, 2800, 0.9) },
  'bird-3': { len: 1.6, render: (k) => bird(k, 7, 4300, 1.8) },
  'horn-1': { len: 0.9, render: (k) => horn(k, 0, 0.45) },
  // a flock taking off: a burst of soft wing claps, fast then thinning out
  wings: {
    len: 1.6,
    render: (k) => {
      for (let i = 0; i < 26; i++) {
        const t = Math.pow(i / 26, 1.6) * 1.2 + k.r() * 0.03;
        const a = 0.42 * (1 - i / 32) * (0.6 + 0.4 * k.r());
        hiss(k, t, 'bandpass', 900 + k.r() * 900, 1.1, a, 0.004, 0.05);
        hiss(k, t + 0.012, 'lowpass', 400, 0.7, a * 0.6, 0.002, 0.04);
      }
    },
  },
  // a sheep: a nasal, wavering 'baa' (buzz through a formant pair)
  bleat: {
    len: 0.9,
    render: (k) => {
      const f = 300 + k.r() * 80;
      const o = k.ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(f, 0);
      o.frequency.linearRampToValueAtTime(f * 0.9, 0.7);
      const vib = k.ctx.createOscillator();
      vib.frequency.value = 7 + k.r() * 3;
      const vd = k.ctx.createGain();
      vd.gain.value = f * 0.06;
      vib.connect(vd).connect(o.frequency);
      const g = k.ctx.createGain();
      g.gain.setValueAtTime(0, 0);
      g.gain.linearRampToValueAtTime(0.16, 0.06);
      g.gain.setValueAtTime(0.14, 0.5);
      g.gain.linearRampToValueAtTime(0, 0.75);
      for (const [fc, q, a] of [[900, 6, 1], [2300, 8, 0.5]] as const) {
        const b = k.ctx.createBiquadFilter();
        b.type = 'bandpass';
        b.frequency.value = fc;
        b.Q.value = q;
        const bg = k.ctx.createGain();
        bg.gain.value = a * 2.5;
        o.connect(b).connect(bg).connect(g);
      }
      g.connect(k.out);
      for (const x of [o, vib]) {
        x.start(0);
        x.stop(0.8);
      }
    },
  },
  'horn-2': {
    len: 1.2,
    render: (k) => {
      horn(k, 0, 0.14);
      horn(k, 0.22, 0.5);
    },
  },
  siren: {
    len: 4.2,
    render: (k) => {
      const o = k.ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime(650, 0);
      for (let i = 0; i < 2; i++) {
        o.frequency.linearRampToValueAtTime(1300, i * 2 + 1);
        o.frequency.linearRampToValueAtTime(650, i * 2 + 2);
      }
      const lpf = k.ctx.createBiquadFilter();
      lpf.frequency.value = 1800;
      const g = k.ctx.createGain();
      g.gain.setValueAtTime(0, 0);
      g.gain.linearRampToValueAtTime(0.18, 0.6);
      g.gain.setValueAtTime(0.18, 3.4);
      g.gain.linearRampToValueAtTime(0, 4.1);
      o.connect(lpf).connect(g).connect(k.out);
      o.start(0);
      o.stop(4.2);
    },
  },
  'cowbell-1': { len: 1.6, render: (k) => cowbell(k, 640) },
  'cowbell-2': { len: 1.6, render: (k) => cowbell(k, 760) },
  'church-bell': {
    len: 5,
    wet: 0.3,
    render: (k) => modal(k, 0, 233, [0.5, 1, 1.183, 1.506, 2, 2.514, 2.662, 3.011], [4, 3.2, 2.6, 2, 1.6, 1.2, 1, 0.8], 0.3),
  },
  tractor: {
    len: 2,
    render: (k) => {
      // diesel putter: 14 Hz firing pulses (28 in the 2 s loop) through a resonant body, plus clatter
      for (let i = 0; i < 28; i++) {
        const t = i / 14;
        thump(k, t, 120, 70, i % 4 === 0 ? 0.32 : 0.26, 0.06);
        hiss(k, t, 'bandpass', 900 + k.r() * 300, 3, 0.05, 0.002, 0.03);
      }
    },
  },
};

/** Prop strike: a few plastic clicks a blade apart, plus a short resonance. */
function tick(k: Kit, f: number, n: number): void {
  for (let i = 0; i < n; i++) hiss(k, i * 0.009, 'bandpass', f * (1 + 0.08 * i), 6, 0.5 / (i + 1), 0.0004, 0.01);
  tone(k, 'sine', f * 0.45, 0, 0.08, 0.001, 0.03);
}

function bell(k: Kit, t: number, f: number, peak: number): void {
  const car = k.ctx.createOscillator();
  car.frequency.value = f;
  const mod = k.ctx.createOscillator();
  mod.frequency.value = f * 3.5;
  const idx = k.ctx.createGain();
  idx.gain.setValueAtTime(f * 1.2, t);
  idx.gain.setTargetAtTime(0, t, 0.12);
  mod.connect(idx).connect(car.frequency);
  const g = k.ctx.createGain();
  env(g.gain, t, peak, 0.002, 0.9);
  car.connect(g).connect(k.out);
  for (const o of [car, mod]) {
    o.start(t);
    o.stop(t + 1.6);
  }
}

function fanfare(k: Kit, best: boolean): void {
  // quick rising arpeggio into a bright brass-like chord; the best-lap version climbs higher and sparkles
  const arpNotes = best ? [523.25, 659.25, 783.99, 1046.5, 1318.5] : [523.25, 659.25, 783.99, 1046.5];
  arpNotes.forEach((f, i) => tone(k, 'triangle', f, i * 0.075, 0.2, 0.004, 0.25));
  const t = arpNotes.length * 0.075;
  const lpf = k.ctx.createBiquadFilter();
  lpf.frequency.setValueAtTime(900, t);
  lpf.frequency.linearRampToValueAtTime(4200, t + 0.12);
  lpf.frequency.setTargetAtTime(1800, t + 0.15, 0.5);
  lpf.connect(k.out);
  const chord = best ? [523.25, 659.25, 783.99, 987.77, 1174.66] : [523.25, 659.25, 783.99, 1046.5];
  for (const f of chord)
    for (const d of [-8, 8]) {
      const o = k.ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.detune.value = d;
      const g = k.ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.05, t + 0.03);
      g.gain.setTargetAtTime(0.035, t + 0.03, 0.2);
      g.gain.setTargetAtTime(0, t + (best ? 1.6 : 1.1), 0.25);
      o.connect(g).connect(lpf);
      o.start(t);
      o.stop(t + (best ? 3.2 : 2.4));
    }
  hiss(k, t - 0.25, 'highpass', 6500, 0.7, 0.08, 0.25, 0.6); // cymbal swell
  if (best) [2093, 2637, 3136, 4186].forEach((f, i) => bell(k, t + 0.3 + i * 0.09, f, 0.1));
}

/** ESC tones are played through the motor windings: a square wave in a resonant bell. */
function esc(k: Kit, notes: readonly number[]): void {
  const bp = k.ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1500;
  bp.Q.value = 1.3;
  bp.connect(k.out);
  notes.forEach((f, i) => tone(k, 'square', f, i * 0.12, 0.35, 0.002, i === notes.length - 1 ? 0.2 : 0.09, undefined, 0.05, bp));
}

/** Piezo buzzer (FC beeper): 2.7 kHz square, band-limited. */
function buzzer(k: Kit, t: number, len: number): void {
  const lpf = k.ctx.createBiquadFilter();
  lpf.frequency.value = 6000;
  lpf.connect(k.out);
  const o = k.ctx.createOscillator();
  o.type = 'square';
  o.frequency.value = 2730;
  const g = k.ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.13, t + 0.003);
  g.gain.setValueAtTime(0.13, t + len);
  g.gain.linearRampToValueAtTime(0, t + len + 0.004);
  o.connect(g).connect(lpf);
  o.start(t);
  o.stop(t + len + 0.01);
}

/** Songbird phrase: `n` syllables of fast FM-warbled sweeps. */
function bird(k: Kit, n: number, f: number, span: number): void {
  for (let i = 0; i < n; i++) {
    const t = (i / n) * span * (0.8 + 0.2 * k.r());
    const len = 0.04 + k.r() * 0.07;
    const o = k.ctx.createOscillator();
    const f0 = f * (0.85 + 0.3 * k.r());
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f0 * (k.r() < 0.5 ? 1.4 : 0.7), t + len);
    const wob = k.ctx.createOscillator();
    wob.frequency.value = 28 + k.r() * 30;
    const wd = k.ctx.createGain();
    wd.gain.value = f0 * 0.05;
    wob.connect(wd).connect(o.frequency);
    const g = k.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.12, t + len * 0.25);
    g.gain.linearRampToValueAtTime(0, t + len);
    o.connect(g).connect(k.out);
    for (const x of [o, wob]) {
      x.start(t);
      x.stop(t + len + 0.01);
    }
  }
}

function horn(k: Kit, t: number, len: number): void {
  const lpf = k.ctx.createBiquadFilter();
  lpf.frequency.value = 2200;
  lpf.Q.value = 1.5;
  lpf.connect(k.out);
  for (const f of [415, 523]) {
    const o = k.ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = f;
    const g = k.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.09, t + 0.02);
    g.gain.setValueAtTime(0.09, t + len);
    g.gain.linearRampToValueAtTime(0, t + len + 0.04);
    o.connect(g).connect(lpf);
    o.start(t);
    o.stop(t + len + 0.05);
  }
}

function cowbell(k: Kit, f: number): void {
  // an alpine bell is a rough sheet-metal shell: inharmonic, quick, struck twice as the cow moves
  for (const [t, a] of [[0, 1], [0.32, 0.6]] as const) {
    modal(k, t, f, [1, 1.47, 2.09, 2.56, 3.31], [0.5, 0.35, 0.25, 0.18, 0.12], 0.16 * a);
    hiss(k, t, 'bandpass', f * 3, 2, 0.05 * a, 0.001, 0.03);
  }
}

// --- rendering ---------------------------------------------------------------------------------------------------

export type Offline = (channels: number, length: number, sampleRate: number) => OfflineAudioContext;

/** Output trims that level the bank (RMS within a few dB per family: impacts, rewards, callouts). */
const TRIM: Partial<Record<SfxId, number>> = { 'crash-water': 1.4, 'stinger-lap': 2, 'stinger-best': 1.7, oob: 2.5, inbounds: 1.8, 'cowbell-1': 1.6, 'cowbell-2': 1.6 };

export function sfxLength(id: SfxId): number {
  return RECIPES[id].len;
}

/** Renders one effect, mono, at `sampleRate`. */
export async function renderSfx(id: SfxId, sampleRate: number, offline: Offline, seed = 1): Promise<AudioBuffer> {
  const recipe = RECIPES[id];
  const ctx = offline(1, Math.ceil(recipe.len * sampleRate), sampleRate);
  const out = ctx.createGain();
  out.gain.value = TRIM[id] ?? 1;
  out.connect(ctx.destination);
  const nbuf = ctx.createBuffer(1, Math.round(sampleRate * 3), sampleRate);
  nbuf.copyToChannel(noise(nbuf.length, 'white', 5 + seed), 0);
  const k: Kit = { ctx, out, wet: out, noise: nbuf, r: rng(seed * 977 + id.length * 13) };
  if (recipe.wet) {
    const [ir] = impulseResponse('loft', sampleRate, 0.6, 3);
    const ib = ctx.createBuffer(1, ir.length, sampleRate);
    ib.copyToChannel(ir, 0);
    const conv = ctx.createConvolver();
    conv.normalize = false;
    conv.buffer = ib;
    const send = ctx.createGain();
    send.gain.value = recipe.wet;
    out.connect(send).connect(conv).connect(ctx.destination);
  }
  recipe.render(k);
  return ctx.startRendering();
}

/** Renders a list of effects (sequentially: small peak memory). Failures leave the effect out. */
export async function renderBank(ids: readonly SfxId[], sampleRate: number, offline: Offline, into: Map<SfxId, AudioBuffer>): Promise<void> {
  for (const id of ids) {
    if (into.has(id)) continue;
    try {
      into.set(id, await renderSfx(id, sampleRate, offline));
    } catch (err) {
      console.warn('Sound effect render failed', id, err);
    }
  }
}
