/**
 * Generator v2 additions to chunk meshes (v1 meshes are untouched): macro colour variation of the ground (dry,
 * lush and dark patches at two scales, so distant land is never one tint), farmed land as irregular Voronoi fields
 * with crops, furrows and farm tracks, village gardens of the same kind (no plateau colour, no rim), sand and
 * gravel on river banks, per-vertex surface weights (rock, bank) for the renderer, and a continuous water surface
 * that extends one quad under the banks so the shoreline is where the terrain meets the water.
 */
import { CROP_COLOURS, FIELD_CELL, GARDEN_CELL, GARDEN_COLOURS, SALT_FIELDS, SALT_GARDENS, TRACK_COLOUR, cropOf, fieldWeight, onTrack, parcel, parcelAt } from './fields';
import { clamp, dcos, dsin, mix, PI, smoothstep } from './math';
import { noise } from './noise';
import { hash2, rehash, subSeed, u01 } from './rng';
import { BIOME, type BiomeSample } from './terrain-field';

/** channels of `ChunkData.surface` per vertex */
export const SURFACE_STRIDE = 2;
export const SURFACE_ROCK = 0;
export const SURFACE_BANK = 1;
/** a bank is this many metres of terrain above the water surface */
export const BANK_HEIGHT = 2.2;
const SALT_ROCK_NOISE = 73;
const SALT_PARCEL = 74;
const SALT_MACRO = 77;
const SALT_MACRO_FINE = 78;

const SAND = [0xb9, 0xab, 0x86];
/** grass verge between two parcels: a light seam, never the darker ground underneath */
const VERGE = [0x86, 0xa2, 0x55];
/** furrow / garden-row contrast per LOD: rows finer than the grid would only alias into a moiré */
export const ROW_CONTRAST: readonly number[] = [1, 0.5, 0];
const GRAVEL = [0x8e, 0x88, 0x7a];
const DRY = [0xa6, 0x9e, 0x5c];
const DARK = [0x3f, 0x66, 0x30];

const P = parcel();

/** Biomes whose ground colour varies in patches and can be farmed or gardened. */
function vegetated(biome: number): boolean {
  return biome === BIOME.meadow || biome === BIOME.farmland || biome === BIOME.forest || biome === BIOME.conifer || biome === BIOME.scrub || biome === BIOME.village;
}

function blend(out: number[], c: readonly number[], t: number): void {
  out[0] = mix(out[0]!, c[0]!, t);
  out[1] = mix(out[1]!, c[1]!, t);
  out[2] = mix(out[2]!, c[2]!, t);
}

const RGB = [0, 0, 0];

/**
 * Recolours one vertex (3 bytes at `o`) for v2 and writes its surface weights. `roadD` / `farm` are the sample's
 * road distance and farmland noise.
 */
export function shadeV2(b: BiomeSample, seed: number, wx: number, wz: number, waterSurface: number, roadD: number, farm: number, lod: number, out: Uint8Array, o: number, surface: Uint8Array, so: number): void {
  const rows = ROW_CONTRAST[lod] ?? 0;
  const c = RGB;
  c[0] = out[o]!;
  c[1] = out[o + 1]!;
  c[2] = out[o + 2]!;
  const wet = b.biome === BIOME.water || b.biome === BIOME.beach;
  if (vegetated(b.biome) && b.snow < 0.5) {
    // macro patches: a 350 m dry / lush field and a 90 m brightness field
    const m = noise(subSeed(seed, SALT_MACRO), wx * (1 / 350), wz * (1 / 350));
    const f = noise(subSeed(seed, SALT_MACRO_FINE), wx * (1 / 90), wz * (1 / 90));
    if (m > 0) blend(c, DRY, smoothstep(0.1, 0.7, m) * 0.45);
    else blend(c, DARK, smoothstep(0.1, 0.7, -m) * 0.4);
    const k = 0.9 + 0.2 * (f * 0.5 + 0.5);
    c[0] = c[0]! * k;
    c[1] = c[1]! * k;
    c[2] = c[2]! * k;
    // farmed land: irregular fields with crops, furrows and farm tracks
    // fields run up to the gardens: no bare ring around a village
    const fw = fieldWeight(farm, roadD, b.slope, b.height, wet) * (1 - b.road) * (1 - smoothstep(0.25, 0.55, b.village));
    if (fw > 0) {
      parcelAt(seed, SALT_FIELDS, FIELD_CELL, wx, wz, P);
      let crop = CROP_COLOURS[cropOf(P.id)]!;
      const ang = PI * u01(rehash(P.id, 9));
      // furrows along the field's own direction; a light touch (at 2 m a vertex grid draws them as soft bands)
      const furrow = 1 + rows * (Math.floor((wx * dcos(ang) + wz * dsin(ang)) / 5) % 2 === 0 ? -0.04 : 0.03);
      // the seam between two fields is a light grass verge (exposing the ground below drew dark straight lines)
      const verge = (1 - smoothstep(0.3, 1.4, P.edge)) * 0.55;
      const fc = [mix(crop[0]! * furrow, VERGE[0]!, verge), mix(crop[1]! * furrow, VERGE[1]!, verge), mix(crop[2]! * furrow, VERGE[2]!, verge)];
      blend(c, fc, smoothstep(0.45, 0.6, fw));
      if (onTrack(P) && fw > 0.5) {
        crop = TRACK_COLOUR;
        blend(c, crop, 0.9);
      }
    }
    // village gardens: the same kind of cells, smaller, faded in by the village weight (no ring colour)
    if (b.village > 0) {
      parcelAt(seed, SALT_GARDENS, GARDEN_CELL, wx, wz, P);
      const kind = Math.floor(u01(rehash(P.id, 4)) * GARDEN_COLOURS.length);
      let g: readonly number[] = GARDEN_COLOURS[kind]!;
      if (kind === 1 && rows === 1 && Math.floor((wx + wz) / 1.5) % 2 === 0) g = [0x5e, 0x7a, 0x3e];
      const verge = (1 - smoothstep(0.2, 1.0, P.edge)) * 0.5;
      blend(c, [mix(g[0]!, VERGE[0]!, verge), mix(g[1]!, VERGE[1]!, verge), mix(g[2]!, VERGE[2]!, verge)], smoothstep(0.3, 0.8, b.village) * 0.85);
    }
  }
  let bank = 0;
  if (waterSurface > -Infinity) {
    const above = b.height - waterSurface;
    bank = above <= 0 ? 1 : 1 - smoothstep(0, BANK_HEIGHT, above);
    if (b.biome !== BIOME.road && above > -0.4) {
      const gravel = u01(hash2(seed, Math.floor(wx / 3), Math.floor(wz / 3), SALT_PARCEL + 1)) < 0.4 ? GRAVEL : SAND;
      blend(c, gravel, bank * 0.85);
    }
  }
  out[o] = clamp(Math.floor(c[0]!), 0, 255);
  out[o + 1] = clamp(Math.floor(c[1]!), 0, 255);
  out[o + 2] = clamp(Math.floor(c[2]!), 0, 255);
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
