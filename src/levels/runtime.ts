/** A level ready to fly: its definition plus what physics, race and render derive from it. DOM-free. */
import { levelColliders } from '../game/level-data';
import { createSurfaces, type SurfaceProvider } from '../game/surfaces';
import type { Collider, LevelDef, TerrainField } from '../types';
import { ColliderGrid } from '../physics/collider-grid';
import { FLAT_GROUND, type HeightField } from '../physics/terrain';

/** Grid owner of a level's authored colliders (streamed chunks use their chunk keys). */
export const LEVEL_OWNER = 'level';

export interface LevelRuntime {
  readonly def: LevelDef;
  /** null on flat ground (y = 0) */
  readonly terrain: TerrainField | null;
  /** static + kinematic colliders (props, statics, ring rims); room planes / ground live in PhysicsWorld */
  readonly colliders: readonly Collider[];
  /**
   * Outdoor levels: every collider physics and the camera test, `colliders` under LEVEL_OWNER plus the
   * chunks the world streams in. Indoor: null (physics keeps its flat list).
   */
  readonly grid: ColliderGrid | null;
  readonly surfaces: SurfaceProvider;
  /** resolves once the world around the spawn can be flown (authored levels: already resolved) */
  readonly ready: Promise<void>;
}

export function createRuntime(def: LevelDef, terrain: TerrainField | null = null): LevelRuntime {
  const colliders = levelColliders({ props: def.props, rings: def.rings, statics: def.kind === 'outdoor' ? def.statics : [] });
  let grid: ColliderGrid | null = null;
  if (def.kind === 'outdoor') {
    grid = new ColliderGrid();
    grid.insertOwned(LEVEL_OWNER, colliders);
  }
  return {
    def,
    terrain,
    colliders,
    grid,
    surfaces: createSurfaces(def.props, terrain, grid),
    ready: Promise.resolve(),
  };
}

/** The level's ground as a height field (flat y = 0 when it has no terrain). */
export function heightField(rt: Pick<LevelRuntime, 'terrain'>): HeightField {
  return rt.terrain ?? FLAT_GROUND;
}

/** Ground height under (x, z) for a level. */
export function groundAt(rt: Pick<LevelRuntime, 'terrain'>, x: number, z: number): number {
  return rt.terrain ? rt.terrain.heightAt(x, z) : 0;
}

/** True when `x` is a LevelRuntime rather than raw room data (legacy constructors accept both). */
export function isRuntime(x: object): x is LevelRuntime {
  return 'def' in x && 'surfaces' in x;
}
