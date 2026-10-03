/**
 * River flow from the generator's own water surface (docs/12): water runs down the surface the generator built
 * (rivers follow the low-pass height, the Alpine stream the valley floor), along the channel — the component across
 * the channel (towards the banks, where the water gets shallow) is dropped. Lakes are flat: no flow, only ripples.
 *
 * Works on a chunk's water mesh (positions on the terrain grid, triangle indices) and the water depth at each
 * vertex; returns a flow vector (m/s, x and z) per vertex. Pure.
 */

/** surface slope → speed: a 1 ‰ river runs ~0.3 m/s, the steep Alpine stream up to MAX_FLOW */
const SPEED_PER_SLOPE = 300;
export const MIN_FLOW = 0.25;
export const MAX_FLOW = 1.6;
/** below this slope (flat lakes, the City river) the water does not flow */
export const FLAT_SLOPE = 2e-4;
/** water shallower than this (m) is bank, not channel: left out of the surface gradient */
const WET = 0.15;

/**
 * Per-vertex flow (vx, vz in m/s) of a water mesh: `pos` xyz triples, `index` triangles, `depth` water depth per
 * vertex (m). `out` (2 per vertex) is filled and returned.
 */
export function waterFlow(pos: ArrayLike<number>, index: ArrayLike<number>, depth: ArrayLike<number>, out = new Float32Array((pos.length / 3) * 2)): Float32Array {
  const n = pos.length / 3;
  // per-vertex accumulated gradients of the surface (gy) and of the depth (gd), area weighted
  const gy = new Float64Array(n * 2);
  const gd = new Float64Array(n * 2);
  const w = new Float64Array(n);
  for (let t = 0; t + 2 < index.length; t += 3) {
    const a = index[t]!;
    const b = index[t + 1]!;
    const c = index[t + 2]!;
    if (depth[a]! < WET || depth[b]! < WET || depth[c]! < WET) continue;
    const ax = pos[a * 3]!, az = pos[a * 3 + 2]!;
    const bx = pos[b * 3]! - ax, bz = pos[b * 3 + 2]! - az;
    const cx = pos[c * 3]! - ax, cz = pos[c * 3 + 2]! - az;
    const det = bx * cz - bz * cx;
    if (Math.abs(det) < 1e-9) continue;
    // plane through the three values: f = f0 + gx·x + gz·z
    const grad = (fa: number, fb: number, fc: number, o: Float64Array): void => {
      const db = fb - fa;
      const dc = fc - fa;
      o[0] = (db * cz - dc * bz) / det;
      o[1] = (dc * bx - db * cx) / det;
    };
    grad(pos[a * 3 + 1]!, pos[b * 3 + 1]!, pos[c * 3 + 1]!, tmpY);
    grad(depth[a]!, depth[b]!, depth[c]!, tmpD);
    const area = Math.abs(det) * 0.5;
    for (const v of [a, b, c]) {
      gy[v * 2] = gy[v * 2]! + tmpY[0]! * area;
      gy[v * 2 + 1] = gy[v * 2 + 1]! + tmpY[1]! * area;
      gd[v * 2] = gd[v * 2]! + tmpD[0]! * area;
      gd[v * 2 + 1] = gd[v * 2 + 1]! + tmpD[1]! * area;
      w[v] = w[v]! + area;
    }
  }
  for (let v = 0; v < n; v++) {
    out[v * 2] = 0;
    out[v * 2 + 1] = 0;
    const wv = w[v]!;
    if (wv <= 0) continue;
    const sx = gy[v * 2]! / wv;
    const sz = gy[v * 2 + 1]! / wv;
    // across the channel: the depth gradient's direction; keep only the surface slope along it
    let nx = gd[v * 2]! / wv;
    let nz = gd[v * 2 + 1]! / wv;
    const nl = Math.sqrt(nx * nx + nz * nz);
    let tx = -sx;
    let tz = -sz;
    if (nl > 1e-6) {
      nx /= nl;
      nz /= nl;
      const k = tx * nx + tz * nz;
      tx -= k * nx;
      tz -= k * nz;
    }
    const slope = Math.sqrt(tx * tx + tz * tz);
    if (slope < FLAT_SLOPE) continue;
    const speed = Math.min(MAX_FLOW, Math.max(MIN_FLOW, slope * SPEED_PER_SLOPE));
    out[v * 2] = (tx / slope) * speed;
    out[v * 2 + 1] = (tz / slope) * speed;
  }
  return out;
}

const tmpY = new Float64Array(2);
const tmpD = new Float64Array(2);

/** The City's river has a level surface; it is drawn flowing south (+Z) at this speed (m/s). */
export const CITY_RIVER_FLOW: readonly [number, number] = [0, 0.7];
