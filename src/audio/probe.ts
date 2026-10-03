/**
 * What the ambience needs to know about the world around the listener: ground height, and where the
 * nearest water and village are. Generated levels answer from the world engine's field (biomeAt); authored
 * levels have neither. Allocation-free per query.
 */
import { worldField, groundAt, type LevelRuntime } from '../levels/runtime';
import { BIOME, biomeSample, type BiomeSample } from '../world/terrain-field';
import type { Surface } from './surface';

export interface Spot {
  x: number;
  y: number;
  z: number;
  /** 0..1 closeness (1 = on top of it) */
  near: number;
}

export interface AudioProbe {
  ground(x: number, z: number): number;
  /** nearest water around (x, z) into `out`; returns its closeness */
  water(x: number, z: number, out: Spot): number;
  village(x: number, z: number, out: Spot): number;
  /** what the ground at (x, z) is made of, for a drone at height y (water when it is at the surface) */
  surface(x: number, y: number, z: number): Surface;
}

/** Sample rings around the listener: the centre, then 8 directions at each radius. */
const RADII = [28, 70];
const CLOSENESS = [0.65, 0.3];
const DX = Array.from({ length: 8 }, (_, i) => Math.cos((i * Math.PI) / 4));
const DZ = Array.from({ length: 8 }, (_, i) => Math.sin((i * Math.PI) / 4));

const isWater = (s: BiomeSample): number => (s.biome === BIOME.water || s.river > 0.2 || Number.isFinite(s.water) ? Math.max(0.6, s.river) : 0);
const isVillage = (s: BiomeSample): number => (s.village > 0.3 ? s.village : 0);

export function levelProbe(level: Pick<LevelRuntime, 'terrain'>, lite = false): AudioProbe {
  const field = worldField(level);
  const sample = biomeSample();
  const rings = lite ? 1 : RADII.length;

  function consider(sx: number, sz: number, closeness: number, out: Spot, test: (s: BiomeSample) => number): void {
    field!.biomeAt(sx, sz, sample);
    const near = closeness * test(sample);
    if (near <= out.near) return;
    out.near = near;
    out.x = sx;
    out.z = sz;
    out.y = Number.isFinite(sample.water) ? sample.water : sample.height;
  }

  function scan(x: number, z: number, out: Spot, test: (s: BiomeSample) => number): number {
    out.near = 0;
    if (!field) return 0;
    consider(x, z, 1, out, test);
    for (let k = 0; k < rings && out.near < 1; k++) for (let d = 0; d < 8; d++) consider(x + DX[d]! * RADII[k]!, z + DZ[d]! * RADII[k]!, CLOSENESS[k]!, out, test);
    return out.near;
  }

  return {
    ground: (x, z) => groundAt(level, x, z),
    water: (x, z, out) => scan(x, z, out, isWater),
    village: (x, z, out) => scan(x, z, out, isVillage),
    surface: (x, y, z) => {
      if (!field) return 'soft';
      field.biomeAt(x, z, sample);
      if (Number.isFinite(sample.water) && y <= sample.water + 0.6) return 'water';
      if (sample.biome === BIOME.rock || sample.biome === BIOME.road || sample.biome === BIOME.village) return 'concrete';
      return 'soft';
    },
  };
}

/** Probe for levels without a world (and tests): flat ground, no water, no villages. */
export const FLAT_PROBE: AudioProbe = {
  ground: () => 0,
  water: (_x, _z, out) => (out.near = 0),
  village: (_x, _z, out) => (out.near = 0),
  surface: () => 'soft',
};
