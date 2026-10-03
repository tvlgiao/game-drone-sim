/**
 * Where the countryside's life goes (docs/12), from the generated world around a point: smoking chimneys on the
 * village cottages and farmhouses, herds of cows / sheep grazing on open meadow near the villages, rows of wind
 * turbines on open land (Infinite), and the field a tractor ploughs near the closest village. Deterministic per
 * seed and place (hashes of villages and cells, no stream state), so the same spot always holds the same herd.
 * Pure; trigonometry through dsin / dcos.
 */
import { dcos, dsin, TAU } from '../math';
import { hash2, rehash, u01 } from '../rng';
import { houseArchetype } from '../settlements';
import { BIOME, biomeSample, type BiomeSample } from '../terrain-field';
import type { World } from '../world';

const SALT_LIFE = 0x11fe;
/** turbine rows: one candidate per cell of this size (m) */
export const TURBINE_CELL = 640;
export const TURBINE_SPACING = 120;
/** a turbine's tower collider */
export const TURBINE_RADIUS = 1.7;

export interface Herd {
  /** animal positions x, y, z, yaw (4 per animal) */
  animals: number[];
  /** 0 cows, 1 sheep */
  kind: number;
  /** herd centre */
  x: number;
  z: number;
}

export interface TractorField {
  /** field centre, its yaw (rows run along local Z) and half sizes (m) */
  x: number;
  z: number;
  yaw: number;
  halfW: number;
  halfL: number;
}

export interface CountrysideLife {
  /** chimney tops x, y, z (smoking ones only) */
  chimneys: number[];
  herds: Herd[];
  /** turbine feet x, y, z, yaw (facing the wind) */
  turbines: number[];
  tractor: TractorField | null;
}

const open = (b: BiomeSample, maxSlope: number): boolean => (b.biome === BIOME.meadow || b.biome === BIOME.farmland || b.biome === BIOME.scrub) && b.slope < maxSlope && b.water === -Infinity;

/**
 * Life within `radius` of (x, z). `windYaw`: rotation about +Y that faces the wind (turbines turn their rotor into
 * it). `turbines`: rows of wind turbines (Infinite only; the Alpine valley has none).
 */
export function countrysideAround(world: World, x: number, z: number, radius: number, windYaw: number, opts: { turbines: boolean; sheep: boolean } = { turbines: true, sheep: true }): CountrysideLife {
  const seed = world.spec.seed >>> 0;
  const field = world.field;
  const b = biomeSample();
  const out: CountrysideLife = { chimneys: [], herds: [], turbines: [], tractor: null };
  const villages = world.settlements.villagesInBox(x - radius, z - radius, x + radius, z + radius);
  let nearest = Infinity;
  for (const v of villages) {
    const hv = hash2(seed, Math.floor(v.x), Math.floor(v.z), SALT_LIFE);
    // chimneys: cottages and farmhouses, about half of them lit
    for (const h of world.houses(v)) {
      const arch = houseArchetype(h.archetype);
      if (arch !== 0 && arch !== 1) continue;
      const hh = hash2(seed, Math.floor(h.x * 4), Math.floor(h.z * 4), SALT_LIFE + 1);
      if (u01(hh) > 0.55) continue;
      const lx = 0.28 * h.w;
      const lz = -0.2 * h.d;
      const c = dcos(h.yaw);
      const s = dsin(h.yaw);
      out.chimneys.push(h.x + c * lx + s * lz, h.y + h.wallHeight + 0.8 * h.roofHeight + 0.1, h.z - s * lx + c * lz);
    }
    // a herd on open grass beside the village
    if (u01(hv) < 0.75) {
      for (let t = 0; t < 8; t++) {
        const a = u01(rehash(hv, 10 + t)) * TAU;
        const d = v.radius + 50 + 70 * u01(rehash(hv, 20 + t));
        const cx = v.x + dcos(a) * d;
        const cz = v.z + dsin(a) * d;
        field.biomeAt(cx, cz, b);
        if (!open(b, 0.22) || b.road > 0.2 || b.village > 0.2) continue;
        const kind = opts.sheep && u01(rehash(hv, 30)) < 0.4 ? 1 : 0;
        const n = 4 + Math.floor(u01(rehash(hv, 31)) * (kind ? 9 : 6));
        const herd: Herd = { animals: [], kind, x: cx, z: cz };
        for (let i = 0; i < n; i++) {
          const ai = rehash(hv, 40 + i);
          const ax = cx + (u01(ai) - 0.5) * 26;
          const az = cz + (u01(rehash(ai, 1)) - 0.5) * 26;
          field.biomeAt(ax, az, b);
          if (!open(b, 0.3)) continue;
          herd.animals.push(ax, field.heightAt(ax, az), az, u01(rehash(ai, 2)) * TAU);
        }
        if (herd.animals.length > 0) out.herds.push(herd);
        break;
      }
    }
    // the tractor works a field by the village nearest to the point
    const dv = (v.x - x) * (v.x - x) + (v.z - z) * (v.z - z);
    if (dv < nearest) {
      for (let t = 0; t < 10; t++) {
        const a = u01(rehash(hv, 60 + t)) * TAU;
        const d = v.radius + 70 + 90 * u01(rehash(hv, 70 + t));
        const cx = v.x + dcos(a) * d;
        const cz = v.z + dsin(a) * d;
        const yaw = u01(rehash(hv, 80 + t)) * TAU;
        // the whole field must be farmland or meadow and gentle
        let ok = true;
        // the first tries want ploughland, later ones take a meadow
        const farm = t < 6;
        for (const [fx, fz] of [
          [0, 0],
          [-24, -34],
          [24, -34],
          [-24, 34],
          [24, 34],
        ] as const) {
          const px = cx + dcos(yaw) * fx + dsin(yaw) * fz;
          const pz = cz - dsin(yaw) * fx + dcos(yaw) * fz;
          field.biomeAt(px, pz, b);
          if (!open(b, 0.12) || (farm && b.biome !== BIOME.farmland) || b.road > 0.2 || b.village > 0.1 || b.forest > 0.35) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        nearest = dv;
        out.tractor = { x: cx, z: cz, yaw, halfW: 22, halfL: 32 };
        break;
      }
    }
  }
  if (!opts.turbines) return out;
  // wind turbine rows: a candidate per cell, rows of three across the wind
  const i0 = Math.floor((x - radius) / TURBINE_CELL);
  const i1 = Math.floor((x + radius) / TURBINE_CELL);
  const j0 = Math.floor((z - radius) / TURBINE_CELL);
  const j1 = Math.floor((z + radius) / TURBINE_CELL);
  const ax = dcos(windYaw);
  const az = -dsin(windYaw);
  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      const h = hash2(seed, i, j, SALT_LIFE + 7);
      if (u01(h) > 0.24) continue;
      const cx = (i + 0.2 + 0.6 * u01(rehash(h, 1))) * TURBINE_CELL;
      const cz = (j + 0.2 + 0.6 * u01(rehash(h, 2))) * TURBINE_CELL;
      for (let k = -1; k <= 1; k++) {
        const tx = cx + ax * k * TURBINE_SPACING;
        const tz = cz + az * k * TURBINE_SPACING;
        field.biomeAt(tx, tz, b);
        if (!open(b, 0.18) || b.road > 0.05 || b.village > 0.01 || b.forest > 0.3) continue;
        let clear = true;
        for (const v of villages) if ((v.x - tx) * (v.x - tx) + (v.z - tz) * (v.z - tz) < (v.radius + 160) * (v.radius + 160)) clear = false;
        if (!clear) continue;
        out.turbines.push(tx, field.heightAt(tx, tz) - 0.5, tz, windYaw);
      }
    }
  }
  return out;
}
