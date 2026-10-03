/**
 * Roads (design 07 §2.2): each village links to its two nearest accepted neighbours in the 3×3 cell block
 * (union of both directions). A link is a straight line with hash-displaced points every 24 m, smoothed by
 * Chaikin ×2. Where it crosses a river or lake a bridge replaces the road bed. All lookups are memoised per
 * cell in bounded LRU caches; every cached value is a pure function of its key.
 */
import type { BaseTerrain } from './base-terrain';
import { baseSample } from './base-terrain';
import { datan2, LruCache, smoothstep } from './math';
import { hash2, rehash, SALT, u01 } from './rng';
import type { GridSettlementSource, Village } from './settlements';
import { VILLAGE_CELL } from './settlements';

export const ROAD_HALF_WIDTH = 3;
/** Terrain blends from the road bed back to natural over this distance beyond the deck edge, m. */
export const ROAD_SHOULDER = 10;
/** Most the road bed may cut into or fill above the natural terrain, m. */
export const ROAD_MAX_CUT = 4;
export const BRIDGE_WIDTH = 7;
/** Bridge deck clearance above the water surface, m. */
const BRIDGE_CLEARANCE = 2.5;
const MAX_BRIDGE = 160;
const MAX_LINK = 900;
const DISPLACE = 45;
/** Max lateral distance of a smoothed road from the straight village-to-village line. */
const CORRIDOR = DISPLACE + 1;

export interface Bridge {
  /** deck centre; y = top of the deck */
  x: number;
  y: number;
  z: number;
  length: number;
  width: number;
  /** rotation about +Y; the deck's long axis is local Z */
  yaw: number;
}

export interface RoadPolyline {
  key: string;
  /** flat [x0, z0, x1, z1, …] */
  pts: Float64Array;
  /** arc length at each vertex */
  s: Float64Array;
  /** 1 where segment i (pts i → i+1) is carried by a bridge */
  bridged: Uint8Array;
  bridges: Bridge[];
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export interface RoadSource {
  /** Polylines that may come within `margin` of the box, sorted by key. */
  polylinesNear(minX: number, minZ: number, maxX: number, maxZ: number, margin: number): RoadPolyline[];
}

function chaikin(pts: number[]): number[] {
  const n = pts.length / 2;
  if (n < 3) return pts;
  const out: number[] = [pts[0]!, pts[1]!];
  for (let i = 0; i < n - 1; i++) {
    const ax = pts[2 * i]!, az = pts[2 * i + 1]!;
    const bx = pts[2 * i + 2]!, bz = pts[2 * i + 3]!;
    out.push(0.75 * ax + 0.25 * bx, 0.75 * az + 0.25 * bz, 0.25 * ax + 0.75 * bx, 0.25 * az + 0.75 * bz);
  }
  out.push(pts[2 * n - 2]!, pts[2 * n - 1]!);
  return out;
}

/** Smooth 1D value noise in [−1, 1] from hashed control values every unit. */
function valueNoise1(h: number, t: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const a = u01(rehash(h, i + 100)) * 2 - 1;
  const b = u01(rehash(h, i + 101)) * 2 - 1;
  return a + (b - a) * f * f * (3 - 2 * f);
}

/**
 * Builds a road through `ctrl` (flat x, z pairs). `displaceHash` ≠ null bends a straight link with lateral
 * noise. Returns null when the road would need a bridge longer than MAX_BRIDGE (it is dropped).
 */
export function buildRoad(base: BaseTerrain, key: string, ctrl: readonly number[], displaceHash: number | null): RoadPolyline | null {
  let pts: number[] = [];
  if (displaceHash !== null && ctrl.length === 4) {
    const [ax, az, bx, bz] = ctrl as [number, number, number, number];
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.sqrt(dx * dx + dz * dz);
    const nx = -dz / len;
    const nz = dx / len;
    const n = Math.max(2, Math.ceil(len / 24));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const taper = smoothstep(0, 0.25, t) * smoothstep(1, 0.75, t);
      const off = DISPLACE * taper * valueNoise1(displaceHash, (t * len) / 96);
      pts.push(ax + dx * t + nx * off, az + dz * t + nz * off);
    }
  } else {
    for (let k = 0; k + 3 < ctrl.length; k += 2) {
      const ax = ctrl[k]!, az = ctrl[k + 1]!, bx = ctrl[k + 2]!, bz = ctrl[k + 3]!;
      const dx = bx - ax, dz = bz - az;
      const n = Math.max(1, Math.ceil(Math.sqrt(dx * dx + dz * dz) / 24));
      for (let j = 0; j < n; j++) pts.push(ax + (dx * j) / n, az + (dz * j) / n);
    }
    pts.push(ctrl[ctrl.length - 2]!, ctrl[ctrl.length - 1]!);
  }
  pts = chaikin(chaikin(pts));

  const nv = pts.length / 2;
  const s = new Float64Array(nv);
  for (let i = 1; i < nv; i++) {
    const dx = pts[2 * i]! - pts[2 * i - 2]!;
    const dz = pts[2 * i + 1]! - pts[2 * i - 1]!;
    s[i] = s[i - 1]! + Math.sqrt(dx * dx + dz * dz);
  }

  // Wet / river vertices; a segment touching one is bridged, runs grow by one segment each side.
  const bs = baseSample();
  const wet = new Uint8Array(nv);
  const lp = new Float64Array(nv);
  const water = new Float64Array(nv);
  for (let i = 0; i < nv; i++) {
    base.sample(pts[2 * i]!, pts[2 * i + 1]!, bs);
    lp[i] = bs.lp;
    water[i] = bs.water;
    if (bs.water > bs.lp - 0.5 || bs.water > bs.h - 0.3 || bs.riverD < base.riverHalfWidth + 8) wet[i] = 1;
  }
  const raw = new Uint8Array(nv - 1);
  for (let i = 0; i < nv - 1; i++) raw[i] = wet[i]! | wet[i + 1]!;
  const bridged = new Uint8Array(nv - 1);
  for (let i = 0; i < nv - 1; i++) if (raw[i] || (i > 0 && raw[i - 1]) || (i < nv - 2 && raw[i + 1])) bridged[i] = 1;

  const bridges: Bridge[] = [];
  for (let i = 0; i < nv - 1; ) {
    if (!bridged[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < nv - 1 && bridged[j]) j++;
    // segments i .. j-1, vertices i .. j
    const length = s[j]! - s[i]!;
    if (length > MAX_BRIDGE) return null;
    let y = Math.max(lp[i]!, lp[j]!);
    for (let k = i; k <= j; k++) if (water[k]! + BRIDGE_CLEARANCE > y) y = water[k]! + BRIDGE_CLEARANCE;
    const ax = pts[2 * i]!, az = pts[2 * i + 1]!, bx = pts[2 * j]!, bz = pts[2 * j + 1]!;
    const dx = bx - ax, dz = bz - az;
    bridges.push({ x: (ax + bx) / 2, y, z: (az + bz) / 2, length: Math.sqrt(dx * dx + dz * dz) + 4, width: BRIDGE_WIDTH, yaw: datan2(dx, dz) });
    i = j;
  }

  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < nv; i++) {
    const x = pts[2 * i]!, z = pts[2 * i + 1]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { key, pts: Float64Array.from(pts), s, bridged, bridges, minX, minZ, maxX, maxZ };
}

function nearBox(p: RoadPolyline, minX: number, minZ: number, maxX: number, maxZ: number, margin: number): boolean {
  return p.maxX >= minX - margin && p.minX <= maxX + margin && p.maxZ >= minZ - margin && p.minZ <= maxZ + margin;
}

/** Village-to-village roads over grid settlements. */
export class GridRoads implements RoadSource {
  private readonly links = new LruCache<number, Village[]>(256);
  private readonly roads = new LruCache<string, RoadPolyline | null>(512);

  constructor(
    private readonly base: BaseTerrain,
    private readonly settlements: GridSettlementSource,
    private readonly seed: number,
  ) {}

  /** Up to two nearest accepted villages in the 3×3 block around `v`'s cell. */
  linksOf(v: Village, ci: number, cj: number): Village[] {
    return this.links.getOrCreate(v.key, () => {
      const cands: { v: Village; d2: number }[] = [];
      for (let di = -1; di <= 1; di++) {
        for (let dj = -1; dj <= 1; dj++) {
          if (di === 0 && dj === 0) continue;
          const w = this.settlements.villageInCell(ci + di, cj + dj);
          if (!w) continue;
          const dx = w.x - v.x, dz = w.z - v.z;
          const d2 = dx * dx + dz * dz;
          if (d2 <= MAX_LINK * MAX_LINK) cands.push({ v: w, d2 });
        }
      }
      cands.sort((a, b) => a.d2 - b.d2 || a.v.key - b.v.key);
      return cands.slice(0, 2).map((c) => c.v);
    });
  }

  polylinesNear(minX: number, minZ: number, maxX: number, maxZ: number, margin: number): RoadPolyline[] {
    // A link joins villages in neighbouring cells and stays within CORRIDOR of its chord, so one endpoint
    // lies within two cells of any box it passes.
    const reach = margin + CORRIDOR;
    const i0 = Math.floor((minX - reach) / VILLAGE_CELL) - 1;
    const i1 = Math.floor((maxX + reach) / VILLAGE_CELL) + 1;
    const j0 = Math.floor((minZ - reach) / VILLAGE_CELL) - 1;
    const j1 = Math.floor((maxZ + reach) / VILLAGE_CELL) + 1;
    const seen = new Set<string>();
    const out: RoadPolyline[] = [];
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const v = this.settlements.villageInCell(i, j);
        if (!v) continue;
        for (const w of this.linksOf(v, i, j)) {
          const a = v.key < w.key ? v : w;
          const b = v.key < w.key ? w : v;
          const key = `${a.key}:${b.key}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const road = this.roads.getOrCreate(key, () => {
            const ha = hash2(this.seed, Math.floor(a.key / 2097152), a.key % 2097152, SALT.road);
            const h = hash2(ha, Math.floor(b.key / 2097152), b.key % 2097152, SALT.road);
            return buildRoad(this.base, key, [a.x, a.z, b.x, b.z], h);
          });
          if (road && nearBox(road, minX, minZ, maxX, maxZ, margin)) out.push(road);
        }
      }
    }
    out.sort((p, q) => (p.key < q.key ? -1 : p.key > q.key ? 1 : 0));
    return out;
  }
}

/** Authored roads (Alpine): control polylines, no displacement. */
export class FixedRoads implements RoadSource {
  readonly roads: readonly RoadPolyline[];

  constructor(base: BaseTerrain, defs: readonly (readonly number[])[]) {
    const out: RoadPolyline[] = [];
    defs.forEach((ctrl, i) => {
      const r = buildRoad(base, `fixed-${i}`, ctrl, null);
      if (r) out.push(r);
    });
    this.roads = out;
  }

  polylinesNear(minX: number, minZ: number, maxX: number, maxZ: number, margin: number): RoadPolyline[] {
    return this.roads.filter((r) => nearBox(r, minX, minZ, maxX, maxZ, margin));
  }
}

export class NoRoads implements RoadSource {
  polylinesNear(): RoadPolyline[] {
    return [];
  }
}

/** Packed non-bridged road segments [ax, az, bx, bz, …] within `margin` of a box. */
export function roadSegmentsNear(roads: readonly RoadPolyline[], minX: number, minZ: number, maxX: number, maxZ: number, margin: number): Float64Array {
  const out: number[] = [];
  for (const r of roads) {
    const p = r.pts;
    for (let i = 0; i + 3 < p.length; i += 2) {
      if (r.bridged[i >> 1]) continue;
      const ax = p[i]!, az = p[i + 1]!, bx = p[i + 2]!, bz = p[i + 3]!;
      if (Math.max(ax, bx) < minX - margin || Math.min(ax, bx) > maxX + margin) continue;
      if (Math.max(az, bz) < minZ - margin || Math.min(az, bz) > maxZ + margin) continue;
      out.push(ax, az, bx, bz);
    }
  }
  return Float64Array.from(out);
}
