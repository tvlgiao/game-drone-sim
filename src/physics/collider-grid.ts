/**
 * Uniform 2D spatial hash over (x, z) for outdoor colliders. Colliders arrive and leave in owned
 * batches (owner = chunk key) as the world streams; a query returns each collider once whatever
 * number of cells it spans. Queries allocate nothing once the output array has grown.
 */
import type { Collider, ColliderShape } from '../types';
import { DEFAULT_FRICTION, DEFAULT_RESTITUTION, shapeBoundingRadius } from './collision';

export const GRID_CELL = 16;

export interface GridCollider {
  readonly id: string;
  readonly shape: ColliderShape;
  /** radius of the sphere around shape.center that encloses the shape */
  readonly bound: number;
  readonly restitution: number;
  readonly friction: number;
  /** id of the last query that returned this entry */
  mark: number;
}

export type GridOwner = string | number;

/** 16 bits per axis: unique within ±524 km of the origin (the world is capped at 50 km). */
function cellKey(ix: number, iz: number): number {
  return ((ix & 0xffff) << 16) | (iz & 0xffff);
}

function cell(v: number): number {
  return Math.floor(v / GRID_CELL);
}

export class ColliderGrid {
  private readonly cells = new Map<number, GridCollider[]>();
  private readonly owners = new Map<GridOwner, GridCollider[]>();
  private queryId = 0;
  private count = 0;

  get size(): number {
    return this.count;
  }

  has(owner: GridOwner): boolean {
    return this.owners.has(owner);
  }

  /**
   * Registers `colliders` under `owner`, replacing whatever that owner had. Kinematic colliders
   * (`dynamic`) are not supported here: they live in the indoor flat list.
   */
  insertOwned(owner: GridOwner, colliders: readonly Collider[]): void {
    this.removeOwner(owner);
    const entries: GridCollider[] = [];
    for (const c of colliders) {
      if (c.dynamic) throw new Error(`ColliderGrid: kinematic collider ${c.id} is not supported outdoors`);
      const e: GridCollider = {
        id: c.id,
        shape: c.shape,
        bound: shapeBoundingRadius(c.shape),
        restitution: c.restitution ?? DEFAULT_RESTITUTION,
        friction: c.friction ?? DEFAULT_FRICTION,
        mark: 0,
      };
      entries.push(e);
      this.forCells(e, (key) => {
        const list = this.cells.get(key);
        if (list) list.push(e);
        else this.cells.set(key, [e]);
      });
    }
    this.owners.set(owner, entries);
    this.count += entries.length;
  }

  /** Drops every collider of `owner`; false when the owner had none registered. */
  removeOwner(owner: GridOwner): boolean {
    const entries = this.owners.get(owner);
    if (!entries) return false;
    for (const e of entries) {
      this.forCells(e, (key) => {
        const list = this.cells.get(key);
        if (!list) return;
        const i = list.indexOf(e);
        if (i < 0) return;
        list[i] = list[list.length - 1]!;
        list.pop();
        if (list.length === 0) this.cells.delete(key);
      });
    }
    this.owners.delete(owner);
    this.count -= entries.length;
    return true;
  }

  clear(): void {
    this.cells.clear();
    this.owners.clear();
    this.count = 0;
  }

  /**
   * Colliders whose bounding sphere's box overlaps the box [min, max] → out[0 … n), returns n.
   * Entries past n are stale; the array only grows.
   */
  query(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, out: GridCollider[]): number {
    const q = ++this.queryId;
    let n = 0;
    const ix0 = cell(minX);
    const ix1 = cell(maxX);
    const iz0 = cell(minZ);
    const iz1 = cell(maxZ);
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iz = iz0; iz <= iz1; iz++) {
        const list = this.cells.get(cellKey(ix, iz));
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const e = list[i]!;
          if (e.mark === q) continue;
          e.mark = q;
          const c = e.shape.center;
          const b = e.bound;
          if (c[0] + b < minX || c[0] - b > maxX || c[1] + b < minY || c[1] - b > maxY || c[2] + b < minZ || c[2] - b > maxZ) continue;
          if (n < out.length) out[n] = e;
          else out.push(e);
          n++;
        }
      }
    }
    return n;
  }

  /** Colliders whose bounding sphere's box overlaps the box around sphere (x, y, z, r). */
  querySphere(x: number, y: number, z: number, r: number, out: GridCollider[]): number {
    return this.query(x - r, y - r, z - r, x + r, y + r, z + r, out);
  }

  private forCells(e: GridCollider, fn: (key: number) => void): void {
    const c = e.shape.center;
    const ix1 = cell(c[0] + e.bound);
    const iz1 = cell(c[2] + e.bound);
    for (let ix = cell(c[0] - e.bound); ix <= ix1; ix++) for (let iz = cell(c[2] - e.bound); iz <= iz1; iz++) fn(cellKey(ix, iz));
  }
}

/** Top (y) of a box collider if (x, z) lies within its yawed footprint, else -Infinity. */
export function boxTopAt(shape: ColliderShape, x: number, z: number): number {
  if (shape.kind !== 'box') return -Infinity;
  const yaw = shape.yaw ?? 0;
  const dx = x - shape.center[0];
  const dz = z - shape.center[2];
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  // world → local = R_y(-yaw)
  const lx = c * dx - s * dz;
  const lz = s * dx + c * dz;
  return Math.abs(lx) <= shape.half[0] && Math.abs(lz) <= shape.half[2] ? shape.center[1] + shape.half[1] : -Infinity;
}
