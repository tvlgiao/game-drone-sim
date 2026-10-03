/**
 * Outdoor budgets per quality tier (design 07 §7): chunk radius and LOD split, fog distance, tree counts,
 * chunk uploads per frame, sun-follow shadows and the far backdrop. XR always uses `low` (Quest 2).
 * Deviation from the 07 table: with a batched LOD2 backdrop out to `farRadius` the fog can reach further
 * (ultra 4.2 km instead of 1.2 km) for three extra draws, so mountains read at a distance.
 */
import type { FormFactor } from '../../core/device';
import type { QualityTier } from '../../types';
import type { StreamConfig } from '../../levels/chunk-streamer';

export interface OutdoorProfile {
  stream: Pick<StreamConfig, 'radius' | 'lod0' | 'lod1' | 'maxInFlight'>;
  /** backdrop square (chunks, LOD2 ground only, one batched draw); 0 = none */
  farRadius: number;
  /** 1 % visibility distance cap (m); the level's own fog may be shorter */
  fog: number;
  treesLod0: number;
  treesLod1: number;
  /** chunk meshes created / uploaded per frame (the 3 × 3 under the drone never waits) */
  uploads: number;
  sunShadows: boolean;
  /** City: lit windows and facade detail in the building shader */
  facadeDetail: boolean;
  /** animated water normals and sky reflection */
  waterDetail: boolean;
  /** City: visual-only outskirts beyond the playable blocks */
  outskirts: number;
}

export const OUTDOOR_PROFILES: Readonly<Record<QualityTier, OutdoorProfile>> = {
  ultra: {
    stream: { radius: 5, lod0: 1.5, lod1: 2.5, maxInFlight: 6 },
    farRadius: 26,
    fog: 4200, treesLod0: 3000, treesLod1: 12000, uploads: 2, sunShadows: true, facadeDetail: true, waterDetail: true, outskirts: 1,
  },
  high: {
    stream: { radius: 4, lod0: 1.5, lod1: 2.5, maxInFlight: 5 },
    farRadius: 20,
    fog: 3200, treesLod0: 2000, treesLod1: 8000, uploads: 2, sunShadows: true, facadeDetail: true, waterDetail: true, outskirts: 1,
  },
  medium: {
    stream: { radius: 3, lod0: 0.75, lod1: 1.5, maxInFlight: 4 },
    farRadius: 10,
    fog: 1400, treesLod0: 800, treesLod1: 4000, uploads: 1, sunShadows: false, facadeDetail: true, waterDetail: true, outskirts: 0.6,
  },
  low: {
    stream: { radius: 2, lod0: 0, lod1: 1, maxInFlight: 3 },
    farRadius: 0,
    fog: 350, treesLod0: 300, treesLod1: 2500, uploads: 1, sunShadows: false, facadeDetail: false, waterDetail: false, outskirts: 0.35,
  },
};

/** Phones run the medium budget at most (07 §7: iPhone / tablet row); desktop takes the tier as is. */
export function outdoorProfile(tier: QualityTier, form: FormFactor = 'desktop'): OutdoorProfile {
  if (form === 'phone' && (tier === 'ultra' || tier === 'high')) return OUTDOOR_PROFILES.medium;
  return OUTDOOR_PROFILES[tier];
}

/** Adaptive view distance (07 §7): render scale stuck at 0.5 shrinks fog and radius by 0.75, never below 2 chunks. */
export function scaledProfile(p: OutdoorProfile, viewScale: number): OutdoorProfile {
  if (viewScale >= 1) return p;
  const radius = Math.max(2, Math.round(p.stream.radius * viewScale));
  return { ...p, fog: p.fog * viewScale, farRadius: Math.round(p.farRadius * viewScale), stream: { ...p.stream, radius } };
}
