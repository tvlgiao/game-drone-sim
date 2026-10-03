/** What bounds the drone besides level colliders: the room shell indoors, the ground outdoors. Allocation-free. */
import type { Vector3 } from 'three';
import { sphereVsPlane, sphereVsTerrain, type SphereHit } from './collision';
import type { HeightField } from './terrain';

/** Receives a boundary contact; the hit itself is in the SphereHit passed to `sphere()`. */
export type BoundaryHit = (id: string) => void;

export interface Boundary {
  /** Ground height under the drone centre at the last `begin()` (or `settle()`). */
  readonly ground: number;
  groundAt(x: number, z: number): number;
  /** Once per collision pass, with the drone centre, before the per-sphere tests. */
  begin(center: Vector3): void;
  sphere(center: Vector3, radius: number, hit: SphereHit, onHit: BoundaryHit): void;
}

/** The six hard planes of a room (floor y = 0). */
export class IndoorBoundary implements Boundary {
  readonly ground = 0;

  constructor(
    private readonly halfX: number,
    private readonly halfZ: number,
    private readonly height: number,
  ) {}

  groundAt(): number {
    return 0;
  }

  begin(): void {}

  sphere(c: Vector3, r: number, hit: SphereHit, onHit: BoundaryHit): void {
    if (sphereVsPlane(c, r, 0, 1, 0, 0, hit)) onHit('floor');
    if (sphereVsPlane(c, r, 0, -1, 0, -this.height, hit)) onHit('ceiling');
    if (sphereVsPlane(c, r, 1, 0, 0, -this.halfX, hit)) onHit('wall-west');
    if (sphereVsPlane(c, r, -1, 0, 0, -this.halfX, hit)) onHit('wall-east');
    if (sphereVsPlane(c, r, 0, 0, 1, -this.halfZ, hit)) onHit('wall-north');
    if (sphereVsPlane(c, r, 0, 0, -1, -this.halfZ, hit)) onHit('wall-south');
  }
}

/**
 * Open sky over a height field: only the ground stops the drone (leaving the level is the race's soft
 * bounds). Above NEAR_GROUND_AGL the per-sphere terrain tests are skipped: sphere offsets are ≤ 0.1 m
 * and the generator caps the slope at 2.5, so no sphere can reach the ground from there.
 */
export const NEAR_GROUND_AGL = 1;

export class OutdoorBoundary implements Boundary {
  ground = 0;
  private near = true;

  /** `id` is the contact's colliderId ('ground' on flat levels, 'terrain' on a height field). */
  constructor(
    readonly field: HeightField,
    private readonly id: string,
  ) {}

  groundAt(x: number, z: number): number {
    return this.field.heightAt(x, z);
  }

  begin(center: Vector3): void {
    this.ground = this.field.heightAt(center.x, center.z);
    this.near = center.y - this.ground <= NEAR_GROUND_AGL;
  }

  /** True when the last `begin()` found the drone close enough to the ground for sphere tests. */
  get nearGround(): boolean {
    return this.near;
  }

  sphere(c: Vector3, r: number, hit: SphereHit, onHit: BoundaryHit): void {
    if (this.near && sphereVsTerrain(c, r, this.field, hit)) onHit(this.id);
  }
}
