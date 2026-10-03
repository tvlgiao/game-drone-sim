/** Spawn and pilot spots on generated terrain: dry, gentle, clear of objects. DOM-free and deterministic. */
import type { ColliderShape } from '../types';
import { yawFacing } from '../world/math';
import { clearanceAt } from '../world/routes';
import type { TerrainField } from '../world/terrain-field';

export type Obstacles = (x: number, z: number, range: number) => ColliderShape[];

const SPAWN_LIFT = 0.06;
const EYE = 1.7;

function slope(f: TerrainField, x: number, z: number): number {
  const e = 2;
  const gx = (f.heightAt(x + e, z) - f.heightAt(x - e, z)) / (2 * e);
  const gz = (f.heightAt(x, z + e) - f.heightAt(x, z - e)) / (2 * e);
  return Math.sqrt(gx * gx + gz * gz);
}

function dry(f: TerrainField, x: number, z: number): boolean {
  return !(f.waterLevelAt(x, z) > f.heightAt(x, z) - 0.5);
}

function clear(obstacles: Obstacles, x: number, y: number, z: number, r: number): boolean {
  return clearanceAt(x, y, z, obstacles(x, z, r + 2)) >= r;
}

/**
 * The first dry spot with slope < 0.15 and 5 m of clearance on a square spiral (4 m steps) from (x, z), facing
 * `lookAt`. Falls back to (x, z).
 */
export function findSpawn(f: TerrainField, obstacles: Obstacles, x: number, z: number, lookAt: readonly [number, number, number]): { position: [number, number, number]; yaw: number } {
  let i = 0;
  let j = 0;
  let di = 1;
  let dj = 0;
  let leg = 1;
  let walked = 0;
  let turns = 0;
  for (let n = 0; n < 900; n++) {
    const px = x + i * 4;
    const pz = z + j * 4;
    const h = f.heightAt(px, pz);
    if (dry(f, px, pz) && slope(f, px, pz) < 0.15 && clear(obstacles, px, h + 1, pz, 5)) {
      return { position: [px, h + SPAWN_LIFT, pz], yaw: yawFacing(lookAt[0] - px, lookAt[2] - pz) };
    }
    i += di;
    j += dj;
    if (++walked === leg) {
      walked = 0;
      const t = di;
      di = -dj;
      dj = t;
      if (++turns % 2 === 0) leg++;
    }
  }
  return { position: [x, f.heightAt(x, z) + SPAWN_LIFT, z], yaw: yawFacing(lookAt[0] - x, lookAt[2] - z) };
}

/** True when the terrain stays below the eye → target segment (16 samples, ends excluded). */
export function seesOver(f: TerrainField, ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
  for (let k = 1; k < 16; k++) {
    const t = k / 16;
    const x = ax + (bx - ax) * t;
    const z = az + (bz - az) * t;
    if (f.heightAt(x, z) > ay + (by - ay) * t - 0.3) return false;
  }
  return true;
}

/**
 * A lookout for the LOS pilot within 25–110 m of the spawn, on the side towards `toward`: a raised, dry,
 * walkable (slope < 0.3) spot clear of objects that sees the spawn and `watch` over the terrain, at most 25 m
 * above the spawn (a knoll, not the mountain flank). Eye at ground + 1.7 m.
 */
export function findLookout(
  f: TerrainField,
  obstacles: Obstacles,
  sx: number,
  sz: number,
  toward: readonly [number, number],
  watch?: readonly [number, number, number],
): [number, number, number] {
  const sy = f.heightAt(sx, sz);
  const ax = toward[0] - sx;
  const az = toward[1] - sz;
  const al = Math.sqrt(ax * ax + az * az) || 1;
  let best: [number, number, number] | null = null;
  let bestScore = -Infinity;
  for (let r = 25; r <= 110; r += 7) {
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      const dx = Math.cos(a);
      const dz = Math.sin(a);
      // only the half-plane towards `toward` (behind the spawn, looking up the course)
      if ((dx * ax + dz * az) / al < 0.2) continue;
      const x = sx + dx * r;
      const z = sz + dz * r;
      const h = f.heightAt(x, z);
      if (h > sy + 25 || !dry(f, x, z) || slope(f, x, z) > 0.3 || !clear(obstacles, x, h + EYE, z, 2.5)) continue;
      if (!seesOver(f, x, h + EYE, z, sx, sy + 1, sz)) continue;
      if (watch && !seesOver(f, x, h + EYE, z, watch[0], watch[1], watch[2])) continue;
      const score = h - 0.08 * r;
      if (score > bestScore) {
        bestScore = score;
        best = [x, h + EYE, z];
      }
    }
  }
  return best ?? [sx, f.heightAt(sx, sz) + EYE, sz + 4];
}
