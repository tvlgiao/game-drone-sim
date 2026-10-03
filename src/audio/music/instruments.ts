/**
 * Synth and drum voices for the offline stem renderer. Each call schedules one note into a (usually
 * Offline) AudioContext; nothing here runs in the live graph, so node counts only cost render time.
 */
import { mtof } from './songs';
import type { ArpVoice, BassVoice, DrumKind, Kit, LeadVoice, PadVoice } from './songs';

export interface Rig {
  ctx: BaseAudioContext;
  /** white noise, a few seconds */
  noise: AudioBuffer;
  out: AudioNode;
}

/** Attack / decay / sustain / release on a gain param, starting from silence at `t`. */
function adsr(p: AudioParam, t: number, peak: number, a: number, d: number, s: number, hold: number, r: number): number {
  const sus = Math.max(0.0001, peak * s);
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + a);
  p.setTargetAtTime(sus, t + a, Math.max(0.001, d / 3));
  const off = t + Math.max(a, hold);
  p.setTargetAtTime(0, off, Math.max(0.001, r / 4));
  return off + r * 1.2;
}

/** Percussive envelope: instant attack, exponential decay. */
function perc(p: AudioParam, t: number, peak: number, decay: number, attack = 0.002): number {
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + attack);
  p.setTargetAtTime(0, t + attack, decay / 4);
  return t + attack + decay * 1.5;
}

function osc(ctx: BaseAudioContext, type: OscillatorType, f: number, detuneCents = 0): OscillatorNode {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = f;
  o.detune.value = detuneCents;
  return o;
}

function lp(ctx: BaseAudioContext, f: number, q = 0.7, type: BiquadFilterType = 'lowpass'): BiquadFilterNode {
  const b = ctx.createBiquadFilter();
  b.type = type;
  b.frequency.value = f;
  b.Q.value = q;
  return b;
}

function noiseHit(rig: Rig, t: number, dur: number, type: BiquadFilterType, f: number, q: number, peak: number, decay: number, attack = 0.001): void {
  const { ctx } = rig;
  const src = ctx.createBufferSource();
  src.buffer = rig.noise;
  const filt = lp(ctx, f, q, type);
  const g = ctx.createGain();
  const end = perc(g.gain, t, peak, decay, attack);
  src.connect(filt).connect(g).connect(rig.out);
  src.start(t, (t * 7.31) % Math.max(0.01, rig.noise.duration - dur - 0.1));
  src.stop(Math.min(end, t + dur));
}

function pan(ctx: BaseAudioContext, v: number): AudioNode {
  if (typeof ctx.createStereoPanner !== 'function') return ctx.createGain();
  const p = ctx.createStereoPanner();
  p.pan.value = v;
  return p;
}

// --- pads ---------------------------------------------------------------------------------------------------

const PAD: Record<PadVoice, { types: OscillatorType[]; detune: number; cutoff: number; q: number; a: number; r: number; level: number; vibrato?: number }> = {
  'saw-pad': { types: ['sawtooth', 'sawtooth', 'sawtooth'], detune: 11, cutoff: 1900, q: 1.2, a: 0.5, r: 1.2, level: 0.05 },
  'warm-pad': { types: ['triangle', 'sawtooth', 'triangle'], detune: 7, cutoff: 2600, q: 0.7, a: 0.25, r: 0.8, level: 0.05 },
  'dark-pad': { types: ['sawtooth', 'square', 'sawtooth'], detune: 14, cutoff: 950, q: 2.5, a: 0.8, r: 1.5, level: 0.055 },
  'string-pad': { types: ['sawtooth', 'sawtooth', 'sawtooth'], detune: 9, cutoff: 1500, q: 0.9, a: 1.1, r: 1.6, level: 0.055, vibrato: 4 },
  'air-pad': { types: ['sine', 'triangle', 'sine'], detune: 6, cutoff: 3000, q: 0.5, a: 1.8, r: 2.5, level: 0.07 },
};

export function pad(rig: Rig, voice: PadVoice, t: number, midi: number, dur: number, vel: number): void {
  const { ctx } = rig;
  const v = PAD[voice];
  const f = mtof(midi);
  const g = ctx.createGain();
  const filt = lp(ctx, v.cutoff, v.q);
  // the filter breathes slowly across the chord
  filt.frequency.setValueAtTime(v.cutoff * 0.6, t);
  filt.frequency.linearRampToValueAtTime(v.cutoff, t + dur * 0.5);
  filt.frequency.linearRampToValueAtTime(v.cutoff * 0.75, t + dur);
  const end = adsr(g.gain, t, v.level * vel, v.a, 0.6, 0.85, dur, v.r);
  filt.connect(g).connect(rig.out);
  v.types.forEach((type, i) => {
    const o = osc(ctx, type, f, (i - 1) * v.detune);
    const p = pan(ctx, (i - 1) * 0.7);
    if (v.vibrato) {
      const lfo = osc(ctx, 'sine', 4.6 + i * 0.4);
      const depth = ctx.createGain();
      depth.gain.value = v.vibrato;
      lfo.connect(depth).connect(o.detune);
      lfo.start(t);
      lfo.stop(end);
    }
    o.connect(p).connect(filt);
    o.start(t);
    o.stop(end);
  });
}

// --- bass ---------------------------------------------------------------------------------------------------

export function bass(rig: Rig, voice: BassVoice, t: number, midi: number, dur: number, vel: number): void {
  const { ctx } = rig;
  const f = mtof(midi);
  const g = ctx.createGain();
  let end: number;
  switch (voice) {
    case 'pulse-bass': {
      const a = osc(ctx, 'sawtooth', f);
      const b = osc(ctx, 'square', f, 6);
      const filt = lp(ctx, 300, 4);
      filt.frequency.setValueAtTime(1400 * vel + 300, t);
      filt.frequency.setTargetAtTime(320, t, 0.06);
      end = adsr(g.gain, t, 0.2 * vel, 0.004, 0.12, 0.6, dur, 0.05);
      a.connect(filt);
      b.connect(filt);
      filt.connect(g).connect(rig.out);
      for (const o of [a, b]) {
        o.start(t);
        o.stop(end);
      }
      break;
    }
    case 'pluck-bass': {
      const a = osc(ctx, 'sawtooth', f);
      const sub = osc(ctx, 'sine', f);
      const filt = lp(ctx, 500, 6);
      filt.frequency.setValueAtTime(2400, t);
      filt.frequency.setTargetAtTime(380, t, 0.05);
      end = adsr(g.gain, t, 0.2 * vel, 0.003, 0.15, 0.5, dur, 0.06);
      a.connect(filt).connect(g);
      const sg = ctx.createGain();
      sg.gain.value = 0.9;
      sub.connect(sg).connect(g);
      g.connect(rig.out);
      for (const o of [a, sub]) {
        o.start(t);
        o.stop(end);
      }
      break;
    }
    case 'roll-bass': {
      const a = osc(ctx, 'sawtooth', f);
      const filt = lp(ctx, 400, 9);
      filt.frequency.setValueAtTime(1700 + 900 * vel, t);
      filt.frequency.setTargetAtTime(260, t, 0.035);
      end = perc(g.gain, t, 0.24 * vel, dur + 0.08);
      a.connect(filt).connect(g).connect(rig.out);
      a.start(t);
      a.stop(end);
      break;
    }
    case 'string-bass': {
      const a = osc(ctx, 'sawtooth', f, -5);
      const b = osc(ctx, 'sawtooth', f, 5);
      const filt = lp(ctx, 700, 0.8);
      end = adsr(g.gain, t, 0.14 * vel, 0.18, 0.5, 0.8, dur, 0.7);
      a.connect(filt);
      b.connect(filt);
      filt.connect(g).connect(rig.out);
      for (const o of [a, b]) {
        o.start(t);
        o.stop(end);
      }
      break;
    }
    case 'sub-bass': {
      const a = osc(ctx, 'sine', f);
      const b = osc(ctx, 'triangle', f * 2);
      const bg = ctx.createGain();
      bg.gain.value = 0.12;
      end = adsr(g.gain, t, 0.26 * vel, 0.6, 0.6, 0.8, dur, 1.2);
      a.connect(g);
      b.connect(bg).connect(g);
      g.connect(rig.out);
      for (const o of [a, b]) {
        o.start(t);
        o.stop(end);
      }
      break;
    }
  }
}

// --- arps -----------------------------------------------------------------------------------------------------

export function arp(rig: Rig, voice: ArpVoice, t: number, midi: number, dur: number, vel: number): void {
  const { ctx } = rig;
  const f = mtof(midi);
  const g = ctx.createGain();
  switch (voice) {
    case 'square-arp':
    case 'pluck-arp':
    case 'acid-arp': {
      const type: OscillatorType = voice === 'square-arp' ? 'square' : 'sawtooth';
      const o = osc(ctx, type, f);
      const q = voice === 'acid-arp' ? 11 : voice === 'square-arp' ? 3 : 2;
      const top = voice === 'acid-arp' ? 3200 : voice === 'square-arp' ? 3400 : 5200;
      const filt = lp(ctx, 600, q);
      filt.frequency.setValueAtTime(top * (0.6 + 0.4 * vel), t);
      filt.frequency.setTargetAtTime(voice === 'acid-arp' ? 420 : 700, t, voice === 'pluck-arp' ? 0.07 : 0.05);
      const end = perc(g.gain, t, (voice === 'acid-arp' ? 0.07 : 0.06) * vel, Math.max(0.12, dur * 0.12 + 0.12));
      o.connect(filt).connect(g).connect(rig.out);
      o.start(t);
      o.stop(end);
      break;
    }
    case 'spiccato': {
      const a = osc(ctx, 'sawtooth', f, -6);
      const b = osc(ctx, 'sawtooth', f, 6);
      const filt = lp(ctx, 2300, 0.8);
      const end = adsr(g.gain, t, 0.06 * vel, 0.012, 0.12, 0.25, 0.1, 0.18);
      a.connect(filt);
      b.connect(filt);
      filt.connect(g).connect(rig.out);
      for (const o of [a, b]) {
        o.start(t);
        o.stop(end);
      }
      break;
    }
    case 'bell': {
      // two-operator FM: a 3.5× modulator whose index decays, the classic soft glassy bell
      const car = osc(ctx, 'sine', f);
      const mod = osc(ctx, 'sine', f * 3.5);
      const idx = ctx.createGain();
      idx.gain.setValueAtTime(f * 1.6, t);
      idx.gain.setTargetAtTime(f * 0.1, t, 0.25);
      mod.connect(idx).connect(car.frequency);
      const end = perc(g.gain, t, 0.09 * vel, 2.4, 0.003);
      car.connect(g).connect(rig.out);
      for (const o of [car, mod]) {
        o.start(t);
        o.stop(end);
      }
      break;
    }
  }
}

// --- leads ----------------------------------------------------------------------------------------------------

export function lead(rig: Rig, voice: LeadVoice, t: number, midi: number, dur: number, vel: number): void {
  const { ctx } = rig;
  const f = mtof(midi);
  const g = ctx.createGain();
  const vib = osc(ctx, 'sine', 5.4);
  const vibDepth = ctx.createGain();
  vibDepth.gain.setValueAtTime(0, t);
  vibDepth.gain.linearRampToValueAtTime(voice === 'stab' ? 0 : voice === 'horn' ? 5 : 9, t + Math.min(0.35, dur * 0.6));
  vib.connect(vibDepth);
  let end: number;
  const oscs: OscillatorNode[] = [];
  switch (voice) {
    case 'saw-lead': {
      const filt = lp(ctx, 2800, 2);
      oscs.push(osc(ctx, 'sawtooth', f, -7), osc(ctx, 'square', f, 7));
      oscs.forEach((o) => o.connect(filt));
      end = adsr(g.gain, t, 0.065 * vel, 0.015, 0.3, 0.75, dur, 0.18);
      filt.connect(g);
      break;
    }
    case 'whistle': {
      const filt = lp(ctx, 4200, 1);
      oscs.push(osc(ctx, 'triangle', f), osc(ctx, 'sine', f * 2));
      oscs[1]!.detune.value = 3;
      const h = ctx.createGain();
      h.gain.value = 0.18;
      oscs[0]!.connect(filt);
      oscs[1]!.connect(h).connect(filt);
      end = adsr(g.gain, t, 0.11 * vel, 0.02, 0.15, 0.8, dur, 0.1);
      filt.connect(g);
      break;
    }
    case 'stab': {
      const filt = lp(ctx, 900, 5);
      filt.frequency.setValueAtTime(4200, t);
      filt.frequency.setTargetAtTime(700, t, 0.08);
      oscs.push(osc(ctx, 'sawtooth', f, -12), osc(ctx, 'sawtooth', f, 12), osc(ctx, 'square', f / 2));
      oscs.forEach((o) => o.connect(filt));
      end = adsr(g.gain, t, 0.06 * vel, 0.004, 0.2, 0.4, dur, 0.12);
      filt.connect(g);
      break;
    }
    case 'horn': {
      const filt = lp(ctx, 500, 1.2);
      filt.frequency.setValueAtTime(500, t);
      filt.frequency.linearRampToValueAtTime(1700, t + 0.18);
      filt.frequency.setTargetAtTime(1200, t + 0.2, 0.4);
      oscs.push(osc(ctx, 'sawtooth', f, -4), osc(ctx, 'sawtooth', f, 4));
      oscs.forEach((o) => o.connect(filt));
      end = adsr(g.gain, t, 0.07 * vel, 0.09, 0.4, 0.85, dur, 0.35);
      filt.connect(g);
      break;
    }
    case 'flute': {
      const filt = lp(ctx, 3000, 0.7);
      oscs.push(osc(ctx, 'sine', f), osc(ctx, 'triangle', f));
      const tri = ctx.createGain();
      tri.gain.value = 0.3;
      oscs[0]!.connect(filt);
      oscs[1]!.connect(tri).connect(filt);
      end = adsr(g.gain, t, 0.09 * vel, 0.12, 0.3, 0.85, dur, 0.4);
      filt.connect(g);
      // breath
      noiseHit(rig, t, 0.25, 'bandpass', f * 2, 2, 0.012 * vel, 0.2, 0.05);
      break;
    }
  }
  for (const o of oscs) {
    vibDepth.connect(o.detune);
    o.start(t);
    o.stop(end);
  }
  vib.start(t);
  vib.stop(end);
  g.connect(rig.out);
}

// --- drums ----------------------------------------------------------------------------------------------------

function kick(rig: Rig, t: number, vel: number, kit: Kit): void {
  const { ctx } = rig;
  const o = osc(ctx, 'sine', 50);
  const g = ctx.createGain();
  const top = kit === 'synthwave' ? 130 : kit === 'soft' ? 110 : 165;
  const bottom = kit === 'techno' ? 44 : 48;
  const decay = kit === 'synthwave' ? 0.42 : kit === 'techno' ? 0.38 : kit === 'soft' ? 0.35 : 0.3;
  o.frequency.setValueAtTime(top, t);
  o.frequency.exponentialRampToValueAtTime(bottom, t + 0.07);
  const end = perc(g.gain, t, (kit === 'soft' ? 0.45 : 0.75) * vel, decay, 0.001);
  o.connect(g).connect(rig.out);
  o.start(t);
  o.stop(end);
  // beater click
  if (kit !== 'soft') noiseHit(rig, t, 0.02, 'highpass', 3000, 0.7, 0.12 * vel, 0.012);
}

function snare(rig: Rig, t: number, vel: number, kit: Kit): void {
  const { ctx } = rig;
  const big = kit === 'synthwave';
  noiseHit(rig, t, big ? 0.5 : 0.25, 'bandpass', 1900, 0.7, 0.32 * vel, big ? 0.32 : 0.17);
  noiseHit(rig, t, 0.15, 'highpass', 5000, 0.7, 0.12 * vel, 0.09);
  const o = osc(ctx, 'triangle', 185);
  o.frequency.setValueAtTime(220, t);
  o.frequency.exponentialRampToValueAtTime(170, t + 0.05);
  const g = ctx.createGain();
  const end = perc(g.gain, t, 0.25 * vel, 0.1);
  o.connect(g).connect(rig.out);
  o.start(t);
  o.stop(end);
}

function clap(rig: Rig, t: number, vel: number): void {
  for (let i = 0; i < 3; i++) noiseHit(rig, t + i * 0.011, 0.03, 'bandpass', 1300, 1.2, 0.22 * vel, 0.02, 0.0005);
  noiseHit(rig, t + 0.033, 0.3, 'bandpass', 1200, 0.9, 0.2 * vel, 0.16);
}

function tonal(rig: Rig, t: number, vel: number, f0: number, f1: number, decay: number, peak: number, noise: number): void {
  const { ctx } = rig;
  const o = osc(ctx, 'sine', f0);
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(f1, t + decay * 0.6);
  const g = ctx.createGain();
  const end = perc(g.gain, t, peak * vel, decay);
  o.connect(g).connect(rig.out);
  o.start(t);
  o.stop(end);
  if (noise > 0) noiseHit(rig, t, decay, 'lowpass', 900, 0.7, noise * vel, decay * 0.4);
}

export function drum(rig: Rig, kit: Kit, kind: DrumKind, t: number, vel: number): void {
  switch (kind) {
    case 'kick':
      return kick(rig, t, vel, kit);
    case 'snare':
      return snare(rig, t, vel, kit);
    case 'clap':
      return clap(rig, t, vel);
    case 'hat':
      return noiseHit(rig, t, 0.08, 'highpass', 8000, 0.8, 0.13 * vel, 0.035);
    case 'openhat':
      return noiseHit(rig, t, 0.4, 'highpass', 7500, 0.8, 0.1 * vel, 0.28);
    case 'ride':
      noiseHit(rig, t, 0.5, 'bandpass', 9000, 1.5, 0.06 * vel, 0.4);
      return noiseHit(rig, t, 0.05, 'highpass', 6000, 0.7, 0.05 * vel, 0.02);
    case 'shaker':
      return noiseHit(rig, t, 0.1, 'bandpass', 6000, 1.1, 0.12 * vel, 0.05, 0.012);
    case 'tamb':
      noiseHit(rig, t, 0.25, 'bandpass', 9500, 2.5, 0.12 * vel, 0.16, 0.002);
      return noiseHit(rig, t + 0.018, 0.2, 'bandpass', 8000, 2.5, 0.06 * vel, 0.12, 0.002);
    case 'rim':
      tonal(rig, t, vel, 1700, 1600, 0.03, 0.12, 0);
      return noiseHit(rig, t, 0.03, 'bandpass', 3500, 2, 0.08 * vel, 0.015);
    case 'tom':
      return tonal(rig, t, vel, kit === 'taiko' ? 120 : 150, kit === 'taiko' ? 85 : 95, 0.45, 0.45, 0.08);
    case 'taiko':
      return tonal(rig, t, vel, 95, 52, 0.9, 0.8, 0.35);
  }
}
