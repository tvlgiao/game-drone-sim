import { describe, expect, it } from 'vitest';
import { FlightController } from '../../src/control/flight-controller';
import { createDroneState } from '../../src/physics/physics-world';
import { DEFAULT_DRONE } from '../../src/physics/drone-params';
import { HOVER, throttleOut } from '../../src/ui/rate-charts';

/** Collective command the FC really flies: mean motor thrust (u²) is the collective when the mixer is not clamped. */
function fcCollective(stick: number, mid: number | null, expo: number, limit: number): number {
  const fc = new FlightController(DEFAULT_DRONE);
  fc.throttleMid = mid ?? HOVER;
  fc.throttleExpo = expo;
  fc.throttleLimit = limit;
  const state = createDroneState();
  expect(fc.setArmed(true, { throttle: 0, roll: 0, pitch: 0, yaw: 0 }, state)).toBe(true);
  const out = fc.update(0.001, { throttle: stick, roll: 0, pitch: 0, yaw: 0 }, state);
  return Math.sqrt(out.reduce((a, m) => a + m * m, 0) / out.length);
}

describe('throttle curve chart', () => {
  const combos: [number | null, number, number][] = [
    [null, 0.3, 1],
    [null, 0.3, 0.6],
    [0.4, 0.8, 0.5],
    [0.6, 0, 0.75],
    [0.25, 1, 0.9],
  ];
  for (const [mid, expo, limit] of combos) {
    it(`plots what the flight controller outputs (mid ${mid ?? 'auto'}, expo ${expo}, limit ${limit})`, () => {
      for (const stick of [0.2, 0.35, 0.5, 0.65, 0.8, 0.95]) {
        const chart = throttleOut(stick, { throttleMid: mid, throttleExpo: expo, throttleLimit: limit });
        expect(chart, `stick ${stick}`).toBeCloseTo(fcCollective(stick, mid, expo, limit), 3);
      }
    });
  }

  it('a throttle limit leaves the curve below mid untouched and caps full stick at mid + (1 − mid) · limit', () => {
    const s = { throttleMid: 0.4, throttleExpo: 0.3, throttleLimit: 0.6 };
    expect(throttleOut(0.25, s)).toBeCloseTo(throttleOut(0.25, { ...s, throttleLimit: 1 }), 12);
    expect(throttleOut(1, s)).toBeCloseTo(0.4 + 0.6 * 0.6, 12);
  });
});
