/**
 * Terrain layers 1–3 (design 07 §2.2): relief, river carving, lakes. Villages and roads are placed against
 * this field only; terrain-field.ts adds their plateaus and road beds on top.
 *
 * Slope control: every carve is a smooth-min / max against a cone of bounded slope (`level + k·distance`),
 * which never makes the terrain steeper than the steeper of its two inputs, so the relief noise alone sets
 * the slope cap (≤ 2.5, see the unit test).
 */
import { clamp, segDist2, smin, smoothstep } from './math';
import { fbm, fbmDamped, fbmSample, noise, ridged } from './noise';
import { SALT, subSeed } from './rng';

export type TerrainPreset = 'training' | 'alpine' | 'infinite';

/** One evaluation of layers 1–3. */
export interface BaseSample {
  /** height after rivers / lakes (layers 1–3) */
  h: number;
  /** smooth low-pass height: the road bed and river surface follow it */
  lp: number;
  /** candidate water surface here (river or lake), −Infinity when no water body covers this spot */
  water: number;
  /** approximate distance in metres to the nearest river / stream centre line (Infinity: none) */
  riverD: number;
  /** 0..1 mountain weight (colour, rocks) */
  mountain: number;
}

export interface Climate {
  moisture: number;
  temperature: number;
}

export interface BaseTerrain {
  readonly preset: TerrainPreset;
  readonly seed: number;
  /** upper bound of `h` (chunk culling) */
  readonly maxHeight: number;
  readonly minHeight: number;
  /** snow above this height (Infinity: none) */
  readonly snowLine: number;
  /** no trees above this height */
  readonly treeLine: number;
  /** river channel half width, m */
  readonly riverHalfWidth: number;
  /** no scattered objects within this radius of the origin (Training keeps its field clear), m */
  readonly clearRadius: number;
  sample(x: number, z: number, out: BaseSample): BaseSample;
  climate(x: number, z: number, s: BaseSample, out: Climate): Climate;
}

export function baseSample(): BaseSample {
  return { h: 0, lp: 0, water: -Infinity, riverD: Infinity, mountain: 0 };
}

export const LAKE_LEVEL = 6;
const RIVER_HALF_WIDTH = 10;
const NO_WATER = -Infinity;

const f = fbmSample();

/** Shared river carve: broad valley, bank levee, then the channel itself. Returns the new height. */
function carveRiver(h: number, wl: number, d: number, halfWidth: number, valleyFlat: number, valleySlope: number, bankSlope: number): number {
  h = smin(h, wl + 1 + valleySlope * Math.max(0, d - valleyFlat) + 0.6 * Math.max(0, d - valleyFlat - 120), 6);
  const levee = wl + 0.6 - 0.3 * Math.abs(d - (halfWidth + 10));
  if (levee > h) h = levee;
  return smin(h, wl - 2.5 + bankSlope * Math.max(0, d - halfWidth) + Math.max(0, d - halfWidth - 10), 2);
}

/** Flat-ish meadow (±0.3 m inside the 80 m field) with gentle hills from 110 m out. */
class TrainingBase implements BaseTerrain {
  readonly preset = 'training' as const;
  readonly maxHeight = 60;
  readonly minHeight = -1;
  readonly snowLine = Infinity;
  readonly treeLine = Infinity;
  readonly riverHalfWidth = 0;
  readonly clearRadius = 110;
  private readonly sFlat: number;
  private readonly sHill: number;
  private readonly sMoist: number;

  constructor(readonly seed: number) {
    this.sFlat = subSeed(seed, SALT.detail);
    this.sHill = subSeed(seed, SALT.hills);
    this.sMoist = subSeed(seed, SALT.moisture);
  }

  sample(x: number, z: number, o: BaseSample): BaseSample {
    const r = Math.sqrt(x * x + z * z);
    let h = 0.12 * fbm(this.sFlat, x * (1 / 30), z * (1 / 30), 2);
    let lp = 0;
    const m = smoothstep(110, 420, r);
    if (m > 0) {
      fbmDamped(this.sHill, x * (1 / 520), z * (1 / 520), 4, f);
      h += m * 45 * (0.5 + 0.5 * f.v);
      lp += m * 45 * (0.5 + 0.5 * f.lp);
    }
    o.h = h;
    o.lp = lp;
    o.water = NO_WATER;
    o.riverD = Infinity;
    o.mountain = 0;
    return o;
  }

  climate(x: number, z: number, _s: BaseSample, out: Climate): Climate {
    out.moisture = clamp(0.62 + 0.2 * noise(this.sMoist, x * (1 / 400), z * (1 / 400)), 0, 1);
    out.temperature = 0.7;
    return out;
  }
}

/** Infinite world: continental mask over plains / hills / mountains, meandering rivers, lakes below 6 m. */
class InfiniteBase implements BaseTerrain {
  readonly preset = 'infinite' as const;
  readonly maxHeight = 820;
  readonly minHeight = -6;
  readonly snowLine = 560;
  readonly treeLine = 420;
  readonly riverHalfWidth = RIVER_HALF_WIDTH;
  readonly clearRadius = 0;
  private readonly s: Record<'wx' | 'wz' | 'cont' | 'plain' | 'hill' | 'mtn' | 'river' | 'riverMask' | 'moist' | 'temp', number>;

  constructor(readonly seed: number) {
    this.s = {
      wx: subSeed(seed, SALT.warpX),
      wz: subSeed(seed, SALT.warpZ),
      cont: subSeed(seed, SALT.continent),
      plain: subSeed(seed, SALT.plains),
      hill: subSeed(seed, SALT.hills),
      mtn: subSeed(seed, SALT.mountains),
      river: subSeed(seed, SALT.river),
      riverMask: subSeed(seed, SALT.riverMask),
      moist: subSeed(seed, SALT.moisture),
      temp: subSeed(seed, SALT.temperature),
    };
  }

  sample(x: number, z: number, o: BaseSample): BaseSample {
    const s = this.s;
    const wi = 1 / 1600;
    const wx = x + 120 * noise(s.wx, x * wi, z * wi);
    const wz = z + 120 * noise(s.wz, x * wi, z * wi);

    const c = 0.5 + 0.5 * fbm(s.cont, wx * (1 / 6000), wz * (1 / 6000), 2);
    const hillW = smoothstep(0.42, 0.64, c);
    const mtnW = smoothstep(0.56, 0.9, c);

    fbmDamped(s.plain, wx * (1 / 700), wz * (1 / 700), 4, f);
    let h = 12 + 11 * f.v;
    let lp = 12 + 11 * f.lp;
    if (hillW > 0) {
      fbmDamped(s.hill, wx * (1 / 1100), wz * (1 / 1100), 5, f);
      h += hillW * (60 + 60 * f.v);
      lp += hillW * (60 + 60 * f.lp);
    }
    if (mtnW > 0) {
      ridged(s.mtn, wx * (1 / 2600), wz * (1 / 2600), 5, f, 0.45);
      h += mtnW * 640 * f.v;
      lp += mtnW * 640 * f.lp;
    }

    // Rivers: the zero set of a low-frequency noise; |n| scaled to metres approximates the distance to it.
    // They fade out uphill (lp > 140 m) and where a very low-frequency mask says "dry region".
    let d = Math.abs(noise(s.river, wx * (1 / 2400), wz * (1 / 2400))) * 1500;
    d += Math.max(0, lp - 140) * 2.5 + Math.max(0, noise(s.riverMask, x * (1 / 7000), z * (1 / 7000))) * 900;
    let water = NO_WATER;
    const wl = lp - 1.2;
    h = carveRiver(h, wl, d, RIVER_HALF_WIDTH, 30, 0.22, 0.4);
    lp = smin(lp, wl + 1 + 0.22 * Math.max(0, d - 30) + 0.6 * Math.max(0, d - 150), 6);
    if (d < RIVER_HALF_WIDTH + 10) water = wl;
    if (LAKE_LEVEL > water) water = LAKE_LEVEL;

    o.h = h;
    o.lp = lp;
    o.water = water;
    o.riverD = d;
    o.mountain = mtnW;
    return o;
  }

  climate(x: number, z: number, b: BaseSample, out: Climate): Climate {
    const s = this.s;
    const wet = 1 - smoothstep(20, 180, b.riverD);
    out.moisture = clamp(0.52 + 0.5 * fbm(s.moist, x * (1 / 1800), z * (1 / 1800), 3) + 0.25 * wet, 0, 1);
    out.temperature = clamp(0.8 - b.h * (1 / 900) + 0.15 * noise(s.temp, x * (1 / 3000), z * (1 / 3000)), 0, 1);
    return out;
  }
}

/** Alpine Valley: authored valley spline (x, z) through ridged mountains, 3 × 3 km around the origin. */
export const ALPINE_VALLEY: readonly (readonly [number, number])[] = [
  [-150, 1750],
  [-60, 1200],
  [140, 760],
  [-180, 300],
  [160, -240],
  [-120, -800],
  [200, -1350],
  [120, -1800],
];
/** Wide flat basin at the valley mouth (hamlet, lookout hill side). */
export const ALPINE_MOUTH: readonly [number, number] = [-20, 1130];
/** Lake beside the valley. */
export const ALPINE_LAKE: readonly [number, number] = [-470, 360];
export const ALPINE_LAKE_RADIUS = 150;
export const ALPINE_HALF = 1500;

/** Catmull-Rom polyline through `pts`, `perSeg` samples per span, as flat [x0, z0, x1, z1, …]. */
export function catmullRom(pts: readonly (readonly [number, number])[], perSeg: number): Float64Array {
  const n = pts.length;
  const out = new Float64Array(((n - 1) * perSeg + 1) * 2);
  let k = 0;
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[Math.min(n - 1, i + 2)]!;
    for (let j = 0; j < perSeg; j++) {
      const t = j / perSeg;
      const t2 = t * t;
      const t3 = t2 * t;
      for (let a = 0; a < 2; a++) {
        out[k + a] = 0.5 * (2 * p1[a]! + (-p0[a]! + p2[a]!) * t + (2 * p0[a]! - 5 * p1[a]! + 4 * p2[a]! - p3[a]!) * t2 + (-p0[a]! + 3 * p1[a]! - 3 * p2[a]! + p3[a]!) * t3);
      }
      k += 2;
    }
  }
  out[k] = pts[n - 1]![0];
  out[k + 1] = pts[n - 1]![1];
  return out;
}

/** Distance from (x, z) to a flat polyline. */
export function polylineDistance(poly: Float64Array, x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i + 3 < poly.length; i += 2) {
    const d2 = segDist2(x, z, poly[i]!, poly[i + 1]!, poly[i + 2]!, poly[i + 3]!);
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}

class AlpineBase implements BaseTerrain {
  readonly preset = 'alpine' as const;
  readonly maxHeight = 1000;
  readonly minHeight = 60;
  readonly snowLine = 520;
  readonly treeLine = 420;
  readonly riverHalfWidth = 4;
  readonly clearRadius = 0;
  readonly valley = catmullRom(ALPINE_VALLEY, 16);
  readonly lakeLevel: number;
  private readonly s: Record<'wx' | 'wz' | 'mtn' | 'mass' | 'detail' | 'floor' | 'moist' | 'temp', number>;

  constructor(readonly seed: number) {
    this.s = {
      wx: subSeed(seed, SALT.warpX),
      wz: subSeed(seed, SALT.warpZ),
      mtn: subSeed(seed, SALT.mountains),
      mass: subSeed(seed, SALT.hills),
      detail: subSeed(seed, SALT.detail),
      floor: subSeed(seed, SALT.plains),
      moist: subSeed(seed, SALT.moisture),
      temp: subSeed(seed, SALT.temperature),
    };
    this.lakeLevel = this.floorAt(ALPINE_LAKE[0], ALPINE_LAKE[1]) - 2;
  }

  /** Valley floor: falls ≈ 105 m from the north end to the south mouth, with soft undulation. */
  floorAt(x: number, z: number): number {
    return 150 - 0.035 * z + 6 * noise(this.s.floor, x * (1 / 500), z * (1 / 500));
  }

  sample(x: number, z: number, o: BaseSample): BaseSample {
    const s = this.s;
    const wi = 1 / 1200;
    const wx = x + 80 * noise(s.wx, x * wi, z * wi);
    const wz = z + 80 * noise(s.wz, x * wi, z * wi);
    ridged(s.mtn, wx * (1 / 2200), wz * (1 / 2200), 5, f, 0.45);
    let h = 140 + 510 * f.v;
    let lp = 140 + 510 * f.lp;
    fbmDamped(s.mass, wx * (1 / 2200), wz * (1 / 2200), 4, f);
    h += 220 * (0.5 + 0.5 * f.v);
    lp += 220 * (0.5 + 0.5 * f.lp);

    const floor = this.floorAt(x, z);
    const d = polylineDistance(this.valley, x, z);
    const dx = x - ALPINE_MOUTH[0];
    const dz = z - ALPINE_MOUTH[1];
    const dm = Math.sqrt(dx * dx + dz * dz);
    const lx = x - ALPINE_LAKE[0];
    const lz = z - ALPINE_LAKE[1];
    const dl = Math.sqrt(lx * lx + lz * lz);

    // U-shaped valley along the spline, then the wide mouth basin; the walls get their own rock detail so the
    // carve does not leave smooth cones.
    const rock = 12 * fbm(s.detail, x * (1 / 260), z * (1 / 260), 3);
    const wall = floor + 1.3 * Math.max(0, d - 70);
    h = smin(h, wall + rock * smoothstep(70, 200, d), 30);
    lp = smin(lp, wall, 30);
    const basin = floor + 0.9 * Math.max(0, dm - 230);
    h = smin(h, basin + rock * smoothstep(230, 360, dm), 30);
    lp = smin(lp, basin, 30);

    // Stream along the valley centre line.
    const wl = floor - 0.6;
    const levee = wl + 0.4 - 0.3 * Math.abs(d - 12);
    if (levee > h) h = levee;
    h = smin(h, wl - 1.8 + 0.35 * Math.max(0, d - this.riverHalfWidth) + Math.max(0, d - this.riverHalfWidth - 10), 1.5);
    let water = d < 12 ? wl : NO_WATER;

    // Lake: a shallow bowl beside the valley, ringed by a levee at the shoreline radius.
    const ll = this.lakeLevel;
    const rim = 0.09 * Math.max(0, dl - 60) + 0.7 * Math.max(0, dl - 230);
    h = smin(h, ll - 7 + rim, 10);
    lp = smin(lp, ll + 1 + rim, 10);
    const shore = ll + 0.5 - 0.3 * Math.abs(dl - ALPINE_LAKE_RADIUS);
    if (shore > h) h = shore;
    if (dl < ALPINE_LAKE_RADIUS && ll > water) water = ll;

    o.h = h;
    o.lp = lp;
    o.water = water;
    o.riverD = d;
    o.mountain = smoothstep(260, 520, h);
    return o;
  }

  climate(x: number, z: number, b: BaseSample, out: Climate): Climate {
    out.moisture = clamp(0.6 + 0.35 * fbm(this.s.moist, x * (1 / 900), z * (1 / 900), 3) + 0.2 * (1 - smoothstep(15, 120, b.riverD)), 0, 1);
    out.temperature = clamp(0.85 - b.h * (1 / 800) + 0.1 * noise(this.s.temp, x * (1 / 1500), z * (1 / 1500)), 0, 1);
    return out;
  }
}

export function createBaseTerrain(preset: TerrainPreset, seed: number): BaseTerrain {
  switch (preset) {
    case 'training':
      return new TrainingBase(seed >>> 0);
    case 'alpine':
      return new AlpineBase(seed >>> 0);
    case 'infinite':
      return new InfiniteBase(seed >>> 0);
  }
}
