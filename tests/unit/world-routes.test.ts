/**
 * City generator, ring routes (City 18 rings, Alpine 16 rings) and the seed spawn.
 */
import { describe, expect, it } from 'vitest';
import { BUILDING_STRIDE, CITY_BLOCK, CITY_BLOCKS, CITY_HALF, CITY_RING_CLEARANCE, cityObstacles, cityTerrainField, generateCity, blockMin } from '../../src/world/city-gen';
import { ALPINE_RING_COUNT, ALPINE_RING_RADIUS, ALPINE_ROUTE, clearanceAt, distanceToShape, routeFromWaypoints, worldObstacles } from '../../src/world/routes';
import { spawnFromSeed } from '../../src/world/spawn';
import { createWorld } from '../../src/world/world';

const CITY_SEEDS = [1, 42, 7, 0xffffffff, 123456];

describe('distanceToShape', () => {
  it('is signed and respects box yaw', () => {
    const box = { kind: 'box' as const, center: [0, 1, 0] as [number, number, number], half: [2, 1, 0.5] as [number, number, number], yaw: Math.PI / 2 };
    // yawed 90°: the 2 m half extent now lies along z
    expect(distanceToShape(0, 1, 1.9, box)).toBeLessThan(0);
    expect(distanceToShape(1.9, 1, 0, box)).toBeCloseTo(1.4, 6);
    const cyl = { kind: 'cylinder' as const, center: [5, 2, 5] as [number, number, number], radius: 1, halfHeight: 2 };
    expect(distanceToShape(5, 2, 5, cyl)).toBe(-1);
    expect(distanceToShape(8, 2, 5, cyl)).toBe(2);
    expect(distanceToShape(5, 7, 5, cyl)).toBe(3);
  });
});

describe('city', () => {
  for (const seed of CITY_SEEDS) {
    it(`seed ${seed}: 18 rings, none within 3 m of a collider or the ground`, () => {
      const city = generateCity(seed);
      expect(city.rings.length).toBe(18);
      const field = cityTerrainField(city, 1);
      for (const r of city.rings) {
        const [x, y, z] = r.position;
        const near = cityObstacles(city, x, z, 50);
        const all = clearanceAt(x, y, z, city.colliders.map((c) => c.shape));
        expect(clearanceAt(x, y, z, near)).toBe(all);
        expect(all, `${r.id} at ${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}`).toBeGreaterThanOrEqual(r.radius + CITY_RING_CLEARANCE);
        expect(y - r.radius - Math.max(field.heightAt(x, z), field.waterLevelAt(x, z))).toBeGreaterThanOrEqual(CITY_RING_CLEARANCE);
        expect(Math.abs(Math.hypot(...r.direction) - 1)).toBeLessThan(1e-9);
        expect(Math.abs(x)).toBeLessThan(CITY_HALF);
        expect(Math.abs(z)).toBeLessThan(CITY_HALF);
      }
      // street slalom act really is in the 15–25 m band
      for (const r of city.rings.slice(0, 6)) {
        expect(r.position[1]).toBeGreaterThanOrEqual(15);
        expect(r.position[1]).toBeLessThanOrEqual(25 + 1e-9);
      }
      let len = 0;
      for (let i = 1; i < city.rings.length; i++) {
        const a = city.rings[i - 1]!.position;
        const b = city.rings[i]!.position;
        len += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      }
      expect(len).toBeGreaterThan(2400);
    });
  }

  it('layout: buildings within their block, height classes, river column empty, skybridges between towers', () => {
    const city = generateCity(42);
    const b = city.buildings;
    const n = b.length / BUILDING_STRIDE;
    expect(n).toBeGreaterThan(300);
    let downtownTall = 0;
    for (let k = 0; k < n; k++) {
      const o = k * BUILDING_STRIDE;
      const [x, , z, w, h, d] = [b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!, b[o + 4]!, b[o + 5]!];
      const i = Math.floor((x + CITY_HALF) / 80);
      const j = Math.floor((z + CITY_HALF) / 80);
      expect(i).toBeLessThan(CITY_BLOCKS - 1);
      // inside the block minus the 2 m setback
      expect(x - w / 2).toBeGreaterThanOrEqual(blockMin(i) + 2 - 1e-3);
      expect(x + w / 2).toBeLessThanOrEqual(blockMin(i) + CITY_BLOCK - 2 + 1e-3);
      expect(z - d / 2).toBeGreaterThanOrEqual(blockMin(j) + 2 - 1e-3);
      expect(z + d / 2).toBeLessThanOrEqual(blockMin(j) + CITY_BLOCK - 2 + 1e-3);
      if (h >= 80) downtownTall++;
    }
    expect(downtownTall).toBeGreaterThan(5);
    expect(city.skybridges.length / 6).toBe(2);
    expect(city.trees.length).toBeGreaterThan(0);
    // pilot stands on a roof
    const [px, py, pz] = city.pilot;
    expect(py).toBeGreaterThan(1.7);
    expect(clearanceAt(px, py - 1.7 - 0.01, pz, city.colliders.map((c) => c.shape))).toBeLessThanOrEqual(0.01);
  });

  it('is deterministic', () => {
    const a = generateCity(5);
    const b = generateCity(5);
    expect(Array.from(a.buildings)).toEqual(Array.from(b.buildings));
    expect(a.rings).toEqual(b.rings);
    expect(Array.from(generateCity(6).buildings)).not.toEqual(Array.from(a.buildings));
  });
});

describe('alpine route', () => {
  for (const seed of [1, 7, 42]) {
    it(`seed ${seed}: 16 rings ≥ 3 m above terrain / water and clear of every tree, rock, house and bridge`, () => {
      const w = createWorld({ seed, preset: 'alpine', genVersion: 1 });
      const obstacles = worldObstacles(w);
      const rings = routeFromWaypoints(w.field, ALPINE_ROUTE, 3, { count: ALPINE_RING_COUNT, radius: ALPINE_RING_RADIUS, obstacles, maxAgl: 60 });
      expect(rings.length).toBe(16);
      let checked = 0;
      for (const r of rings) {
        const [x, y, z] = r.position;
        // ground and water under the whole ring disc
        for (let a = 0; a < 16; a++) {
          const px = x + Math.cos((a / 16) * Math.PI * 2) * r.radius;
          const pz = z + Math.sin((a / 16) * Math.PI * 2) * r.radius;
          const g = Math.max(w.field.heightAt(px, pz), w.field.waterLevelAt(px, pz));
          expect(y - r.radius - g, `${r.id}`).toBeGreaterThanOrEqual(3);
        }
        const near = obstacles(x, z, 40);
        checked += near.length;
        expect(clearanceAt(x, y, z, near), `${r.id} at ${x.toFixed(0)}, ${y.toFixed(0)}, ${z.toFixed(0)}`).toBeGreaterThanOrEqual(r.radius + 3);
        expect(y - w.field.heightAt(x, z)).toBeLessThanOrEqual(60);
      }
      // the forest is real: the check ran against trees
      expect(checked).toBeGreaterThan(50);
    });
  }

  it('without obstacle avoidance some ring would sit in a tree (the lift is load-bearing)', () => {
    let hits = 0;
    for (const seed of [1, 7, 42, 99, 1234]) {
      const w = createWorld({ seed, preset: 'alpine', genVersion: 1 });
      const obstacles = worldObstacles(w);
      const rings = routeFromWaypoints(w.field, ALPINE_ROUTE, 3, { count: ALPINE_RING_COUNT, radius: ALPINE_RING_RADIUS, maxAgl: 60 });
      for (const r of rings) if (clearanceAt(r.position[0], r.position[1], r.position[2], obstacles(r.position[0], r.position[2], 40)) < r.radius + 3) hits++;
    }
    expect(hits).toBeGreaterThan(0);
  });
});

describe('spawnFromSeed', () => {
  for (const seed of [1, 42, 0xffffffff, 2024]) {
    it(`seed ${seed}: dry, flat, clear, facing the village when one is near`, () => {
      const w = createWorld({ seed, preset: 'infinite', genVersion: 1 });
      const s = spawnFromSeed(w);
      const [x, y, z] = s.position;
      expect(y).toBeCloseTo(w.field.heightAt(x, z) + 0.06, 9);
      expect(w.field.waterLevelAt(x, z)).toBe(-Infinity);
      const e = 2;
      const gx = (w.field.heightAt(x + e, z) - w.field.heightAt(x - e, z)) / (2 * e);
      const gz = (w.field.heightAt(x, z + e) - w.field.heightAt(x, z - e)) / (2 * e);
      expect(Math.hypot(gx, gz)).toBeLessThan(0.08);
      expect(clearanceAt(x, y + 0.5, z, worldObstacles(w)(x, z, 20))).toBeGreaterThan(4);
      if (s.village) {
        // forward is −Z rotated by yaw: (−sin, −cos)
        const fx = -Math.sin(s.yaw);
        const fz = -Math.cos(s.yaw);
        const dx = s.village.x - x;
        const dz = s.village.z - z;
        expect((fx * dx + fz * dz) / Math.hypot(dx, dz)).toBeGreaterThan(0.999);
      }
      expect(spawnFromSeed(createWorld({ seed, preset: 'infinite', genVersion: 1 }))).toEqual(s);
    });
  }
});
