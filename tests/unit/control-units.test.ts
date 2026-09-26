import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { RATE_PRESETS, actualRate, throttleCurve } from '../../src/control/rates';
import { Mixer, mixTable } from '../../src/control/mixer';
import { Pid } from '../../src/control/pid';
import { LowPass1 } from '../../src/control/filters';
import { FlightController } from '../../src/control/flight-controller';
import { DEFAULT_DRONE, MOTOR_LAYOUT, hoverThrottle } from '../../src/physics/drone-params';
import { createDroneState } from '../../src/physics/physics-world';
import { Rng } from '../../src/physics/rng';
import { input } from './physics-helpers';

describe('Betaflight Actual rates', () => {
  const fs = RATE_PRESETS.freestyle;

  it('presets match the spec', () => {
    expect(RATE_PRESETS.beginner).toEqual({ center: 150, max: 420, expo: 0.3 });
    expect(RATE_PRESETS.freestyle).toEqual({ center: 200, max: 670, expo: 0.54 });
    expect(RATE_PRESETS.race).toEqual({ center: 240, max: 800, expo: 0.45 });
  });

  it('0 at centre, max rate at full stick, odd symmetric', () => {
    for (const r of Object.values(RATE_PRESETS)) {
      expect(actualRate(0, r)).toBeCloseTo(0, 12);
      expect(actualRate(1, r)).toBeCloseTo(r.max, 9);
      expect(actualRate(-1, r)).toBeCloseTo(-r.max, 9);
      expect(actualRate(-0.37, r)).toBeCloseTo(-actualRate(0.37, r), 12);
      expect(actualRate(1.5, r)).toBeCloseTo(r.max, 9); // clamped
    }
  });

  it('slope at centre equals centre sensitivity (deg/s per full stick)', () => {
    const e = 1e-4;
    expect(actualRate(e, fs) / e).toBeCloseTo(fs.center, 1);
  });

  it('matches the Betaflight formula at half stick', () => {
    // rate = x·c + (max−c)·|x|·(x⁵·expo + x·(1−expo))
    const x = 0.5;
    const expected = x * 200 + 470 * x * (x ** 5 * 0.54 + x * 0.46);
    expect(actualRate(0.5, fs)).toBeCloseTo(expected, 9);
    expect(actualRate(0.5, fs)).toBeCloseTo(158.0156, 3);
  });

  it('is monotonic', () => {
    for (const r of Object.values(RATE_PRESETS)) {
      let prev = -Infinity;
      for (let s = -1; s <= 1; s += 0.01) {
        const v = actualRate(s, r);
        expect(v).toBeGreaterThan(prev);
        prev = v;
      }
    }
  });
});

describe('throttle curve', () => {
  const mid = hoverThrottle();
  it('endpoints and mid', () => {
    expect(throttleCurve(0, mid)).toBeCloseTo(0, 12);
    expect(throttleCurve(1, mid)).toBeCloseTo(1, 12);
    expect(throttleCurve(0.5, mid)).toBeCloseTo(mid, 12);
  });
  it('monotonic and flatter around hover than a straight line', () => {
    let prev = -1;
    for (let s = 0; s <= 1.0001; s += 0.01) {
      const v = throttleCurve(s, mid);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    const slopeMid = (throttleCurve(0.51, mid) - throttleCurve(0.49, mid)) / 0.02;
    expect(slopeMid).toBeLessThan(1);
  });
});

describe('quad-X mixer with airmode', () => {
  const floor = DEFAULT_DRONE.idle ** 2;

  it('mix factors follow geometry: +roll lowers right motors, +pitch lowers front motors, +yaw raises CCW props', () => {
    const t = mixTable();
    MOTOR_LAYOUT.forEach((m, i) => {
      expect(t[i].roll).toBe(m.position[0] > 0 ? -1 : 1);
      expect(t[i].pitch).toBe(m.position[2] < 0 ? -1 : 1);
      expect(t[i].yaw).toBe(m.spin);
    });
  });

  it('plain mix in the middle of the range', () => {
    const m = new Mixer();
    const o = [...m.mix(0.4, 0.1, 0, 0, floor)];
    expect(m.saturated).toBe(false);
    // FR, RL, FL, RR
    expect(o).toEqual([0.3, 0.5, 0.5, 0.3].map((x) => expect.closeTo(x, 12)));
  });

  it('airmode at zero throttle: keeps the full differential, lowest motor at the idle floor', () => {
    const m = new Mixer();
    const o = [...m.mix(0, 0.2, 0, 0, floor)];
    expect(Math.min(...o)).toBeCloseTo(floor, 12);
    expect(o[2] - o[0]).toBeCloseTo(0.4, 12); // FL − FR = 2·roll
    expect(o[1] - o[3]).toBeCloseTo(0.4, 12);
  });

  it('airmode at full throttle: keeps the differential, highest motor at 1', () => {
    const m = new Mixer();
    const o = [...m.mix(1, 0, 0.15, 0, floor)];
    expect(Math.max(...o)).toBeCloseTo(1, 12);
    expect(o[1] - o[0]).toBeCloseTo(0.3, 12); // rear − front = 2·pitch
  });

  it('oversized commands are scaled keeping the roll:pitch ratio; yaw is sacrificed first', () => {
    const m = new Mixer();
    const o = [...m.mix(0.5, 0.6, 0.3, 0.4, floor)];
    expect(m.saturated).toBe(true);
    for (const v of o) {
      expect(v).toBeGreaterThanOrEqual(floor - 1e-12);
      expect(v).toBeLessThanOrEqual(1 + 1e-12);
    }
    // yaw dropped: diagonal pairs with the same spin but opposite roll/pitch signs cancel
    const rollDiff = (o[1] + o[2] - o[0] - o[3]) / 4; // left − right
    const pitchDiff = (o[1] + o[3] - o[0] - o[2]) / 4; // rear − front
    expect(rollDiff / pitchDiff).toBeCloseTo(2, 9);
    expect(Math.max(...o) - Math.min(...o)).toBeCloseTo(1 - floor, 9);

    const o2 = [...m.mix(0.5, 0.2, 0, 0.4, floor)];
    const yaw = (o2[0] + o2[1] - o2[2] - o2[3]) / 4;
    expect(yaw).toBeGreaterThan(0);
    expect(yaw).toBeLessThan(0.4);
    expect((o2[2] + o2[1] - o2[0] - o2[3]) / 4).toBeCloseTo(0.2, 9); // roll untouched
  });
});

describe('PID and filters', () => {
  it('first-order LPF reaches 63 % after one time constant', () => {
    const f = new LowPass1(10);
    const tau = 1 / (2 * Math.PI * 10);
    const dt = 1e-5;
    for (let t = 0; t < tau; t += dt) f.update(1, dt);
    expect(f.value).toBeCloseTo(1 - Math.exp(-1), 2);
  });

  it('P acts on error, D on measurement only (no kick on setpoint steps), I clamps and relaxes', () => {
    const pid = new Pid({ kp: 2, ki: 10, kd: 0.1, kf: 0, iLimit: 0.5, dCutoffHz: 1000, relaxThreshold: 0 });
    pid.update(0, 0, 0.001, true);
    const out = pid.update(1, 0, 0.001, true);
    expect(pid.p).toBeCloseTo(2, 12);
    expect(pid.d).toBeCloseTo(0, 12);
    expect(out).toBeCloseTo(2 + 10 * 1 * 0.001, 9); // P + one step of I
    for (let i = 0; i < 1000; i++) pid.update(1, 0, 0.001, true);
    expect(pid.integral).toBe(0.5);
    pid.relax(0.05, 0.05);
    expect(pid.integral).toBeCloseTo(0.5 * Math.exp(-1), 9);
    // measurement moving up produces a negative D term
    pid.update(1, 0.01, 0.001, false);
    expect(pid.d).toBeLessThan(0);
  });

  it('I-term relax blocks windup while the setpoint is moving fast', () => {
    const pid = new Pid({ kp: 0, ki: 10, kd: 0, kf: 0, iLimit: 10, dCutoffHz: 100, relaxThreshold: 0.7 });
    pid.update(10, 0, 0.001, true); // 10 rad/s step: fully relaxed at first
    expect(Math.abs(pid.integral)).toBeLessThan(0.01);
  });

  it('seeded RNG is deterministic and Gaussian-ish', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    for (let i = 0; i < 100; i++) expect(a.gaussian()).toBe(b.gaussian());
    const r = new Rng(3);
    let sum = 0;
    let sq = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) {
      const g = r.gaussian();
      sum += g;
      sq += g * g;
    }
    expect(Math.abs(sum / n)).toBeLessThan(0.03);
    expect(Math.sqrt(sq / n)).toBeCloseTo(1, 1);
  });
});

describe('arming rules', () => {
  it('refuses to arm with throttle up, arms with throttle low', () => {
    const fc = new FlightController(DEFAULT_DRONE);
    const s = createDroneState();
    expect(fc.setArmed(true, input(0.05), s)).toBe(false);
    expect(fc.setArmed(true, input(0.3), s)).toBe(false);
    expect(fc.armed).toBe(false);
    expect(fc.setArmed(true, input(0.04), s)).toBe(true);
    expect(fc.armed).toBe(true);
    // disarm is always allowed
    expect(fc.setArmed(false, input(0.9), s)).toBe(false);
  });

  it('refuses to arm when tilted more than 60° or upside down', () => {
    const fc = new FlightController(DEFAULT_DRONE);
    const s = createDroneState();
    s.orientation.setFromAxisAngle(new Vector3(1, 0, 0), (65 * Math.PI) / 180);
    expect(fc.setArmed(true, input(0), s)).toBe(false);
    s.orientation.setFromAxisAngle(new Vector3(0, 0, 1), Math.PI);
    expect(fc.setArmed(true, input(0), s)).toBe(false);
    s.orientation.copy(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), (50 * Math.PI) / 180));
    expect(fc.setArmed(true, input(0), s)).toBe(true);
  });

  it('disarmed ⇒ motors 0; armed at zero throttle ⇒ idle floor', () => {
    const fc = new FlightController(DEFAULT_DRONE);
    const s = createDroneState();
    expect([...fc.update(0.001, input(0.8), s)]).toEqual([0, 0, 0, 0]);
    fc.setArmed(true, input(0), s);
    const out = fc.update(0.001, input(0), s);
    for (const u of out) {
      expect(u).toBeGreaterThanOrEqual(DEFAULT_DRONE.idle - 1e-9);
      expect(u).toBeLessThan(0.1);
    }
  });
});
