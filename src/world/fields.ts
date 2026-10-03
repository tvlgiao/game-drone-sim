/**
 * Generator v2 field and garden layout: irregular parcels as the cells of a jittered Voronoi diagram (fields
 * ≈ 70 m, village gardens ≈ 24 m), each with a crop and a furrow direction from its hash, farm tracks along some
 * of the parcel edges. Fields cover farmland noise and the land along roads (where villages farm), on gentle,
 * dry ground. Arithmetic only (shared by chunk colours and the object scatter).
 */
import { clamp, smoothstep } from './math';
import { hash2, rehash, u01 } from './rng';

export const FIELD_CELL = 70;
export const SALT_FIELDS = 75;
export const SALT_GARDENS = 76;
export const GARDEN_CELL = 24;
/** crops (sRGB) */
export const CROP = { wheat: 0, barley: 1, ploughed: 2, green: 3, pasture: 4, rapeseed: 5 } as const;
export const CROP_COLOURS: readonly (readonly [number, number, number])[] = [
  [0xc9, 0xb2, 0x65],
  [0xb3, 0x9c, 0x56],
  [0x6b, 0x55, 0x3f],
  [0x6a, 0x96, 0x3a],
  [0x7d, 0xa2, 0x4a],
  [0xd2, 0xbf, 0x3e],
];
/** garden kinds: lawn, vegetable rows, orchard grass, yard gravel */
export const GARDEN_COLOURS: readonly (readonly [number, number, number])[] = [
  [0x5f, 0x8a, 0x3a],
  [0x6e, 0x58, 0x40],
  [0x55, 0x7c, 0x38],
  [0x97, 0x8e, 0x76],
];
export const TRACK_COLOUR: readonly [number, number, number] = [0x98, 0x88, 0x68];
/** a farm track runs along this share of field edges */
const TRACK_SHARE = 0.22;
const TRACK_HALF_WIDTH = 1.6;

export interface Parcel {
  /** stable id of the cell (hash of its lattice coordinates) */
  id: number;
  /** distance to the nearest edge (half the F2 − F1 gap), m */
  edge: number;
  /** id of the neighbouring cell across that edge */
  neighbour: number;
  /** feature point of the cell */
  px: number;
  pz: number;
}

/** The Voronoi cell of (x, z) on a jittered `size` lattice (3 × 3 search). */
export function parcelAt(seed: number, salt: number, size: number, x: number, z: number, out: Parcel): Parcel {
  const ci = Math.floor(x / size);
  const cj = Math.floor(z / size);
  let d1 = Infinity;
  let d2 = Infinity;
  let id1 = 0;
  let id2 = 0;
  let p1x = 0;
  let p1z = 0;
  for (let j = cj - 1; j <= cj + 1; j++) {
    for (let i = ci - 1; i <= ci + 1; i++) {
      const h = hash2(seed, i, j, salt);
      const px = (i + 0.15 + 0.7 * u01(rehash(h, 1))) * size;
      const pz = (j + 0.15 + 0.7 * u01(rehash(h, 2))) * size;
      const d = Math.sqrt((px - x) * (px - x) + (pz - z) * (pz - z));
      if (d < d1) {
        d2 = d1;
        id2 = id1;
        d1 = d;
        id1 = h;
        p1x = px;
        p1z = pz;
      } else if (d < d2) {
        d2 = d;
        id2 = h;
      }
    }
  }
  out.id = id1;
  out.edge = (d2 - d1) / 2;
  out.neighbour = id2;
  out.px = p1x;
  out.pz = p1z;
  return out;
}

/**
 * 0..1: how much (x, z) is farmed. Farmland noise and a band along roads, cut on slopes over ~0.15, near water
 * and high up.
 */
export function fieldWeight(farm: number, roadD: number, slope: number, height: number, wet: boolean): number {
  if (wet || height > 160) return 0;
  const by = Math.max(smoothstep(0.0, 0.12, farm), 1 - smoothstep(70, 120, roadD));
  return clamp(by * (1 - smoothstep(0.1, 0.18, slope)), 0, 1);
}

export function parcel(): Parcel {
  return { id: 0, edge: 0, neighbour: 0, px: 0, pz: 0 };
}

/** Crop of a field cell. */
export function cropOf(id: number): number {
  return Math.floor(u01(rehash(id, 7)) * CROP_COLOURS.length);
}

/** True when a farm track runs along the edge between two field cells (symmetric in the pair). */
export function trackBetween(a: number, b: number): boolean {
  const lo = a < b ? a : b;
  const hi = a < b ? b : a;
  return u01(rehash((lo ^ Math.imul(hi, 0x9e3779b1)) >>> 0, 3)) < TRACK_SHARE;
}

/** On a farm track (its centre band, m). */
export function onTrack(p: Parcel): boolean {
  return p.edge < TRACK_HALF_WIDTH && trackBetween(p.id, p.neighbour);
}
