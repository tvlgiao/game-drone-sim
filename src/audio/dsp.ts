/**
 * Sample-level generators (pure, deterministic from a seed): noise colours, procedural impulse responses for
 * the per-environment reverbs, and the tail fold that makes rendered music loops seamless.
 */

/** mulberry32: small, fast, deterministic. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type NoiseColour = 'white' | 'pink' | 'brown';

/** `n` samples of noise, roughly ±1 peak. Pink: Paul Kellet's refined filter; brown: leaky integrator. */
export function noise(n: number, colour: NoiseColour, seed = 1): Float32Array<ArrayBuffer> {
  const r = rng(seed);
  const d = new Float32Array(n);
  let b0 = 0,
    b1 = 0,
    b2 = 0,
    b3 = 0,
    b4 = 0,
    b5 = 0,
    b6 = 0;
  let last = 0;
  for (let i = 0; i < n; i++) {
    const w = r() * 2 - 1;
    if (colour === 'white') d[i] = w * 0.7;
    else if (colour === 'pink') {
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    } else {
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    }
  }
  // loop seam: a short crossfade of the end into the start, so a looping noise bed never clicks
  const fade = Math.min(n >> 3, 2048);
  for (let i = 0; i < fade; i++) {
    const k = i / fade;
    d[i] = d[i]! * k + d[n - fade + i]! * (1 - k);
  }
  return n > fade ? d.subarray(0, n - fade).slice() : d;
}

/** Reverb characters, one per environment. */
export type ReverbKind = 'loft' | 'city' | 'open' | 'valley' | 'hall';

export interface IrSpec {
  /** RT60 of the diffuse tail (s) */
  rt60: number;
  /** pre-delay before the tail (s) */
  pre: number;
  /** discrete early reflections: [delay s, gain, pan −1..1] */
  taps: readonly (readonly [number, number, number])[];
  /** tail level */
  tail: number;
  /** high-frequency damping 0..1 (1 = dark) */
  damp: number;
  /** IR length (s) */
  length: number;
}

/**
 * Reverb shapes: the loft is a brick-and-timber room (~1.1 s, dense early field); the city is a street
 * canyon (strong slapback off the facing towers at 70–180 ms, short diffuse tail); open fields barely
 * reverberate (ground bounce + faint tree line); the alpine valley echoes off the far slopes.
 */
export const IR_SPECS: Readonly<Record<ReverbKind, IrSpec>> = {
  loft: { rt60: 1.15, pre: 0.008, taps: [[0.011, 0.5, -0.4], [0.017, 0.42, 0.5], [0.023, 0.35, -0.7], [0.031, 0.3, 0.3], [0.042, 0.24, 0.8], [0.053, 0.2, -0.2]], tail: 0.55, damp: 0.55, length: 1.6 },
  city: { rt60: 0.9, pre: 0.02, taps: [[0.072, 0.55, -0.8], [0.096, 0.45, 0.85], [0.141, 0.35, -0.5], [0.183, 0.28, 0.6], [0.262, 0.16, -0.2]], tail: 0.22, damp: 0.45, length: 1.2 },
  open: { rt60: 0.45, pre: 0.006, taps: [[0.006, 0.35, 0], [0.19, 0.06, -0.6], [0.31, 0.04, 0.7]], tail: 0.06, damp: 0.6, length: 0.7 },
  valley: { rt60: 1.6, pre: 0.01, taps: [[0.008, 0.3, 0], [0.42, 0.16, -0.7], [0.66, 0.11, 0.8], [0.93, 0.07, -0.3]], tail: 0.09, damp: 0.7, length: 1.9 },
  /** the soundtrack's own space (baked into the stems, never run live) */
  hall: { rt60: 2, pre: 0.025, taps: [[0.031, 0.25, -0.6], [0.047, 0.22, 0.6], [0.067, 0.18, -0.3], [0.089, 0.15, 0.4]], tail: 0.5, damp: 0.5, length: 2.4 },
};

/**
 * Stereo impulse response for `kind` at `sampleRate`: discrete taps plus exponentially decaying noise whose
 * high end darkens over time (one-pole low-pass sweeping down). `scale` < 1 shortens it (lite tier).
 */
export function impulseResponse(kind: ReverbKind, sampleRate: number, scale = 1, seed = 7): [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] {
  const s = IR_SPECS[kind];
  const len = Math.max(1, Math.floor(s.length * scale * sampleRate));
  const out: [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] = [new Float32Array(len), new Float32Array(len)];
  const decay = Math.log(1000) / (s.rt60 * scale);
  for (let ch = 0; ch < 2; ch++) {
    const r = rng(seed + ch * 101);
    const d = out[ch]!;
    let lp = 0;
    const pre = Math.floor(s.pre * sampleRate);
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / sampleRate;
      const env = Math.exp(-decay * t);
      // damping: coefficient falls from bright to dark over the tail
      const a = Math.min(0.98, 0.15 + s.damp * 0.8 * (1 - Math.exp(-t * 4)));
      lp = lp * a + (r() * 2 - 1) * (1 - a);
      // fade in over 4 ms so the tail does not click on
      const fadeIn = Math.min(1, t / 0.004);
      d[i] = lp * env * s.tail * fadeIn * 1.8;
    }
    for (const [dt, g, pan] of s.taps) {
      const i = Math.floor(dt * scale * sampleRate);
      if (i >= len) continue;
      const pg = ch === 0 ? Math.sqrt((1 - pan) / 2) : Math.sqrt((1 + pan) / 2);
      // a 3-sample smeared tap reads as a surface, not a digital click
      d[i] += g * pg * 0.6;
      if (i + 1 < len) d[i + 1]! += g * pg * 0.3;
      if (i + 2 < len) d[i + 2]! += g * pg * 0.1;
    }
  }
  // unit energy: a reverb send of 1 returns about the dry level, whatever the room's length
  let e = 0;
  for (const d of out) for (let i = 0; i < d.length; i++) e += d[i]! * d[i]!;
  const k = e > 0 ? 1 / Math.sqrt(e / 2) : 1;
  for (const d of out) for (let i = 0; i < d.length; i++) d[i]! *= k;
  return out;
}

/** RMS of a signal (linear). */
export function rms(data: Float32Array): number {
  let s = 0;
  for (let i = 0; i < data.length; i++) s += data[i]! * data[i]!;
  return data.length ? Math.sqrt(s / data.length) : 0;
}

/**
 * Gain that brings channels to `targetDb` RMS without their peak passing `ceilingDb` (sparse material —
 * a lone kick — reaches the ceiling before the target). 1 for silence.
 */
export function normalizeGain(chans: readonly Float32Array[], targetDb: number, ceilingDb = -3): number {
  let s = 0;
  let n = 0;
  let pk = 0;
  for (const d of chans) {
    for (let i = 0; i < d.length; i++) {
      const v = d[i]!;
      s += v * v;
      const a = Math.abs(v);
      if (a > pk) pk = a;
    }
    n += d.length;
  }
  const r = n ? Math.sqrt(s / n) : 0;
  if (r <= 1e-6 || pk <= 1e-6) return 1;
  return Math.min(Math.pow(10, targetDb / 20) / r, Math.pow(10, ceilingDb / 20) / pk);
}

/**
 * Seamless loop: the material rendered after `loopLen` (reverb / delay tails) is mixed back onto the start,
 * exactly what a looping player would have overlapped. Returns a copy `loopLen` long.
 */
export function foldTail(data: Float32Array, loopLen: number): Float32Array<ArrayBuffer> {
  const out = new Float32Array(loopLen);
  out.set(data.subarray(0, Math.min(loopLen, data.length)));
  for (let i = loopLen; i < data.length; i++) out[(i - loopLen) % loopLen]! += data[i]!;
  return out;
}

/** Peak absolute sample. */
export function peak(data: Float32Array): number {
  let p = 0;
  for (let i = 0; i < data.length; i++) {
    const a = Math.abs(data[i]!);
    if (a > p) p = a;
  }
  return p;
}
