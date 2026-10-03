/**
 * Public entry of the world engine: a `World` bundles the terrain field with the settlement and road layers
 * of one (seed, preset, generator version). Pure TS — no DOM, no three.js — so the worker, the main thread
 * (physics) and tests build identical worlds from the same spec.
 */
import type { BaseTerrain, TerrainPreset } from './base-terrain';
import { createWorldV1 } from './generators/v1';
import { createWorldV2 } from './generators/v2';
import type { RoadSource } from './roads';
import type { House, Settlements, Village } from './settlements';
import type { ComposedTerrainField } from './terrain-field';

/** Generator version for new worlds. Older versions stay in generators/ so saved seeds reproduce forever. */
export const GEN_VERSION = 2;
export const SUPPORTED_GEN_VERSIONS: readonly number[] = [1, 2];

export interface WorldSpec {
  seed: number;
  preset: TerrainPreset;
  genVersion: number;
}

export interface World {
  readonly spec: Readonly<WorldSpec>;
  /** the analytic terrain (physics, chunk meshes, spawn, routes) */
  readonly field: ComposedTerrainField;
  readonly base: BaseTerrain;
  readonly settlements: Settlements;
  readonly roads: RoadSource;
  /** houses of a village (memoised; identical for every caller) */
  houses(v: Village): House[];
}

export function worldKey(spec: WorldSpec): string {
  return `${spec.genVersion}:${spec.preset}:${spec.seed >>> 0}`;
}

/** Builds the world for `spec`. Throws for a generator version this build does not ship. */
export function createWorld(spec: WorldSpec): World {
  const s: WorldSpec = { seed: spec.seed >>> 0, preset: spec.preset, genVersion: spec.genVersion };
  switch (s.genVersion) {
    case 1:
      return createWorldV1(s);
    case 2:
      return createWorldV2(s);
    default:
      throw new Error(`Unsupported world generator version ${spec.genVersion}`);
  }
}
