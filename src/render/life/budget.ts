/**
 * Living-world budgets per quality tier (docs/12 §budgets). Quest / VR always runs `low`: traffic within 250 m on
 * one generic draw, no pedestrians, no smoke, no light pools — at most four extra draws per eye in any level.
 */
import type { FormFactor } from '../../core/device';
import type { QualityTier } from '../../types';

export interface LifeBudget {
  /** City cars alive at once and the radius they live in (m) */
  cars: number;
  carRadius: number;
  /** one generic vehicle draw for every type */
  genericCars: boolean;
  /** headlight pools / beams (one additive draw) */
  carGlow: boolean;
  /** cars and signal housings cast into the sun cascades */
  carShadows: boolean;
  /** traffic lights drawn within this distance (m) */
  signalRange: number;
  /** rural cars (Infinite, Alpine) */
  ruralCars: number;
  /** bird flocks and birds per flock */
  flocks: number;
  birds: number;
  /** soft smoke / steam puffs (0: none) */
  puffs: number;
  /** grazing animals drawn */
  animals: number;
  /** the tractor */
  tractor: boolean;
  /** City roof life: AC fans, flags (one draw each) */
  roofLife: boolean;
  /** cloud drift on the sky dome */
  clouds: boolean;
}

export const LIFE_BUDGETS: Readonly<Record<QualityTier, LifeBudget>> = {
  ultra: { cars: 220, carRadius: 420, genericCars: false, carGlow: true, carShadows: true, signalRange: 260, ruralCars: 10, flocks: 3, birds: 16, puffs: 160, animals: 90, tractor: true, roofLife: true, clouds: true },
  high: { cars: 160, carRadius: 380, genericCars: false, carGlow: true, carShadows: true, signalRange: 220, ruralCars: 8, flocks: 3, birds: 12, puffs: 110, animals: 70, tractor: true, roofLife: true, clouds: true },
  medium: { cars: 90, carRadius: 300, genericCars: false, carGlow: false, carShadows: false, signalRange: 170, ruralCars: 6, flocks: 2, birds: 10, puffs: 60, animals: 48, tractor: true, roofLife: true, clouds: true },
  low: { cars: 40, carRadius: 250, genericCars: true, carGlow: false, carShadows: false, signalRange: 110, ruralCars: 4, flocks: 1, birds: 8, puffs: 0, animals: 24, tractor: false, roofLife: false, clouds: true },
};

/** Phones take the medium budget at most (like the outdoor profile). */
export function lifeBudget(tier: QualityTier, form: FormFactor = 'desktop'): LifeBudget {
  if (form === 'phone' && (tier === 'ultra' || tier === 'high')) return LIFE_BUDGETS.medium;
  return LIFE_BUDGETS[tier];
}
