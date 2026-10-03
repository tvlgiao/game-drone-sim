/**
 * City (design 07 §3): 1.2 × 1.2 km, 15 × 15 blocks of 80 m (64 m block + 16 m street), flat ground, a river
 * along the east edge and one park block. Block height class comes from the distance to the centre plus a
 * hash (downtown 80–180 m, midrise 25–60 m, low 8–20 m); 1–4 buildings per block with 2 m setbacks; rooftop
 * AC boxes, water tanks and antennas; two skybridges and one pass-through slab on stilts. Also the 18-ring
 * route: street-canyon slalom, rooftop hop, downtown gap dive, skybridge.
 *
 * Buildings are axis-aligned boxes; colliders use the shared `Collider` shapes. Pure and deterministic.
 */
import type { Collider, ColliderShape, RingDef } from '../types';
import { clamp, smoothstep, TAU, yawFacing } from './math';
import { hash2, rehash, SALT, u01 } from './rng';
import { clearanceAt } from './routes';
import { TREE_DIMENSIONS, TREE_STRIDE } from './scatter';
import { BIOME, type BiomeSample, type TerrainField } from './terrain-field';

export const CITY_BLOCKS = 15;
export const CITY_PITCH = 80;
export const CITY_BLOCK = 64;
export const CITY_STREET = 16;
export const CITY_SETBACK = 2;
export const CITY_HALF = (CITY_BLOCKS * CITY_PITCH) / 2;
/** River channel along the east edge (block column 14). */
export const CITY_RIVER = { x: 560, halfWidth: 24, bed: -4, level: -0.8 } as const;
export const CITY_RING_RADIUS = 1.75;
export const CITY_RING_CLEARANCE = 3;

/** x, y (base), z, w, h, d, seed (24-bit), kind (0 building, 1 slab) */
export const BUILDING_STRIDE = 8;
/** kind (0 AC box, 1 water tank, 2 antenna), x, y (base), z, sx, sy, sz */
export const ROOF_PROP_STRIDE = 7;

export type BlockClass = 'downtown' | 'midrise' | 'low' | 'park' | 'river';

export interface City {
  seed: number;
  buildings: Float32Array;
  roofProps: Float32Array;
  /** box centre x, y, z and size w, h, d per skybridge */
  skybridges: Float32Array;
  /** park trees in the scatter layout (x, y, z absolute, scale, yaw, species) */
  trees: Float32Array;
  colliders: Collider[];
  blockClass: (i: number, j: number) => BlockClass;
  /** LOS spot on a low roof at the south edge (y = roof + 1.7) */
  pilot: [number, number, number];
  spawn: { position: [number, number, number]; yaw: number };
  rings: RingDef[];
}

export function blockMin(i: number): number {
  return -CITY_HALF + i * CITY_PITCH + CITY_STREET / 2;
}
export function blockCentre(i: number): number {
  return blockMin(i) + CITY_BLOCK / 2;
}
/** Street centre line between block i − 1 and block i. */
export function streetLine(i: number): number {
  return -CITY_HALF + i * CITY_PITCH;
}

const SKYBRIDGE_BLOCKS: readonly [readonly [number, number], readonly [number, number]][] = [
  [
    [6, 7],
    [7, 7],
  ],
  [
    [7, 8],
    [7, 9],
  ],
];
const SLAB_BLOCK = [4, 9] as const;
const PILOT_BLOCK = [7, 0] as const;
const PARK_CANDIDATES: readonly (readonly [number, number])[] = [
  [10, 4],
  [4, 4],
  [10, 10],
  [3, 7],
];

interface Box {
  x: number;
  z: number;
  w: number;
  d: number;
}

export function generateCity(seed: number): City {
  seed >>>= 0;
  const buildings: number[] = [];
  const roof: number[] = [];
  const sky: number[] = [];
  const trees: number[] = [];
  const colliders: Collider[] = [];
  const tops = new Map<string, { top: number; box: Box }>();
  const parkPick = PARK_CANDIDATES[Math.floor(u01(hash2(seed, 0, 0, SALT.city)) * PARK_CANDIDATES.length)]!;

  const special = (i: number, j: number): 'sky' | 'slab' | 'pilot' | null => {
    for (const pair of SKYBRIDGE_BLOCKS) for (const b of pair) if (b[0] === i && b[1] === j) return 'sky';
    if (i === SLAB_BLOCK[0] && j === SLAB_BLOCK[1]) return 'slab';
    if (i === PILOT_BLOCK[0] && j === PILOT_BLOCK[1]) return 'pilot';
    return null;
  };

  const blockClass = (i: number, j: number): BlockClass => {
    if (i === CITY_BLOCKS - 1) return 'river';
    if (i === parkPick[0] && j === parkPick[1]) return 'park';
    const s = special(i, j);
    if (s === 'sky') return 'downtown';
    if (s === 'slab') return 'midrise';
    if (s === 'pilot') return 'low';
    const cx = blockCentre(i);
    const cz = blockCentre(j);
    const d = Math.sqrt(cx * cx + cz * cz) + 80 * (u01(hash2(seed, i, j, SALT.city)) - 0.5);
    return d < 220 ? 'downtown' : d < 430 ? 'midrise' : 'low';
  };

  const addBox = (id: string, x: number, y: number, z: number, w: number, h: number, d: number): void => {
    colliders.push({ id, shape: { kind: 'box', center: [x, y + h / 2, z], half: [w / 2, h / 2, d / 2] } });
  };

  let nb = 0;
  for (let j = 0; j < CITY_BLOCKS; j++) {
    for (let i = 0; i < CITY_BLOCKS; i++) {
      const cls = blockClass(i, j);
      const bx0 = blockMin(i);
      const bz0 = blockMin(j);
      const hb = hash2(seed, i, j, SALT.city + 1);
      if (cls === 'river') continue;
      if (cls === 'park') {
        for (let tj = 0; tj < 8; tj++) {
          for (let ti = 0; ti < 8; ti++) {
            const ht = hash2(seed, i * 8 + ti, j * 8 + tj, SALT.tree);
            if (u01(ht) > 0.45) continue;
            const x = bx0 + 4 + ti * 7.5 + 4 * u01(rehash(ht, 1));
            const z = bz0 + 4 + tj * 7.5 + 4 * u01(rehash(ht, 2));
            const scale = 0.8 + 0.5 * u01(rehash(ht, 3));
            trees.push(x, 0, z, scale, TAU * u01(rehash(ht, 4)), 1);
            const dm = TREE_DIMENSIONS[1]!;
            const H = dm.height * scale;
            const trunk = H * dm.crownBase;
            const id = `park-tree-${trees.length / TREE_STRIDE - 1}`;
            colliders.push({ id, shape: { kind: 'cylinder', center: [x, trunk / 2, z], radius: dm.trunkRadius * scale, halfHeight: trunk / 2 } });
            colliders.push({ id, shape: { kind: 'cylinder', center: [x, H - (H - trunk) / 2, z], radius: dm.crownRadius * scale, halfHeight: (H - trunk) / 2 } });
          }
        }
        continue;
      }
      const sp = special(i, j);
      if (sp === 'slab') {
        const x = bx0 + CITY_BLOCK / 2;
        const z = bz0 + CITY_BLOCK / 2;
        const w = CITY_BLOCK - 12;
        const base = 24;
        const thick = 10;
        buildings.push(x, base, z, w, thick, w, hb & 0xffffff, 1);
        addBox('slab', x, base, z, w, thick, w);
        for (const [sx, sz] of [
          [-1, -1],
          [1, -1],
          [-1, 1],
          [1, 1],
        ] as const) {
          const px = x + sx * (w / 2 - 2);
          const pz = z + sz * (w / 2 - 2);
          buildings.push(px, 0, pz, 3, base, 3, (hb + sx * 3 + sz) & 0xffffff, 0);
          addBox(`slab-stilt-${sx}${sz}`, px, 0, pz, 3, base, 3);
        }
        tops.set(`${i},${j}`, { top: base + thick, box: { x, z, w, d: w } });
        continue;
      }

      let count = 1 + Math.floor(u01(rehash(hb, 1)) * 4);
      if (cls === 'downtown') count = 1 + Math.floor(u01(rehash(hb, 1)) * 2);
      if (sp) count = 1;
      const lots = splitLots(bx0 + CITY_SETBACK, bz0 + CITY_SETBACK, CITY_BLOCK - 2 * CITY_SETBACK, count, u01(rehash(hb, 2)) < 0.5);
      let blockTop = 0;
      let blockBox: Box = { x: bx0 + CITY_BLOCK / 2, z: bz0 + CITY_BLOCK / 2, w: 0, d: 0 };
      lots.forEach((lot, k) => {
        const hk = rehash(hb, 10 + k);
        const shrink = cls === 'downtown' || sp ? 0 : 3 * u01(rehash(hk, 1));
        const w = lot.w - 2 * CITY_SETBACK - 2 * shrink;
        const d = lot.d - 2 * CITY_SETBACK - 2 * shrink;
        const [lo, hi] = cls === 'downtown' ? [80, 180] : cls === 'midrise' ? [25, 60] : [8, 20];
        let h = lo + (hi - lo) * u01(rehash(hk, 2));
        if (sp === 'sky') h = Math.max(h, 110);
        h = Math.floor(h);
        const id = `bld-${nb++}`;
        // podium + setback tower on most big lots (not the skybridge towers: the bridges span their facades)
        let tw = w;
        let td = d;
        if (!sp && cls !== 'low' && h >= 45 && w >= 26 && d >= 26 && u01(rehash(hk, 40)) < 0.65) {
          const inset = 3 + 3 * u01(rehash(hk, 41));
          const hp = Math.floor(Math.min(h * 0.4, 9 + 9 * u01(rehash(hk, 42))));
          tw = w - 2 * inset;
          td = d - 2 * inset;
          buildings.push(lot.x, 0, lot.z, w, hp, d, rehash(hk, 43) & 0xffffff, 0);
          addBox(`${id}-podium`, lot.x, 0, lot.z, w, hp, d);
        }
        buildings.push(lot.x, 0, lot.z, tw, h, td, hk & 0xffffff, 0);
        addBox(id, lot.x, 0, lot.z, tw, h, td);
        if (h > blockTop) {
          blockTop = h;
          blockBox = { x: lot.x, z: lot.z, w: tw, d: td };
        }
        roofPropsFor(id, lot.x, h, lot.z, tw, td, cls, hk, roof, colliders);
      });
      tops.set(`${i},${j}`, { top: blockTop, box: blockBox });
    }
  }

  // Skybridges span the street between the facing towers (setback faces 20 m apart).
  SKYBRIDGE_BLOCKS.forEach((pair, k) => {
    const [a, b] = pair;
    const hk = hash2(seed, k, 0, SALT.city + 2);
    const ta = tops.get(`${a[0]},${a[1]}`)!;
    const tb = tops.get(`${b[0]},${b[1]}`)!;
    const y0 = Math.min(50 + 30 * u01(hk), Math.min(ta.top, tb.top) - 20);
    const along = a[0] !== b[0];
    const x = along ? streetLine(b[0]) : ta.box.x;
    const z = along ? ta.box.z : streetLine(b[1]);
    // facing facades are street + 2 × (lot setback + building setback) apart; embed 1 m into each
    const len = CITY_STREET + 4 * CITY_SETBACK + 2;
    const w = along ? len : 8;
    const d = along ? 8 : len;
    sky.push(x, y0 + 2, z, w, 4, d);
    addBox(`skybridge-${k}`, x, y0, z, w, 4, d);
  });

  const pilotTop = tops.get(`${PILOT_BLOCK[0]},${PILOT_BLOCK[1]}`)!;
  const pilot: [number, number, number] = [pilotTop.box.x, pilotTop.top + 1.7, pilotTop.box.z];
  const spawn = { position: [streetLine(1), 0.06, streetLine(5)] as [number, number, number], yaw: yawFacing(1, 0) };

  const city: City = {
    seed,
    buildings: Float32Array.from(buildings),
    roofProps: Float32Array.from(roof),
    skybridges: Float32Array.from(sky),
    trees: Float32Array.from(trees),
    colliders,
    blockClass,
    pilot,
    spawn,
    rings: [],
  };
  city.rings = cityRoute(city, tops);
  return city;
}

interface Lot {
  x: number;
  z: number;
  w: number;
  d: number;
}

/** 1–4 lots inside a square of side `s` at (x0, z0); lot centres and sizes. */
function splitLots(x0: number, z0: number, s: number, count: number, alongX: boolean): Lot[] {
  const h = s / 2;
  const lot = (x: number, z: number, w: number, d: number): Lot => ({ x: x + w / 2, z: z + d / 2, w, d });
  if (count <= 1) return [lot(x0, z0, s, s)];
  if (count === 2) return alongX ? [lot(x0, z0, h, s), lot(x0 + h, z0, h, s)] : [lot(x0, z0, s, h), lot(x0, z0 + h, s, h)];
  if (count === 3)
    return alongX
      ? [lot(x0, z0, h, s), lot(x0 + h, z0, h, h), lot(x0 + h, z0 + h, h, h)]
      : [lot(x0, z0, s, h), lot(x0, z0 + h, h, h), lot(x0 + h, z0 + h, h, h)];
  return [lot(x0, z0, h, h), lot(x0 + h, z0, h, h), lot(x0, z0 + h, h, h), lot(x0 + h, z0 + h, h, h)];
}

function roofPropsFor(id: string, x: number, top: number, z: number, w: number, d: number, cls: BlockClass, h: number, out: number[], colliders: Collider[]): void {
  const n = 1 + Math.floor(u01(rehash(h, 20)) * 3);
  for (let k = 0; k < n; k++) {
    const hk = rehash(h, 21 + k);
    const px = x + (u01(rehash(hk, 1)) - 0.5) * Math.max(0, w - 6);
    const pz = z + (u01(rehash(hk, 2)) - 0.5) * Math.max(0, d - 6);
    out.push(0, px, top, pz, 2, 1.5, 2);
    colliders.push({ id: `${id}-ac${k}`, shape: { kind: 'box', center: [px, top + 0.75, pz], half: [1, 0.75, 1] } });
  }
  if (cls !== 'downtown' && u01(rehash(h, 30)) < 0.3 && w > 10 && d > 10) {
    const px = x - w / 4;
    const pz = z + d / 4;
    out.push(1, px, top, pz, 3, 4, 3);
    colliders.push({ id: `${id}-tank`, shape: { kind: 'cylinder', center: [px, top + 2, pz], radius: 1.5, halfHeight: 2 } });
  }
  if (cls === 'downtown' && u01(rehash(h, 31)) < 0.4) {
    const ah = 8 + 8 * u01(rehash(h, 32));
    out.push(2, x, top, z, 0.3, ah, 0.3);
    colliders.push({ id: `${id}-antenna`, shape: { kind: 'cylinder', center: [x, top + ah / 2, z], radius: 0.15, halfHeight: ah / 2 } });
  }
}

/** Obstacles near (x, z): every collider whose footprint comes within `range`. */
export function cityObstacles(city: City, x: number, z: number, range: number): ColliderShape[] {
  const out: ColliderShape[] = [];
  for (const c of city.colliders) {
    const s = c.shape;
    const ext = s.kind === 'box' ? Math.max(s.half[0], s.half[2]) : s.kind === 'cylinder' ? s.radius : s.majorRadius;
    if (Math.abs(s.center[0] - x) <= range + ext && Math.abs(s.center[2] - z) <= range + ext) out.push(s);
  }
  return out;
}

/** Lifts (x, y, z) in 1 m steps until it clears every collider by ring radius + clearance (or reaches `ceiling`). */
export function clearPoint(city: City, x: number, y: number, z: number, ceiling = 250): [number, number, number] {
  const need = CITY_RING_RADIUS + CITY_RING_CLEARANCE;
  const near = cityObstacles(city, x, z, need + 2);
  let yy = Math.max(y, need);
  while (clearanceAt(x, yy, z, near) < need && yy < ceiling) yy += 1;
  return [x, yy, z];
}

/**
 * 18 rings, ≈ 2.7 km: (1) street-canyon slalom at 15–25 m along the street between block rows 4 and 5,
 * (2) rooftop hop north over block column 12, (3) dive down the street between columns 8 and 9,
 * (4) under the first skybridge, up between the towers, over the second, back down the street.
 */
function cityRoute(city: City, tops: Map<string, { top: number; box: Box }>): RingDef[] {
  const pts: [number, number, number][] = [];
  const zs = streetLine(5);
  for (let k = 0; k < 6; k++) {
    const x = blockCentre(1 + 2 * k);
    const offset = k % 2 === 0 ? 3 : -3;
    pts.push(clearPoint(city, x, 15 + 10 * u01(hash2(city.seed, k, 1, SALT.city + 3)), zs + offset));
  }
  for (let k = 0; k < 5; k++) {
    const j = 4 + 2 * k;
    const t = tops.get(`12,${j}`);
    const top = t ? t.top : 10;
    pts.push(clearPoint(city, blockCentre(12), top + 8, blockCentre(j)));
  }
  const xs = streetLine(9);
  for (const [z, y] of [
    [blockCentre(11), 70],
    [blockCentre(9), 40],
    [blockCentre(7), 18],
  ] as const) {
    pts.push(clearPoint(city, xs, y, z));
  }
  // skybridge 0 spans x = streetLine(7) at z of block row 7; skybridge 1 spans z = streetLine(9) at x of column 7
  const s0 = 0;
  const s1 = 6;
  const sb = city.skybridges;
  const under0y = sb[s0 + 1]! - sb[s0 + 4]! / 2 - CITY_RING_RADIUS - CITY_RING_CLEARANCE - 1;
  pts.push(clearPoint(city, sb[s0]!, clamp(under0y, 8, 200), sb[s0 + 2]! - 4, under0y + 0.5));
  pts.push(clearPoint(city, streetLine(7), sb[s0 + 1]! + 22, blockCentre(8)));
  pts.push(clearPoint(city, sb[s1]!, sb[s1 + 1]! + sb[s1 + 4]! / 2 + 6, sb[s1 + 2]!));
  pts.push(clearPoint(city, streetLine(7), 30, blockCentre(11)));
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)]!;
    const b = pts[Math.min(pts.length - 1, i + 1)]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dz = b[2] - a[2];
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    return { id: `ring-${i}`, position: p, direction: [dx / len, dy / len, dz / len], radius: CITY_RING_RADIUS, tube: 0.12 };
  });
}

/** Flat city ground (y = 0) with the river channel on the east edge. */
export function cityTerrainField(city: City, genVersion: number): TerrainField {
  const r = CITY_RIVER;
  const heightAt = (x: number, _z: number): number => r.bed * (1 - smoothstep(r.halfWidth - 6, r.halfWidth + 2, Math.abs(x - r.x)));
  const waterLevelAt = (x: number, z: number): number => (heightAt(x, z) < r.level ? r.level : -Infinity);
  return {
    seed: city.seed,
    genVersion,
    preset: 'city',
    maxHeight: 0,
    minHeight: r.bed,
    heightAt,
    baseHeightAt: heightAt,
    waterLevelAt,
    biomeAt(x: number, z: number, out: BiomeSample): BiomeSample {
      const h = heightAt(x, z);
      const water = waterLevelAt(x, z);
      const half = CITY_HALF;
      const inCity = Math.abs(x) < half && Math.abs(z) < half;
      const bi = Math.floor((x + half) / CITY_PITCH);
      const bj = Math.floor((z + half) / CITY_PITCH);
      const lx = x + half - bi * CITY_PITCH;
      const lz = z + half - bj * CITY_PITCH;
      const street = lx < CITY_STREET / 2 || lx > CITY_PITCH - CITY_STREET / 2 || lz < CITY_STREET / 2 || lz > CITY_PITCH - CITY_STREET / 2;
      const cls = inCity ? city.blockClass(bi, bj) : 'low';
      out.biome = water > -Infinity ? BIOME.water : !inCity ? BIOME.meadow : street ? BIOME.road : cls === 'park' ? BIOME.meadow : BIOME.village;
      out.height = h;
      out.water = water;
      out.slope = 0;
      out.moisture = 0.5;
      out.temperature = 0.6;
      out.forest = cls === 'park' ? 0.5 : 0;
      out.road = street ? 1 : 0;
      out.village = inCity && !street ? 1 : 0;
      out.river = water > -Infinity ? 1 : 0;
      out.snow = 0;
      return out;
    },
  };
}
