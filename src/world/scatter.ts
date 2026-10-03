/**
 * Object scatter per chunk (design 07 §2.2): trees on a jittered 8 m grid, rocks on a 16 m grid, houses and
 * bridges from the village / road layers. Each object belongs to the chunk that contains its anchor, and
 * every decision is a hash of (seed, global cell), so chunks agree at their borders and build in any order.
 *
 * Packed layouts (x, z relative to the chunk origin, y absolute):
 * - trees   TREE_STRIDE:   x, y, z, scale, yaw, species (index into TREE_SPECIES)
 * - rocks   ROCK_STRIDE:   x, y, z, scale, yaw
 * - houses  HOUSE_STRIDE:  x, y, z, w, wallHeight, d, yaw, archetype, colour (0xRRGGBB), roofHeight
 * - bridges BRIDGE_STRIDE: x, y (deck top), z, length, width, yaw
 * - colliders COLLIDER_STRIDE: shape (1 cylinder, 2 box), object (OBJECT_KIND), cx, cy, cz, a, b, c, yaw
 *   cylinder: a = radius, b = half height; box: a, b, c = half extents, yaw about +Y.
 */
import type { Climate } from './base-terrain';
import { dcos, dsin, smoothstep, TAU } from './math';
import { noise } from './noise';
import { hash2, rehash, SALT, subSeed, u01 } from './rng';
import { forestDensity, terrainSample, type TerrainSample } from './terrain-field';
import { ROAD_HALF_WIDTH } from './roads';
import type { World } from './world';

export const CHUNK_SIZE = 128;
export const TREE_CELL = 8;
export const ROCK_CELL = 16;

export const TREE_STRIDE = 6;
export const ROCK_STRIDE = 5;
export const HOUSE_STRIDE = 10;
export const BRIDGE_STRIDE = 6;
export const COLLIDER_STRIDE = 9;

export const TREE_SPECIES = ['conifer', 'broadleaf', 'scrub'] as const;
export const SHAPE = { cylinder: 1, box: 2 } as const;
export const OBJECT_KIND = { tree: 1, house: 2, rock: 3, bridge: 4 } as const;

/** Tree size at scale 1 (renderer and colliders agree on these). */
export const TREE_DIMENSIONS: readonly { height: number; trunkRadius: number; crownRadius: number; crownBase: number }[] = [
  { height: 12, trunkRadius: 0.3, crownRadius: 2.4, crownBase: 0.22 },
  { height: 9, trunkRadius: 0.3, crownRadius: 3, crownBase: 0.35 },
  { height: 2.2, trunkRadius: 0, crownRadius: 1.2, crownBase: 0 },
];

/** Rock collider half extents relative to its scale. */
export const ROCK_HALF: readonly [number, number, number] = [0.6, 0.45, 0.5];

export interface ChunkObjects {
  trees: Float32Array;
  rocks: Float32Array;
  houses: Float32Array;
  bridges: Float32Array;
  colliders: Float32Array;
}

const climate: Climate = { moisture: 0, temperature: 0 };

function slopeAt(w: World, x: number, z: number): number {
  const f = w.field;
  const gx = (f.heightAt(x + 1, z) - f.heightAt(x - 1, z)) * 0.5;
  const gz = (f.heightAt(x, z + 1) - f.heightAt(x, z - 1)) * 0.5;
  return Math.sqrt(gx * gx + gz * gz);
}

function pushTreeColliders(col: number[], species: number, x: number, y: number, z: number, scale: number): void {
  const d = TREE_DIMENSIONS[species]!;
  const H = d.height * scale;
  if (d.trunkRadius > 0) {
    const trunkTop = H * d.crownBase;
    col.push(SHAPE.cylinder, OBJECT_KIND.tree, x, y + trunkTop / 2, z, d.trunkRadius * scale, trunkTop / 2, 0, 0);
  }
  const crownH = H * (1 - d.crownBase);
  col.push(SHAPE.cylinder, OBJECT_KIND.tree, x, y + H - crownH / 2, z, d.crownRadius * scale, crownH / 2, 0, 0);
}

function pushBox(col: number[], kind: number, cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, yaw: number): void {
  col.push(SHAPE.box, kind, cx, cy, cz, hx, hy, hz, yaw);
}

/** Trees, rocks, houses and bridges anchored in chunk (cx, cz), with their colliders. */
export function chunkObjects(w: World, cx: number, cz: number): ChunkObjects {
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
      const c = f.climate(x, z, s, climate);
      const clump = smoothstep(-0.3, 0.35, noise(clumpSeed, x * (1 / 160), z * (1 / 160)));
      // density never grows with slope, so the flat-ground density is an exact early reject
      if (u >= forestDensity(base, s, 0, c) * clump) continue;
      const slope = slopeAt(w, x, z);
      if (u >= forestDensity(base, s, slope, c) * clump) continue;
      const species = c.moisture < 0.42 ? 2 : s.h > 120 || c.temperature < 0.45 ? 0 : 1;
      const scale = 0.8 + 0.6 * u01(rehash(h0, 3));
      const yaw = TAU * u01(rehash(h0, 4));
      trees.push(x - ox, s.h, z - oz, scale, yaw, species);
      pushTreeColliders(col, species, x - ox, s.h, z - oz, scale);
    }
  }

  const m = CHUNK_SIZE / ROCK_CELL;
  const ri0 = cx * m;
  const rj0 = cz * m;
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < m; i++) {
      const h0 = hash2(seed, ri0 + i, rj0 + j, SALT.rock);
      const u = u01(h0);
      if (u > 0.35) continue;
      const x = (ri0 + i + 0.1 + 0.8 * u01(rehash(h0, 1))) * ROCK_CELL;
      const z = (rj0 + j + 0.1 + 0.8 * u01(rehash(h0, 2))) * ROCK_CELL;
      if (x * x + z * z < clear2) continue;
      f.sample(x, z, s);
      if (s.water > s.h - 0.3 || s.village > 0 || s.roadD < ROAD_HALF_WIDTH + 3) continue;
      const high = s.h > base.treeLine - 40;
      if (!high && s.mountain < 0.5 && u > 0.12) {
        const slope = slopeAt(w, x, z);
        if (slope < 0.55 || slope > 1.6) continue;
      }
      const scale = 0.6 + 1.8 * u01(rehash(h0, 3));
      const yaw = TAU * u01(rehash(h0, 4));
      rocks.push(x - ox, s.h, z - oz, scale, yaw);
      pushBox(col, OBJECT_KIND.rock, x - ox, s.h + ROCK_HALF[1] * scale * 0.6, z - oz, ROCK_HALF[0] * scale, ROCK_HALF[1] * scale, ROCK_HALF[2] * scale, yaw);
    }
  }

  const fc = f.featureCell(cx, cz);
  for (const v of fc.villages) {
    for (const hs of w.houses(v)) {
      if (hs.x < ox || hs.x >= ox + CHUNK_SIZE || hs.z < oz || hs.z >= oz + CHUNK_SIZE) continue;
      const lx = hs.x - ox;
      const lz = hs.z - oz;
      houses.push(lx, hs.y, lz, hs.w, hs.wallHeight, hs.d, hs.yaw, hs.archetype, hs.colour, hs.roofHeight);
      pushBox(col, OBJECT_KIND.house, lx, hs.y + hs.wallHeight / 2, lz, hs.w / 2, hs.wallHeight / 2, hs.d / 2, hs.yaw);
      pushBox(col, OBJECT_KIND.house, lx, hs.y + hs.wallHeight + hs.roofHeight / 2, lz, hs.w * 0.3, hs.roofHeight / 2, hs.d / 2, hs.yaw);
    }
  }

  for (const road of fc.roads) {
    for (const b of road.bridges) {
      if (b.x < ox || b.x >= ox + CHUNK_SIZE || b.z < oz || b.z >= oz + CHUNK_SIZE) continue;
      const lx = b.x - ox;
      const lz = b.z - oz;
      bridges.push(lx, b.y, lz, b.length, b.width, b.yaw);
      pushBox(col, OBJECT_KIND.bridge, lx, b.y - 0.3, lz, b.width / 2, 0.3, b.length / 2, b.yaw);
      // rails sit ±(width/2 − 0.1) along the deck's local x axis, which yaw turns to (cos, −sin)
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
