/** A level ready to fly: its definition plus what physics, race and render derive from it. DOM-free. */
import { levelColliders } from '../game/level-data';
import { createSurfaces, type SurfaceProvider } from '../game/surfaces';
import type { Collider, LevelDef, TerrainField } from '../types';

export interface LevelRuntime {
  readonly def: LevelDef;
  /** null on flat ground (y = 0) */
  readonly terrain: TerrainField | null;
  /** static + kinematic colliders (props, statics, ring rims); room planes / ground live in PhysicsWorld */
  readonly colliders: readonly Collider[];
  readonly surfaces: SurfaceProvider;
  /** resolves once the world around the spawn can be flown (authored levels: already resolved) */
  readonly ready: Promise<void>;
}

export function createRuntime(def: LevelDef, terrain: TerrainField | null = null): LevelRuntime {
  return {
    def,
    terrain,
    colliders: levelColliders({ props: def.props, rings: def.rings, statics: def.kind === 'outdoor' ? def.statics : [] }),
    surfaces: createSurfaces(def.props, terrain),
    ready: Promise.resolve(),
  };
}

/** Ground height under (x, z) for a level. */
export function groundAt(rt: Pick<LevelRuntime, 'terrain'>, x: number, z: number): number {
  return rt.terrain ? rt.terrain.heightAt(x, z) : 0;
}

/** True when `x` is a LevelRuntime rather than raw room data (legacy constructors accept both). */
export function isRuntime(x: object): x is LevelRuntime {
  return 'def' in x && 'surfaces' in x;
}
