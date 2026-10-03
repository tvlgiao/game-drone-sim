/**
 * Infinite World (design 07 §3): a seeded countryside (hills, rivers, lakes, villages, roads, forests) streamed
 * around the drone out to 50 km, free fly with a 120 m AGL cap, pilot relocation on. The optional Seed Run is
 * 10 rings along a path generated from the seed; its best time is kept per world code.
 */
import type { OutdoorLevel, RingDef } from '../types';
import { dcos, dsin, PI } from '../world/math';
import { hash1, u01 } from '../world/rng';
import { routeFromWaypoints, worldObstacles, type RouteWaypoint } from '../world/routes';
import { encodeSeed } from '../world/seed-code';
import { spawnFromSeed } from '../world/spawn';
import { createWorld, GEN_VERSION, type World } from '../world/world';
import type { LevelRuntime } from './runtime';
import { outdoorEnv, timeFromSeed } from './skies';
import { streamedRuntime, type StreamedLevelOptions } from './world-runtime';

export const INFINITE_MAX_AGL = 120;
/** soft edge of the world (07 §1.7): integer hashing stays exact well inside this */
export const INFINITE_RADIUS = 50_000;
export const SEED_RUN_RINGS = 10;
const SEED_RUN_LEG = 140;
const SEED_RUN_SALT = 0x5eed;
const INFINITE_VIEW = 4200;
const PILOT_BEHIND = 6;
const EYE = 1.7;

/** A fresh random seed (crypto when available); the world itself is deterministic from it. */
export function randomSeed(): number {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.getRandomValues) return c.getRandomValues(new Uint32Array(1))[0]!;
  return Math.floor(Math.random() * 4294967296) >>> 0;
}

/** Seed Run: 10 rings on a wandering path that leaves the spawn straight ahead and turns by the seed's hash. */
export function seedRunRings(world: World, start: readonly [number, number, number], yaw: number): RingDef[] {
  const seed = world.spec.seed;
  const wps: RouteWaypoint[] = [];
  let x = start[0];
  let z = start[2];
  let heading = yaw;
  wps.push({ x, z, agl: 4 });
  for (let k = 0; k < 7; k++) {
    if (k > 0) heading += (u01(hash1(seed, k, SEED_RUN_SALT)) - 0.5) * PI * 0.7;
    // yaw 0 flies towards −Z
    x += -dsin(heading) * SEED_RUN_LEG;
    z += -dcos(heading) * SEED_RUN_LEG;
    wps.push({ x, z, agl: 8 + 14 * u01(hash1(seed, k, SEED_RUN_SALT + 1)) });
  }
  return routeFromWaypoints(world.field, wps, 3, { count: SEED_RUN_RINGS, radius: 1.75, obstacles: worldObstacles(world), maxAgl: 60 });
}

export function infiniteLevel(world: World): OutdoorLevel {
  const sp = spawnFromSeed(world);
  const [sx, , sz] = sp.position;
  // the pilot stands a few metres behind the drone, looking the way it faces
  const px = sx + dsin(sp.yaw) * PILOT_BEHIND;
  const pz = sz + dcos(sp.yaw) * PILOT_BEHIND;
  const seed = world.spec.seed >>> 0;
  const code = encodeSeed(seed, world.spec.genVersion);
  return {
    id: 'infinite',
    kind: 'outdoor',
    name: 'Infinite World',
    env: outdoorEnv(timeFromSeed(seed), INFINITE_VIEW, 0.55),
    bounds: { kind: 'rect', min: [-INFINITE_RADIUS, -INFINITE_RADIUS], max: [INFINITE_RADIUS, INFINITE_RADIUS], maxAgl: INFINITE_MAX_AGL },
    rings: seedRunRings(world, sp.position, sp.yaw),
    spawn: { position: sp.position, yaw: sp.yaw },
    pilot: [px, world.field.heightAt(px, pz) + EYE, pz],
    pilotPlatform: 2,
    world: { gen: 'terrain', genVersion: world.spec.genVersion, seed, preset: 'infinite' },
    props: [],
    statics: [],
    relocatePilot: true,
    bestKey: `infinite.${code}`,
  };
}

/** The Infinite world for `seed` (generator `genVersion`, default the current one). */
export function infiniteRuntime(seed: number, opts: StreamedLevelOptions & { genVersion?: number } = {}): LevelRuntime {
  const world = createWorld({ seed: seed >>> 0, preset: 'infinite', genVersion: opts.genVersion ?? GEN_VERSION });
  return streamedRuntime(infiniteLevel(world), world, opts);
}
