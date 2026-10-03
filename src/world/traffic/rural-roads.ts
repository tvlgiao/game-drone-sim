/**
 * Rural roads as a lane network (docs/12): every village road near a point becomes two lanes (right-hand traffic,
 * RURAL_LANE m off the centre line), following the ground (and the bridge decks over rivers). Roads end in
 * villages: a car that reaches the end of its lane leaves the simulation, and a new one starts elsewhere. No lights.
 */
import { ROAD_HALF_WIDTH, type RoadPolyline } from '../roads';
import { ROAD_LIFT } from '../chunk-gen';
import type { World } from '../world';
import { EDGE_LANE, makeEdge, type Edge, type Network } from './network';

export const RURAL_LANE = 1.45;
export const RURAL_LIMIT = 16;

function laneOf(id: number, r: RoadPolyline, world: World, forward: boolean): Edge | null {
  const p = r.pts;
  const n = p.length / 2;
  if (n < 2) return null;
  const xs: number[] = [];
  const zs: number[] = [];
  const ys: number[] = [];
  for (let k = 0; k < n; k++) {
    const i = forward ? k : n - 1 - k;
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    // the road's direction here (travel direction for this lane)
    let dx = p[b * 2]! - p[a * 2]!;
    let dz = p[b * 2 + 1]! - p[a * 2 + 1]!;
    if (!forward) {
      dx = -dx;
      dz = -dz;
    }
    const l = Math.sqrt(dx * dx + dz * dz) || 1;
    // right of the heading (dx, dz) is (−dz, dx)
    const x = p[i * 2]! + (-dz / l) * RURAL_LANE;
    const z = p[i * 2 + 1]! + (dx / l) * RURAL_LANE;
    let y = world.field.heightAt(x, z);
    // on a bridge: the deck
    const seg = Math.min(n - 2, i);
    if (r.bridged[seg] || (i > 0 && r.bridged[i - 1])) {
      let best = Infinity;
      for (const br of r.bridges) {
        const d = (br.x - x) * (br.x - x) + (br.z - z) * (br.z - z);
        if (d < best) {
          best = d;
          y = br.y;
        }
      }
    }
    xs.push(x);
    zs.push(z);
    ys.push(y + ROAD_LIFT);
  }
  return makeEdge(id, EDGE_LANE, xs, zs, ys, { limit: RURAL_LIMIT });
}

/** The roads within `radius` of (x, z) as lanes (both directions). */
export function buildRuralNetwork(world: World, x: number, z: number, radius: number): Network {
  const roads = world.roads.polylinesNear(x - radius, z - radius, x + radius, z + radius, ROAD_HALF_WIDTH);
  const edges: Edge[] = [];
  for (const r of roads) {
    for (const fwd of [true, false]) {
      const e = laneOf(edges.length, r, world, fwd);
      if (e && e.length > 60) edges.push(e);
    }
  }
  return { edges, spawnable: edges.map((e) => e.id), nodes: [] };
}
