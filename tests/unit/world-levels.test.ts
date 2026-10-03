/**
 * City, Alpine Valley and Infinite level data: bounds and ceilings, ring counts, spawn and pilot on dry ground
 * clear of objects, relocation flags, the Infinite world being a pure function of its seed (best times keyed by
 * world code), the level event bus and the outdoor quality budgets.
 */
import { describe, expect, it } from 'vitest';
import { alpineRuntime, ALPINE_CEILING } from '../../src/levels/alpine';
import { cityRuntime, CITY_CEILING } from '../../src/levels/city';
import { cityOutskirts, OUTSKIRTS_COLLIDER_REACH } from '../../src/levels/city-outskirts';
import { INFINITE_MAX_AGL, infiniteRuntime, SEED_RUN_RINGS } from '../../src/levels/infinite';
import { LevelEvents } from '../../src/levels/level-events';
import type { LevelRuntime } from '../../src/levels/runtime';
import { duskAmount, SKIES, timeFromSeed } from '../../src/levels/skies';
import { OUTDOOR_PROFILES, outdoorProfile, scaledProfile } from '../../src/render/outdoor/outdoor-profile';
import { BUILDING_STRIDE, CITY_HALF } from '../../src/world/city-gen';
import { clearanceAt, worldObstacles } from '../../src/world/routes';
import { decodeSeed } from '../../src/world/seed-code';
import type { OutdoorLevel } from '../../src/types';
import { InlineChunkBuilder } from '../../src/world/worker/chunk-builder';
import { findLookout, seesOver } from '../../src/levels/spots';
import type { TerrainField } from '../../src/world/terrain-field';

const outdoor = (rt: LevelRuntime): OutdoorLevel => {
  if (rt.def.kind !== 'outdoor') throw new Error('expected an outdoor level');
  return rt.def;
};

describe('City', () => {
  const rt = cityRuntime();
  const def = outdoor(rt);

  it('1.2 km square, 250 m ceiling, 18 rings, no relocation, every building in the collider grid', () => {
    expect(def.bounds).toEqual({ kind: 'rect', min: [-CITY_HALF, -CITY_HALF], max: [CITY_HALF, CITY_HALF], maxAgl: CITY_CEILING });
    expect(CITY_CEILING).toBe(250);
    expect(def.rings.length).toBe(18);
    expect(def.relocatePilot).toBeFalsy();
    expect(rt.content?.kind).toBe('city');
    expect(rt.grid!.size).toBeGreaterThanOrEqual(def.statics.length);
    if (rt.content?.kind !== 'city') return;
    expect(def.statics.length).toBeGreaterThan(rt.content.city.colliders.length);
    // the pilot stands on a low roof (a building top under the feet)
    const [px, py, pz] = def.pilot;
    expect(rt.surfaces.topBelow(px, py, pz)).toBeCloseTo(py - 1.7, 3);
  });

  it('outskirts stay outside the playable blocks, sorted outwards; only the near ring gets colliders', () => {
    const o = cityOutskirts(def.world.gen === 'city' ? def.world.seed : 0);
    const n = o.buildings.length / BUILDING_STRIDE;
    expect(n).toBeGreaterThan(300);
    for (let i = 0; i < n; i++) {
      const x = o.buildings[i * BUILDING_STRIDE]!;
      const z = o.buildings[i * BUILDING_STRIDE + 2]!;
      expect(Math.max(Math.abs(x), Math.abs(z))).toBeGreaterThan(CITY_HALF);
      if (i > 0) expect(o.reach[i]!).toBeGreaterThanOrEqual(o.reach[i - 1]!);
    }
    expect(o.colliders.length).toBeGreaterThan(0);
    for (const c of o.colliders) {
      const s = c.shape;
      if (s.kind !== 'box') throw new Error('box expected');
      expect(Math.max(Math.abs(s.center[0]), Math.abs(s.center[2])) - CITY_HALF).toBeLessThan(OUTSKIRTS_COLLIDER_REACH + 40);
    }
  });
});

describe('Alpine Valley', () => {
  const rt = alpineRuntime(undefined, { builder: new InlineChunkBuilder() });
  const def = outdoor(rt);
  const field = rt.content?.kind === 'terrain' ? rt.content.world.field : null;

  it('3 × 3 km, 400 m ceiling, 16 rings, relocation on, golden-hour sky, streamed terrain', async () => {
    expect(def.bounds).toEqual({ kind: 'rect', min: [-1500, -1500], max: [1500, 1500], maxAgl: ALPINE_CEILING });
    expect(def.rings.length).toBe(16);
    expect(def.relocatePilot).toBe(true);
    expect(rt.content?.kind).toBe('terrain');
    await rt.ready;
    expect(rt.progress?.()).toBe(1);
    rt.dispose?.();
  });

  it('spawn on dry, gentle ground clear of objects; the pilot on a knoll that sees the spawn', () => {
    if (!field || rt.content?.kind !== 'terrain') throw new Error('terrain expected');
    const [sx, sy, sz] = def.spawn.position;
    expect(sy).toBeCloseTo(field.heightAt(sx, sz) + 0.06, 6);
    expect(field.waterLevelAt(sx, sz)).toBeLessThan(field.heightAt(sx, sz));
    expect(clearanceAt(sx, sy + 1, sz, worldObstacles(rt.content.world)(sx, sz, 10))).toBeGreaterThanOrEqual(5);
    const [px, py, pz] = def.pilot;
    expect(py).toBeCloseTo(field.heightAt(px, pz) + 1.7, 6);
    expect(py - sy).toBeLessThan(27);
    for (let k = 1; k < 16; k++) {
      const t = k / 16;
      expect(field.heightAt(px + (sx - px) * t, pz + (sz - pz) * t)).toBeLessThan(py + (sy + 1 - py) * t);
    }
  });
});

describe('Infinite World', () => {
  it('is a pure function of the seed: spawn, pilot, rings, sky and best-time key repeat; another seed differs', () => {
    const a = outdoor(infiniteRuntime(42, { builder: new InlineChunkBuilder() }));
    const b = outdoor(infiniteRuntime(42, { builder: new InlineChunkBuilder() }));
    const c = outdoor(infiniteRuntime(43, { builder: new InlineChunkBuilder() }));
    expect(b.spawn).toEqual(a.spawn);
    expect(b.pilot).toEqual(a.pilot);
    expect(b.rings).toEqual(a.rings);
    expect(b.env).toEqual(a.env);
    expect(c.spawn).not.toEqual(a.spawn);
    expect(a.rings.length).toBe(SEED_RUN_RINGS);
    expect(a.bounds.maxAgl).toBe(INFINITE_MAX_AGL);
    expect(a.relocatePilot).toBe(true);
    expect(a.bestKey).toMatch(/^infinite\.[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(c.bestKey).not.toBe(a.bestKey);
  });

  it('the runtime carries the seed and its code; the code decodes back to the seed', async () => {
    const rt = infiniteRuntime(0xdeadbeef, { builder: new InlineChunkBuilder() });
    if (rt.content?.kind !== 'terrain') throw new Error('terrain expected');
    expect(rt.content.seed).toBe(0xdeadbeef);
    const d = decodeSeed(rt.content.code);
    expect(d.ok && d.seed).toBe(0xdeadbeef);
    expect(rt.terrain!.heightAt(123.5, -456.25)).toBe(rt.content.world.field.heightAt(123.5, -456.25));
    await rt.ready;
    // the chunk objects around the spawn are in physics once ready
    expect(rt.grid!.size).toBeGreaterThan(0);
    rt.dispose?.();
  });

  it('time of day follows the seed and every preset is a real sky; dusk lights windows, noon does not', () => {
    const seen = new Set<string>();
    for (let s = 0; s < 64; s++) seen.add(timeFromSeed(s));
    expect([...seen].sort()).toEqual(['dawn', 'dusk', 'golden', 'noon']);
    expect(duskAmount(SKIES.noon)).toBe(0);
    expect(duskAmount(SKIES.dusk)).toBeGreaterThan(0.8);
  });
});

describe('pilot lookout', () => {
  const flat = (h: (x: number, z: number) => number): TerrainField => ({
    seed: 0,
    genVersion: 1,
    preset: 'city',
    maxHeight: 100,
    minHeight: 0,
    heightAt: h,
    baseHeightAt: h,
    waterLevelAt: () => -Infinity,
    biomeAt: (_x, _z, out) => out,
  });
  const none = (): [] => [];

  it('never picks a spot hidden from the spawn behind a ridge, nor a cliff top more than 25 m up', () => {
    // a 6 m bank 12–30 m south of the spawn hides a plateau rising behind it: the knoll stays where the spawn is in sight
    const wall = flat((x, z) => (x > -10 && z > 12 ? (z < 30 ? 6 : 4 + (z - 30) * 0.2) : 0));
    const p = findLookout(wall, none, 0, 0, [0, 300]);
    expect(p[2]).toBeLessThan(30);
    expect(seesOver(wall, p[0], p[1], p[2], 0, 1, 0)).toBe(true);
    // a 40 m mesa south of the spawn: the knoll may not be on it
    const mesa = flat((_x, z) => (z > 40 ? 40 : z > 30 ? (z - 30) * 0.2 : 0));
    const q = findLookout(mesa, none, 0, 0, [0, 300]);
    expect(q[1] - 1.7).toBeLessThanOrEqual(25);
  });
});

describe('level events', () => {
  it('delivers to every listener, survives a throwing one, remembers the loaded level and unsubscribes', () => {
    const bus = new LevelEvents();
    const got: string[] = [];
    const off = bus.on((e) => got.push(e.type));
    bus.on(() => {
      throw new Error('bad listener');
    });
    const err = console.error;
    console.error = () => undefined;
    try {
      bus.emit({ type: 'loading', id: 'infinite', seed: 1, progress: 0.5 });
      bus.emit({ type: 'loaded', level: { id: 'infinite', seed: 1, code: 'ABCD-EFGH' } });
    } finally {
      console.error = err;
    }
    expect(got).toEqual(['loading', 'loaded']);
    expect(bus.current).toEqual({ id: 'infinite', seed: 1, code: 'ABCD-EFGH' });
    off();
    bus.emit({ type: 'failed', id: 'city', error: 'x' });
    expect(got.length).toBe(2);
  });
});

describe('outdoor budgets (07 §7)', () => {
  it('Quest / low: 2-chunk radius, 350 m fog, no backdrop, no lit windows; phones never above medium', () => {
    const low = OUTDOOR_PROFILES.low;
    expect([low.stream.radius, low.fog, low.farRadius, low.facadeDetail, low.treesLod0]).toEqual([2, 350, 0, false, 0]);
    expect(outdoorProfile('ultra', 'phone')).toBe(OUTDOOR_PROFILES.medium);
    expect(outdoorProfile('ultra', 'tablet')).toBe(OUTDOOR_PROFILES.ultra);
    expect(OUTDOOR_PROFILES.ultra.stream.radius).toBe(5);
    expect(OUTDOOR_PROFILES.high.stream.radius).toBe(4);
    expect(OUTDOOR_PROFILES.medium.stream.radius).toBe(3);
  });

  it('the adaptive view scale shrinks fog and radius by 0.75 but never below 2 chunks', () => {
    const p = scaledProfile(OUTDOOR_PROFILES.ultra, 0.75);
    expect(p.stream.radius).toBe(4);
    expect(p.fog).toBeCloseTo(OUTDOOR_PROFILES.ultra.fog * 0.75, 6);
    expect(scaledProfile(OUTDOOR_PROFILES.low, 0.75).stream.radius).toBe(2);
    expect(scaledProfile(OUTDOOR_PROFILES.low, 0.5).stream.radius).toBe(2);
    expect(scaledProfile(OUTDOOR_PROFILES.high, 1)).toBe(OUTDOOR_PROFILES.high);
  });
});
