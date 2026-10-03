/**
 * Villages (design 07 §2.2): one candidate per jittered 512 m cell, accepted on flat, dry ground away from
 * rivers; a plateau at the mean low-pass height; houses on 2–3 street rings with one church / tower.
 * Placement reads terrain layers 1–3 only (BaseTerrain), so it never depends on other villages or roads.
 */
import type { BaseSample, BaseTerrain } from './base-terrain';
import { baseSample } from './base-terrain';
import { cellKey, dcos, dsin, LruCache, PI, TAU } from './math';
import { hash2, rehash, SALT, u01 } from './rng';

export const VILLAGE_CELL = 512;
/** Width of the ring where the plateau blends back into the terrain, m. */
export const VILLAGE_BLEND = 60;
export const VILLAGE_MIN_RADIUS = 60;
export const VILLAGE_MAX_RADIUS = 140;
/** Largest |terrain − plateau| allowed across the blend ring (keeps the embankment slope ≤ 0.4). */
const MAX_PLATEAU_STEP = 12;

export interface Village {
  /** stable id: cell key for generated villages */
  key: number;
  x: number;
  z: number;
  /** plateau radius, m (flat inside, blends out over VILLAGE_BLEND) */
  radius: number;
  /** plateau height */
  plateau: number;
  houseCount: number;
  hash: number;
}

export const HOUSE_ARCHETYPES = ['cottage', 'farmhouse', 'barn', 'tower'] as const;
export type HouseArchetype = (typeof HOUSE_ARCHETYPES)[number];

export interface House {
  x: number;
  y: number;
  z: number;
  /** footprint across the front (local x), m */
  w: number;
  /** footprint depth (local z), m */
  d: number;
  wallHeight: number;
  roofHeight: number;
  /** rotation about +Y (Object3D.rotation.y); local +Z (the door side) faces the village centre */
  yaw: number;
  /** index into HOUSE_ARCHETYPES */
  archetype: number;
  /** wall colour 0xRRGGBB */
  colour: number;
}

export interface Settlements {
  /** Villages whose blend disc reaches the box, in a fixed order (by key). */
  villagesInBox(minX: number, minZ: number, maxX: number, maxZ: number): Village[];
}

/** Grid settlements also expose cells, for the road network. */
export interface GridSettlementSource extends Settlements {
  villageInCell(ci: number, cj: number): Village | null;
}

const DIR8: readonly (readonly [number, number])[] = [
  [1, 0],
  [0.7071067811865476, 0.7071067811865476],
  [0, 1],
  [-0.7071067811865476, 0.7071067811865476],
  [-1, 0],
  [-0.7071067811865476, -0.7071067811865476],
  [0, -1],
  [0.7071067811865476, -0.7071067811865476],
];

function boxOverlapsDisc(minX: number, minZ: number, maxX: number, maxZ: number, x: number, z: number, r: number): boolean {
  const dx = x < minX ? minX - x : x > maxX ? x - maxX : 0;
  const dz = z < minZ ? minZ - z : z > maxZ ? z - maxZ : 0;
  return dx * dx + dz * dz <= r * r;
}

export class GridSettlements implements GridSettlementSource {
  private readonly cells = new LruCache<number, Village | null>(256);
  private readonly s: BaseSample = baseSample();

  constructor(
    private readonly base: BaseTerrain,
    private readonly seed: number,
  ) {}

  villageInCell(ci: number, cj: number): Village | null {
    const key = cellKey(ci, cj);
    const hit = this.cells.get(key);
    if (hit !== undefined) return hit;
    const v = this.place(ci, cj, key);
    this.cells.set(key, v);
    return v;
  }

  villagesInBox(minX: number, minZ: number, maxX: number, maxZ: number): Village[] {
    const reach = VILLAGE_MAX_RADIUS + VILLAGE_BLEND;
    const i0 = Math.floor((minX - reach) / VILLAGE_CELL);
    const i1 = Math.floor((maxX + reach) / VILLAGE_CELL);
    const j0 = Math.floor((minZ - reach) / VILLAGE_CELL);
    const j1 = Math.floor((maxZ + reach) / VILLAGE_CELL);
    const out: Village[] = [];
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const v = this.villageInCell(i, j);
        if (v && boxOverlapsDisc(minX, minZ, maxX, maxZ, v.x, v.z, v.radius + VILLAGE_BLEND)) out.push(v);
      }
    }
    return out;
  }

  private place(ci: number, cj: number, key: number): Village | null {
    const h0 = hash2(this.seed, ci, cj, SALT.village);
    if (u01(h0) > 0.7) return null;
    const x = (ci + 0.2 + 0.6 * u01(rehash(h0, 1))) * VILLAGE_CELL;
    const z = (cj + 0.2 + 0.6 * u01(rehash(h0, 2))) * VILLAGE_CELL;
    const radius = VILLAGE_MIN_RADIUS + (VILLAGE_MAX_RADIUS - VILLAGE_MIN_RADIUS) * u01(rehash(h0, 3));
    const b = this.base;
    const s = this.s;

    b.sample(x, z, s);
    const hc = s.h;
    if (s.water > hc - 2 || hc > 260) return null;
    if (s.riverD < radius + VILLAGE_BLEND + 20) return null;
    const e = 8;
    const gx = (b.sample(x + e, z, s).h - b.sample(x - e, z, s).h) / (2 * e);
    const gz = (b.sample(x, z + e, s).h - b.sample(x, z - e, s).h) / (2 * e);
    if (gx * gx + gz * gz >= 0.12 * 0.12) return null;

    let lpSum = b.sample(x, z, s).lp;
    for (let k = 0; k < 8; k += 2) lpSum += b.sample(x + DIR8[k]![0] * radius * 0.5, z + DIR8[k]![1] * radius * 0.5, s).lp;
    const plateau = lpSum / 5;

    for (const ring of [radius, radius + VILLAGE_BLEND * 0.5, radius + VILLAGE_BLEND]) {
      for (const [dx, dz] of DIR8) {
        b.sample(x + dx * ring, z + dz * ring, s);
        if (Math.abs(s.h - plateau) > MAX_PLATEAU_STEP || s.water > s.h - 1 || s.riverD < 20) return null;
      }
    }
    const span = (radius - VILLAGE_MIN_RADIUS) / (VILLAGE_MAX_RADIUS - VILLAGE_MIN_RADIUS);
    const houseCount = Math.min(30, 6 + Math.floor(u01(rehash(h0, 4)) * (7 + 18 * span)));
    return { key, x, z, radius, plateau, houseCount, hash: h0 };
  }
}

/** Authored villages (Alpine hamlet): plateau from the low-pass terrain, no acceptance test. */
export class FixedSettlements implements Settlements {
  readonly villages: readonly Village[];

  constructor(base: BaseTerrain, seed: number, defs: readonly { x: number; z: number; radius: number; houses: number }[]) {
    const s = baseSample();
    this.villages = defs.map((d, i) => {
      let lpSum = base.sample(d.x, d.z, s).lp;
      for (let k = 0; k < 8; k += 2) lpSum += base.sample(d.x + DIR8[k]![0] * d.radius * 0.5, d.z + DIR8[k]![1] * d.radius * 0.5, s).lp;
      return { key: i, x: d.x, z: d.z, radius: d.radius, plateau: lpSum / 5, houseCount: d.houses, hash: hash2(seed, i, 0, SALT.village) };
    });
  }

  villagesInBox(minX: number, minZ: number, maxX: number, maxZ: number): Village[] {
    return this.villages.filter((v) => boxOverlapsDisc(minX, minZ, maxX, maxZ, v.x, v.z, v.radius + VILLAGE_BLEND));
  }
}

export class NoSettlements implements Settlements {
  villagesInBox(): Village[] {
    return [];
  }
}

const WALL_COLOURS = [0xe8dcc4, 0xd9c3a0, 0xf2efe6, 0xc98f6b, 0xb8c4c9, 0xe3cf9a, 0xa8b89a];
const BARN_COLOURS = [0x9c3b2e, 0x7a4a2c, 0x8a5a3c];

interface Dims {
  w: number;
  d: number;
  wallHeight: number;
  roofHeight: number;
}

function dims(archetype: number, u: number): Dims {
  switch (archetype) {
    case 0:
      return { w: 6 + 2 * u, d: 8 + 2 * u, wallHeight: 3 + 0.6 * u, roofHeight: 2.4 };
    case 1:
      return { w: 8 + 2 * u, d: 11 + 3 * u, wallHeight: 4 + 0.6 * u, roofHeight: 3.2 };
    case 2:
      return { w: 10 + 2 * u, d: 14 + 4 * u, wallHeight: 5 + u, roofHeight: 4 };
    default:
      return { w: 6, d: 6, wallHeight: 14 + 4 * u, roofHeight: 6 };
  }
}

/**
 * Houses of a village. `blocked(x, z, r)` rejects spots on roads; the result depends only on the village and
 * the road network, so every chunk that asks gets the same list.
 */
export function villageLayout(v: Village, blocked: (x: number, z: number, r: number) => boolean): House[] {
  const R = v.radius;
  const radii = R < 95 ? [0.34 * R, 0.82 * R] : [0.3 * R, 0.57 * R, 0.84 * R];
  let rSum = 0;
  for (const r of radii) rSum += r;
  const out: House[] = [];
  let towerPlaced = false;
  let k = 10;
  for (let ring = 0; ring < radii.length; ring++) {
    const r = radii[ring]!;
    const cap = Math.floor((TAU * r) / 16);
    const n = Math.min(cap, Math.max(2, Math.floor((v.houseCount * r) / rSum + 0.5)));
    const theta0 = TAU * u01(rehash(v.hash, k++));
    const outer = ring === radii.length - 1;
    for (let j = 0; j < n; j++) {
      const hj = rehash(v.hash, k++);
      const theta = theta0 + (TAU * (j + 0.25 * (u01(hj) - 0.5))) / n;
      const ua = u01(rehash(hj, 1));
      let archetype: number;
      if (!towerPlaced && ring === 0) archetype = 3;
      else if (outer && ua < 0.25) archetype = 2;
      else archetype = ua < 0.6 ? 0 : 1;
      const dm = dims(archetype, u01(rehash(hj, 2)));
      const rr = r + (u01(rehash(hj, 3)) - 0.5) * 3;
      const x = v.x + rr * dcos(theta);
      const z = v.z + rr * dsin(theta);
      if (blocked(x, z, 0.5 * Math.sqrt(dm.w * dm.w + dm.d * dm.d) + 3)) continue;
      if (archetype === 3) towerPlaced = true;
      const palette = archetype === 2 ? BARN_COLOURS : WALL_COLOURS;
      const colour = palette[Math.floor(u01(rehash(hj, 4)) * palette.length)]!;
      out.push({ x, y: v.plateau, z, w: dm.w, d: dm.d, wallHeight: dm.wallHeight, roofHeight: dm.roofHeight, yaw: -theta - PI / 2, archetype, colour });
    }
  }
  return out;
}
