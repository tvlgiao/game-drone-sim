/**
 * Generator v2 additions to chunk meshes (v1 meshes are untouched): village ground as garden parcels that fade
 * into the surrounding grass (no dry halo), sand and gravel on river banks, per-vertex surface weights
 * (rock, bank) for the renderer, and a continuous water surface that extends one quad under the banks so the
 * shoreline is where the terrain meets the water, not a quad staircase.
 */
import { clamp, mix, smoothstep } from './math';
import { noise } from './noise';
import { hash2, subSeed, u01 } from './rng';
import { BIOME, type BiomeSample } from './terrain-field';
import { PARCEL } from './scatter-v2';

/** channels of `ChunkData.surface` per vertex */
export const SURFACE_STRIDE = 2;
export const SURFACE_ROCK = 0;
export const SURFACE_BANK = 1;
/** a bank is this many metres of terrain above the water surface */
export const BANK_HEIGHT = 2.2;
const SALT_ROCK_NOISE = 73;
const SALT_PARCEL = 74;

const LUSH = [0x4f, 0x8a, 0x3c];
const SAND = [0xb9, 0xab, 0x86];
const GRAVEL = [0x8e, 0x88, 0x7a];
/** lawn, vegetable soil, long grass, orchard, gravel yard */
const PARCELS: readonly (readonly [number, number, number])[] = [
  [0x5f, 0x8a, 0x3a],
  [0x76, 0x60, 0x46],
  [0x6f, 0x96, 0x45],
  [0x55, 0x7c, 0x38],
  [0x97, 0x8e, 0x76],
];

/**
 * Recolours one vertex (3 bytes at `o`) for v2 and returns its surface weights: village plateaus become garden
 * parcels blended into lush grass by the village weight; meadows near villages lose the dry tint; banks get
 * sand / gravel.
 */
export function shadeV2(b: BiomeSample, seed: number, wx: number, wz: number, waterSurface: number, out: Uint8Array, o: number, surface: Uint8Array, so: number): void {
  let r = out[o]!;
  let g = out[o + 1]!;
  let bl = out[o + 2]!;
  const vw = b.village;
  if (vw > 0 && b.biome !== BIOME.road && b.biome !== BIOME.water) {
    // dry meadow in the blend ring turns lush: no pale halo around the village
    if (b.biome === BIOME.meadow) {
      const lush = smoothstep(0, 0.6, vw) * 0.6;
      r = mix(r, LUSH[0]!, lush);
      g = mix(g, LUSH[1]!, lush);
      bl = mix(bl, LUSH[2]!, lush);
    }
    const p = Math.floor(wx / PARCEL);
    const q = Math.floor(wz / PARCEL);
    const hp = hash2(seed, p, q, SALT_PARCEL);
    const kind = Math.floor(u01(hp) * PARCELS.length);
    let c = PARCELS[kind]!;
    // vegetable gardens: soil rows 1.5 m apart
    if (kind === 1 && Math.floor((u01(hp) > 0.1 ? wx : wz) / 1.5) % 2 === 0) c = [0x5e, 0x7a, 0x3e];
    const t = smoothstep(0.35, 0.85, vw);
    r = mix(r, c[0]!, t);
    g = mix(g, c[1]!, t);
    bl = mix(bl, c[2]!, t);
  }
  let bank = 0;
  if (waterSurface > -Infinity) {
    const above = b.height - waterSurface;
    bank = above <= 0 ? 1 : 1 - smoothstep(0, BANK_HEIGHT, above);
    if (b.biome !== BIOME.road && above > -0.4) {
      const gravel = u01(hash2(seed, Math.floor(wx / 3), Math.floor(wz / 3), SALT_PARCEL + 1)) < 0.4 ? GRAVEL : SAND;
      const k = bank * 0.85;
      r = mix(r, gravel[0]!, k);
      g = mix(g, gravel[1]!, k);
      bl = mix(bl, gravel[2]!, k);
    }
  }
  out[o] = clamp(Math.floor(r), 0, 255);
  out[o + 1] = clamp(Math.floor(g), 0, 255);
  out[o + 2] = clamp(Math.floor(bl), 0, 255);
  const rn = noise(subSeed(seed, SALT_ROCK_NOISE), wx * (1 / 23), wz * (1 / 23));
  const rock = clamp(smoothstep(0.7, 1.15, b.slope) + 0.25 * rn, 0, 1) * (1 - b.snow);
  surface[so + SURFACE_ROCK] = Math.round(rock * 255);
  surface[so + SURFACE_BANK] = Math.round(bank * 255);
}

/**
 * Continuous water for a chunk grid: every quad with a wet corner, dilated by one quad, so the surface runs
 * under the banks and the terrain draws the shoreline. Vertices take the local water surface where one is
 * defined (rivers and lakes follow the carved bed), else the level of the wet quad they border.
 */
export function waterMeshV2(n: number, step: number, cand: Float64Array, ground: (v: number) => number): { positions: number[]; indices: number[] } {
  const side = n + 1;
  const wet = (v: number): boolean => cand[v]! > ground(v);
  const level = new Float64Array(n * n).fill(-Infinity);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * side + i;
      let l = -Infinity;
      for (const q of [a, a + 1, a + side, a + side + 1]) if (wet(q) && cand[q]! > l) l = cand[q]!;
      level[j * n + i] = l;
    }
  }
  const quadLevel = new Float64Array(n * n).fill(-Infinity);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      let l = -Infinity;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ii = i + di;
          const jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
          if (level[jj * n + ii]! > l) l = level[jj * n + ii]!;
        }
      }
      quadLevel[j * n + i] = l;
    }
  }
  const positions: number[] = [];
  const indices: number[] = [];
  const map = new Int32Array(side * side).fill(-1);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const ql = quadLevel[j * n + i]!;
      if (ql === -Infinity) continue;
      const a = j * side + i;
      const ids: number[] = [];
      for (const q of [a, a + 1, a + side, a + side + 1]) {
        let id = map[q]!;
        if (id < 0) {
          id = positions.length / 3;
          map[q] = id;
          const c = cand[q]!;
          // no water body here: dip the surface under the ground, so the shoreline crosses the quad smoothly
          const y = c > -Infinity && Math.abs(c - ql) < 1.5 ? c : Math.min(ql, ground(q) - 0.5);
          positions.push((q % side) * step, y, Math.floor(q / side) * step);
        }
        ids.push(id);
      }
      indices.push(ids[0]!, ids[2]!, ids[1]!, ids[1]!, ids[2]!, ids[3]!);
    }
  }
  return { positions, indices };
}
