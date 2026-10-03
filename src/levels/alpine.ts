/**
 * Alpine Valley (design 07 §3): 3 × 3 km of ridged mountains around a U-valley with a stream, a lake and a
 * hamlet; 16 rings along ALPINE_ROUTE (valley floor, forest, lake, saddle, ridge, back). Golden hour, pilot
 * on a knoll at the valley mouth, relocation on, ceiling 400 m AGL.
 */
import type { OutdoorLevel } from '../types';
import { ALPINE_HALF } from '../world/base-terrain';
import { ALPINE_RING_COUNT, ALPINE_RING_RADIUS, ALPINE_ROUTE, routeFromWaypoints, worldObstacles } from '../world/routes';
import { createWorld, GEN_VERSION, type World } from '../world/world';
import { outdoorEnv } from './skies';
import type { LevelRuntime } from './runtime';
import { findLookout, findSpawn } from './spots';
import { streamedRuntime, type StreamedLevelOptions } from './world-runtime';

export const ALPINE_SEED = 20261003;
export const ALPINE_CEILING = 400;
/** long golden-hour views down the valley (desktop; the quality profile caps it on phones and Quest) */
const ALPINE_VIEW = 5000;

export function alpineLevel(world: World): OutdoorLevel {
  const obstacles = worldObstacles(world);
  const rings = routeFromWaypoints(world.field, ALPINE_ROUTE, 3, { count: ALPINE_RING_COUNT, radius: ALPINE_RING_RADIUS, obstacles, maxAgl: 60 });
  const first = ALPINE_ROUTE[0]!;
  // on the valley floor a little south of the first waypoint, nose up the valley (towards ring 0)
  const spawn = findSpawn(world.field, obstacles, first.x, first.z + 45, rings[0]!.position);
  // a knoll behind the spawn: the pilot sees the take-off and the route climbing up the valley
  const pilot = findLookout(world.field, obstacles, spawn.position[0], spawn.position[2], [spawn.position[0], spawn.position[2] + 300], rings[0]!.position);
  return {
    id: 'alpine',
    kind: 'outdoor',
    name: 'Alpine Valley',
    env: outdoorEnv('alpine', ALPINE_VIEW, 0.6),
    bounds: { kind: 'rect', min: [-ALPINE_HALF, -ALPINE_HALF], max: [ALPINE_HALF, ALPINE_HALF], maxAgl: ALPINE_CEILING },
    rings,
    spawn,
    pilot,
    pilotPlatform: 2,
    world: { gen: 'terrain', genVersion: world.spec.genVersion, seed: world.spec.seed, preset: 'alpine' },
    props: [],
    statics: [],
    relocatePilot: true,
  };
}

export function alpineRuntime(seed = ALPINE_SEED, opts: StreamedLevelOptions = {}): LevelRuntime {
  const world = createWorld({ seed, preset: 'alpine', genVersion: GEN_VERSION });
  return streamedRuntime(alpineLevel(world), world, { ...opts, half: ALPINE_HALF });
}
