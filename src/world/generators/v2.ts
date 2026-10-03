/**
 * Generator v2 (new worlds from GEN_VERSION 2; saved v1 seeds keep generators/v1.ts). Same relief, rivers,
 * villages and roads as v1; what changes is everything placed on top, branched on `genVersion` in the shared
 * modules: noise-warped village edges with gardens, hedges and tree clusters, houses facing the roads with
 * their own roof colours, forests and boulders on slopes up to 1.2, four tree species clustered into forests,
 * edges and lone trees, continuous water meshes and per-vertex rock / bank weights.
 */
import { createBaseTerrain } from '../base-terrain';
import { dcos, dsin, LruCache, segDist2 } from '../math';
import type { RoadSource } from '../roads';
import { FixedRoads, GridRoads, NoRoads, ROAD_HALF_WIDTH } from '../roads';
import type { House, RoadNear, Settlements, Village } from '../settlements';
import { FixedSettlements, GridSettlements, NoSettlements, villageLayoutV2 } from '../settlements';
import { ComposedTerrainField } from '../terrain-field';
import type { World, WorldSpec } from '../world';
import { ALPINE_HAMLET, ALPINE_ROAD } from './v1';

export const V2 = 2;

export function createWorldV2(spec: WorldSpec): World {
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
  const field = new ComposedTerrainField(base, settlements, roads, V2);
  const layouts = new LruCache<string, House[]>(256);

  const houses = (v: Village): House[] =>
    layouts.getOrCreate(`${v.key}`, () => {
      const pad = v.radius + 40;
      const near = roads.polylinesNear(v.x - pad, v.z - pad, v.x + pad, v.z + pad, 0);
      const blocked = (x: number, z: number, r: number): boolean => {
        const lim = (r + ROAD_HALF_WIDTH) * (r + ROAD_HALF_WIDTH);
        for (const road of near) {
          const p = road.pts;
          for (let i = 0; i + 3 < p.length; i += 2) if (segDist2(x, z, p[i]!, p[i + 1]!, p[i + 2]!, p[i + 3]!) < lim) return true;
        }
        return false;
      };
      const nearest = (x: number, z: number, out: RoadNear): RoadNear => {
        out.d = Infinity;
        for (const road of near) {
          const p = road.pts;
          for (let i = 0; i + 3 < p.length; i += 2) {
            const ax = p[i]!;
            const az = p[i + 1]!;
            const dx = p[i + 2]! - ax;
            const dz = p[i + 3]! - az;
            const l2 = dx * dx + dz * dz;
            const t = l2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
            const px = ax + dx * t;
            const pz = az + dz * t;
            const d = Math.sqrt((px - x) * (px - x) + (pz - z) * (pz - z));
            if (d < out.d) {
              out.d = d;
              out.px = px;
              out.pz = pz;
            }
          }
        }
        return out;
      };
      // v2 villages follow the land (no plateau): each house stands on the lowest corner of its footprint
      return villageLayoutV2(v, blocked, nearest).map((h) => {
        const c = dcos(h.yaw);
        const s = dsin(h.yaw);
        let y = field.heightAt(h.x, h.z);
        for (const [ax, az] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
          const lx = (ax * h.w) / 2;
          const lz = (az * h.d) / 2;
          y = Math.min(y, field.heightAt(h.x + c * lx + s * lz, h.z - s * lx + c * lz));
        }
        return { ...h, y: y - 0.05 };
      });
    });

  return { spec: Object.freeze({ ...spec }), field, base, settlements, roads, houses };
}
