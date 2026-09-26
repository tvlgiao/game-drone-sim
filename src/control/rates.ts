/** Stick shaping: Betaflight "Actual" rates and the throttle mid/expo curve. */
import type { AxisRates, RateProfile } from '../types';

/** Betaflight Actual rates: centre sensitivity, max rate and expo; returns deg/s (sign follows stick). */
export function actualRate(stick: number, r: RateProfile): number {
  const x = stick < -1 ? -1 : stick > 1 ? 1 : stick;
  const ax = Math.abs(x);
  const x5 = x * x * x * x * x;
  const expof = ax * (x5 * r.expo + x * (1 - r.expo));
  const stickMovement = Math.max(0, r.max - r.center);
  return x * r.center + stickMovement * expof;
}

export const RATE_PRESETS: Record<'beginner' | 'freestyle' | 'race', RateProfile> = {
  beginner: { center: 150, max: 420, expo: 0.3 },
  freestyle: { center: 200, max: 670, expo: 0.54 },
  race: { center: 240, max: 800, expo: 0.45 },
};

/** Same profile on all three axes (deep copy, safe to mutate). */
export function axisRatesFrom(r: RateProfile): AxisRates {
  return { roll: { ...r }, pitch: { ...r }, yaw: { ...r } };
}

/**
 * Throttle stick 0..1 → normalised motor command 0..1. Stick centre maps to `mid` (hover command)
 * and `expo` flattens the curve around it for fine altitude control; monotonic, f(0)=0, f(1)=1.
 */
export function throttleCurve(stick: number, mid: number, expo = 0.3): number {
  const s = stick < 0 ? 0 : stick > 1 ? 1 : stick;
  const x = (s - 0.5) * 2; // -1..1
  const shaped = x * (1 - expo + expo * x * x);
  return shaped < 0 ? mid + shaped * mid : mid + shaped * (1 - mid);
}
