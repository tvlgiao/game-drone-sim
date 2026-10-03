/**
 * Generator v2 invariants: v1 worlds unchanged (the golden test pins them), v2 objects never on roads, water or
 * river channels, forests on slopes up to 1.2 only, boulders on cliffs, village blend continuous and warped (not a
 * disc), houses near roads facing them, continuous water that dips under dry banks, per-vertex rock / bank
 * weights, determinism. Also the City furniture keeps the 18-ring route clear.
 */
import { describe, expect, it } from 'vitest';
import { CAR_SIZE, CAR_STRIDE, cityFurniture } from '../../src/levels/city-furniture';
import { FIELD_CELL, SALT_FIELDS, fieldWeight, onTrack, parcel, parcelAt } from '../../src/world/fields';
import { buildChunk, chunkDigest, CHUNK_SIZE, LOD_QUADS } from '../../src/world/chunk-gen';
import { shadeV2, SURFACE_BANK, SURFACE_ROCK, SURFACE_STRIDE } from '../../src/world/chunk-gen-v2';
import { BIOME, biomeSample } from '../../src/world/terrain-field';
import { dcos, dsin, PI } from '../../src/world/math';
import { rehash, u01 } from '../../src/world/rng';
import { CITY_HALF, CITY_PITCH, CITY_RING_CLEARANCE, CITY_STREET, generateCity, streetLine } from '../../src/world/city-gen';
import { ROAD_HALF_WIDTH } from '../../src/world/roads';
import { distanceToShape } from '../../src/world/routes';
import { chunkObjects, HOUSE_STRIDE, ROCK_STRIDE, TREE_STRIDE, slopeAt } from '../../src/world/scatter';
import { BOULDER_SLOPE } from '../../src/world/scatter-v2';
import { houseArchetype, ROAD_FACING_V2, VILLAGE_BLEND } from '../../src/world/settlements';
import { FOREST_MAX_SLOPE_V2, terrainSample } from '../../src/world/terrain-field';
import { createWorld, GEN_VERSION, SUPPORTED_GEN_VERSIONS, type World } from '../../src/world/world';
import { InlineChunkBuilder } from '../../src/world/worker/chunk-builder';

const v2 = (seed: number, preset: 'infinite' | 'alpine' = 'infinite'): World => createWorld({ seed, preset, genVersion: 2 });

/** A village of the world near the origin (Infinite worlds have one every ~0.5 km²). */
function someVillage(w: World): { x: number; z: number; radius: number } {
  const vs = w.settlements.villagesInBox(-1500, -1500, 1500, 1500);
  expect(vs.length).toBeGreaterThan(0);
  return vs[0]!;
}

describe('generator versions', () => {
  it('new worlds are v2; v1 stays supported for saved seeds', () => {
    expect(GEN_VERSION).toBe(2);
    expect(SUPPORTED_GEN_VERSIONS).toEqual([1, 2]);
    const a = createWorld({ seed: 9, preset: 'infinite', genVersion: 1 });
    const b = v2(9);
    // same relief away from villages and roads: v2 only changes what is placed on top
    expect(b.field.baseHeightAt(4321.5, -987.25)).toBe(a.field.baseHeightAt(4321.5, -987.25));
  });

  it('v2 chunks are deterministic and carry surface weights; v1 chunks carry none', async () => {
    const w = v2(42);
    const c1 = buildChunk(w, { cx: 1, cz: -2, lod: 0 });
    const c2 = await new InlineChunkBuilder().build(w.spec, { cx: 1, cz: -2, lod: 0 });
    expect(chunkDigest(c2)).toBe(chunkDigest(c1));
    expect(c1.surface.length).toBe((c1.positions.length / 3) * SURFACE_STRIDE);
    const old = buildChunk(createWorld({ seed: 42, preset: 'infinite', genVersion: 1 }), { cx: 1, cz: -2, lod: 0 });
    expect(old.surface.length).toBe(0);
  });
});

describe('v2 scatter', () => {
  it('no tree, rock or house stands on a road, in water or in a river channel (6 seeds × 9 chunks)', () => {
    const s = terrainSample();
    let trees = 0;
    for (const seed of [1, 7, 21, 42, 99, 2026]) {
      const w = v2(seed);
      const v = someVillage(w);
      const ccx = Math.floor(v.x / CHUNK_SIZE);
      const ccz = Math.floor(v.z / CHUNK_SIZE);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const cx = ccx + dx;
          const cz = ccz + dz;
          const o = chunkObjects(w, cx, cz);
          const check = (lx: number, lz: number, clear: number): void => {
            const x = cx * CHUNK_SIZE + lx;
            const z = cz * CHUNK_SIZE + lz;
            w.field.sample(x, z, s);
            expect(s.roadD).toBeGreaterThanOrEqual(ROAD_HALF_WIDTH + clear);
            expect(s.water > s.h - 0.5).toBe(false);
            expect(s.riverD).toBeGreaterThanOrEqual(w.base.riverHalfWidth);
          };
          for (let k = 0; k < o.trees.length; k += TREE_STRIDE) {
            check(o.trees[k]!, o.trees[k + 2]!, 2.5);
            trees++;
          }
          for (let k = 0; k < o.rocks.length; k += ROCK_STRIDE) check(o.rocks[k]!, o.rocks[k + 2]!, 3);
          for (let k = 0; k < o.houses.length; k += HOUSE_STRIDE) check(o.houses[k]!, o.houses[k + 2]!, 1);
        }
      }
    }
    expect(trees).toBeGreaterThan(500);
  });

  it('forests reach steeper slopes than v1 but never past 1.2; boulders cover the cliffs; four species appear', () => {
    const w = v2(20261003, 'alpine');
    let steepTrees = 0;
    let cliffRocks = 0;
    const species = new Set<number>();
    for (let cz = 0; cz < 10; cz++) {
      for (let cx = -6; cx < 4; cx++) {
        const o = chunkObjects(w, cx, cz);
        for (let k = 0; k < o.trees.length; k += TREE_STRIDE) {
          const slope = slopeAt(w, cx * CHUNK_SIZE + o.trees[k]!, cz * CHUNK_SIZE + o.trees[k + 2]!);
          expect(slope).toBeLessThanOrEqual(FOREST_MAX_SLOPE_V2 + 1e-9);
          if (slope > 0.9) steepTrees++;
          species.add(o.trees[k + 5]!);
        }
        for (let k = 0; k < o.rocks.length; k += ROCK_STRIDE) if (slopeAt(w, cx * CHUNK_SIZE + o.rocks[k]!, cz * CHUNK_SIZE + o.rocks[k + 2]!) > BOULDER_SLOPE) cliffRocks++;
      }
    }
    expect(steepTrees).toBeGreaterThan(20);
    expect(cliffRocks).toBeGreaterThan(100);
    expect([...species].sort()).toEqual([0, 1, 2, 3]);
  });

  it('houses near a road face it (door towards the nearest road point) and carry a roof colour', () => {
    const w = v2(21);
    let checked = 0;
    for (const v of w.settlements.villagesInBox(-3000, -3000, 3000, 3000)) {
      for (const h of w.houses(v)) {
        expect(houseArchetype(h.archetype)).toBeLessThan(4);
        expect(h.archetype).toBeGreaterThanOrEqual(houseArchetype(h.archetype));
        if (houseArchetype(h.archetype) === 3) continue;
        const near = w.roads.polylinesNear(h.x - 40, h.z - 40, h.x + 40, h.z + 40, 0);
        let best = Infinity;
        let px = 0;
        let pz = 0;
        for (const r of near) {
          const p = r.pts;
          for (let i = 0; i + 3 < p.length; i += 2) {
            const ax = p[i]!;
            const az = p[i + 1]!;
            const dx = p[i + 2]! - ax;
            const dz = p[i + 3]! - az;
            const l2 = dx * dx + dz * dz;
            const t = l2 > 0 ? Math.min(1, Math.max(0, ((h.x - ax) * dx + (h.z - az) * dz) / l2)) : 0;
            const d = Math.hypot(ax + dx * t - h.x, az + dz * t - h.z);
            if (d < best) {
              best = d;
              px = ax + dx * t;
              pz = az + dz * t;
            }
          }
        }
        if (best >= ROAD_FACING_V2) continue;
        // local +Z after yaw is (sin yaw, cos yaw)
        const fx = Math.sin(h.yaw);
        const fz = Math.cos(h.yaw);
        expect((fx * (px - h.x) + fz * (pz - h.z)) / best).toBeGreaterThan(0.99);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(5);
  });
});

describe('v2 scatter near water and in the open', () => {
  it('rivers and lakes stay clear of trees and rocks; birch and shrubs grow outside villages too', () => {
    const s = terrainSample();
    let wetCells = 0;
    let open = 0;
    let birch = 0;
    for (const seed of [21, 34, 38]) {
      const w = v2(seed);
      for (let cz = -3; cz <= 3; cz++) {
        for (let cx = -3; cx <= 3; cx++) {
          for (let k = 0; k < 16; k++) {
            w.field.sample(cx * CHUNK_SIZE + (k % 4) * 32 + 16, cz * CHUNK_SIZE + Math.floor(k / 4) * 32 + 16, s);
            if (s.water > s.h) wetCells++;
          }
          const o = chunkObjects(w, cx, cz);
          const at = (lx: number, lz: number): void => {
            w.field.sample(cx * CHUNK_SIZE + lx, cz * CHUNK_SIZE + lz, s);
            expect(s.water > s.h - 0.5).toBe(false);
            expect(s.riverD).toBeGreaterThanOrEqual(w.base.riverHalfWidth + 6);
          };
          for (let k = 0; k < o.trees.length; k += TREE_STRIDE) {
            at(o.trees[k]!, o.trees[k + 2]!);
            if (s.village === 0) {
              open++;
              if (o.trees[k + 5] === 3) birch++;
            }
          }
          for (let k = 0; k < o.rocks.length; k += ROCK_STRIDE) at(o.rocks[k]!, o.rocks[k + 2]!);
        }
      }
    }
    // the area really has water to avoid
    expect(wetCells).toBeGreaterThan(5);
    expect(birch / open).toBeGreaterThan(0.08);
  });
});

describe('v2 village ground (no mesa)', () => {
  it('across the village edge the ground is never steeper than the land around it (+0.05), and never above 0.3', () => {
    let edge = 0;
    let natural = 0;
    const s = terrainSample();
    for (const seed of [1, 3, 9, 21, 42, 77]) {
      const w = v2(seed);
      const v = someVillage(w);
      for (let k = 0; k < 36; k++) {
        const a = (k / 36) * Math.PI * 2;
        let prev = NaN;
        let prevBase = NaN;
        for (let r = v.radius - 30; r <= v.radius + VILLAGE_BLEND + 5; r += 0.25) {
          w.field.sample(v.x + Math.cos(a) * r, v.z + Math.sin(a) * r, s);
          // road beds have their own cut / fill: measure the village ground only
          if (!Number.isNaN(prev) && s.roadD > 12) {
            edge = Math.max(edge, Math.abs(s.h - prev) / 0.25);
            natural = Math.max(natural, Math.abs(s.base - prevBase) / 0.25);
          }
          prev = s.h;
          prevBase = s.base;
        }
      }
    }
    expect(edge).toBeLessThanOrEqual(natural + 0.05);
    expect(edge).toBeLessThanOrEqual(0.3);
  });

  it('the village sits on the smoothed land, not on a plateau above it', () => {
    const s = terrainSample();
    for (const seed of [3, 21, 77]) {
      const w = v2(seed);
      const v = someVillage(w);
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        w.field.sample(v.x + Math.cos(a) * v.radius * 0.5, v.z + Math.sin(a) * v.radius * 0.5, s);
        if (s.roadD < 12) continue;
        expect(Math.abs(s.h - s.lp)).toBeLessThan(0.05);
      }
    }
  });
});

describe('v2 village blend', () => {
  it('the plateau edge is continuous (no step over a 0.25 m move) and warped: its radius varies around the village', () => {
    let warpSpread = 0;
    for (const seed of [3, 21, 77]) {
      const w = v2(seed);
      const v = someVillage(w);
      const s = terrainSample();
      const edge: number[] = [];
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * Math.PI * 2;
        let prevH = NaN;
        let prevV = NaN;
        let first = -1;
        for (let r = v.radius - 30; r <= v.radius + VILLAGE_BLEND + 5; r += 0.25) {
          w.field.sample(v.x + Math.cos(a) * r, v.z + Math.sin(a) * r, s);
          if (!Number.isNaN(prevH)) {
            expect(Math.abs(s.h - prevH)).toBeLessThan(0.25 * 2.5);
            expect(Math.abs(s.village - prevV)).toBeLessThan(0.05);
          }
          if (first < 0 && s.village < 0.999) first = r;
          prevH = s.h;
          prevV = s.village;
        }
        edge.push(first);
      }
      warpSpread = Math.max(warpSpread, Math.max(...edge) - Math.min(...edge));
    }
    // a disc would start blending at the same radius in every direction
    expect(warpSpread).toBeGreaterThan(8);
  });
});

describe('v2 chunk surfaces', () => {
  it('water runs on under the banks but dips below dry ground there; rock and bank weights follow slope and shore', () => {
    let dry = 0;
    let wetBank = 0;
    for (const seed of [21, 34, 38]) {
      const w = v2(seed);
      for (let cz = -4; cz <= 4; cz++) {
        for (let cx = -4; cx <= 4; cx++) {
          const c = buildChunk(w, { cx, cz, lod: 2, objects: false });
          const wp = c.water.positions;
          for (let k = 0; k < wp.length; k += 3) {
            const x = c.originX + wp[k]!;
            const z = c.originZ + wp[k + 2]!;
            const ground = w.field.heightAt(x, z);
            if (w.field.waterLevelAt(x, z) === -Infinity && ground > wp[k + 1]! - 0.01) dry++;
            // a water vertex never floats above dry ground
            if (w.field.waterLevelAt(x, z) === -Infinity) expect(wp[k + 1]!).toBeLessThanOrEqual(ground + 1e-3);
          }
          const side = LOD_QUADS[2]! + 1;
          for (let v = 0; v < side * side; v++) {
            if (c.surface[v * SURFACE_STRIDE + SURFACE_BANK]! > 200) wetBank++;
          }
        }
      }
    }
    expect(dry).toBeGreaterThan(0);
    expect(wetBank).toBeGreaterThan(0);
    // cliffs read as rock
    const alp = v2(20261003, 'alpine');
    let steep = 0;
    let steepRock = 0;
    const side = LOD_QUADS[2]! + 1;
    for (let cz = 0; cz < 10; cz += 2) {
      for (let cx = -8; cx < 6; cx += 2) {
        const a = buildChunk(alp, { cx, cz, lod: 2, objects: false });
        for (let v = 0; v < side * side; v++) {
          const ny = a.normals[v * 3 + 1]! / 127;
          const slope = Math.sqrt(1 / (ny * ny) - 1);
          if (slope > 1.3) {
            steep++;
            if (a.surface[v * SURFACE_STRIDE + SURFACE_ROCK]! > 128) steepRock++;
          }
        }
      }
    }
    expect(steep).toBeGreaterThan(10);
    expect(steepRock / steep).toBeGreaterThan(0.9);
  });
});

describe('field colours', () => {
  const SEED = 21;
  const shadeAt = (x: number, z: number, lod: number, base: [number, number, number]): number[] => {
    const b = biomeSample();
    b.biome = BIOME.meadow;
    b.height = 30;
    const out = Uint8Array.from(base);
    shadeV2(b, SEED, x, z, -Infinity, 500, 0.5, lod, out, 0, new Uint8Array(SURFACE_STRIDE), 0);
    return [out[0]!, out[1]!, out[2]!];
  };
  const lum = (c: number[]): number => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;

  it('the seam between two fields is never darker than the fields (it drew dark straight lines over dark ground)', () => {
    const p = parcel();
    let seams = 0;
    for (let k = 0; k < 40; k++) {
      // walk from one cell's feature point towards a far point until the parcel changes: that is a seam
      parcelAt(SEED, SALT_FIELDS, FIELD_CELL, 300 + k * 57, 200 + k * 31, p);
      const ax = p.px;
      const az = p.pz;
      const id = p.id;
      let sx = ax;
      let sz = az;
      for (let t = 0; t < 140; t += 0.25) {
        sx = ax + t * 0.8;
        sz = az + t * 0.6;
        parcelAt(SEED, SALT_FIELDS, FIELD_CELL, sx, sz, p);
        if (p.id !== id) break;
      }
      const other = { x: p.px, z: p.pz };
      const dark: [number, number, number] = [0x20, 0x30, 0x18];
      const seam = lum(shadeAt(sx, sz, 2, dark));
      const inside = Math.min(lum(shadeAt(ax, az, 2, dark)), lum(shadeAt(other.x, other.z, 2, dark)));
      expect(seam).toBeGreaterThanOrEqual(inside * 0.8);
      seams++;
    }
    expect(seams).toBe(40);
  });

  it('crop rows fade out with LOD: full at LOD0, half at LOD1, none at LOD2', () => {
    const p = parcel();
    const contrast = [0, 0, 0];
    for (let k = 0; k < 20; k++) {
      parcelAt(SEED, SALT_FIELDS, FIELD_CELL, 500 + k * 71, -300 + k * 43, p);
      const ang = PI * u01(rehash(p.id, 9));
      const dx = dcos(ang);
      const dz = dsin(ang);
      // two points in neighbouring 5 m furrow bands near the cell centre
      const s = p.px * dx + p.pz * dz;
      const s0 = Math.floor(s / 5) * 5 + 2.5;
      const ax = p.px + (s0 - s) * dx;
      const az = p.pz + (s0 - s) * dz;
      for (const lod of [0, 1, 2]) {
        const a = shadeAt(ax, az, lod, [0x50, 0x70, 0x30]);
        const b = shadeAt(ax + 5 * dx, az + 5 * dz, lod, [0x50, 0x70, 0x30]);
        contrast[lod] = Math.max(contrast[lod]!, Math.abs(lum(a) - lum(b)));
      }
    }
    expect(contrast[0]!).toBeGreaterThan(6);
    expect(contrast[1]!).toBeLessThan(contrast[0]! * 0.7);
    expect(contrast[1]!).toBeGreaterThan(2);
    expect(contrast[2]!).toBeLessThan(2.5);
  });
});

describe('fields and farm tracks', () => {
  it('fields are irregular Voronoi parcels (varied sizes), farmed along roads; tracks are symmetric between parcels', () => {
    const p = parcel();
    const sizes = new Map<number, number>();
    for (let z = 0; z < 700; z += 5) {
      for (let x = 0; x < 700; x += 5) {
        parcelAt(7, SALT_FIELDS, FIELD_CELL, x, z, p);
        sizes.set(p.id, (sizes.get(p.id) ?? 0) + 1);
        expect(p.edge).toBeGreaterThanOrEqual(0);
      }
    }
    const areas = [...sizes.values()].filter((n) => n > 20);
    // a checkerboard would give equal parcels
    expect(Math.max(...areas) / Math.min(...areas)).toBeGreaterThan(1.8);
    expect(fieldWeight(0, 40, 0.02, 30, false)).toBe(1);
    expect(fieldWeight(-0.5, 400, 0.02, 30, false)).toBe(0);
    expect(fieldWeight(0, 40, 0.3, 30, false)).toBe(0);
    expect(fieldWeight(0, 40, 0.02, 30, true)).toBe(0);
    const a = { ...p, id: 123, neighbour: 456, edge: 0.5 };
    const b = { ...p, id: 456, neighbour: 123, edge: 0.5 };
    expect(onTrack(a)).toBe(onTrack(b));
  });
});

describe('City furniture', () => {
  it('parked cars keep 8 m from every intersection (5 seeds)', () => {
    for (const seed of [1, 5, 42, 0x0c172026, 777]) {
      const f = cityFurniture(generateCity(seed));
      for (let k = 0; k < f.cars.length; k += CAR_STRIDE) {
        const x = f.cars[k]!;
        const z = f.cars[k + 2]!;
        // intersections are the 16 × 16 m squares around every street-line crossing
        const near = (v: number): number => {
          const l = streetLine(Math.round((v + CITY_HALF) / CITY_PITCH));
          return Math.abs(v - l);
        };
        const along = Math.abs(f.cars[k + 3]! % Math.PI) > 0.1 ? x : z;
        const dist = near(along) - CITY_STREET / 2 - CAR_SIZE[2] / 2;
        expect(dist).toBeGreaterThanOrEqual(8 - 1e-3);
      }
    }
  });

  // five cities and their furniture: ~1 s alone, several under a full parallel run (a correctness test, not a perf budget)
  it('street trees, lights and parked cars stay ring radius + 3 m clear of the 18 race rings (5 seeds)', () => {
    for (const seed of [1, 5, 42, 0x0c172026, 777]) {
      const city = generateCity(seed);
      const f = cityFurniture(city);
      expect(f.trees.length).toBeGreaterThan(0);
      expect(f.lights.length).toBeGreaterThan(0);
      expect(f.cars.length).toBeGreaterThan(0);
      for (const r of city.rings) {
        for (const c of f.colliders) expect(distanceToShape(r.position[0], r.position[1], r.position[2], c.shape)).toBeGreaterThanOrEqual(r.radius + CITY_RING_CLEARANCE - 1e-9);
      }
    }
  }, 30_000);

  it('a ring right over a street light removes that light (and anything else within its clearance)', () => {
    const city = generateCity(42);
    const free = cityFurniture({ ...city, rings: [] });
    const lx = free.lights[0]!;
    const lz = free.lights[1]!;
    const crowded = cityFurniture({ ...city, rings: [{ id: 'r', position: [lx, 10, lz], direction: [1, 0, 0], radius: 1.75, tube: 0.1 }] });
    expect(crowded.lights.length).toBe(free.lights.length - 3);
    for (let k = 0; k < crowded.lights.length; k += 3) expect([crowded.lights[k], crowded.lights[k + 1]]).not.toEqual([lx, lz]);
  });
});
