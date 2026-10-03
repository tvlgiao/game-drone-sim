/**
 * Object scatter for generator v2 (generator v1 stays in scatter.ts). Same packed layouts and chunk ownership.
 *
 * - Trees: the v1 8 m jittered grid, but four species (conifer, broadleaf, scrub, birch) chosen from climate,
 *   altitude, slope and the clump noise, so forests have cores of one species, mixed edges with birch and
 *   shrubs, and lone trees stand in the meadows. Forests climb slopes up to 1.2 (thinning out, conifers only
 *   past 0.9).
 * - Rocks: v1 rocks plus boulders and outcrops on slopes over 0.9.
 * - Villages: hedges along 18 m garden parcels and small clusters of garden trees, clear of houses and roads.
 * - Houses and bridges as in v1 (the v2 house layout already faces the roads).
 */
import { dcos, dsin, smoothstep, TAU } from './math';
import { noise } from './noise';
import { hash2, rehash, SALT, subSeed, u01 } from './rng';
import { ROAD_HALF_WIDTH } from './roads';
import type { ChunkObjects } from './scatter';
import { CHUNK_SIZE, OBJECT_KIND, ROCK_CELL, ROCK_HALF, TREE_CELL, pushBox, pushTreeColliders, slopeAt } from './scatter';
import { forestDensity, terrainSample, type TerrainSample } from './terrain-field';
import type { Climate } from './base-terrain';
import type { House, Village } from './settlements';
import type { World } from './world';

/** garden parcels inside villages, m */
export const PARCEL = 18;
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
      if (s.village > 0 || !dryGround(w, s, 4) || s.h > base.treeLine) continue;
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
 * Hedges along the 18 m garden parcels and small clusters of garden trees, inside the village plateau, only
 * for parcels whose anchor lies in this chunk (so nothing is duplicated across chunks).
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
  const p0 = Math.floor(Math.max(ox, v.x - R) / PARCEL);
  const p1 = Math.floor(Math.min(ox + CHUNK_SIZE - 1e-6, v.x + R) / PARCEL);
  const q0 = Math.floor(Math.max(oz, v.z - R) / PARCEL);
  const q1 = Math.floor(Math.min(oz + CHUNK_SIZE - 1e-6, v.z + R) / PARCEL);
  const ok = (x: number, z: number, r: number): boolean => {
    if (x < ox || x >= ox + CHUNK_SIZE || z < oz || z >= oz + CHUNK_SIZE) return false;
    const dx = x - v.x;
    const dz = z - v.z;
    if (dx * dx + dz * dz > R * R) return false;
    f.sample(x, z, s);
    return s.village > 0.5 && dryGround(w, s, 2.5 + r) && clearOfHouses(vh, x, z, r + 1.5);
  };
  for (let q = q0; q <= q1; q++) {
    for (let p = p0; p <= p1; p++) {
      const hp = hash2(seed, p, q, SALT_HEDGE);
      // a hedge along the parcel's west or south edge
      if (u01(hp) < 0.3) {
        const alongX = u01(rehash(hp, 1)) < 0.5;
        for (let k = 0; k * HEDGE_STEP < PARCEL; k++) {
          const x = p * PARCEL + (alongX ? (k + 0.5) * HEDGE_STEP : 0.4);
          const z = q * PARCEL + (alongX ? 0.4 : (k + 0.5) * HEDGE_STEP);
          if (!ok(x, z, 1)) continue;
          tree(x, s.h, z, 0.55 + 0.2 * u01(rehash(hp, 10 + k)), TAU * u01(rehash(hp, 30 + k)), SPECIES.scrub);
        }
      }
      // garden trees: 2–4 around the parcel centre
      const hg = hash2(seed, p, q, SALT_GARDEN);
      if (u01(hg) < 0.14) {
        const count = 2 + Math.floor(u01(rehash(hg, 1)) * 3);
        for (let k = 0; k < count; k++) {
          const a = TAU * u01(rehash(hg, 2 + k));
          const r = 2 + 3 * u01(rehash(hg, 8 + k));
          const x = (p + 0.5) * PARCEL + r * dcos(a);
          const z = (q + 0.5) * PARCEL + r * dsin(a);
          const sc = 0.6 + 0.35 * u01(rehash(hg, 14 + k));
          if (!ok(x, z, 3 * sc)) continue;
          tree(x, s.h, z, sc, TAU * u01(rehash(hg, 20 + k)), u01(rehash(hg, 26 + k)) < 0.3 ? SPECIES.birch : SPECIES.broadleaf);
        }
      }
    }
  }
}
