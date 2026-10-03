/**
 * Spawn point from a seed (design 07 §2.6): the edge of the nearest village within 600 m of the origin,
 * facing it; otherwise a square spiral from (0, 0) in 32 m steps to the first dry spot with slope < 0.08.
 * Always clear of roads, water, trees, rocks and houses.
 */
import { dcos, dsin, TAU, yawFacing } from './math';
import { chunkObjects, CHUNK_SIZE, COLLIDER_STRIDE, type ChunkObjects } from './scatter';
import type { Village } from './settlements';
import { VILLAGE_BLEND } from './settlements';
import { terrainSample } from './terrain-field';
import type { World } from './world';

export interface SpawnPoint {
  /** drone position: ground + 0.06 m, like the Training pad */
  position: [number, number, number];
  /** Object3D.rotation.y; forward (−Z) faces the village when there is one */
  yaw: number;
  village: Village | null;
}

const SPAWN_LIFT = 0.06;
const MAX_SLOPE = 0.08;
const CLEARANCE = 5;
const SPIRAL_STEP = 32;
const SPIRAL_MAX = 4096;

function nearestVillage(w: World, x: number, z: number, radius: number): Village | null {
  let best: Village | null = null;
  let bestD = radius * radius;
  for (const v of w.settlements.villagesInBox(x - radius, z - radius, x + radius, z + radius)) {
    const d = (v.x - x) * (v.x - x) + (v.z - z) * (v.z - z);
    if (d < bestD || (d === bestD && best !== null && v.key < best.key)) {
      best = v;
      bestD = d;
    }
  }
  return best;
}

export function spawnFromSeed(w: World): SpawnPoint {
  const f = w.field;
  const s = terrainSample();
  const objects = new Map<string, ChunkObjects>();

  const clearOfObjects = (x: number, z: number): boolean => {
    const cx = Math.floor(x / CHUNK_SIZE);
    const cz = Math.floor(z / CHUNK_SIZE);
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const key = `${cx + di},${cz + dj}`;
        let o = objects.get(key);
        if (!o) {
          o = chunkObjects(w, cx + di, cz + dj);
          objects.set(key, o);
        }
        const ox = (cx + di) * CHUNK_SIZE;
        const oz = (cz + dj) * CHUNK_SIZE;
        const c = o.colliders;
        for (let k = 0; k < c.length; k += COLLIDER_STRIDE) {
          const dx = ox + c[k + 2]! - x;
          const dz = oz + c[k + 4]! - z;
          const r = Math.max(c[k + 5]!, c[k + 7]!) + CLEARANCE;
          if (dx * dx + dz * dz < r * r) return false;
        }
      }
    }
    return true;
  };

  const ok = (x: number, z: number): boolean => {
    f.sample(x, z, s);
    if (s.water > s.h - 0.5 || s.roadD < 8 || s.village > 0.5) return false;
    const e = 2;
    const gx = (f.heightAt(x + e, z) - f.heightAt(x - e, z)) / (2 * e);
    const gz = (f.heightAt(x, z + e) - f.heightAt(x, z - e)) / (2 * e);
    if (gx * gx + gz * gz >= MAX_SLOPE * MAX_SLOPE) return false;
    return clearOfObjects(x, z);
  };

  const at = (x: number, z: number, village: Village | null, yaw: number): SpawnPoint => ({
    position: [x, f.heightAt(x, z) + SPAWN_LIFT, z],
    yaw,
    village,
  });

  const home = nearestVillage(w, 0, 0, 600);
  if (home) {
    const r = home.radius + VILLAGE_BLEND + 12;
    const cands: { x: number; z: number; d: number }[] = [];
    for (let k = 0; k < 16; k++) {
      const a = (TAU * k) / 16;
      const x = home.x + r * dcos(a);
      const z = home.z + r * dsin(a);
      cands.push({ x, z, d: x * x + z * z });
    }
    cands.sort((p, q) => p.d - q.d);
    for (const c of cands) if (ok(c.x, c.z)) return at(c.x, c.z, home, yawFacing(home.x - c.x, home.z - c.z));
  }

  // square spiral: (0,0), (1,0), (1,1), (0,1), (−1,1), …
  let x = 0;
  let z = 0;
  let dx = 1;
  let dz = 0;
  let leg = 1;
  let walked = 0;
  let turns = 0;
  for (let i = 0; i < SPIRAL_MAX; i++) {
    const px = x * SPIRAL_STEP;
    const pz = z * SPIRAL_STEP;
    if (ok(px, pz)) {
      const v = nearestVillage(w, px, pz, 2000);
      return at(px, pz, v, v ? yawFacing(v.x - px, v.z - pz) : 0);
    }
    x += dx;
    z += dz;
    if (++walked === leg) {
      walked = 0;
      const t = dx;
      dx = -dz;
      dz = t;
      if (++turns % 2 === 0) leg++;
    }
  }
  return at(0, 0, null, 0);
}
