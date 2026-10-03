/**
 * Ring routes over generated worlds (design 07 §3): `routeFromWaypoints` places rings along a smooth path a
 * set height above the terrain, lifts any ring that would sit within the clearance of an obstacle, and aims
 * each ring along the path tangent. Pure and deterministic.
 */
import type { ColliderShape, RingDef } from '../types';
import { catmullRom } from './base-terrain';
import { chunkColliders } from './chunk-gen';
import { dcos, dsin } from './math';
import { chunkObjects, CHUNK_SIZE } from './scatter';
import type { World } from './world';

/** Minimal terrain view the route needs (TerrainField satisfies it). */
export interface RouteTerrain {
  heightAt(x: number, z: number): number;
  waterLevelAt(x: number, z: number): number;
}

export interface RouteWaypoint {
  x: number;
  z: number;
  /** wanted height above ground at this waypoint, m */
  agl: number;
}

export interface RouteOptions {
  count: number;
  /** inner ring radius, m */
  radius: number;
  tube?: number;
  /** obstacles near (x, z) within `range` metres (e.g. chunk colliders) */
  obstacles?: (x: number, z: number, range: number) => readonly ColliderShape[];
  /** highest allowed height above ground; a ring is never pushed above it (default 40) */
  maxAgl?: number;
  idPrefix?: string;
}

/** Distance from a point to a collider's surface; negative inside. */
export function distanceToShape(px: number, py: number, pz: number, s: ColliderShape): number {
  switch (s.kind) {
    case 'box': {
      let lx = px - s.center[0];
      let lz = pz - s.center[2];
      if (s.yaw) {
        // world → local = R_y(−yaw)
        const c = dcos(s.yaw);
        const sn = dsin(s.yaw);
        const x = c * lx - sn * lz;
        const z = sn * lx + c * lz;
        lx = x;
        lz = z;
      }
      const qx = Math.abs(lx) - s.half[0];
      const qy = Math.abs(py - s.center[1]) - s.half[1];
      const qz = Math.abs(lz) - s.half[2];
      const ox = Math.max(qx, 0);
      const oy = Math.max(qy, 0);
      const oz = Math.max(qz, 0);
      return Math.sqrt(ox * ox + oy * oy + oz * oz) + Math.min(Math.max(qx, qy, qz), 0);
    }
    case 'cylinder': {
      const dx = px - s.center[0];
      const dz = pz - s.center[2];
      const qr = Math.sqrt(dx * dx + dz * dz) - s.radius;
      const qy = Math.abs(py - s.center[1]) - s.halfHeight;
      const or = Math.max(qr, 0);
      const oy = Math.max(qy, 0);
      return Math.sqrt(or * or + oy * oy) + Math.min(Math.max(qr, qy), 0);
    }
    case 'torus': {
      const dx = px - s.center[0];
      const dy = py - s.center[1];
      const dz = pz - s.center[2];
      const n = s.normal;
      const along = dx * n[0] + dy * n[1] + dz * n[2];
      const rx = dx - along * n[0];
      const ry = dy - along * n[1];
      const rz = dz - along * n[2];
      const radial = Math.sqrt(rx * rx + ry * ry + rz * rz) - s.majorRadius;
      return Math.sqrt(radial * radial + along * along) - s.tubeRadius;
    }
  }
}

/** Smallest distance from (x, y, z) to any of `shapes` (Infinity when none). */
export function clearanceAt(x: number, y: number, z: number, shapes: readonly ColliderShape[]): number {
  let best = Infinity;
  for (const s of shapes) {
    const d = distanceToShape(x, y, z, s);
    if (d < best) best = d;
  }
  return best;
}

/** Highest ground or water surface within `r` of (x, z) (centre + 8 points on two rings). */
export function groundMaxAround(t: RouteTerrain, x: number, z: number, r: number): number {
  const S = 0.7071067811865476;
  const dirs = [
    [0, 0],
    [1, 0],
    [S, S],
    [0, 1],
    [-S, S],
    [-1, 0],
    [-S, -S],
    [0, -1],
    [S, -S],
  ] as const;
  let top = -Infinity;
  for (const k of [0.5, 1]) {
    for (const [dx, dz] of dirs) {
      const px = x + dx * r * k;
      const pz = z + dz * r * k;
      const g = Math.max(t.heightAt(px, pz), t.waterLevelAt(px, pz));
      if (g > top) top = g;
    }
  }
  return top;
}

/**
 * Rings along a Catmull-Rom path through `waypoints`, evenly spaced by arc length (the first ring one
 * spacing in, the last on the final waypoint). Each ring sits at `agl` (interpolated) above the ground and
 * at least `clearance` + radius above every ground sample under it; rings closer than `clearance` to an
 * obstacle are lifted 1 m at a time. Direction = 3D tangent to the neighbouring rings.
 */
export function routeFromWaypoints(t: RouteTerrain, waypoints: readonly RouteWaypoint[], clearance: number, opts: RouteOptions): RingDef[] {
  const path = catmullRom(
    waypoints.map((w) => [w.x, w.z] as const),
    32,
  );
  const np = path.length / 2;
  const arc = new Float64Array(np);
  for (let i = 1; i < np; i++) {
    const dx = path[2 * i]! - path[2 * i - 2]!;
    const dz = path[2 * i + 1]! - path[2 * i - 1]!;
    arc[i] = arc[i - 1]! + Math.sqrt(dx * dx + dz * dz);
  }
  // waypoint arc positions: Catmull-Rom passes through each waypoint every 32 samples
  const wpArc = waypoints.map((_, i) => arc[Math.min(np - 1, i * 32)]!);
  const total = arc[np - 1]!;
  const r = opts.radius;
  const tube = opts.tube ?? 0.1;
  const maxAgl = opts.maxAgl ?? 40;
  const pts: [number, number, number][] = [];
  let seg = 0;
  for (let k = 1; k <= opts.count; k++) {
    const target = (total * k) / opts.count;
    while (seg < np - 2 && arc[seg + 1]! < target) seg++;
    const span = arc[seg + 1]! - arc[seg]!;
    const u = span > 0 ? (target - arc[seg]!) / span : 0;
    const x = path[2 * seg]! + (path[2 * seg + 2]! - path[2 * seg]!) * u;
    const z = path[2 * seg + 1]! + (path[2 * seg + 3]! - path[2 * seg + 1]!) * u;
    let w = 0;
    while (w < waypoints.length - 2 && wpArc[w + 1]! < target) w++;
    const wspan = wpArc[w + 1]! - wpArc[w]!;
    const wu = wspan > 0 ? Math.min(1, Math.max(0, (target - wpArc[w]!) / wspan)) : 0;
    const agl = waypoints[w]!.agl + (waypoints[w + 1]!.agl - waypoints[w]!.agl) * wu;
    const ground = t.heightAt(x, z);
    const floor = groundMaxAround(t, x, z, r + clearance) + r + clearance;
    let y = Math.max(ground + agl, floor);
    if (opts.obstacles) {
      const near = opts.obstacles(x, z, r + clearance + 30);
      const ceiling = ground + Math.max(maxAgl, agl);
      while (clearanceAt(x, y, z, near) < r + clearance && y < ceiling) y += 1;
    }
    pts.push([x, y, z]);
  }
  const rings: RingDef[] = [];
  const prefix = opts.idPrefix ?? 'ring';
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)]!;
    const b = pts[Math.min(pts.length - 1, i + 1)]!;
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    let dz = b[2] - a[2];
    if (i === 0) {
      // first ring: tangent from the path start
      dx = b[0] - path[0]!;
      dz = b[2] - path[1]!;
      dy = 0;
    }
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    rings.push({ id: `${prefix}-${i}`, position: pts[i]!, direction: [dx / len, dy / len, dz / len], radius: r, tube });
  }
  return rings;
}

/**
 * Alpine Valley route (design 07 §3): valley floor, forest slalom, around the lake, saddle crossing, ridge
 * run, valley return — 16 rings, ≈ 2.8 km. Waypoints (x, z, AGL) for `routeFromWaypoints`.
 */
export const ALPINE_ROUTE: readonly RouteWaypoint[] = [
  { x: -30, z: 1250, agl: 8 },
  { x: 20, z: 950, agl: 10 },
  { x: -150, z: 640, agl: 12 },
  { x: -380, z: 560, agl: 14 },
  { x: -600, z: 380, agl: 14 },
  { x: -440, z: 190, agl: 16 },
  { x: -180, z: 150, agl: 22 },
  { x: 120, z: -40, agl: 30 },
  { x: 300, z: 120, agl: 34 },
  { x: 180, z: 420, agl: 24 },
  { x: 40, z: 780, agl: 12 },
  { x: -20, z: 1100, agl: 7 },
];
export const ALPINE_RING_RADIUS = 1.75;
export const ALPINE_RING_COUNT = 16;

/** Obstacle query over a world's scattered objects (trees, rocks, houses, bridges), memoised per chunk. */
export function worldObstacles(w: World): (x: number, z: number, range: number) => ColliderShape[] {
  const cache = new Map<string, ColliderShape[]>();
  const chunk = (cx: number, cz: number): ColliderShape[] => {
    const key = `${cx},${cz}`;
    let shapes = cache.get(key);
    if (!shapes) {
      const o = chunkObjects(w, cx, cz);
      shapes = chunkColliders({ cx, cz, originX: cx * CHUNK_SIZE, originZ: cz * CHUNK_SIZE, colliders: o.colliders }).map((c) => c.shape);
      cache.set(key, shapes);
    }
    return shapes;
  };
  return (x, z, range) => {
    const out: ColliderShape[] = [];
    // object colliders reach at most ~10 m beyond their chunk (tree crowns, house boxes)
    const pad = range + 12;
    for (let cz = Math.floor((z - pad) / CHUNK_SIZE); cz <= Math.floor((z + pad) / CHUNK_SIZE); cz++) {
      for (let cx = Math.floor((x - pad) / CHUNK_SIZE); cx <= Math.floor((x + pad) / CHUNK_SIZE); cx++) {
        for (const s of chunk(cx, cz)) {
          if (s.kind === 'torus') continue;
          const ext = s.kind === 'box' ? Math.max(s.half[0], s.half[2]) * 1.4143 : s.radius;
          if (Math.abs(s.center[0] - x) <= range + ext && Math.abs(s.center[2] - z) <= range + ext) out.push(s);
        }
      }
    }
    return out;
  };
}
