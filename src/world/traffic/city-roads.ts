/**
 * The City's road graph for traffic: intersections at every crossing of the inner street lines (14 × 14), one
 * lane per direction (right-hand traffic, on the inner lane the ground shader paints, 2.1 m right of the double
 * yellow centre line), stop lines 13 m before each intersection centre (the painted ones), connectors through the
 * box as quadratic Béziers (straight, right, left; no U-turns), and a traffic light per approach: a pole on the
 * right-hand corner with a mast arm over the lane. Pure and deterministic from the city.
 */
import type { Collider, ColliderShape } from '../../types';
import { CITY_BLOCKS, CITY_RING_CLEARANCE, streetLine, type City } from '../city-gen';
import { distanceToShape } from '../routes';
import { bezierSamples, EDGE_CONNECTOR, EDGE_LANE, makeEdge, TURN, type Edge, type Network } from './network';

/** street lines carrying traffic: 1 … 14 on both axes */
export const ROAD_LINES = CITY_BLOCKS - 1;
/** lane centre offset right of the street centre line, m */
export const LANE_OFFSET = 2.1;
/** stop line distance from the intersection centre, m (the painted one) */
export const STOP_LINE = 13;
/** city speed limit, m/s (50 km/h) */
export const CITY_LIMIT = 13.9;
/** traffic light pole: along the approach from the intersection centre, across from the street centre line, m */
export const SIGNAL_POLE_ALONG = 12.2;
export const SIGNAL_POLE_ACROSS = 8.7;
export const SIGNAL_POLE_HEIGHT = 6.2;
/** mast arm height and the head's offset from the street centre line (over the lane) */
export const SIGNAL_ARM_Y = 5.6;
export const SIGNAL_HEAD_ACROSS = 2.4;
/** short pole (no arm) where a mast arm would crowd a race ring: head height */
export const SIGNAL_SHORT_HEAD_Y = 3.1;

/** heading per approach / direction index: 0 +x, 1 +z, 2 −x, 3 −z */
export const DIR_X = [1, 0, -1, 0] as const;
export const DIR_Z = [0, 1, 0, -1] as const;

/** x, z (pole foot), yaw (head faces the approaching traffic), node, approach, short (1: head on the pole) */
export const SIGNAL_STRIDE = 6;

export interface CityRoads extends Network {
  /** traffic lights, SIGNAL_STRIDE floats each, one per (node, approach) */
  readonly signals: Float32Array;
  readonly signalColliders: Collider[];
  /** node index of (i, j), 1-based street lines; −1 outside */
  nodeIndex(i: number, j: number): number;
}

const nodeOf = (i: number, j: number): number => (i < 1 || j < 1 || i > ROAD_LINES || j > ROAD_LINES ? -1 : (j - 1) * ROAD_LINES + (i - 1));

export function buildCityRoads(city: City): CityRoads {
  const edges: Edge[] = [];
  const nodes: { x: number; z: number; approaches: number[] }[] = [];
  for (let j = 1; j <= ROAD_LINES; j++) for (let i = 1; i <= ROAD_LINES; i++) nodes.push({ x: streetLine(i), z: streetLine(j), approaches: [] });
  // lane[node * 4 + dir] = lane leaving `node` heading `dir` (−1: none)
  const laneOut = new Int32Array(nodes.length * 4).fill(-1);
  for (let j = 1; j <= ROAD_LINES; j++) {
    for (let i = 1; i <= ROAD_LINES; i++) {
      const a = nodeOf(i, j);
      for (let d = 0; d < 4; d++) {
        const b = nodeOf(i + DIR_X[d], j + DIR_Z[d]);
        if (b < 0) continue;
        const A = nodes[a]!;
        const B = nodes[b]!;
        const dx = DIR_X[d];
        const dz = DIR_Z[d];
        // right of heading (dx, dz) is (−dz, dx)
        const rx = -dz * LANE_OFFSET;
        const rz = dx * LANE_OFFSET;
        const e = makeEdge(edges.length, EDGE_LANE, [A.x + dx * STOP_LINE + rx, B.x - dx * STOP_LINE + rx], [A.z + dz * STOP_LINE + rz, B.z - dz * STOP_LINE + rz], null, { node: b, approach: d, limit: CITY_LIMIT });
        edges.push(e);
        laneOut[a * 4 + d] = e.id;
        B.approaches.push(d);
      }
    }
  }
  // connectors at the far end of every lane
  const lanes = edges.slice();
  for (const inLane of lanes) {
    const b = inLane.node;
    const d1 = inLane.approach;
    const B = nodes[b]!;
    for (const turn of [TURN.straight, TURN.right, TURN.left]) {
      const d2 = turn === TURN.straight ? d1 : turn === TURN.right ? (d1 + 1) % 4 : (d1 + 3) % 4;
      const out = laneOut[b * 4 + d2]!;
      if (out < 0) continue;
      const outLane = edges[out]!;
      const p0x = inLane.px[1]!;
      const p0z = inLane.pz[1]!;
      const p1x = outLane.px[0]!;
      const p1z = outLane.pz[0]!;
      let xs: number[];
      let zs: number[];
      if (turn === TURN.straight) {
        xs = [p0x, p1x];
        zs = [p0z, p1z];
      } else {
        // control point: where the two lane lines cross
        const cx = B.x + -DIR_Z[d1] * LANE_OFFSET + -DIR_Z[d2] * LANE_OFFSET;
        const cz = B.z + DIR_X[d1] * LANE_OFFSET + DIR_X[d2] * LANE_OFFSET;
        ({ xs, zs } = bezierSamples(p0x, p0z, cx, cz, p1x, p1z, 10));
      }
      const c = makeEdge(edges.length, EDGE_CONNECTOR, xs, zs, null, { from: inLane.id, turn, limit: turn === TURN.straight ? CITY_LIMIT : turn === TURN.right ? 5.5 : 7 });
      c.next.push(out);
      c.turns.push(TURN.straight);
      edges.push(c);
      inLane.next.push(c.id);
      inLane.turns.push(turn);
    }
  }

  // traffic lights: one per approach, on the right-hand corner before the crosswalk
  const signals: number[] = [];
  const signalColliders: Collider[] = [];
  const rings = city.rings;
  const clear = (shapes: readonly ColliderShape[]): boolean => {
    for (const r of rings) {
      const need = r.radius + CITY_RING_CLEARANCE;
      for (const sh of shapes) if (distanceToShape(r.position[0], r.position[1], r.position[2], sh) < need) return false;
    }
    return true;
  };
  nodes.forEach((B, n) => {
    for (const d of B.approaches) {
      const dx = DIR_X[d];
      const dz = DIR_Z[d];
      const rx = -dz;
      const rz = dx;
      const x = B.x - dx * SIGNAL_POLE_ALONG + rx * SIGNAL_POLE_ACROSS;
      const z = B.z - dz * SIGNAL_POLE_ALONG + rz * SIGNAL_POLE_ACROSS;
      // the head looks back down the approach: its front (local +Z) points along −heading
      const yaw = Math.abs(dx) > 0 ? (dx > 0 ? -Math.PI / 2 : Math.PI / 2) : dz > 0 ? Math.PI : 0;
      const pole: ColliderShape = { kind: 'cylinder', center: [x, SIGNAL_POLE_HEIGHT / 2, z], radius: 0.13, halfHeight: SIGNAL_POLE_HEIGHT / 2 };
      const armLen = SIGNAL_POLE_ACROSS - SIGNAL_HEAD_ACROSS + 0.4;
      const ax = x - rx * armLen * 0.5;
      const az = z - rz * armLen * 0.5;
      const arm: ColliderShape = { kind: 'box', center: [ax, SIGNAL_ARM_Y, az], half: [Math.abs(rx) * armLen * 0.5 + 0.25, 0.55, Math.abs(rz) * armLen * 0.5 + 0.25] };
      const full = clear([pole, arm]);
      const short: ColliderShape = { kind: 'cylinder', center: [x, (SIGNAL_SHORT_HEAD_Y + 0.6) / 2, z], radius: 0.25, halfHeight: (SIGNAL_SHORT_HEAD_Y + 0.6) / 2 };
      signals.push(x, z, yaw, n, d, full ? 0 : 1);
      const id = `signal:${n}:${d}`;
      if (full) signalColliders.push({ id, shape: pole }, { id, shape: arm });
      else signalColliders.push({ id, shape: short });
    }
  });

  const spawnable = lanes.map((e) => e.id);
  return {
    edges,
    nodes,
    spawnable,
    signals: Float32Array.from(signals),
    signalColliders,
    nodeIndex: nodeOf,
  };
}
