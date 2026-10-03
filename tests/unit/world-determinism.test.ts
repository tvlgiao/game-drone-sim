/**
 * World engine determinism: arithmetic-only source scan, hash golden vectors, golden heights for seeds
 * 1, 42 and 0xFFFFFFFF (bit-exact fixture, also checked in Chromium and WebKit by e2e/world-worker.spec.ts),
 * generation-order independence and LOD seams.
 *
 * Regenerate the fixture after an intentional generator change (which also needs a new GEN_VERSION):
 * `WORLD_GOLDEN_UPDATE=1 npx vitest run tests/unit/world-determinism.test.ts`.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildChunk, chunkDigest, LOD_QUADS, LOD_STEP, type ChunkData, type Lod } from '../../src/world/chunk-gen';
import { dcos, datan2, dsin } from '../../src/world/math';
import { fbm, noise } from '../../src/world/noise';
import { hash2, u01 } from '../../src/world/rng';
import { createWorld, type WorldSpec } from '../../src/world/world';
import { GOLDEN_CHUNKS, GOLDEN_POINTS, GOLDEN_SEEDS, goldenHeights } from './world-golden';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURE = join(ROOT, 'tests/unit/fixtures/world-golden.json');

interface Golden {
  heights: Record<string, Record<string, number[]>>;
  chunks: Record<string, string>;
}

function goldenNow(): Golden {
  const heights: Golden['heights'] = {};
  for (const preset of ['infinite', 'alpine', 'training'] as const) {
    heights[preset] = {};
    for (const seed of GOLDEN_SEEDS) heights[preset]![String(seed)] = goldenHeights(preset, seed);
  }
  const chunks: Golden['chunks'] = {};
  for (const g of GOLDEN_CHUNKS) chunks[g.key] = chunkDigest(buildChunk(createWorld(g.spec), g.req));
  return { heights, chunks };
}

describe('world determinism', () => {
  it('src/world uses arithmetic only (no transcendental Math, no Math.random, no Date, no **)', () => {
    // The pattern is assembled from parts so this file does not match itself.
    const fns = ['si' + 'n', 'co' + 's', 'ta' + 'n', 'asi' + 'n', 'aco' + 's', 'ata' + 'n', 'atan' + '2', 'ex' + 'p', 'expm' + '1', 'lo' + 'g', 'log' + '2', 'log' + '10', 'log1' + 'p', 'po' + 'w', 'rand' + 'om', 'hyp' + 'ot', 'cb' + 'rt', 'sin' + 'h', 'cos' + 'h', 'tan' + 'h'];
    const banned = new RegExp(`\\bMath\\.(${fns.join('|')})\\b|\\b${'Da' + 'te'}\\b|[\\w)\\]] \\*\\* `);
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    walk(join(ROOT, 'src/world'));
    expect(files.length).toBeGreaterThan(10);
    const hits: string[] = [];
    for (const f of files) {
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (banned.test(line)) hits.push(`${f.slice(ROOT.length)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(hits).toEqual([]);
  });

  it('the scan pattern does catch banned calls (guard against an empty regex)', () => {
    const banned = new RegExp(`\\bMath\\.(${['si' + 'n', 'ra' + 'ndom'].join('|')})\\b|\\b${'Da' + 'te'}\\b`);
    expect(banned.test('const a = Math.' + 'sin(x);')).toBe(true);
    expect(banned.test('new ' + 'Date()')).toBe(true);
    expect(banned.test('Math.sqrt(x)')).toBe(false);
  });

  it('hash golden vectors', () => {
    expect([hash2(0, 0, 0, 0), hash2(1, 2, 3, 4), hash2(0xffffffff, -5, 7, 41), hash2(42, -100000, 100000, 13)]).toEqual([0, 3075982334, 775000872, 2017996484]);
    expect(u01(0xffffffff)).toBeLessThan(1);
    expect(noise(7, 0.25, 0.75)).toBe(0.12063561423445437);
    expect(fbm(7, 12.3, -4.5, 4)).toBe(0.1890779684949453);
  });

  it('deterministic trig matches Math within 1e-12', () => {
    for (let k = -2000; k <= 2000; k++) {
      const x = k * 0.0731;
      expect(Math.abs(dsin(x) - Math.sin(x))).toBeLessThan(1e-12);
      expect(Math.abs(dcos(x) - Math.cos(x))).toBeLessThan(1e-12);
      const y = dsin(k * 0.37) * 3;
      const z = dcos(k * 0.51) * 2 - 0.3;
      expect(Math.abs(datan2(y, z) - Math.atan2(y, z))).toBeLessThan(1e-12);
    }
  });

  it('heightAt matches the golden fixture bit for bit (20 points × seeds 1, 42, 0xFFFFFFFF × 3 presets)', () => {
    const now = goldenNow();
    if (process.env.WORLD_GOLDEN_UPDATE) writeFileSync(FIXTURE, `${JSON.stringify(now, null, 1)}\n`);
    const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Golden;
    expect(GOLDEN_POINTS.length).toBe(20);
    for (const preset of Object.keys(fixture.heights)) {
      for (const seed of Object.keys(fixture.heights[preset]!)) {
        const want = fixture.heights[preset]![seed]!;
        const got = now.heights[preset]![seed]!;
        expect(got.length).toBe(20);
        got.forEach((h, i) => expect(Object.is(h, want[i]), `${preset} seed ${seed} point ${i}: ${h} vs ${want[i]}`).toBe(true));
      }
    }
    expect(now.chunks).toEqual(fixture.chunks);
  });

  it('goldens are not degenerate (heights vary across points and seeds)', () => {
    const a = goldenHeights('infinite', 1);
    const b = goldenHeights('infinite', 42);
    expect(new Set(a).size).toBeGreaterThan(15);
    // every point differs between seeds, the origin included (gradient noise alone is 0 on lattice points)
    expect(a.filter((h, i) => h !== b[i]).length).toBe(20);
  });
});

function vertexHeights(c: ChunkData): Map<string, number> {
  const m = new Map<string, number>();
  const n = c.gridSize;
  for (let v = 0; v < n * n; v++) m.set(`${c.originX + c.positions[v * 3]!},${c.originZ + c.positions[v * 3 + 2]!}`, c.positions[v * 3 + 1]!);
  return m;
}

describe('chunk seams and order independence', () => {
  const spec: WorldSpec = { seed: 42, preset: 'infinite', genVersion: 1 };
  // a chunk with a village, roads and a river nearby for seed 42
  const C: [number, number] = [-1, 1];

  it('LOD0/1/2 share identical heights at coinciding vertices', () => {
    const w = createWorld(spec);
    const l0 = vertexHeights(buildChunk(w, { cx: C[0], cz: C[1], lod: 0 }));
    for (const lod of [1, 2] as Lod[]) {
      const c = buildChunk(w, { cx: C[0], cz: C[1], lod });
      expect(c.gridSize).toBe(LOD_QUADS[lod]! + 1);
      let shared = 0;
      for (const [k, h] of vertexHeights(c)) {
        expect(l0.get(k), `lod${lod} vertex ${k}`).toBe(h);
        shared++;
      }
      expect(shared).toBe((LOD_QUADS[lod]! + 1) ** 2);
    }
  });

  it('neighbouring chunks agree on their shared edge at every LOD', () => {
    const w = createWorld(spec);
    for (const lod of [0, 1, 2] as Lod[]) {
      const a = vertexHeights(buildChunk(w, { cx: C[0], cz: C[1], lod }));
      const east = vertexHeights(buildChunk(w, { cx: C[0] + 1, cz: C[1], lod }));
      const south = vertexHeights(buildChunk(w, { cx: C[0], cz: C[1] + 1, lod }));
      let shared = 0;
      for (const m of [east, south]) {
        for (const [k, h] of m) {
          if (!a.has(k)) continue;
          expect(a.get(k), `lod${lod} ${k}`).toBe(h);
          shared++;
        }
      }
      expect(shared).toBe(2 * (LOD_QUADS[lod]! + 1));
      expect(LOD_STEP[lod]! * LOD_QUADS[lod]!).toBe(128);
    }
  });

  it('chunk bytes do not depend on generation order or on what was built before', () => {
    const order = (keys: [number, number][]): Map<string, string> => {
      const w = createWorld(spec);
      const out = new Map<string, string>();
      for (const [cx, cz] of keys) out.set(`${cx},${cz}`, chunkDigest(buildChunk(w, { cx, cz, lod: 0 })));
      return out;
    };
    const keys: [number, number][] = [];
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) keys.push([C[0] + dx, C[1] + dz]);
    const forward = order(keys);
    const reverse = order([...keys].reverse());
    // a world that first wandered far away (cold caches, other cells evicted) then came back
    const w = createWorld(spec);
    for (let k = 0; k < 40; k++) buildChunk(w, { cx: 200 + k * 7, cz: -150 - k * 3, lod: 2 });
    const roaming = new Map(keys.map(([cx, cz]) => [`${cx},${cz}`, chunkDigest(buildChunk(w, { cx, cz, lod: 0 }))]));
    expect(reverse).toEqual(forward);
    expect(roaming).toEqual(forward);
    // the area really has content, so the comparison is not of empty chunks
    const c = buildChunk(createWorld(spec), { cx: C[0], cz: C[1], lod: 0 });
    expect(c.trees.length + c.houses.length + c.roads.positions.length).toBeGreaterThan(0);
  });

  it('heightAt is independent of call history', () => {
    const fresh = createWorld(spec).field;
    const busy = createWorld(spec).field;
    for (let k = 0; k < 2000; k++) busy.heightAt(k * 517.3 - 30000, k * -311.9 + 9000);
    for (let k = 0; k < 200; k++) {
      const x = k * 13.7 - 900;
      const z = k * -9.1 + 700;
      expect(busy.heightAt(x, z)).toBe(fresh.heightAt(x, z));
    }
  });
});
