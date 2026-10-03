/**
 * Generator v1. Frozen once shipped: any change that moves a height, a tree or a house is a new version
 * (generators/v2.ts) used for new worlds only, so saved v1 seeds keep reproducing the same map.
 */
import { createBaseTerrain } from '../base-terrain';
import { LruCache } from '../math';
import type { RoadSource } from '../roads';
import { FixedRoads, GridRoads, NoRoads, ROAD_HALF_WIDTH } from '../roads';
import type { House, Settlements, Village } from '../settlements';
import { FixedSettlements, GridSettlements, NoSettlements, villageLayout } from '../settlements';
import { ComposedTerrainField } from '../terrain-field';
import { segDist2 } from '../math';
import type { World, WorldSpec } from '../world';

export const V1 = 1;

/** Alpine hamlet in the valley-mouth basin, east of the stream. */
export const ALPINE_HAMLET = { x: 100, z: 1180, radius: 45, houses: 9 } as const;
/** Alpine road: hamlet → south edge, staying east of the stream. */
export const ALPINE_ROAD: readonly number[] = [100, 1180, 70, 1340, 0, 1520, -40, 1700];

export function createWorldV1(spec: WorldSpec): World {
  const base = createBaseTerrain(spec.preset, spec.seed);
  let settlements: Settlements;
  let roads: RoadSource;
  switch (spec.preset) {
    case 'infinite': {
      const grid = new GridSettlements(base, spec.seed);
      settlements = grid;
      roads = new GridRoads(base, grid, spec.seed);
      break;
    }
    case 'alpine':
      settlements = new FixedSettlements(base, spec.seed, [ALPINE_HAMLET]);
      roads = new FixedRoads(base, [ALPINE_ROAD]);
      break;
    default:
      settlements = new NoSettlements();
      roads = new NoRoads();
  }
  const field = new ComposedTerrainField(base, settlements, roads, V1);
  const layouts = new LruCache<string, House[]>(256);

  const houses = (v: Village): House[] =>
    layouts.getOrCreate(`${v.key}`, () => {
      const pad = v.radius + 20;
      const near = roads.polylinesNear(v.x - pad, v.z - pad, v.x + pad, v.z + pad, 0);
      const blocked = (x: number, z: number, r: number): boolean => {
        const lim = (r + ROAD_HALF_WIDTH) * (r + ROAD_HALF_WIDTH);
        for (const road of near) {
          const p = road.pts;
          for (let i = 0; i + 3 < p.length; i += 2) if (segDist2(x, z, p[i]!, p[i + 1]!, p[i + 2]!, p[i + 3]!) < lim) return true;
        }
        return false;
      };
      return villageLayout(v, blocked);
    });

  return { spec: Object.freeze({ ...spec }), field, base, settlements, roads, houses };
}
