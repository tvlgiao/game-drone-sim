/** Drone level-of-detail policy and the render budgets the model is held to (unit-tested). */
import type { QualityTier } from '../../types';

export type DroneLod = 0 | 1;

/** LOD0: close / chase views. LOD1: LOS at distance, the low tier and Quest. */
export const DRONE_BUDGET = {
  lod0: { triangles: 25_000, drawCalls: 12 },
  lod1: { triangles: 5_000, drawCalls: 6 },
} as const;

/** Viewing distance (m) beyond which LOD1 is used at scale 1; LOD0 returns below FAR × HYSTERESIS. */
export const LOD_FAR = 4;
export const LOD_HYSTERESIS = 0.85;

export interface LodPolicy {
  /** always LOD1 (low tier: Quest 2, software GPUs) */
  forceLite: boolean;
  /** multiplies LOD_FAR (higher tiers keep the detailed model further out) */
  scale: number;
}

export function lodPolicy(tier: QualityTier): LodPolicy {
  switch (tier) {
    case 'ultra':
      return { forceLite: false, scale: 1.6 };
    case 'high':
      return { forceLite: false, scale: 1.25 };
    case 'medium':
      return { forceLite: false, scale: 0.8 };
    default:
      return { forceLite: true, scale: 0 };
  }
}

/** Next LOD for a viewing distance, with hysteresis so it never flickers at the boundary. */
export function selectLod(distance: number, current: DroneLod, policy: LodPolicy): DroneLod {
  if (policy.forceLite) return 1;
  const far = LOD_FAR * policy.scale;
  if (current === 0) return distance > far ? 1 : 0;
  return distance < far * LOD_HYSTERESIS ? 0 : 1;
}
