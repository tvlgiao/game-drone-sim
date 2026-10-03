/**
 * Low-rise outskirts around the City's 15 × 15 playable blocks, continuing the same street grid out to
 * OUTSKIRTS_REACH so the skyline does not end in an empty plain. Outside the level bounds: the renderer draws as
 * many rings as the quality profile allows, and the buildings within COLLIDER_REACH of the edge get colliders
 * (the drone can be out of bounds for up to 5 s). Deterministic, BUILDING_STRIDE layout.
 */
import type { Collider } from '../types';
import { BUILDING_STRIDE, CITY_BLOCK, CITY_BLOCKS, CITY_HALF, CITY_RIVER, CITY_SETBACK, blockMin } from '../world/city-gen';
import { hash2, rehash, u01 } from '../world/rng';

export const OUTSKIRTS_REACH = 1800;
export const OUTSKIRTS_COLLIDER_REACH = 320;
const SALT_OUT = 0x0b7c;

export interface Outskirts {
  /** BUILDING_STRIDE layout, kind 0; sorted by distance from the city edge (draw the first N) */
  buildings: Float32Array;
  /** distance beyond the city edge of each building (same order) */
  reach: Float32Array;
  colliders: Collider[];
}

export function cityOutskirts(seed: number): Outskirts {
  const items: { b: number[]; reach: number }[] = [];
  const colliders: Collider[] = [];
  const nBlocks = Math.ceil((OUTSKIRTS_REACH - CITY_HALF) / 80) + 1;
  for (let j = -nBlocks; j < CITY_BLOCKS + nBlocks; j++) {
    for (let i = -nBlocks; i < CITY_BLOCKS + nBlocks; i++) {
      if (i >= 0 && i < CITY_BLOCKS && j >= 0 && j < CITY_BLOCKS) continue;
      const x0 = blockMin(i);
      const z0 = blockMin(j);
      const cx = x0 + CITY_BLOCK / 2;
      const cz = z0 + CITY_BLOCK / 2;
      // the river channel runs north–south through block column 14 forever
      if (Math.abs(cx - CITY_RIVER.x) < CITY_BLOCK / 2 + CITY_RIVER.halfWidth) continue;
      const reach = Math.max(Math.abs(cx), Math.abs(cz)) - CITY_HALF;
      if (reach > OUTSKIRTS_REACH - CITY_HALF) continue;
      const h0 = hash2(seed, i, j, SALT_OUT);
      // some blocks stay open (parks, car parks, fields), more of them further out
      if (u01(h0) < 0.12 + 0.25 * (reach / (OUTSKIRTS_REACH - CITY_HALF))) continue;
      const fade = 1 - Math.min(1, reach / 900);
      const lots = 2 + Math.floor(u01(rehash(h0, 1)) * 3);
      const span = CITY_BLOCK - 2 * CITY_SETBACK;
      const across = lots <= 2 ? 1 : 2;
      const along = Math.ceil(lots / across);
      const lw = span / along;
      const ld = span / across;
      for (let a = 0; a < along; a++) {
        for (let b = 0; b < across; b++) {
          const hk = rehash(h0, 10 + a * 3 + b);
          if (u01(hk) < 0.15) continue;
          const shrink = 2 + 4 * u01(rehash(hk, 1));
          const w = lw - 2 * shrink;
          const d = ld - 2 * shrink;
          if (w < 6 || d < 6) continue;
          const x = x0 + CITY_SETBACK + lw * (a + 0.5);
          const z = z0 + CITY_SETBACK + ld * (b + 0.5);
          const h = Math.floor(6 + (8 + 22 * fade) * u01(rehash(hk, 2)));
          items.push({ b: [x, 0, z, w, h, d, hk & 0xffffff, 0], reach });
          if (reach < OUTSKIRTS_COLLIDER_REACH) {
            colliders.push({ id: `out-${i},${j}-${a}${b}`, shape: { kind: 'box', center: [x, h / 2, z], half: [w / 2, h / 2, d / 2] } });
          }
        }
      }
    }
  }
  items.sort((p, q) => p.reach - q.reach);
  const buildings = new Float32Array(items.length * BUILDING_STRIDE);
  const reachArr = new Float32Array(items.length);
  items.forEach((it, k) => {
    buildings.set(it.b, k * BUILDING_STRIDE);
    reachArr[k] = it.reach;
  });
  return { buildings, reach: reachArr, colliders };
}
