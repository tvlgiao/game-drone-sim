import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { Simulation } from '../../src/physics/simulation';
import { actualRate } from '../../src/control/rates';
import { ANGLE_MAX_TILT_DEG } from '../../src/control/flight-controller';
import { LOFT_LEVEL } from '../../src/game/level-data';
import type { ControlInput } from '../../src/types';
import { DEFAULT_DRONE } from '../../src/physics/drone-params';
import { SETTINGS_OPTIONS } from '../../src/core/settings';
import { EMPTY_LEVEL, input, tiltDeg } from './physics-helpers';

const DT = 0.001;
const RAD = 180 / Math.PI;

function airborne(mode: 'acro' | 'angle', seed = 1, y = 100): Simulation {
  const sim = new Simulation(EMPTY_LEVEL, undefined, seed);
  sim.fc.mode = mode;
  expect(sim.setArmed(true, input(0))).toBe(true);
  sim.reset(new Vector3(0, y, 0), 0);
  for (let i = 0; i < 500; i++) sim.step(DT, input(0.5));
  return sim;
}

function run(sim: Simulation, seconds: number, inp: ControlInput, each?: () => void): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    sim.step(DT, inp);
    each?.();
  }
}

/** pilot-axis rates (deg/s): roll (+right), pitch (+nose down), yaw (+clockwise) */
function pilotRates(sim: Simulation): [number, number, number] {
  const w = sim.world.state.angularVelocity;
  return [-w.z * RAD, -w.x * RAD, -w.y * RAD];
}

describe('acro rate loop', () => {
  const axes = [
    ['roll', 0],
    ['pitch', 1],
  ] as const;
  for (const [name, idx] of axes) {
    for (const stick of [1, 0.3, -0.6]) {
      it(`${name} step to ${stick} stick settles < 80 ms (±5 %), overshoot < 15 %, no oscillation`, () => {
        const sim = airborne('acro');
        const target = actualRate(stick, idx === 0 ? sim.fc.rates.roll : sim.fc.rates.pitch);
        const inp = idx === 0 ? input(0.5, stick, 0, 0) : input(0.5, 0, stick, 0);
        let peak = 0;
        let settled = -1;
        const tail: number[] = [];
        let k = 0;
        run(sim, 0.25, inp, () => {
          k++;
          const r = pilotRates(sim)[idx] / target;
          peak = Math.max(peak, r);
          if (Math.abs(r - 1) > 0.05) settled = -1;
          else if (settled < 0) settled = k;
          if (k > 150) tail.push(r);
        });
        expect(settled).toBeGreaterThan(0);
        expect(settled).toBeLessThan(80);
        expect(peak - 1).toBeLessThan(0.15);
        // steady tracking without oscillation
        const lo = Math.min(...tail);
        const hi = Math.max(...tail);
        expect(hi - lo).toBeLessThan(0.02);
        // the other axes stay quiet
        const other = pilotRates(sim)[idx === 0 ? 1 : 0];
        expect(Math.abs(other)).toBeLessThan(0.05 * Math.abs(target));
      });
    }
  }

  it('yaw step tracks the rate with modest overshoot', () => {
    const sim = airborne('acro');
    let peak = 0;
    let k = 0;
    let settled = -1;
    run(sim, 0.4, input(0.5, 0, 0, 1), () => {
      k++;
      const r = pilotRates(sim)[2] / 670;
      peak = Math.max(peak, r);
      if (Math.abs(r - 1) > 0.05) settled = -1;
      else if (settled < 0) settled = k;
    });
    expect(peak - 1).toBeLessThan(0.15);
    expect(settled).toBeGreaterThan(0);
    expect(settled).toBeLessThan(150);
  });

  it('hover with centred sticks: rates stay near zero with gyro noise (no limit cycles)', () => {
    const sim = airborne('acro');
    let maxRate = 0;
    run(sim, 2, input(0.5), () => {
      const r = pilotRates(sim);
      maxRate = Math.max(maxRate, Math.abs(r[0]), Math.abs(r[1]), Math.abs(r[2]));
    });
    expect(maxRate).toBeLessThan(3);
  });

  it('holds attitude in acro: centring the stick after a roll stops the rotation', () => {
    const sim = airborne('acro');
    run(sim, 0.1, input(0.5, 0.3, 0, 0));
    run(sim, 0.1, input(0.5));
    const before = tiltDeg(sim.world.state);
    run(sim, 0.3, input(0.5));
    expect(Math.abs(tiltDeg(sim.world.state) - before)).toBeLessThan(2);
    expect(before).toBeGreaterThan(5);
  });
});

describe('stick directions', () => {
  it('yaw + turns clockwise seen from above', () => {
    const sim = airborne('angle');
    run(sim, 0.3, input(0.5, 0, 0, 0.5));
    const fwd = new Vector3(0, 0, -1).applyQuaternion(sim.world.state.orientation);
    expect(fwd.x).toBeGreaterThan(0.3); // -Z forward swung towards +X (right)
    expect(sim.world.state.angularVelocity.y).toBeLessThan(0);
  });

  it('pitch + flies forward (−Z), roll + flies right (+X)', () => {
    const a = airborne('angle');
    run(a, 1, input(0.55, 0, 0.5, 0));
    expect(a.world.state.velocity.z).toBeLessThan(-2);
    expect(Math.abs(a.world.state.velocity.x)).toBeLessThan(0.3);
    const b = airborne('angle');
    run(b, 1, input(0.55, 0.5, 0, 0));
    expect(b.world.state.velocity.x).toBeGreaterThan(2);
    expect(Math.abs(b.world.state.velocity.z)).toBeLessThan(0.3);
  });
});

describe('angle mode', () => {
  it('stays level with no input (tilt < 1° for 5 s) and mid throttle is near hover', () => {
    const sim = airborne('angle');
    let maxTilt = 0;
    run(sim, 5, input(0.5), () => {
      maxTilt = Math.max(maxTilt, tiltDeg(sim.world.state));
    });
    expect(maxTilt).toBeLessThan(1);
    // with centred throttle the climb/sink rate stays small (battery sag slowly lowers it)
    expect(Math.abs(sim.world.state.velocity.y)).toBeLessThan(1);
  });

  it('self-levels from a 40° upset within 0.4 s', () => {
    const sim = airborne('angle');
    sim.world.state.orientation.setFromAxisAngle(new Vector3(1, 0, 1).normalize(), (40 * Math.PI) / 180);
    run(sim, 0.4, input(0.5));
    expect(tiltDeg(sim.world.state)).toBeLessThan(3);
    run(sim, 0.6, input(0.5));
    expect(tiltDeg(sim.world.state)).toBeLessThan(1);
  });

  it('recovers from upside down', () => {
    const sim = airborne('angle', 1, 200);
    sim.world.state.orientation.setFromAxisAngle(new Vector3(0, 0, 1), Math.PI);
    run(sim, 1.5, input(0.5));
    expect(tiltDeg(sim.world.state)).toBeLessThan(3);
  });

  it(`full stick holds the ${ANGLE_MAX_TILT_DEG}° tilt limit`, () => {
    const sim = airborne('angle');
    run(sim, 0.6, input(0.6, 0, 1, 0));
    expect(tiltDeg(sim.world.state)).toBeGreaterThan(ANGLE_MAX_TILT_DEG - 2);
    expect(tiltDeg(sim.world.state)).toBeLessThan(ANGLE_MAX_TILT_DEG + 2);
  });
});

describe('whole simulation', () => {
  it('determinism: same seed ⇒ bit-identical state after 10 s of scripted flight', () => {
    const script = (i: number): ControlInput =>
      input(0.5 + 0.2 * Math.sin(i * 0.003), 0.4 * Math.sin(i * 0.0021), 0.3 * Math.cos(i * 0.0017), 0.2 * Math.sin(i * 0.001));
    const make = (seed: number) => {
      const sim = new Simulation(LOFT_LEVEL, undefined, seed);
      sim.setArmed(true, input(0));
      sim.reset(new Vector3(0, 2.5, 0), 0);
      for (let i = 0; i < 10000; i++) sim.step(DT, script(i));
      return sim.world.state;
    };
    const a = make(5);
    const b = make(5);
    const c = make(6);
    expect(a.position.toArray()).toEqual(b.position.toArray());
    expect(a.orientation.toArray()).toEqual(b.orientation.toArray());
    expect(a.angularVelocity.toArray()).toEqual(b.angularVelocity.toArray());
    expect(a.motors).toEqual(b.motors);
    expect(a.position.equals(c.position)).toBe(false);
  });

  it('arm on the floor, take off, hover and land back without bouncing away', () => {
    const sim = new Simulation(EMPTY_LEVEL);
    sim.fc.mode = 'angle';
    run(sim, 0.3, input(0));
    expect(sim.setArmed(true, input(0.3))).toBe(false);
    expect(sim.setArmed(true, input(0))).toBe(true);
    expect(sim.world.state.armed).toBe(true);
    run(sim, 0.5, input(0)); // idle on the ground: must not wander
    expect(sim.world.state.position.y).toBeLessThan(0.05);
    expect(Math.hypot(sim.world.state.position.x, sim.world.state.position.z)).toBeLessThan(0.01);
    run(sim, 1, input(0.7));
    expect(sim.world.state.position.y).toBeGreaterThan(1);
    let touchdown = 0;
    for (let i = 0; i < 10000 && sim.world.state.position.y > 0.1; i++) {
      // pilot: aim for a 0.6 m/s descent
      const vy = sim.world.state.velocity.y;
      sim.step(DT, input(Math.max(0, Math.min(1, 0.5 + 0.2 * (-0.6 - vy)))));
      touchdown = -sim.world.state.velocity.y;
    }
    expect(sim.world.state.position.y).toBeLessThan(0.1);
    expect(touchdown).toBeLessThan(3);
    run(sim, 1, input(0));
    const s = sim.world.state;
    expect(s.velocity.length()).toBeLessThan(0.05);
    expect(tiltDeg(s)).toBeLessThan(3);
    sim.setArmed(false, input(0));
    run(sim, 0.2, input(0));
    expect(s.armed).toBe(false);
    expect(Math.max(...s.motors)).toBeLessThan(0.01);
  });

  it('sanity flight: angle-mode full forward stick, altitude held, reaches a plausible top speed', () => {
    // pilot: hover, then full forward stick (55° tilt) while a simple altitude-hold adjusts throttle
    const sim2 = airborne('angle', 1, 100);
    const alt0 = sim2.world.state.position.y;
    let t2 = 0.5;
    let integ = 0.6;
    let v1 = 0;
    let alt1 = 0;
    for (let i = 1; i <= 8000; i++) {
      sim2.step(DT, input(t2, 0, 1, 0));
      const s = sim2.world.state;
      const e = alt0 - s.position.y;
      integ += e * DT * 0.5;
      t2 = Math.max(0, Math.min(1, integ + 0.3 * e - 0.1 * s.velocity.y));
      if (i === 1000) {
        v1 = s.velocity.length();
        alt1 = s.position.y;
      }
    }
    const s = sim2.world.state;
    const vTop = Math.hypot(s.velocity.x, s.velocity.z);
    console.log(
      `[sanity] 1 s: speed ${v1.toFixed(1)} m/s, alt Δ ${(alt1 - alt0).toFixed(2)} m | 8 s: ${vTop.toFixed(1)} m/s ` +
        `(${(vTop * 3.6).toFixed(0)} km/h), alt Δ ${(s.position.y - alt0).toFixed(2)} m, tilt ${tiltDeg(s).toFixed(1)}°, ` +
        `throttle ${t2.toFixed(2)}, battery ${s.batteryVoltage.toFixed(2)} V`,
    );
    expect(v1).toBeGreaterThan(6);
    expect(vTop).toBeGreaterThan(14);
    expect(vTop).toBeLessThan(20);
    expect(Math.abs(s.position.y - alt0)).toBeLessThan(0.5);
    expect(tiltDeg(s)).toBeCloseTo(ANGLE_MAX_TILT_DEG, 0);
  });
});

describe('pilot-tunable FC parameters (Rates & Sensitivity)', () => {
  it('custom angle limit: full stick holds 30° when angleMaxTiltDeg = 30', () => {
    const sim = airborne('angle');
    sim.fc.angleMaxTiltDeg = 30;
    run(sim, 0.8, input(0.55, 0, 1, 0));
    expect(tiltDeg(sim.world.state)).toBeGreaterThan(28);
    expect(tiltDeg(sim.world.state)).toBeLessThan(32);
  });

  it('per-axis rates: yaw uses its own profile, roll/pitch unaffected', () => {
    const sim = airborne('acro');
    sim.fc.rates.yaw = { center: 100, max: 300, expo: 0 };
    run(sim, 0.3, input(0.5, 0, 0, 1));
    expect(pilotRates(sim)[2]).toBeCloseTo(300, -1);
    expect(actualRate(1, sim.fc.rates.roll)).toBeCloseTo(670, 5);
  });

  it('throttle limit scales full-throttle motor output', () => {
    const full = airborne('angle');
    const limited = airborne('angle');
    limited.fc.throttleLimit = 0.6;
    run(full, 0.3, input(1));
    run(limited, 0.3, input(1));
    const avg = (s: Simulation) => s.world.state.motors.reduce((a, b) => a + b, 0) / 4;
    expect(avg(limited)).toBeLessThan(avg(full) * 0.85);
    expect(avg(limited)).toBeGreaterThan(avg(full) * 0.65);
  });

  it('at the minimum throttle limit centre stick still hovers and full stick still climbs, even on a drained pack', () => {
    const limit = SETTINGS_OPTIONS.throttleLimit.min;
    const vy = (s: Simulation) => s.world.state.velocity.y;
    const unlimited = airborne('angle');
    const centre = airborne('angle');
    centre.fc.throttleLimit = limit;
    run(unlimited, 1, input(0.5));
    run(centre, 1, input(0.5));
    expect(vy(centre)).toBeCloseTo(vy(unlimited), 6);
    for (const drained of [false, true]) {
      const sim = airborne('angle');
      sim.fc.throttleLimit = limit;
      if (drained) sim.world.consumed = DEFAULT_DRONE.battery.capacityS;
      run(sim, 1.5, input(1));
      expect(vy(sim), drained ? 'drained pack' : 'full pack').toBeGreaterThan(1);
    }
  });

  it('throttle expo 0.3 vs 0.8: higher expo = finer control near mid, same end points', () => {
    const a = airborne('angle');
    const b = airborne('angle');
    b.fc.throttleExpo = 0.8;
    run(a, 0.3, input(0.6));
    run(b, 0.3, input(0.6));
    const vy = (s: Simulation) => s.world.state.velocity.y;
    expect(vy(b)).toBeLessThan(vy(a));
  });
});

describe('altitude hold (touch auto-centre, DJI A/Atti style)', () => {
  it('centred stick holds altitude within 5 cm for 5 s, even after a climb', () => {
    const sim = airborne('angle', 1, 10);
    sim.fc.altitudeHold = true;
    run(sim, 1, input(1)); // climb at max rate
    expect(sim.world.state.velocity.y).toBeGreaterThan(2.5);
    run(sim, 1.5, input(0.5)); // release to centre
    const y0 = sim.world.state.position.y;
    run(sim, 5, input(0.5));
    expect(Math.abs(sim.world.state.position.y - y0)).toBeLessThan(0.05);
  });

  it('full stick commands ≈ +3 m/s climb and ≈ −2.5 m/s sink', () => {
    const sim = airborne('angle', 1, 50);
    sim.fc.altitudeHold = true;
    run(sim, 2, input(1));
    expect(sim.world.state.velocity.y).toBeCloseTo(3, 0);
    run(sim, 3, input(0));
    expect(sim.world.state.velocity.y).toBeCloseTo(-2.5, 0);
  });

  // touch QA: thumbs bashing yaw + pitch with the throttle at the bottom climbed y 5 → 37 (airmode lifting the collective)
  it.each([
    ['angle', true],
    ['angle', false],
    ['acro', true],
  ] as const)('%s, altitude hold %s: full-stick yaw + pitch reversals at zero throttle never climb', (mode, hold) => {
    for (const period of [0.05, 0.1, 0.2]) {
      const sim = airborne(mode, 1, 5);
      sim.fc.altitudeHold = hold;
      let maxY = sim.world.state.position.y;
      const y0 = maxY;
      const n = Math.round(4 / DT);
      for (let i = 0; i < n; i++) {
        const s = Math.floor((i * DT) / period) % 2 === 0 ? 1 : -1;
        sim.step(DT, input(0, 0, s, s));
        maxY = Math.max(maxY, sim.world.state.position.y);
      }
      expect(maxY - y0, `period ${period}s`).toBeLessThan(0.3);
    }
  });

  it('with the stick centred, the same reversals keep the held height', () => {
    const sim = airborne('angle', 1, 5);
    sim.fc.altitudeHold = true;
    run(sim, 1, input(0.5));
    const y0 = sim.world.state.position.y;
    const n = Math.round(4 / DT);
    for (let i = 0; i < n; i++) {
      const s = Math.floor((i * DT) / 0.1) % 2 === 0 ? 1 : -1;
      sim.step(DT, input(0.5, 0, s, s));
    }
    expect(Math.abs(sim.world.state.position.y - y0)).toBeLessThan(1);
  });

  it('holds altitude while tilted forward (tilt compensation)', () => {
    const sim = airborne('angle', 1, 10);
    sim.fc.altitudeHold = true;
    const y0 = sim.world.state.position.y;
    run(sim, 3, input(0.5, 0, 0.8, 0));
    expect(Math.abs(sim.world.state.position.y - y0)).toBeLessThan(0.3);
  });
});

describe('position hold (VR thumbsticks, DJI P style)', () => {
  const hold = (sim: Simulation): Simulation => {
    sim.fc.altitudeHold = true;
    sim.fc.positionHold = true;
    return sim;
  };
  const horiz = (sim: Simulation): number => Math.hypot(sim.world.state.velocity.x, sim.world.state.velocity.z);

  it('released stick brakes a 3 m/s drift to a stop instead of coasting on momentum', () => {
    const sim = hold(airborne('angle', 1, 10));
    sim.world.state.velocity.set(2, 0, -2.2);
    run(sim, 2.5, input(0.5));
    expect(horiz(sim)).toBeLessThan(0.15);
    const p0 = sim.world.state.position.clone();
    run(sim, 3, input(0.5));
    expect(sim.world.state.position.distanceTo(p0)).toBeLessThan(0.15);
  });

  it('without position hold the same drift keeps coasting', () => {
    const sim = airborne('angle', 1, 10);
    sim.fc.altitudeHold = true;
    sim.world.state.velocity.set(2, 0, -2.2);
    run(sim, 2.5, input(0.5));
    expect(horiz(sim)).toBeGreaterThan(1);
  });

  it('full pitch stick flies forward (−Z at yaw 0) near the speed cap (P-only: drag leaves ≈ 3.2 of 4 m/s)', () => {
    const sim = hold(airborne('angle', 1, 10));
    run(sim, 5, input(0.5, 0, 1, 0));
    const v = sim.world.state.velocity;
    expect(-v.z).toBeGreaterThan(2.8);
    expect(-v.z).toBeLessThan(4.5);
    expect(Math.abs(v.x)).toBeLessThan(0.3);
  });

  it('full roll stick flies right (+X at yaw 0)', () => {
    const sim = hold(airborne('angle', 1, 10));
    run(sim, 5, input(0.5, 1, 0, 0));
    expect(sim.world.state.velocity.x).toBeGreaterThan(2.8);
  });

  it('acro mode ignores position hold', () => {
    const sim = hold(airborne('acro', 1, 10));
    sim.world.state.velocity.set(3, 0, 0);
    run(sim, 1, input(0.5));
    expect(horiz(sim)).toBeGreaterThan(1.5);
  });
});

describe('position hold fine control (no deadband stacked on the XR stick shaping)', () => {
  it('a small shaped stick (0.03 ≈ 15 % thumbstick travel after deadzone + expo) still creeps forward', () => {
    const sim = airborne('angle', 1, 10);
    sim.fc.altitudeHold = true;
    sim.fc.positionHold = true;
    run(sim, 4, input(0.5, 0, 0.03, 0));
    expect(-sim.world.state.velocity.z).toBeGreaterThan(0.05);
  });
});

describe('battery over a long flight', () => {
  /** HUD thresholds (src/ui/hud.ts): amber below 3.55 V/cell, red below 3.3 V/cell on the 4S pack */
  const CELLS = 4;
  const WARN = 3.55;
  const CRIT = 3.3;

  it('a continuous hover reaches the low-battery warning, then critical, and can still hold altitude', () => {
    const sim = airborne('angle', 1, 50);
    sim.fc.altitudeHold = true;
    let warnAt = -1;
    let critAt = -1;
    const seconds = 380;
    const n = Math.round(seconds / DT);
    for (let i = 0; i < n; i++) {
      sim.step(DT, input(0.5));
      const cell = sim.world.state.batteryVoltage / CELLS;
      if (warnAt < 0 && cell < WARN) warnAt = i * DT;
      if (critAt < 0 && cell < CRIT) critAt = i * DT;
    }
    expect(warnAt).toBeGreaterThan(180);
    expect(critAt).toBeGreaterThan(warnAt + 20);
    expect(critAt).toBeLessThan(seconds);
    expect(Math.abs(sim.world.state.position.y - 50)).toBeLessThan(1);
  });
});
