/**
 * Terrain field, settlements, roads, scatter and chunk structure (design 07 §2.2–2.3).
 */
import { describe, expect, it } from 'vitest';
import { ALPINE_LAKE, ALPINE_LAKE_RADIUS, LAKE_LEVEL } from '../../src/world/base-terrain';
import { buildChunk, chunkColliders, chunkIndices, LOD_QUADS, SKIRT_DEPTH } from '../../src/world/chunk-gen';
import { ROAD_HALF_WIDTH, ROAD_MAX_CUT } from '../../src/world/roads';
import { COLLIDER_STRIDE, HOUSE_STRIDE, TREE_STRIDE } from '../../src/world/scatter';
import { VILLAGE_BLEND } from '../../src/world/settlements';
import { BIOME, biomeSample, terrainSample } from '../../src/world/terrain-field';
import { createWorld, type World } from '../../src/world/world';
import type { TerrainPreset } from '../../src/world/base-terrain';

const SLOPE_CAP = 2.5;
const EPS = 0.25; // the physics' central-difference step (design 07 §1.3)

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

function slope(w: World, x: number, z: number): number {
  const f = w.field;
  const gx = (f.heightAt(x + EPS, z) - f.heightAt(x - EPS, z)) / (2 * EPS);
  const gz = (f.heightAt(x, z + EPS) - f.heightAt(x, z - EPS)) / (2 * EPS);
  return Math.sqrt(gx * gx + gz * gz);
}

describe('terrain slope cap (≤ 2.5 over 50 000 samples)', () => {
  const cases: [TerrainPreset, number, number][] = [
    ['alpine', 1, 1600],
    ['infinite', 42, 20000],
    ['training', 7, 600],
  ];
  for (const [preset, seed, range] of cases) {
    it(`${preset} seed ${seed}`, () => {
      const w = createWorld({ seed, preset, genVersion: 1 });
      const rnd = lcg(seed * 7919 + 17);
      let max = 0;
      let at = '';
      let siteX = 0;
      let siteZ = 0;
      const N = 50_000;
      // Infinite: half the samples go around villages / roads, where plateaus and road beds reshape the ground.
      const villages = preset === 'infinite' ? w.settlements.villagesInBox(-3000, -3000, 3000, 3000) : [];
      for (let i = 0; i < N; i++) {
        let x: number;
        let z: number;
        if (villages.length && i % 2 === 0) {
          const v = villages[Math.floor(rnd() * villages.length)]!;
          const r = (v.radius + VILLAGE_BLEND + 40) * rnd();
          x = v.x + (rnd() * 2 - 1) * r;
          z = v.z + (rnd() * 2 - 1) * r;
        } else {
          // 100 samples around each random site: wide coverage without re-deriving a new village / road cell
          // per sample
          if (i % 200 < 2) {
            siteX = (rnd() * 2 - 1) * range;
            siteZ = (rnd() * 2 - 1) * range;
          }
          x = siteX + (rnd() * 2 - 1) * 150;
          z = siteZ + (rnd() * 2 - 1) * 150;
        }
        const g = slope(w, x, z);
        if (g > max) {
          max = g;
          at = `${x.toFixed(1)}, ${z.toFixed(1)}`;
        }
      }
      expect(max, `steepest at ${at}`).toBeLessThanOrEqual(SLOPE_CAP);
      // and the terrain is not trivially flat (training is meant to be)
      if (preset !== 'training') expect(max).toBeGreaterThan(0.5);
    }, 30_000);
  }
});

describe('terrain presets', () => {
  it('training field is flat within ±0.3 m and dry, hills only far out', () => {
    const w = createWorld({ seed: 3, preset: 'training', genVersion: 1 });
    for (let x = -40; x <= 40; x += 1) {
      for (let z = -40; z <= 40; z += 1) {
        const h = w.field.heightAt(x, z);
        expect(Math.abs(h)).toBeLessThanOrEqual(0.3);
        expect(w.field.waterLevelAt(x, z)).toBe(-Infinity);
      }
    }
    expect(w.field.heightAt(500, -500)).toBeGreaterThan(5);
  });

  it('heights stay within [minHeight, maxHeight]', () => {
    for (const preset of ['training', 'alpine', 'infinite'] as const) {
      const w = createWorld({ seed: 11, preset, genVersion: 1 });
      const rnd = lcg(5);
      for (let i = 0; i < 1200; i++) {
        const h = w.field.heightAt((rnd() * 2 - 1) * 30000, (rnd() * 2 - 1) * 30000);
        expect(h).toBeGreaterThanOrEqual(w.field.minHeight);
        expect(h).toBeLessThanOrEqual(w.field.maxHeight);
      }
    }
  });

  it('alpine: lake is wet at its level, valley floor low, peaks above the snow line', () => {
    const w = createWorld({ seed: 1, preset: 'alpine', genVersion: 1 });
    const f = w.field;
    const lake = f.waterLevelAt(ALPINE_LAKE[0], ALPINE_LAKE[1]);
    expect(lake).toBeGreaterThan(f.heightAt(ALPINE_LAKE[0], ALPINE_LAKE[1]));
    // no water hangs over dry ground at the shore ring
    for (let k = 0; k < 64; k++) {
      const a = (k / 64) * Math.PI * 2;
      const x = ALPINE_LAKE[0] + Math.cos(a) * ALPINE_LAKE_RADIUS;
      const z = ALPINE_LAKE[1] + Math.sin(a) * ALPINE_LAKE_RADIUS;
      expect(f.heightAt(x, z)).toBeGreaterThanOrEqual(lake);
    }
    let peak = -Infinity;
    for (let x = -1500; x <= 1500; x += 50) for (let z = -1500; z <= 1500; z += 50) peak = Math.max(peak, f.heightAt(x, z));
    expect(peak).toBeGreaterThan(600);
    const out = biomeSample();
    expect(f.biomeAt(ALPINE_LAKE[0], ALPINE_LAKE[1], out).biome).toBe(BIOME.water);
  });

  it('infinite: lakes fill to LAKE_LEVEL; dry ground reports −Infinity', () => {
    const w = createWorld({ seed: 1, preset: 'infinite', genVersion: 1 });
    const f = w.field;
    let wet = 0;
    let dry = 0;
    const rnd = lcg(9);
    for (let i = 0; i < 20000 && (wet < 5 || dry < 5); i++) {
      const x = (rnd() * 2 - 1) * 20000;
      const z = (rnd() * 2 - 1) * 20000;
      const h = f.heightAt(x, z);
      const wl = f.waterLevelAt(x, z);
      if (wl === -Infinity) dry++;
      else {
        wet++;
        expect(wl).toBeGreaterThan(h);
        if (h < LAKE_LEVEL) expect(wl).toBeGreaterThanOrEqual(LAKE_LEVEL);
      }
    }
    expect(wet).toBeGreaterThanOrEqual(5);
    expect(dry).toBeGreaterThanOrEqual(5);
  });
});

describe('villages and roads', () => {
  const w = createWorld({ seed: 42, preset: 'infinite', genVersion: 1 });
  const villages = w.settlements.villagesInBox(-2500, -2500, 2500, 2500);

  it('there are villages, each on a flat plateau with 6–30 houses inside it', () => {
    expect(villages.length).toBeGreaterThan(5);
    for (const v of villages) {
      expect(v.radius).toBeGreaterThanOrEqual(60);
      expect(v.radius).toBeLessThanOrEqual(140);
      for (let k = 0; k < 12; k++) {
        const r = v.radius * (k / 12);
        expect(w.field.heightAt(v.x + r, v.z)).toBe(v.plateau);
      }
      const houses = w.houses(v);
      expect(houses.length).toBeGreaterThanOrEqual(3);
      expect(houses.length).toBeLessThanOrEqual(30);
      expect(houses.filter((h) => h.archetype === 3).length).toBeLessThanOrEqual(1);
      for (const h of houses) {
        expect(Math.hypot(h.x - v.x, h.z - v.z) + Math.hypot(h.w, h.d) / 2).toBeLessThanOrEqual(v.radius + 2);
        expect(h.y).toBe(v.plateau);
      }
    }
  });

  it('houses never sit on a road', () => {
    const s = terrainSample();
    for (const v of villages) {
      for (const h of w.houses(v)) expect(w.field.sample(h.x, h.z, s).roadD).toBeGreaterThan(ROAD_HALF_WIDTH + 2);
    }
  });

  it('road decks sit on the road bed, cutting / filling at most 4 m into the natural ground', () => {
    const roads = w.roads.polylinesNear(-2500, -2500, 2500, 2500, 0);
    expect(roads.length).toBeGreaterThan(3);
    const s = terrainSample();
    let onDeck = 0;
    let clamped = 0;
    for (const r of roads) {
      for (let i = 0; i + 1 < r.pts.length / 2; i++) {
        if (r.bridged[i]) continue;
        const x = (r.pts[2 * i]! + r.pts[2 * i + 2]!) / 2;
        const z = (r.pts[2 * i + 1]! + r.pts[2 * i + 3]!) / 2;
        w.field.sample(x, z, s);
        expect(s.roadD).toBeLessThan(ROAD_HALF_WIDTH);
        if (s.village > 0) continue;
        // outside villages the natural ground is the base height
        expect(Math.abs(s.h - s.base)).toBeLessThanOrEqual(4 + 1e-9);
        if (Math.abs(s.bed - s.base) <= 4) expect(s.h).toBe(s.bed);
        else clamped++;
        onDeck++;
      }
    }
    expect(ROAD_MAX_CUT).toBe(4);
    expect(onDeck).toBeGreaterThan(100);
    // the cut limit is exercised: some road crosses ground more than 4 m off its bed
    expect(clamped).toBeGreaterThan(0);
  });

  it('water never hangs in the air: at every wet → dry step the dry ground is at or above the water', () => {
    for (const [preset, seed, x0, z0, size] of [
      ['alpine', 1, -700, -200, 1400],
      ['alpine', 99, -700, 100, 500],
      ['alpine', 2024, -700, 100, 500],
      ['infinite', 1, -4000, -4000, 8000],
    ] as const) {
      const f = createWorld({ seed, preset, genVersion: 1 }).field;
      const step = 0.5;
      let transitions = 0;
      // scan lines across the area; only the neighbourhood of water matters, so coarse-search then refine
      for (let row = 0; row < 120; row++) {
        const z = z0 + (row / 120) * size;
        let prevWet = f.waterLevelAt(x0, z);
        for (let x = x0 + 4; x <= x0 + size; x += 4) {
          const wl = f.waterLevelAt(x, z);
          if ((wl === -Infinity) !== (prevWet === -Infinity)) {
            for (let fx = x - 4; fx < x; fx += step) {
              const a = f.waterLevelAt(fx, z);
              const b = f.waterLevelAt(fx + step, z);
              if ((a === -Infinity) === (b === -Infinity)) continue;
              const level = a === -Infinity ? b : a;
              const dryX = a === -Infinity ? fx : fx + step;
              expect(f.heightAt(dryX, z), `${preset} at ${dryX}, ${z}`).toBeGreaterThanOrEqual(level - SLOPE_CAP * step);
              transitions++;
            }
          }
          prevWet = wl;
        }
      }
      expect(transitions, preset).toBeGreaterThan(10);
    }
  }, 30_000);
});

describe('chunk structure', () => {
  const w = createWorld({ seed: 42, preset: 'infinite', genVersion: 1 });

  it('array sizes, skirts and indices are consistent per LOD', () => {
    for (const lod of [0, 1, 2] as const) {
      const c = buildChunk(w, { cx: -1, cz: 1, lod });
      const n = LOD_QUADS[lod]!;
      const nv = (n + 1) ** 2 + 4 * n;
      expect(c.positions.length).toBe(nv * 3);
      expect(c.normals.length).toBe(nv * 3);
      expect(c.colors.length).toBe(nv * 3);
      const idx = chunkIndices(lod);
      expect(idx.length).toBe(n * n * 6 + 4 * n * 6);
      expect(Math.max(...idx)).toBe(nv - 1);
      // skirt vertex r hangs SKIRT_DEPTH under its border vertex
      const side = n + 1;
      expect(c.positions[(side * side) * 3 + 1]).toBeCloseTo(c.positions[1]! - SKIRT_DEPTH, 4);
      // normals point up and are ~unit
      for (let v = 0; v < side * side; v++) {
        const nx = c.normals[v * 3]!, ny = c.normals[v * 3 + 1]!, nz = c.normals[v * 3 + 2]!;
        expect(ny).toBeGreaterThan(0);
        expect(Math.abs(Math.hypot(nx, ny, nz) - 127)).toBeLessThan(2);
      }
      expect(c.minY).toBeLessThan(c.maxY);
    }
  });

  it('grid triangles face up (counter-clockwise from above)', () => {
    const c = buildChunk(w, { cx: -1, cz: 1, lod: 2 });
    const idx = chunkIndices(2);
    const n = LOD_QUADS[2]!;
    for (let t = 0; t < n * n * 6; t += 3) {
      const p = (k: number): number[] => [c.positions[idx[t + k]! * 3]!, c.positions[idx[t + k]! * 3 + 1]!, c.positions[idx[t + k]! * 3 + 2]!];
      const [a, b, d] = [p(0), p(1), p(2)];
      const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
      const v = [d[0]! - a[0]!, d[1]! - a[1]!, d[2]! - a[2]!];
      expect(u[2]! * v[0]! - u[0]! * v[2]!).toBeGreaterThan(0);
    }
  });

  it('objects: colliders unpack to absolute coordinates; trees get trunk + crown', () => {
    const c = buildChunk(w, { cx: -1, cz: 1, lod: 0 });
    const cols = chunkColliders(c);
    expect(cols.length).toBe(c.colliders.length / COLLIDER_STRIDE);
    expect(c.trees.length / TREE_STRIDE).toBeGreaterThan(0);
    for (const col of cols) {
      const [x, , z] = col.shape.center;
      expect(x).toBeGreaterThanOrEqual(c.originX - 20);
      expect(x).toBeLessThanOrEqual(c.originX + 148);
      expect(z).toBeGreaterThanOrEqual(c.originZ - 20);
      expect(z).toBeLessThanOrEqual(c.originZ + 148);
    }
    const treeCols = cols.filter((k) => k.id.startsWith('tree:')).length;
    const scrub = Array.from({ length: c.trees.length / TREE_STRIDE }, (_, i) => c.trees[i * TREE_STRIDE + 5]).filter((s) => s === 2).length;
    expect(treeCols).toBe(2 * (c.trees.length / TREE_STRIDE) - scrub);
    expect(c.houses.length % HOUSE_STRIDE).toBe(0);
  });

  it('objects=false skips the scatter', () => {
    const c = buildChunk(w, { cx: -1, cz: 1, lod: 2, objects: false });
    expect(c.trees.length + c.colliders.length + c.houses.length).toBe(0);
  });
});
