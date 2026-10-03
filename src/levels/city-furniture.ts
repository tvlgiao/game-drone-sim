/**
 * City street furniture: street trees and street lights on the sidewalks, parked cars in the kerb lanes, and
 * the kerbs themselves. Deterministic from the city seed, inside the playable blocks only, never in an
 * intersection, a crosswalk or the river column. Trees, lights and cars are colliders (what the pilot sees is
 * what the drone hits); kerbs are 15 cm and only drawn. Anything that would come within ring radius + 3 m of a
 * race ring is left out, so the 18-ring route stays clear.
 */
import type { Collider } from '../types';
import { CITY_BLOCK, CITY_BLOCKS, CITY_RING_CLEARANCE, CITY_STREET, blockMin, streetLine, type City } from '../world/city-gen';
import { distanceToShape } from '../world/routes';
import type { ColliderShape } from '../types';
import { hash2, rehash, u01 } from '../world/rng';
import { TREE_DIMENSIONS, TREE_STRIDE } from '../world/scatter';

/** x, y, z, yaw, colour (0xRRGGBB) */
export const CAR_STRIDE = 5;
/** x, z, yaw (the arm reaches over the street along local +Z) */
export const LIGHT_STRIDE = 3;
/** x, z, length, yaw */
export const KERB_STRIDE = 4;
export const CAR_SIZE: readonly [number, number, number] = [1.9, 1.5, 4.4];
/** parked cars keep at least this distance (m) from the edge of every intersection */
export const CAR_INTERSECTION_GAP = 8;
export const LIGHT_HEIGHT = 8;
export const STREET_TREE_SCALE = 0.62;
/** sidewalk offset of trees / lights from the street centre line, m */
export const FURNITURE_OFFSET = CITY_STREET / 2 + 1.4;
/** parked cars sit this far from the street centre line, m */
export const PARKING_OFFSET = CITY_STREET / 2 - 1.3;
const SALT_FURNITURE = 0x5f1;
const CAR_COLOURS = [0x1d2a3a, 0xb8bcc0, 0x7a1c1c, 0x2d3d2a, 0xe4e2dc, 0x303033, 0x8a6a2a, 0x24456e];

export interface CityFurniture {
  /** street trees in the TREE_STRIDE layout, absolute coordinates (broadleaf / birch) */
  trees: Float32Array;
  lights: Float32Array;
  cars: Float32Array;
  kerbs: Float32Array;
  colliders: Collider[];
}

export function cityFurniture(city: City): CityFurniture {
  const trees: number[] = [];
  const lights: number[] = [];
  const cars: number[] = [];
  const kerbs: number[] = [];
  const colliders: Collider[] = [];
  const seed = city.seed;
  const rings = city.rings;
  /** false when the shapes would crowd a ring (ring radius + clearance, like the route generator) */
  const clearOfRings = (shapes: readonly ColliderShape[]): boolean => {
    for (const r of rings) {
      const need = r.radius + CITY_RING_CLEARANCE;
      for (const sh of shapes) if (distanceToShape(r.position[0], r.position[1], r.position[2], sh) < need) return false;
    }
    return true;
  };
  const playable = (i: number, j: number): boolean => i >= 0 && j >= 0 && i < CITY_BLOCKS && j < CITY_BLOCKS && city.blockClass(i, j) !== 'river';

  // Each street segment between two intersections: streets run along x (at z = streetLine(j)) and along z.
  for (let j = 1; j < CITY_BLOCKS; j++) {
    for (let i = 0; i < CITY_BLOCKS; i++) {
      for (const alongX of [true, false]) {
        // segment beside block (i, j-1) / (i, j): along x at z = streetLine(j); along z at x = streetLine(j) beside (j-1, i) / (j, i)
        const a = alongX ? playable(i, j - 1) && playable(i, j) : playable(j - 1, i) && playable(j, i);
        if (!a) continue;
        const line = streetLine(j);
        const s0 = blockMin(i) + 6;
        const s1 = blockMin(i) + CITY_BLOCK - 6;
        const h = hash2(seed, i, j * 2 + (alongX ? 0 : 1), SALT_FURNITURE);
        const at = (s: number, off: number): [number, number] => (alongX ? [s, line + off] : [line + off, s]);
        const downtown = alongX ? city.blockClass(i, j) === 'downtown' : city.blockClass(j, i) === 'downtown';
        const yawAlong = alongX ? Math.PI / 2 : 0;
        for (const side of [-1, 1]) {
          // trees every 13 m on both sidewalks; street lights between them, staggered from side to side
          for (let k = 0, s = s0; s <= s1; k++, s += 13) {
            const hk = rehash(h, 10 + k * 2 + (side > 0 ? 1 : 0));
            const [x, z] = at(s, side * FURNITURE_OFFSET);
            if (k % 2 === 1 && (k + (side > 0 ? 1 : 0) + i + j) % 4 < 2) {
              const yaw = alongX ? (side > 0 ? Math.PI : 0) : side > 0 ? -Math.PI / 2 : Math.PI / 2;
              const pole: ColliderShape = { kind: 'cylinder', center: [x, LIGHT_HEIGHT / 2, z], radius: 0.15, halfHeight: LIGHT_HEIGHT / 2 };
              if (!clearOfRings([pole])) continue;
              lights.push(x, z, yaw);
              colliders.push({ id: `light-${lights.length / LIGHT_STRIDE - 1}`, shape: pole });
            } else if (u01(hk) < 0.8) {
              const species = u01(rehash(hk, 1)) < 0.3 ? 3 : 1;
              const scale = STREET_TREE_SCALE * (0.9 + 0.2 * u01(rehash(hk, 2)));
              const d = TREE_DIMENSIONS[species]!;
              const H = d.height * scale;
              const trunk = H * d.crownBase;
              const trunkShape: ColliderShape = { kind: 'cylinder', center: [x, trunk / 2, z], radius: d.trunkRadius * scale, halfHeight: trunk / 2 };
              const crownShape: ColliderShape = { kind: 'cylinder', center: [x, H - (H - trunk) / 2, z], radius: d.crownRadius * scale, halfHeight: (H - trunk) / 2 };
              if (!clearOfRings([trunkShape, crownShape])) continue;
              trees.push(x, 0, z, scale, 6.283 * u01(rehash(hk, 3)), species);
              const id = `street-tree-${trees.length / TREE_STRIDE - 1}`;
              colliders.push({ id, shape: trunkShape }, { id, shape: crownShape });
            }
          }
          // parked cars with gaps
          const c0 = blockMin(i) + CAR_INTERSECTION_GAP + CAR_SIZE[2] / 2;
          const c1 = blockMin(i) + CITY_BLOCK - CAR_INTERSECTION_GAP - CAR_SIZE[2] / 2;
          for (let k = 0, s = c0; s <= c1 + 1e-9; k++, s += 5.6) {
            const hc = rehash(h, 100 + k * 2 + (side > 0 ? 1 : 0));
            // downtown streets are no-parking; elsewhere about a third of the kerb is taken
            if (u01(hc) < (downtown ? 1 : 0.78)) continue;
            const [x, z] = at(s, side * PARKING_OFFSET);
            const colour = CAR_COLOURS[Math.floor(u01(rehash(hc, 1)) * CAR_COLOURS.length)]!;
            const yaw = yawAlong + (side > 0 ? Math.PI : 0);
            const body: ColliderShape = { kind: 'box', center: [x, CAR_SIZE[1] / 2, z], half: [CAR_SIZE[0] / 2, CAR_SIZE[1] / 2, CAR_SIZE[2] / 2], yaw };
            if (!clearOfRings([body])) continue;
            cars.push(x, 0, z, yaw, colour);
            colliders.push({ id: `car-${cars.length / CAR_STRIDE - 1}`, shape: body });
          }
        }
      }
    }
  }
  // kerbs around every playable block, at the sidewalk edge
  for (let j = 0; j < CITY_BLOCKS; j++) {
    for (let i = 0; i < CITY_BLOCKS; i++) {
      if (!playable(i, j)) continue;
      const x0 = blockMin(i);
      const z0 = blockMin(j);
      const L = CITY_BLOCK;
      kerbs.push(x0 + L / 2, z0, L, Math.PI / 2, x0 + L / 2, z0 + L, L, Math.PI / 2, x0, z0 + L / 2, L, 0, x0 + L, z0 + L / 2, L, 0);
    }
  }
  return {
    trees: Float32Array.from(trees),
    lights: Float32Array.from(lights),
    cars: Float32Array.from(cars),
    kerbs: Float32Array.from(kerbs),
    colliders,
  };
}

