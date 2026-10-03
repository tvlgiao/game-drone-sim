/** Deterministic, tileable noise for the procedural texture generators (pure math: runs in workers and tests). */

/** mulberry32: a fast 32-bit seeded generator, 0 ≤ x < 1. */
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

/** Integer lattice hash → 0..1. */
export function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const wrap = (i: number, p: number): number => ((i % p) + p) % p;
const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

/**
 * Value noise on a lattice that repeats every `period` cells, so a texture sampled over
 * x, y ∈ [0, period) tiles seamlessly.
 */
export function tileNoise(x: number, y: number, period: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = fade(x - ix);
  const fy = fade(y - iy);
  const x0 = wrap(ix, period);
  const y0 = wrap(iy, period);
  const x1 = wrap(ix + 1, period);
  const y1 = wrap(iy + 1, period);
  const a = hash2(x0, y0, seed);
  const b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed);
  const d = hash2(x1, y1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/**
 * Tileable fractal noise, 0..1: `u, v` in [0, 1) map onto `period` lattice cells at the base octave;
 * each octave doubles the period, so every octave still tiles.
 */
export function tileFbm(u: number, v: number, period: number, octaves: number, seed: number, gain = 0.5): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let p = period;
  for (let o = 0; o < octaves; o++) {
    sum += amp * tileNoise(u * p, v * p, p, seed + o * 1013);
    norm += amp;
    amp *= gain;
    p *= 2;
  }
  return sum / norm;
}

/** Distance to the nearest of `period²` jittered points (tileable cellular noise), plus that cell's id hash. */
export function tileCells(u: number, v: number, period: number, seed: number): { d: number; id: number } {
  const x = u * period;
  const y = v * period;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let best = 9;
  let id = 0;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const cx = ix + ox;
      const cy = iy + oy;
      const wx = wrap(cx, period);
      const wy = wrap(cy, period);
      const px = cx + hash2(wx, wy, seed);
      const py = cy + hash2(wx, wy, seed + 7);
      const d = (px - x) * (px - x) + (py - y) * (py - y);
      if (d < best) {
        best = d;
        id = hash2(wx, wy, seed + 13);
      }
    }
  }
  return { d: Math.sqrt(best), id };
}

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
export const smooth = (e0: number, e1: number, x: number): number => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
export const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
