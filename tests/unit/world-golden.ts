/** Golden sample sets shared by the Vitest determinism test and the browser harness (Chromium / WebKit). */
import type { ChunkRequest } from '../../src/world/chunk-gen';
import { createWorld, type WorldSpec } from '../../src/world/world';
import type { TerrainPreset } from '../../src/world/base-terrain';

export const GOLDEN_SEEDS: readonly number[] = [1, 42, 0xffffffff];

/** 20 points: origin, the Training field, Alpine valley / lake / peaks, far-out and fractional coordinates. */
export const GOLDEN_POINTS: readonly (readonly [number, number])[] = [
  [0, 0],
  [12.5, -7.25],
  [-36, 30],
  [100, 1180],
  [-470, 360],
  [-1200, -900],
  [900, 400],
  [-60, 1200],
  [333.333, -777.777],
  [1500, -1500],
  [-2048, 4096],
  [5000.5, -2500.25],
  [-10000, -10000],
  [12345.678, 9876.543],
  [-24999.9, 24999.9],
  [40000, -3000],
  [-37000.125, 18000.875],
  [0.001, -0.001],
  [777, 777],
  [-4321, 1234],
];

export function goldenHeights(preset: TerrainPreset, seed: number): number[] {
  const f = createWorld({ seed, preset, genVersion: 1 }).field;
  return GOLDEN_POINTS.map(([x, z]) => f.heightAt(x, z));
}

/** Chunks whose byte digests are pinned (terrain, water, roads, houses, trees). */
export const GOLDEN_CHUNKS: readonly { key: string; spec: WorldSpec; req: ChunkRequest }[] = [
  { key: 'infinite-42-(-1,1)-lod0', spec: { seed: 42, preset: 'infinite', genVersion: 1 }, req: { cx: -1, cz: 1, lod: 0 } },
  { key: 'infinite-1-(0,2)-lod1', spec: { seed: 1, preset: 'infinite', genVersion: 1 }, req: { cx: 0, cz: 2, lod: 1 } },
  { key: 'alpine-1-(0,9)-lod0', spec: { seed: 1, preset: 'alpine', genVersion: 1 }, req: { cx: 0, cz: 9, lod: 0 } },
  { key: 'alpine-1-(-4,2)-lod2', spec: { seed: 1, preset: 'alpine', genVersion: 1 }, req: { cx: -4, cz: 2, lod: 2 } },
  { key: 'training-7-(1,-1)-lod0', spec: { seed: 7, preset: 'training', genVersion: 1 }, req: { cx: 1, cz: -1, lod: 0 } },
];
