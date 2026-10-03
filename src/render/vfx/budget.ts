/**
 * Per-tier VFX budgets. Pools are allocated once per device class (capacity) and every event
 * emits at most its tier's cap, so switching tier at runtime (e.g. entering VR → 'low') never
 * reallocates. Quest 2 runs the 'low' tier: no speed lines, no wash decal ripples, few particles.
 */
import type { FormFactor } from '../../core/device';
import type { QualityTier } from '../../types';

export interface VfxBudget {
  tier: QualityTier;
  /** legacy emission multiplier for the point-particle pools */
  scale: number;
  /** spark streaks per crash (at speed ≥ 8 m/s) */
  crashSparks: number;
  /** spark streaks per wall/floor impact */
  impactSparks: number;
  /** tumbling debris pieces per crash */
  debris: number;
  /** dust/smoke puffs per crash */
  dust: number;
  /** ring-pass sparkles (point pool) */
  ringParticles: number;
  /** ring-pass streaks flung off the gate */
  ringStreaks: number;
  /** prop-wash dust particles per second at full throttle on the ground */
  washRate: number;
  /** animated ripple decal under the quad */
  washDecal: boolean;
  /** FPV air streaks at speed (0 = off) */
  speedLines: number;
}

export const VFX_BUDGETS: Readonly<Record<QualityTier, VfxBudget>> = {
  ultra: { tier: 'ultra', scale: 1, crashSparks: 220, impactSparks: 40, debris: 28, dust: 26, ringParticles: 220, ringStreaks: 48, washRate: 240, washDecal: true, speedLines: 160 },
  high: { tier: 'high', scale: 0.85, crashSparks: 170, impactSparks: 32, debris: 22, dust: 20, ringParticles: 180, ringStreaks: 36, washRate: 200, washDecal: true, speedLines: 120 },
  medium: { tier: 'medium', scale: 0.55, crashSparks: 100, impactSparks: 20, debris: 14, dust: 12, ringParticles: 120, ringStreaks: 20, washRate: 120, washDecal: true, speedLines: 64 },
  low: { tier: 'low', scale: 0.3, crashSparks: 48, impactSparks: 10, debris: 8, dust: 6, ringParticles: 64, ringStreaks: 0, washRate: 60, washDecal: false, speedLines: 0 },
};

/** Pool capacities per device class (desktop also covers the Quest browser, which runs 'low'). */
export interface VfxCapacity {
  points: number;
  soft: number;
  streaks: number;
  debris: number;
  speedLines: number;
}

export function vfxCapacity(form: FormFactor): VfxCapacity {
  const mobile = form !== 'desktop';
  return {
    points: mobile ? 2048 : 4096,
    soft: mobile ? 1024 : 2048,
    streaks: mobile ? 320 : 512,
    debris: mobile ? 32 : 64,
    speedLines: VFX_BUDGETS.ultra.speedLines,
  };
}

/** Tier budget for a device class: phones halve the per-event counts (but keep the features). */
export function vfxBudget(tier: QualityTier, form: FormFactor = 'desktop'): VfxBudget {
  const b = VFX_BUDGETS[tier];
  if (form !== 'phone') return b;
  const k = 0.5;
  return {
    ...b,
    crashSparks: Math.round(b.crashSparks * k),
    impactSparks: Math.round(b.impactSparks * k),
    debris: Math.round(b.debris * k),
    dust: Math.round(b.dust * k),
    ringParticles: Math.round(b.ringParticles * k),
    ringStreaks: Math.round(b.ringStreaks * k),
    washRate: Math.round(b.washRate * k),
    speedLines: Math.round(b.speedLines * k),
  };
}
