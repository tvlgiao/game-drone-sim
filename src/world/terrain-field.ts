/**
 * The analytic terrain every consumer shares (design 07 §2.2): physics calls `heightAt`, the chunk worker
 * meshes it, the race and spawn logic query water and biomes. Layers in a fixed order: (1–3) relief, rivers
 * and lakes from BaseTerrain, (4) village plateaus, (5) road beds. Placement of villages and roads reads
 * layers 1–3 only, so there are no circular dependencies.
 */
import type { BaseSample, BaseTerrain, Climate, TerrainPreset } from './base-terrain';
import { baseSample } from './base-terrain';
import { cellKey, clamp, LruCache, segDist2, smoothstep } from './math';
import { noise } from './noise';
import type { RoadPolyline, RoadSource } from './roads';
import { ROAD_HALF_WIDTH, ROAD_MAX_CUT, ROAD_SHOULDER, roadSegmentsNear } from './roads';
import { SALT, subSeed } from './rng';
import type { Settlements, Village } from './settlements';
import { VILLAGE_BLEND } from './settlements';

export type { TerrainPreset } from './base-terrain';

export const BIOME = {
  water: 0,
  beach: 1,
  meadow: 2,
  farmland: 3,
  forest: 4,
  conifer: 5,
  scrub: 6,
  rock: 7,
  snow: 8,
  village: 9,
  road: 10,
} as const;
export type BiomeId = (typeof BIOME)[keyof typeof BIOME];
export const BIOME_NAMES: readonly (keyof typeof BIOME)[] = ['water', 'beach', 'meadow', 'farmland', 'forest', 'conifer', 'scrub', 'rock', 'snow', 'village', 'road'];

export interface BiomeSample {
  biome: BiomeId;
  height: number;
  /** water surface, −Infinity when dry */
  water: number;
  /** |∇h| (rise over run) */
  slope: number;
  moisture: number;
  temperature: number;
  /** 0..1 tree density the scatter uses */
  forest: number;
  /** 0..1, 1 on the road deck */
  road: number;
  /** 0..1, 1 on a village plateau */
  village: number;
  /** 0..1, 1 in a river channel */
  river: number;
  /** 0..1 snow cover */
  snow: number;
}

export function biomeSample(): BiomeSample {
  return { biome: BIOME.meadow, height: 0, water: -Infinity, slope: 0, moisture: 0, temperature: 0, forest: 0, road: 0, village: 0, river: 0, snow: 0 };
}

/** Analytic terrain (design 07 §2.2). Pure, deterministic and safe to call from any thread. */
export interface TerrainField {
  readonly seed: number;
  readonly genVersion: number;
  readonly preset: TerrainPreset | 'city';
  /** final height, includes river carving, village plateaus and road beds */
  heightAt(x: number, z: number): number;
  /** layers 1–3 (pre-settlement), for placement tests */
  baseHeightAt(x: number, z: number): number;
  /** water surface at (x, z), −Infinity when dry */
  waterLevelAt(x: number, z: number): number;
  biomeAt(x: number, z: number, out: BiomeSample): BiomeSample;
  /** upper / lower bounds of `heightAt` (chunk culling) */
  readonly maxHeight: number;
  readonly minHeight: number;
}

/** Everything one evaluation yields; chunk-gen and scatter read it directly to avoid re-evaluating. */
export interface TerrainSample extends BaseSample {
  /** layers 1–3 height (BaseSample.h is overwritten with the final height) */
  base: number;
  /** road bed target: the low-pass height blended into village plateaus */
  bed: number;
  /** distance to the nearest road centre line (bridged spans excluded), m */
  roadD: number;
  /** 0..1, 1 on a village plateau, 0 beyond its blend ring */
  village: number;
}

export function terrainSample(): TerrainSample {
  return { ...baseSample(), base: 0, bed: 0, roadD: Infinity, village: 0 };
}

/** Village and road data relevant to one 128 m cell (FEATURE_CELL). */
export interface FeatureCell {
  villages: Village[];
  roads: RoadPolyline[];
  /** non-bridged road segments [ax, az, bx, bz, …] within the road's reach of the cell */
  segs: Float64Array;
}

export const FEATURE_CELL = 128;
/** v2: the village ground blends out over at least this many metres (outer − inner, the warp included) */
export const VILLAGE_FALLOFF_V2 = 40;
/** v2: trees grow where the village weight is below this (the outer part of the falloff) */
export const VILLAGE_TREES_V2 = 0.3;
/** v2: the village blend ring is warped by noise up to this many metres, so villages are not discs */
export const VILLAGE_WARP = 22;
const VILLAGE_WARP_SCALE = 1 / 46;
/** salt of the v2 village-edge noise (outside SALT: v1 streams stay untouched) */
const SALT_VILLAGE_EDGE = 61;
const ROAD_REACH = ROAD_HALF_WIDTH + ROAD_SHOULDER;

export class ComposedTerrainField implements TerrainField {
  readonly seed: number;
  readonly preset: TerrainPreset;
  readonly maxHeight: number;
  readonly minHeight: number;
  private readonly cells = new LruCache<number, FeatureCell>(1024);
  private readonly ts = terrainSample();
  private readonly climateOut: Climate = { moisture: 0, temperature: 0 };
  private readonly farmSeed: number;
  private readonly edgeSeed: number;

  constructor(
    readonly base: BaseTerrain,
    readonly settlements: Settlements,
    readonly roads: RoadSource,
    readonly genVersion: number,
  ) {
    this.seed = base.seed;
    this.preset = base.preset;
    this.maxHeight = base.maxHeight;
    this.minHeight = base.minHeight;
    this.farmSeed = subSeed(base.seed, SALT.farm);
    this.edgeSeed = subSeed(base.seed, SALT_VILLAGE_EDGE);
  }

  /** Villages and roads around a 128 m cell (memoised). */
  featureCell(fi: number, fj: number): FeatureCell {
    const key = cellKey(fi, fj);
    const hit = this.cells.get(key);
    if (hit) return hit;
    const minX = fi * FEATURE_CELL;
    const minZ = fj * FEATURE_CELL;
    const maxX = minX + FEATURE_CELL;
    const maxZ = minZ + FEATURE_CELL;
    const villages = this.settlements.villagesInBox(minX, minZ, maxX, maxZ);
    const roads = this.roads.polylinesNear(minX, minZ, maxX, maxZ, ROAD_REACH + 1);
    const cell: FeatureCell = { villages, roads, segs: roadSegmentsNear(roads, minX, minZ, maxX, maxZ, ROAD_REACH + 1) };
    this.cells.set(key, cell);
    return cell;
  }

  sample(x: number, z: number, o: TerrainSample): TerrainSample {
    this.base.sample(x, z, o);
    let h = o.h;
    let bed = o.lp;
    o.base = h;
    let vm = 0;
    const fc = this.featureCell(Math.floor(x / FEATURE_CELL), Math.floor(z / FEATURE_CELL));
    // v2: one warp value per point, shared by every village (the edge wobbles, but stays continuous)
    const warp = this.genVersion >= 2 && fc.villages.length > 0 ? VILLAGE_WARP * noise(this.edgeSeed, x * VILLAGE_WARP_SCALE, z * VILLAGE_WARP_SCALE) : 0;
    for (const v of fc.villages) {
      const dx = x - v.x;
      const dz = z - v.z;
      const d2 = dx * dx + dz * dz;
      const outer = v.radius + VILLAGE_BLEND;
      if (d2 >= outer * outer) continue;
      const d = Math.sqrt(d2);
      if (this.genVersion >= 2) {
        // v2: no plateau. The village smooths the ground towards the local low-pass height over a wide,
        // noise-warped falloff (≥ VILLAGE_FALLOFF_V2 m), so it follows the land and never ends in a step.
        const inner = v.radius - VILLAGE_FALLOFF_V2 * 0.25 + warp * 0.4;
        const t = smoothstep(inner, outer, d);
        h = o.lp + (h - o.lp) * t;
        if (1 - t > vm) vm = 1 - t;
        continue;
      }
      const t = smoothstep(v.radius, outer, d);
      h = v.plateau + (h - v.plateau) * t;
      bed = v.plateau + (bed - v.plateau) * t;
      if (1 - t > vm) vm = 1 - t;
    }
    let best = Infinity;
    const segs = fc.segs;
    for (let i = 0; i < segs.length; i += 4) {
      const d2 = segDist2(x, z, segs[i]!, segs[i + 1]!, segs[i + 2]!, segs[i + 3]!);
      if (d2 < best) best = d2;
    }
    const roadD = Math.sqrt(best);
    if (roadD < ROAD_REACH) {
      const m = 1 - smoothstep(ROAD_HALF_WIDTH, ROAD_REACH, roadD);
      h += m * clamp(bed - h, -ROAD_MAX_CUT, ROAD_MAX_CUT);
    }
    o.h = h;
    o.bed = bed;
    o.roadD = roadD;
    o.village = vm;
    return o;
  }

  heightAt(x: number, z: number): number {
    return this.sample(x, z, this.ts).h;
  }

  baseHeightAt(x: number, z: number): number {
    return this.base.sample(x, z, this.ts).h;
  }

  waterLevelAt(x: number, z: number): number {
    const s = this.sample(x, z, this.ts);
    return s.water > s.h ? s.water : -Infinity;
  }

  /** Farmland pattern 0..1 at (x, z): patches of fields near the lowlands. */
  farmAt(x: number, z: number): number {
    return noise(this.farmSeed, x * (1 / 420), z * (1 / 420));
  }

  climate(x: number, z: number, s: TerrainSample, out: Climate): Climate {
    return this.base.climate(x, z, s, out);
  }

  biomeAt(x: number, z: number, out: BiomeSample): BiomeSample {
    const e = 1;
    const gx = (this.heightAt(x + e, z) - this.heightAt(x - e, z)) / (2 * e);
    const gz = (this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e);
    const s = this.sample(x, z, this.ts);
    const c = this.base.climate(x, z, s, this.climateOut);
    return classify(this.base, s, Math.sqrt(gx * gx + gz * gz), c, this.farmAt(x, z), out, this.genVersion);
  }
}

/** v2: trees reach slopes up to this, thinning out from FOREST_THIN_SLOPE */
export const FOREST_MAX_SLOPE_V2 = 1.2;
const FOREST_THIN_SLOPE_V2 = 0.55;

/**
 * 0..1 tree density from terrain, slope and climate (design 07 §2.2 `forestDensity`). Generator v1 stops at
 * slope 0.9 (bare cliffs); v2 thins the forest out up to slope 1.2.
 */
export function forestDensity(base: BaseTerrain, s: TerrainSample, slope: number, c: Climate, genVersion = 1): number {
  // v2: woods reach into the outer half of a village's falloff (no treeless ring around it)
  if (s.water > s.h - 0.5 || s.village > (genVersion >= 2 ? VILLAGE_TREES_V2 : 0) || s.roadD < ROAD_HALF_WIDTH + 4 || s.riverD < base.riverHalfWidth + 8) return 0;
  const v2 = genVersion >= 2;
  if (slope > (v2 ? FOREST_MAX_SLOPE_V2 : 0.9) || s.h > base.treeLine) return 0;
  const wet = smoothstep(0.3, 0.75, c.moisture);
  const high = base.treeLine === Infinity ? 1 : 1 - smoothstep(base.treeLine - 60, base.treeLine, s.h);
  return wet * high * (1 - (v2 ? smoothstep(FOREST_THIN_SLOPE_V2, FOREST_MAX_SLOPE_V2, slope) : smoothstep(0.6, 0.9, slope)));
}

/** Biome classification shared by `biomeAt` and the chunk colours. */
export function classify(base: BaseTerrain, s: TerrainSample, slope: number, c: Climate, farm: number, out: BiomeSample, genVersion = 1): BiomeSample {
  const h = s.h;
  const wet = s.water > h;
  out.height = h;
  out.water = wet ? s.water : -Infinity;
  out.slope = slope;
  out.moisture = c.moisture;
  out.temperature = c.temperature;
  out.forest = forestDensity(base, s, slope, c, genVersion);
  if (genVersion >= 2 && out.forest === 0 && s.village > 0 && s.village < 0.5) {
    // v2: the ground keeps the surrounding biome through the plateau's blend ring (no halo of bare meadow)
    const v = s.village;
    s.village = 0;
    out.forest = forestDensity(base, s, slope, c, genVersion) * (1 - 2 * v);
    s.village = v;
  }
  out.road = 1 - smoothstep(ROAD_HALF_WIDTH, ROAD_HALF_WIDTH + 2, s.roadD);
  out.village = s.village;
  out.river = base.riverHalfWidth > 0 ? 1 - smoothstep(base.riverHalfWidth, base.riverHalfWidth + 6, s.riverD) : 0;
  out.snow = base.snowLine === Infinity ? 0 : smoothstep(base.snowLine - 25, base.snowLine + 25, h) * (1 - smoothstep(0.8, 1.1, slope));
  let b: BiomeId;
  if (wet) b = BIOME.water;
  else if (out.road > 0.5) b = BIOME.road;
  // v2 villages keep their land's biome (gardens are painted over it, no plateau colour)
  else if (s.village > 0.5 && genVersion < 2) b = BIOME.village;
  else if (out.snow > 0.5) b = BIOME.snow;
  else if (slope > 0.8 || h > base.treeLine + 80) b = BIOME.rock;
  else if (s.water > h - 1.5) b = BIOME.beach;
  else if (out.forest > 0.45) b = h > 120 || c.temperature < 0.45 ? BIOME.conifer : BIOME.forest;
  else if (c.moisture < 0.3) b = BIOME.scrub;
  else if (farm > 0.15 && h < 150 && slope < 0.12 && c.moisture < 0.75) b = BIOME.farmland;
  else b = BIOME.meadow;
  out.biome = b;
  return out;
}
