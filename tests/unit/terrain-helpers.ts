import { createRuntime, type LevelRuntime } from '../../src/levels/runtime';
import { TRAINING_LEVEL } from '../../src/levels/training';
import type { HeightField } from '../../src/physics/terrain';
import type { Collider, OutdoorLevel, RingDef, WorldBounds } from '../../src/types';

/** Height-field stubs standing in for the world engine's TerrainField. */
export const FLAT: HeightField = { heightAt: () => 0 };
export const raised = (h: number): HeightField => ({ heightAt: () => h });
/** plane rising towards +x with gradient `g` */
export const slope = (g: number): HeightField => ({ heightAt: (x) => g * x });
/** rolling hills, slope ≤ 0.8 */
export const HILLS: HeightField = {
  heightAt: (x, z) => 6 * Math.sin(x / 15) * Math.cos(z / 17) + 2 * Math.sin(x / 5.3 + z / 7.1) + 8,
};
/** flat at 0, then a ramp at the generator's slope cap (2.5 ≈ 68°) from x = 10 up to a 30 m plateau */
export const CLIFF: HeightField = { heightAt: (x) => Math.min(30, Math.max(0, (x - 10) * 2.5)) };
/** a true vertical 30 m wall at x = 10 (steeper than the generator ever makes) */
export const WALL: HeightField = { heightAt: (x) => (x > 10 ? 30 : 0) };

export interface OutdoorOpts {
  bounds?: WorldBounds;
  rings?: RingDef[];
  statics?: Collider[];
  spawn?: OutdoorLevel['spawn'];
  pilot?: OutdoorLevel['pilot'];
  relocatePilot?: boolean;
}

/** An outdoor level over `field` with no props (Training's environment, empty course unless given). */
export function outdoor(field: HeightField | null, o: OutdoorOpts = {}): LevelRuntime {
  const def: OutdoorLevel = {
    ...TRAINING_LEVEL,
    props: [],
    rings: o.rings ?? [],
    statics: o.statics ?? [],
    bounds: o.bounds ?? { kind: 'infinite', maxAgl: 120 },
    spawn: o.spawn ?? { position: [0, (field?.heightAt(0, 0) ?? 0) + 0.06, 0], yaw: 0 },
    pilot: o.pilot ?? [0, (field?.heightAt(0, 5) ?? 0) + 1.7, 5],
    relocatePilot: o.relocatePilot,
  };
  return createRuntime(def, field);
}

export function box(id: string, center: [number, number, number], half: [number, number, number], yaw = 0): Collider {
  return { id, shape: { kind: 'box', center, half, yaw } };
}

/** Deterministic 0..1 sequence (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
