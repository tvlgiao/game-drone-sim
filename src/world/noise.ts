/**
 * 2D gradient noise (Perlin-style, 8 literal unit gradients, quintic fade) with analytic derivatives, plus
 * the fractal sums built on it. Arithmetic only (see math.ts); inputs are in lattice units.
 */

/** Value and partial derivatives (per lattice unit) of a noise evaluation. */
export interface NoiseSample {
  v: number;
  dx: number;
  dz: number;
}

/** Fractal sum result: `v` all octaves, `lp` the two lowest octaves only (low-pass). */
export interface FbmSample {
  v: number;
  lp: number;
}

export function noiseSample(): NoiseSample {
  return { v: 0, dx: 0, dz: 0 };
}

export function fbmSample(): FbmSample {
  return { v: 0, lp: 0 };
}

const S = 0.7071067811865476;
const GX = [1, -1, 0, 0, S, -S, S, -S];
const GZ = [0, 0, 1, -1, S, S, -S, -S];
/** Scales the ±√½ range of 2D gradient noise to about ±1. */
const AMP = 1.4142135623730951;

function grad(seed: number, ix: number, iz: number): number {
  let h = (Math.imul(ix, 0x8da6b343) ^ Math.imul(iz, 0xd8163841) ^ seed) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return h & 7;
}

/** Gradient noise with derivative; `out.v` is roughly in [−1, 1]. */
export function noised(seed: number, x: number, z: number, out: NoiseSample): NoiseSample {
  // Gradient noise is 0 on lattice points; a per-seed shift keeps the origin (and every octave's
  // rotated origin) from having the same height in every world.
  x += ((seed >>> 12) & 0xfff) * 0.0137 + 0.371;
  z += (seed & 0xfff) * 0.0119 + 0.587;
  const fx0 = Math.floor(x);
  const fz0 = Math.floor(z);
  const ix = fx0 | 0;
  const iz = fz0 | 0;
  const fx = x - fx0;
  const fz = z - fz0;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const w = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const du = 30 * fx * fx * (fx * (fx - 2) + 1);
  const dw = 30 * fz * fz * (fz * (fz - 2) + 1);

  const g00 = grad(seed, ix, iz);
  const g10 = grad(seed, ix + 1, iz);
  const g01 = grad(seed, ix, iz + 1);
  const g11 = grad(seed, ix + 1, iz + 1);
  const ax = GX[g00]!, az = GZ[g00]!;
  const bx = GX[g10]!, bz = GZ[g10]!;
  const cx = GX[g01]!, cz = GZ[g01]!;
  const ex = GX[g11]!, ez = GZ[g11]!;

  const a = ax * fx + az * fz;
  const b = bx * (fx - 1) + bz * fz;
  const c = cx * fx + cz * (fz - 1);
  const d = ex * (fx - 1) + ez * (fz - 1);
  const k1 = b - a;
  const k2 = c - a;
  const k3 = a - b - c + d;

  out.v = AMP * (a + u * k1 + w * k2 + u * w * k3);
  out.dx = AMP * (ax + u * (bx - ax) + w * (cx - ax) + u * w * (ax - bx - cx + ex) + du * (k1 + w * k3));
  out.dz = AMP * (az + u * (bz - az) + w * (cz - az) + u * w * (az - bz - cz + ez) + dw * (k2 + u * k3));
  return out;
}

const scratch = noiseSample();

/** Gradient noise value only. */
export function noise(seed: number, x: number, z: number): number {
  return noised(seed, x, z, scratch).v;
}

/** Octave rotation (0.8, −0.6; 0.6, 0.8) — breaks lattice alignment between octaves. */
const R00 = 0.8, R01 = -0.6, R10 = 0.6, R11 = 0.8;

/** Plain fBm, normalised to about [−1, 1]. Lacunarity 2, gain 0.5. */
export function fbm(seed: number, x: number, z: number, octaves: number): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let px = x;
  let pz = z;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noised((seed + Math.imul(i, 0x632be5ab)) | 0, px, pz, scratch).v;
    norm += amp;
    amp *= 0.5;
    const nx = 2 * (R00 * px + R01 * pz);
    pz = 2 * (R10 * px + R11 * pz);
    px = nx;
  }
  return sum / norm;
}

/**
 * Derivative-damped fBm: each octave is divided by `1 + |Σ gradients|²`, which flattens valley floors and
 * keeps steep flanks from collecting more detail (erosion-like). Normalised to about [−1, 1].
 */
export function fbmDamped(seed: number, x: number, z: number, octaves: number, out: FbmSample): FbmSample {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let gx = 0;
  let gz = 0;
  let px = x;
  let pz = z;
  let lp = 0;
  let lpNorm = 1;
  for (let i = 0; i < octaves; i++) {
    noised((seed + Math.imul(i, 0x632be5ab)) | 0, px, pz, scratch);
    gx += scratch.dx;
    gz += scratch.dz;
    sum += (amp * scratch.v) / (1 + gx * gx + gz * gz);
    norm += amp;
    if (i === 1) {
      lp = sum;
      lpNorm = norm;
    }
    amp *= 0.5;
    const nx = 2 * (R00 * px + R01 * pz);
    pz = 2 * (R10 * px + R11 * pz);
    px = nx;
  }
  out.v = sum / norm;
  out.lp = octaves > 1 ? lp / lpNorm : out.v;
  return out;
}

/**
 * Ridged multifractal in [0, 1]: octaves of `(1 − |n|)²`, each weighted by the previous one so ridges get
 * the detail and valleys stay smooth.
 */
export function ridged(seed: number, x: number, z: number, octaves: number, out: FbmSample, gain = 0.5): FbmSample {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let weight = 1;
  let px = x;
  let pz = z;
  let lp = 0;
  let lpNorm = 1;
  for (let i = 0; i < octaves; i++) {
    const n = noised((seed + Math.imul(i, 0x1b873593)) | 0, px, pz, scratch).v;
    let r = 1 - Math.abs(n);
    r *= r;
    r *= weight;
    weight = r * 1.6;
    if (weight > 1) weight = 1;
    sum += r * amp;
    norm += amp;
    if (i === 1) {
      lp = sum;
      lpNorm = norm;
    }
    amp *= gain;
    const nx = 2 * (R00 * px + R01 * pz);
    pz = 2 * (R10 * px + R11 * pz);
    px = nx;
  }
  out.v = sum / norm;
  out.lp = octaves > 1 ? lp / lpNorm : out.v;
  return out;
}

/** Domain warp: shifts (x, z) by up to `amp` metres using two noise samples of wavelength `wavelength` m. */
export function warp(seedX: number, seedZ: number, x: number, z: number, amp: number, wavelength: number, out: { x: number; z: number }): void {
  const inv = 1 / wavelength;
  out.x = x + amp * noise(seedX, x * inv, z * inv);
  out.z = z + amp * noise(seedZ, x * inv, z * inv);
}
