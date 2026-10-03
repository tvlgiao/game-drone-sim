/**
 * Object scatter for generator v2 (generator v1 stays in scatter.ts). Same packed layouts and chunk ownership.
 *
 * - Trees: the v1 8 m jittered grid, but four species (conifer, broadleaf, scrub, birch) chosen from climate,
 *   altitude, slope and the clump noise, so forests have cores of one species, mixed edges with birch and
 *   shrubs, and lone trees stand in the meadows. Forests climb slopes up to 1.2 (thinning out, conifers only
 *   past 0.9).
 * - Rocks: v1 rocks plus boulders and outcrops on slopes over 0.9.
 * - Fields (fields.ts) keep trees only along their edges; villages get hedges along garden-parcel edges and small
 *   clusters of garden trees, clear of houses and roads.
 * - Houses and bridges as in v1 (the v2 house layout already faces the roads).
 */
import { dcos, dsin, smoothstep, TAU } from './math';
import { noise } from './noise';
import { hash2, rehash, SALT, subSeed, u01 } from './rng';
import { ROAD_HALF_WIDTH } from './roads';
import type { ChunkObjects } from './scatter';
import { CHUNK_SIZE, OBJECT_KIND, ROCK_CELL, ROCK_HALF, TREE_CELL, pushBox, pushTreeColliders, slopeAt } from './scatter';
import { forestDensity, terrainSample, VILLAGE_TREES_V2, type TerrainSample } from './terrain-field';
import { FIELD_CELL, GARDEN_CELL, SALT_FIELDS, SALT_GARDENS, fieldWeight, onTrack, parcel, parcelAt } from './fields';
import type { Climate } from './base-terrain';
import type { House, Village } from './settlements';
import type { World } from './world';

/** spacing of hedge shrubs along a parcel edge, m */
const HEDGE_STEP = 3;
/** lone trees per meadow tree cell */
const LONE_TREE = 0.012;
/** boulder scatter on cliffs starts at this slope */
export const BOULDER_SLOPE = 0.9;
const SALT_HEDGE = 71;
const SALT_GARDEN = 72;

export const SPECIES = { conifer: 0, broadleaf: 1, scrub: 2, birch: 3 } as const;

const climate: Climate = { moisture: 0, temperature: 0 };
const P = parcel();

/** Free of water, road deck and river channel: where any object may stand. */
function dryGround(w: World, s: TerrainSample, margin: number): boolean {
  return !(s.water > s.h - 0.5) && s.roadD >= ROAD_HALF_WIDTH + margin && s.riverD >= w.base.riverHalfWidth + 6;
}

function clearOfHouses(houses: readonly House[], x: number, z: number, r: number): boolean {
  for (const h of houses) {
    const reach = 0.5 * Math.sqrt(h.w * h.w + h.d * h.d) + r;
    const dx = h.x - x;
    const dz = h.z - z;
    if (dx * dx + dz * dz < reach * reach) return false;
  }
  return true;
}

export function chunkObjectsV2(w: World, cx: number, cz: number): ChunkObjects {
  const ox = cx * CHUNK_SIZE;
  const oz = cz * CHUNK_SIZE;
  const seed = w.spec.seed;
  const base = w.base;
  const f = w.field;
  const s: TerrainSample = terrainSample();
  const clumpSeed = subSeed(seed, SALT.tree);
  const clear2 = base.clearRadius * base.clearRadius;
  const trees: number[] = [];
  const rocks: number[] = [];
  const houses: number[] = [];
  const bridges: number[] = [];
  const col: number[] = [];
  const tree = (x: number, y: number, z: number, scale: number, yaw: number, species: number): void => {
    trees.push(x - ox, y, z - oz, scale, yaw, species);
    pushTreeColliders(col, species, x - ox, y, z - oz, scale);
  };

  const n = CHUNK_SIZE / TREE_CELL;
  const ti0 = cx * n;
  const tj0 = cz * n;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const h0 = hash2(seed, ti0 + i, tj0 + j, SALT.tree);
      const x = (ti0 + i + 0.1 + 0.8 * u01(rehash(h0, 1))) * TREE_CELL;
      const z = (tj0 + j + 0.1 + 0.8 * u01(rehash(h0, 2))) * TREE_CELL;
      if (x * x + z * z < clear2) continue;
      const u = u01(h0);
      f.sample(x, z, s);
      if (s.village > VILLAGE_TREES_V2 || !dryGround(w, s, 4) || s.h > base.treeLine) continue;
      const c = f.climate(x, z, s, climate);
      const clump = smoothstep(-0.3, 0.35, noise(clumpSeed, x * (1 / 160), z * (1 / 160)));
      const flat = forestDensity(base, s, 0, c, 2);
      const lone = u < LONE_TREE && c.moisture > 0.25;
      // forest edge band: the clump noise between its core and the open meadow
      const edge = clump > 0.08 && clump < 0.55;
      const shrubby = !lone && edge && flat > 0 && u < flat * 0.18;
      if (!lone && !shrubby && u >= flat * clump) continue;
      const slope = slopeAt(w, x, z);
      if (!lone && !shrubby && u >= forestDensity(base, s, slope, c, 2) * clump) continue;
      if ((lone || shrubby) && slope > 0.6) continue;
      // farmed fields keep trees only along their edges (hedgerows), never on a farm track
      if (fieldWeight(f.farmAt(x, z), s.roadD, slope, s.h, false) > 0.5) {
        parcelAt(seed, SALT_FIELDS, FIELD_CELL, x, z, P);
        if (P.edge > 3 || onTrack(P)) continue;
      }
      const us = u01(rehash(h0, 5));
      const cold = s.h > 120 || c.temperature < 0.45;
      let species: number;
      if (shrubby || (c.moisture < 0.42 && us < 0.6)) species = SPECIES.scrub;
      else if (slope > BOULDER_SLOPE || (cold && us > (s.h < 300 && c.moisture > 0.5 ? 0.15 : 0))) species = SPECIES.conifer;
      else species = us < (edge ? 0.5 : 0.25) ? SPECIES.birch : SPECIES.broadleaf;
      let scale = 0.75 + 0.7 * u01(rehash(h0, 3));
      if (lone) scale = 1.1 + 0.4 * u01(rehash(h0, 3));
      if (slope > BOULDER_SLOPE) scale *= 0.8;
      tree(x, s.h, z, scale, TAU * u01(rehash(h0, 4)), species);
    }
  }

  const m = CHUNK_SIZE / ROCK_CELL;
  const ri0 = cx * m;
  const rj0 = cz * m;
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < m; i++) {
      const h0 = hash2(seed, ri0 + i, rj0 + j, SALT.rock);
      const u = u01(h0);
      if (u > 0.6) continue;
      const x = (ri0 + i + 0.1 + 0.8 * u01(rehash(h0, 1))) * ROCK_CELL;
      const z = (rj0 + j + 0.1 + 0.8 * u01(rehash(h0, 2))) * ROCK_CELL;
      if (x * x + z * z < clear2) continue;
      f.sample(x, z, s);
      if (s.village > 0 || !dryGround(w, s, 3)) continue;
      const slope = slopeAt(w, x, z);
      const cliff = slope > BOULDER_SLOPE;
      let scale: number;
      if (cliff) scale = 1.2 + 2.6 * u01(rehash(h0, 3));
      else {
        if (u > 0.35) continue;
        const high = s.h > base.treeLine - 40;
        if (!high && s.mountain < 0.5 && u > 0.12 && (slope < 0.55 || slope > 1.6)) continue;
        scale = 0.6 + 1.8 * u01(rehash(h0, 3));
      }
      const yaw = TAU * u01(rehash(h0, 4));
      rocks.push(x - ox, s.h, z - oz, scale, yaw);
      pushBox(col, OBJECT_KIND.rock, x - ox, s.h + ROCK_HALF[1] * scale * 0.6, z - oz, ROCK_HALF[0] * scale, ROCK_HALF[1] * scale, ROCK_HALF[2] * scale, yaw);
    }
  }

  const fc = f.featureCell(cx, cz);
  for (const v of fc.villages) {
    const vh = w.houses(v);
    for (const hs of vh) {
      if (hs.x < ox || hs.x >= ox + CHUNK_SIZE || hs.z < oz || hs.z >= oz + CHUNK_SIZE) continue;
      const lx = hs.x - ox;
      const lz = hs.z - oz;
      houses.push(lx, hs.y, lz, hs.w, hs.wallHeight, hs.d, hs.yaw, hs.archetype, hs.colour, hs.roofHeight);
      pushBox(col, OBJECT_KIND.house, lx, hs.y + hs.wallHeight / 2, lz, hs.w / 2, hs.wallHeight / 2, hs.d / 2, hs.yaw);
      pushBox(col, OBJECT_KIND.house, lx, hs.y + hs.wallHeight + hs.roofHeight / 2, lz, hs.w * 0.3, hs.roofHeight / 2, hs.d / 2, hs.yaw);
    }
    villageGreenery(w, v, vh, cx, cz, s, tree);
  }

  for (const road of fc.roads) {
    for (const b of road.bridges) {
      if (b.x < ox || b.x >= ox + CHUNK_SIZE || b.z < oz || b.z >= oz + CHUNK_SIZE) continue;
      const lx = b.x - ox;
      const lz = b.z - oz;
      bridges.push(lx, b.y, lz, b.length, b.width, b.yaw);
      pushBox(col, OBJECT_KIND.bridge, lx, b.y - 0.3, lz, b.width / 2, 0.3, b.length / 2, b.yaw);
      const off = b.width / 2 - 0.1;
      const ax = off * dcos(b.yaw);
      const az = -off * dsin(b.yaw);
      pushBox(col, OBJECT_KIND.bridge, lx + ax, b.y + 0.5, lz + az, 0.1, 0.5, b.length / 2, b.yaw);
      pushBox(col, OBJECT_KIND.bridge, lx - ax, b.y + 0.5, lz - az, 0.1, 0.5, b.length / 2, b.yaw);
    }
  }

  return {
    trees: Float32Array.from(trees),
    rocks: Float32Array.from(rocks),
    houses: Float32Array.from(houses),
    bridges: Float32Array.from(bridges),
    colliders: Float32Array.from(col),
  };
}

/**
 * Hedges along some garden-parcel edges (the Voronoi gardens chunk-gen paints) and small clusters of garden trees
 * around parcel centres, inside the village, clear of houses and roads. Every chunk walks the parcels that can
 * reach it and keeps what falls inside it, so nothing is duplicated or lost across chunk borders.
 */
function villageGreenery(
  w: World,
  v: Village,
  vh: readonly House[],
  cx: number,
  cz: number,
  s: TerrainSample,
  tree: (x: number, y: number, z: number, scale: number, yaw: number, species: number) => void,
): void {
  const seed = w.spec.seed;
  const f = w.field;
  const ox = cx * CHUNK_SIZE;
  const oz = cz * CHUNK_SIZE;
  const R = v.radius * 0.95;
  const ok = (x: number, z: number, r: number): boolean => {
    if (x < ox || x >= ox + CHUNK_SIZE || z < oz || z >= oz + CHUNK_SIZE) return false;
    const dx = x - v.x;
    const dz = z - v.z;
    if (dx * dx + dz * dz > R * R) return false;
    f.sample(x, z, s);
    return s.village > 0.5 && dryGround(w, s, 2.5 + r) && clearOfHouses(vh, x, z, r + 1.5);
  };
  const x0 = Math.max(ox, v.x - R);
  const x1 = Math.min(ox + CHUNK_SIZE, v.x + R);
  const z0 = Math.max(oz, v.z - R);
  const z1 = Math.min(oz + CHUNK_SIZE, v.z + R);
  if (x0 >= x1 || z0 >= z1) return;
  // hedges: points on a HEDGE_STEP lattice that sit on a hedged parcel edge
  for (let gz = Math.ceil(z0 / HEDGE_STEP); gz * HEDGE_STEP < z1; gz++) {
    for (let gx = Math.ceil(x0 / HEDGE_STEP); gx * HEDGE_STEP < x1; gx++) {
      const x = gx * HEDGE_STEP;
      const z = gz * HEDGE_STEP;
      parcelAt(seed, SALT_GARDENS, GARDEN_CELL, x, z, P);
      if (P.edge > HEDGE_STEP * 0.5 || !hedged(P.id, P.neighbour)) continue;
      if (!ok(x, z, 1)) continue;
      const hh = hash2(seed, gx, gz, SALT_HEDGE);
      tree(x, s.h, z, 0.55 + 0.2 * u01(hh), TAU * u01(rehash(hh, 1)), SPECIES.scrub);
    }
  }
  // garden trees: 2–4 around some parcel centres
  for (let j = Math.floor((z0 - 6) / GARDEN_CELL) - 1; j <= Math.floor((z1 + 6) / GARDEN_CELL) + 1; j++) {
    for (let i = Math.floor((x0 - 6) / GARDEN_CELL) - 1; i <= Math.floor((x1 + 6) / GARDEN_CELL) + 1; i++) {
      const hc = hash2(seed, i, j, SALT_GARDENS);
      const px = (i + 0.15 + 0.7 * u01(rehash(hc, 1))) * GARDEN_CELL;
      const pz = (j + 0.15 + 0.7 * u01(rehash(hc, 2))) * GARDEN_CELL;
      const hg = hash2(seed, i, j, SALT_GARDEN);
      if (u01(hg) >= 0.18) continue;
      const count = 2 + Math.floor(u01(rehash(hg, 1)) * 3);
      for (let k = 0; k < count; k++) {
        const a = TAU * u01(rehash(hg, 2 + k));
        const r = 2 + 3 * u01(rehash(hg, 8 + k));
        const x = px + r * dcos(a);
        const z = pz + r * dsin(a);
        const sc = 0.6 + 0.35 * u01(rehash(hg, 14 + k));
        if (!ok(x, z, 3 * sc)) continue;
        tree(x, s.h, z, sc, TAU * u01(rehash(hg, 20 + k)), u01(rehash(hg, 26 + k)) < 0.3 ? SPECIES.birch : SPECIES.broadleaf);
      }
    }
  }
}

/** True for the parcel edges that carry a hedge (symmetric in the pair). */
function hedged(a: number, b: number): boolean {
  const lo = a < b ? a : b;
  const hi = a < b ? b : a;
  return u01(rehash((lo ^ Math.imul(hi, 0x85ebca77)) >>> 0, 5)) < 0.35;
}
