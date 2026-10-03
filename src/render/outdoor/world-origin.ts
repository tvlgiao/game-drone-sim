/**
 * Floating origin (design 07 §1.7). Physics, race and generation keep absolute float64 coordinates; GPU-side data
 * (chunk vertices, instance buffers) is stored relative to this origin and the owning groups sit at the origin.
 * three.js composes model-view matrices on the CPU in float64, so the absolute offset never reaches a float32
 * buffer. Rebase moves the origin (a chunk multiple) under the drone once it is more than REBASE_DISTANCE away.
 */
import { CHUNK_SIZE } from '../../world/chunk-gen';

export const REBASE_DISTANCE = 1024;

export class WorldOrigin {
  x = 0;
  z = 0;
  /** bumps on every rebase: views holding origin-relative buffers rebuild them */
  version = 0;

  /** Rebases when (x, z) is over REBASE_DISTANCE from the origin; true when it moved. */
  follow(x: number, z: number): boolean {
    const dx = x - this.x;
    const dz = z - this.z;
    if (dx * dx + dz * dz <= REBASE_DISTANCE * REBASE_DISTANCE) return false;
    this.set(Math.floor(x / CHUNK_SIZE) * CHUNK_SIZE, Math.floor(z / CHUNK_SIZE) * CHUNK_SIZE);
    return true;
  }

  set(x: number, z: number): void {
    if (x === this.x && z === this.z) return;
    this.x = x;
    this.z = z;
    this.version++;
  }
}
