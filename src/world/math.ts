/**
 * Arithmetic-only helpers for the world generator. Everything here uses `+ - * /`, `Math.sqrt`,
 * `Math.floor`, `Math.abs`, `Math.min` and `Math.max` only, so results are bit-identical in every JS
 * engine (IEEE-754 doubles, round to nearest, no fused multiply-add). Trigonometry is a fixed polynomial
 * instead of the engine's `Math` functions, which are not required to be correctly rounded.
 */

export const PI = 3.141592653589793;
export const TAU = 6.283185307179586;
const HALF_PI = 1.5707963267948966;
const HALF_PI_LO = 6.123233995736766e-17;
const INV_HALF_PI = 0.6366197723675814;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Polynomial smooth minimum (k = blend width in metres). Its gradient is a convex combination of the
 * gradients of `a` and `b`, so it never steepens terrain beyond the steeper input.
 */
export function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/** Smooth maximum, the mirror of {@link smin}. */
export function smax(a: number, b: number, k: number): number {
  return -smin(-a, -b, k);
}

function sinPoly(r: number): number {
  const r2 = r * r;
  return r * (1 + r2 * (-1 / 6 + r2 * (1 / 120 + r2 * (-1 / 5040 + r2 * (1 / 362880 + r2 * (-1 / 39916800 + r2 * (1 / 6227020800)))))));
}

function cosPoly(r: number): number {
  const r2 = r * r;
  return 1 + r2 * (-1 / 2 + r2 * (1 / 24 + r2 * (-1 / 720 + r2 * (1 / 40320 + r2 * (-1 / 3628800 + r2 * (1 / 479001600 + r2 * (-1 / 87178291200)))))));
}

/** Deterministic sine (abs error < 1e-13 for |x| < 1e4). */
export function dsin(x: number): number {
  const k = Math.floor(x * INV_HALF_PI + 0.5);
  const r = x - k * HALF_PI - k * HALF_PI_LO;
  switch (k & 3) {
    case 0:
      return sinPoly(r);
    case 1:
      return cosPoly(r);
    case 2:
      return -sinPoly(r);
    default:
      return -cosPoly(r);
  }
}

/** Deterministic cosine, see {@link dsin}. */
export function dcos(x: number): number {
  return dsin(x + HALF_PI);
}

const TAN_PI_12 = 0.2679491924311227;
const INV_SQRT3 = 0.5773502691896258;
const PI_6 = 0.5235987755982988;

function atanSmall(x: number): number {
  const x2 = x * x;
  let s = 1 / 17;
  for (let k = 15; k >= 1; k -= 2) s = 1 / k - x2 * s;
  return x * s;
}

/** Deterministic arctangent (abs error < 1e-12). */
export function datan(x: number): number {
  const neg = x < 0;
  let a = neg ? -x : x;
  let base = 0;
  let inv = false;
  if (a > 1) {
    a = 1 / a;
    inv = true;
  }
  if (a > TAN_PI_12) {
    a = (a - INV_SQRT3) / (1 + a * INV_SQRT3);
    base = PI_6;
  }
  let r = base + atanSmall(a);
  if (inv) r = HALF_PI - r;
  return neg ? -r : r;
}

/** Deterministic `atan2(y, x)` in (−π, π]. */
export function datan2(y: number, x: number): number {
  if (x > 0) return datan(y / x);
  if (x < 0) return y >= 0 ? datan(y / x) + PI : datan(y / x) - PI;
  if (y > 0) return HALF_PI;
  if (y < 0) return -HALF_PI;
  return 0;
}

/**
 * Yaw (rotation about +Y, three.js `Object3D.rotation.y` convention) that turns the drone's forward axis
 * (−Z) to point along (dx, dz).
 */
export function yawFacing(dx: number, dz: number): number {
  return datan2(-dx, -dz);
}

/** Squared distance from (px, pz) to segment a→b. */
export function segDist2(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const ex = bx - ax;
  const ez = bz - az;
  const l2 = ex * ex + ez * ez;
  let t = l2 > 0 ? ((px - ax) * ex + (pz - az) * ez) / l2 : 0;
  t = clamp(t, 0, 1);
  const dx = px - ax - ex * t;
  const dz = pz - az - ez * t;
  return dx * dx + dz * dz;
}

/** Bounded least-recently-used map. Contents are pure functions of the key, so eviction never changes results. */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>();

  constructor(readonly capacity: number) {}

  get size(): number {
    return this.map.size;
  }

  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.capacity) {
      const oldest = this.map.keys().next();
      if (!oldest.done) this.map.delete(oldest.value);
    }
    this.map.set(key, value);
  }

  getOrCreate(key: K, make: () => V): V {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const v = make();
    this.set(key, v);
    return v;
  }
}

/** Integer cell key for a 2D grid (|i|, |j| < 2^20 — the 50 km world cap keeps far inside it). */
export function cellKey(i: number, j: number): number {
  return (i + 1048576) * 2097152 + (j + 1048576);
}
