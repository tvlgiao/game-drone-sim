/**
 * City traffic set-up: the road graph, the traffic lights, the simulation, and the race-ring check. Rings sit above
 * street level (≥ 6 m at their lowest point today); should a seed ever put a ring's volume within reach of a lane's
 * vehicle envelope, the cars on that edge stop being colliders (they never block the race: the drone flies through
 * the ring, the car is only drawn).
 */
import type { RingDef } from '../../types';
import type { City } from '../city-gen';
import { distanceToShape } from '../routes';
import { buildCityRoads, type CityRoads } from './city-roads';
import { pointAt, type Network } from './network';
import { SignalPlan } from './signals';
import { TrafficSim } from './traffic-sim';
import { VEHICLE_MAX_HEIGHT, VEHICLE_MAX_WIDTH } from './vehicles';

/** most cars the City pool holds (desktop ultra); tiers ask for fewer through `sim.target` / `sim.radius` */
export const CITY_TRAFFIC_MAX = 220;
export const CITY_TRAFFIC_RADIUS = 420;

export interface CityTraffic {
  readonly roads: CityRoads;
  readonly signals: SignalPlan;
  readonly sim: TrafficSim;
  /** 1 per edge whose vehicles could touch a race ring (cars there are not colliders) */
  readonly ringEdges: Uint8Array;
}

/** 1 per edge whose vehicle envelope (full width, ground to the tallest roof) comes within `margin` of a ring's tube. */
export function ringConflicts(net: Network, rings: readonly RingDef[], margin = 0.25): Uint8Array {
  const out = new Uint8Array(net.edges.length);
  const p = new Float64Array(3);
  const half = VEHICLE_MAX_WIDTH / 2 + 0.1;
  for (const e of net.edges) {
    for (const r of rings) {
      // quick reject: the ring's lowest point is above every roof
      const reach = r.radius + (r.tube ?? 0.12);
      if (r.position[1] - reach > VEHICLE_MAX_HEIGHT + margin + 1) continue;
      const torus = { kind: 'torus' as const, center: r.position, normal: r.direction, majorRadius: r.radius, tubeRadius: r.tube ?? 0.12 };
      for (let s = 0; s <= e.length; s += 1) {
        pointAt(e, s, p);
        const dxr = p[0]! - r.position[0];
        const dzr = p[2]! - r.position[2];
        if (dxr * dxr + dzr * dzr > (reach + half + 2) * (reach + half + 2)) continue;
        for (let y = 0; y <= VEHICLE_MAX_HEIGHT + 1e-9; y += VEHICLE_MAX_HEIGHT / 4) {
          for (const ox of [-half, 0, half]) {
            for (const oz of [-half, 0, half]) {
              if (distanceToShape(p[0]! + ox, (p[1] ?? 0) + y, p[2]! + oz, torus) < margin) {
                out[e.id] = 1;
              }
            }
          }
        }
        if (out[e.id]) break;
      }
      if (out[e.id]) break;
    }
  }
  return out;
}

export function createCityTraffic(city: City, opts: { maxCars?: number; radius?: number } = {}): CityTraffic {
  const roads = buildCityRoads(city);
  const signals = new SignalPlan(city.seed, roads.nodes.map((n) => n.approaches));
  const ringEdges = ringConflicts(roads, city.rings);
  const sim = new TrafficSim(roads, signals, {
    seed: city.seed,
    maxCars: opts.maxCars ?? CITY_TRAFFIC_MAX,
    radius: opts.radius ?? CITY_TRAFFIC_RADIUS,
    noCollide: ringEdges,
  });
  return { roads, signals, sim, ringEdges };
}
