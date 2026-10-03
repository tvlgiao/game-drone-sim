/**
 * Kinematic colliders that move every frame (cars, the tractor): physics asks a MoverSource for the ones near
 * the drone each step instead of re-inserting them into the static ColliderGrid. A mover reports its velocity, so a
 * hit transfers the car's motion (the contact solver works with the relative velocity, like the loft's fan).
 */
import type { ColliderShape } from '../../types';

export interface MoverCollider {
  readonly id: string;
  readonly shape: ColliderShape;
  /** radius around shape.center enclosing the shape */
  bound: number;
  restitution: number;
  friction: number;
  /** world velocity, m/s */
  readonly velocity: [number, number, number];
}

export interface MoverSource {
  /** colliders whose extent overlaps the box [min, max] → out[0 … n) (objects reused, the array only grows) */
  queryMovers(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, out: MoverCollider[]): number;
}

/** Several sources behind one (City traffic, rural cars, the tractor); add / remove as level life comes and goes. */
export class MoverSet implements MoverSource {
  private readonly sources: MoverSource[] = [];
  private readonly scratch: MoverCollider[] = [];

  add(s: MoverSource): void {
    if (!this.sources.includes(s)) this.sources.push(s);
  }

  remove(s: MoverSource): void {
    const i = this.sources.indexOf(s);
    if (i >= 0) this.sources.splice(i, 1);
  }

  get size(): number {
    return this.sources.length;
  }

  queryMovers(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, out: MoverCollider[]): number {
    let n = 0;
    for (let k = 0; k < this.sources.length; k++) {
      const m = this.sources[k]!.queryMovers(minX, minY, minZ, maxX, maxY, maxZ, this.scratch);
      for (let i = 0; i < m; i++) {
        if (n < out.length) out[n] = this.scratch[i]!;
        else out.push(this.scratch[i]!);
        n++;
      }
    }
    return n;
  }
}
