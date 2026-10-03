/**
 * Touch Acro, from the measured iPhone scenario: a thumb holding the right stick ≈ 26 % forward for 1.5 s.
 * On the preset (gamepad) rates the quad went belly up (102° at 1.5 s, motors saturated, 15 m/s down into
 * the ground); on the touch rates the same thumb leaves it under the altitude hold's tilt limit.
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { Simulation } from '../../src/physics/simulation';
import { RATE_PRESETS, TOUCH_ACRO_CENTER_SCALE, actualRate, axisRatesFrom, touchAcroRates } from '../../src/control/rates';
import type { AxisRates } from '../../src/types';
import { EMPTY_LEVEL, input, tiltDeg } from './physics-helpers';

const DT = 0.001;
const THUMB = 0.26;

/** Acro + altitude hold (touch auto-centre) hovering at 20 m, then the thumb on pitch for `hold` s and released. */
function thumbPitch(rates: AxisRates, hold: number, after: number): { tilt: number; drop: number; minY: number } {
  const sim = new Simulation(EMPTY_LEVEL, undefined, 1);
  sim.fc.mode = 'acro';
  sim.fc.altitudeHold = true;
  sim.fc.rates = rates;
  expect(sim.setArmed(true, input(0))).toBe(true);
  sim.reset(new Vector3(0, 20, 0), 0);
  for (let i = 0; i < 2000; i++) sim.step(DT, input(0.5));
  const y0 = sim.world.state.position.y;
  let minY = y0;
  for (let i = 0; i < Math.round(hold / DT); i++) {
    sim.step(DT, input(0.5, 0, THUMB, 0));
    minY = Math.min(minY, sim.world.state.position.y);
  }
  const tilt = tiltDeg(sim.world.state);
  for (let i = 0; i < Math.round(after / DT); i++) {
    sim.step(DT, input(0.5));
    minY = Math.min(minY, sim.world.state.position.y);
  }
  return { tilt, drop: y0 - sim.world.state.position.y, minY };
}

describe('touch Acro rates', () => {
  const pad = axisRatesFrom(RATE_PRESETS.freestyle);
  const thumb = touchAcroRates(pad);

  it('halve the roll / pitch centre rate, keep the full-stick rate (flips) and yaw', () => {
    expect(TOUCH_ACRO_CENTER_SCALE).toBe(0.5);
    for (const ax of ['roll', 'pitch'] as const) {
      expect(actualRate(THUMB, thumb[ax])).toBeLessThan(0.7 * actualRate(THUMB, pad[ax]));
      expect(actualRate(1, thumb[ax])).toBeCloseTo(actualRate(1, pad[ax]), 9);
    }
    expect(thumb.yaw).toEqual(pad.yaw);
    expect(pad.roll.center).toBe(RATE_PRESETS.freestyle.center); // the pilot's rates are not touched
  });

  it('measured scenario: 26 % pitch for 1.5 s flips the quad on preset rates, not on touch rates', () => {
    const flipped = thumbPitch(pad, 1.5, 2);
    expect(flipped.tilt).toBeGreaterThan(90);
    expect(flipped.drop).toBeGreaterThan(5);
    const held = thumbPitch(thumb, 1.5, 2);
    // under the altitude hold's limit: its cos(tilt) floor of 0.35 is ≈ 69.5°
    expect(held.tilt).toBeLessThan(69);
    expect(held.drop).toBeLessThan(1);
  });

  it('a full-stick flip on touch still goes all the way round', () => {
    const sim = new Simulation(EMPTY_LEVEL, undefined, 1);
    sim.fc.mode = 'acro';
    sim.fc.rates = thumb;
    sim.setArmed(true, input(0));
    sim.reset(new Vector3(0, 40, 0), 0);
    for (let i = 0; i < 500; i++) sim.step(DT, input(0.5));
    let maxTilt = 0;
    for (let i = 0; i < 400; i++) {
      sim.step(DT, input(0.5, 0, 1, 0));
      maxTilt = Math.max(maxTilt, tiltDeg(sim.world.state));
    }
    expect(maxTilt).toBeGreaterThan(170);
  });
});
