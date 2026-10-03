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
  /**
   * detailed trees near the drone (the Training models: ≈ 1.4–2.3 k triangles each on ultra / high, the opaque
   * masses on medium), nearest chunks first
   */
  treesLod0: number;
  treesLod1: number;
  /** rocks and boulders drawn (Quest: off, one draw saved per eye) */
  rocks: boolean;
  /**
   * City: street trees, lights, parked cars and kerbs are drawn within this distance of the drone (inside the fog;
   * high: the sun cascades draw them again, twice)
   */
  furnitureRange: number;
  /** City: raised kerbs (no collider; the ground shader paints the kerb line anyway) */
  kerbs: boolean;
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
    fog: 4200, treesLod0: 180, treesLod1: 14000, rocks: true, furnitureRange: Infinity, kerbs: true, uploads: 2, sunShadows: true, facadeDetail: true, waterDetail: true, outskirts: 1,
  },
  high: {
    stream: { radius: 4, lod0: 1.5, lod1: 2.5, maxInFlight: 5 },
    farRadius: 20,
    fog: 3200, treesLod0: 70, treesLod1: 10000, rocks: true, furnitureRange: 450, kerbs: true, uploads: 2, sunShadows: true, facadeDetail: true, waterDetail: true, outskirts: 1,
  },
  medium: {
    stream: { radius: 3, lod0: 0.75, lod1: 1.5, maxInFlight: 4 },
    farRadius: 10,
    fog: 1400, treesLod0: 90, treesLod1: 5000, rocks: true, furnitureRange: 320, kerbs: false, uploads: 1, sunShadows: false, facadeDetail: true, waterDetail: true, outskirts: 0.6,
  },
  low: {
    // only the chunk under the drone at LOD1 (landing matches the physics ground); the rest is one LOD2 batch
    stream: { radius: 2, lod0: 0, lod1: 0.5, maxInFlight: 3 },
    farRadius: 0,
    fog: 350, treesLod0: 0, treesLod1: 1800, rocks: false, furnitureRange: 260, kerbs: false, uploads: 1, sunShadows: false, facadeDetail: false, waterDetail: false, outskirts: 0.15,
  },
};

/** View distance setting → scale of the tier's fog / streaming reach ('auto' = the tier's own). */
export const VIEW_DISTANCE_SCALE: Readonly<Record<'auto' | 'short' | 'medium' | 'long', number>> = { auto: 1, short: 0.5, medium: 0.75, long: 1.3 };

/**
 * Phones: the medium budget, with the batched far backdrop one chunk ring shorter (9 × 128 m, still past where
 * the medium fog leaves ~5 % of the ground): Alpine in chase was at 254 k triangles of the 250 k budget, and the
 * backdrop is the largest single draw (≈ 51 k → 41 k).
 */
export const PHONE_OUTDOOR_PROFILE: Readonly<OutdoorProfile> = { ...OUTDOOR_PROFILES.medium, farRadius: 9 };

/** Phones run the phone budget at most (07 §7: iPhone row); tablets and desktop take the tier as is. */
export function outdoorProfile(tier: QualityTier, form: FormFactor = 'desktop'): OutdoorProfile {
  if (form === 'phone' && tier !== 'low') return PHONE_OUTDOOR_PROFILE;
  return OUTDOOR_PROFILES[tier];
}

/**
 * View distance scale: the pilot's View distance setting times the adaptive step (07 §7: render scale stuck at
 * 0.5 shrinks fog and radius by 0.75, never below 2 chunks). Above 1 ("Long") only the fog and the batched far
 * backdrop reach further (one draw either way); the streamed radius keeps the tier's budget.
 */
export function scaledProfile(p: OutdoorProfile, viewScale: number): OutdoorProfile {
  if (viewScale === 1) return p;
  if (viewScale > 1) return p.farRadius > 0 ? { ...p, fog: p.fog * viewScale, farRadius: Math.round(p.farRadius * viewScale) } : { ...p, fog: p.fog * viewScale };
  const radius = Math.max(2, Math.round(p.stream.radius * viewScale));
  return { ...p, fog: p.fog * viewScale, farRadius: Math.round(p.farRadius * viewScale), stream: { ...p.stream, radius } };
}
