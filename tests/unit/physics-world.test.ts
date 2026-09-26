import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { PhysicsWorld, createDroneState, groundEffectFactor } from '../../src/physics/physics-world';
import {
  AIR_DENSITY,
  CENTER_COLLIDER_OFFSET,
  DEFAULT_DRONE,
  GRAVITY,
  MOTOR_LAYOUT,
  hoverThrottle,
  type DroneParams,
} from '../../src/physics/drone-params';
import { LOFT_LEVEL } from '../../src/game/level-data';
import type { Contact, LevelDef } from '../../src/types';
import { EMPTY_LEVEL, energy, tiltDeg } from './physics-helpers';

const DT = 0.001;
const OFF = [0, 0, 0, 0];
const NO_DRAG: DroneParams = { ...DEFAULT_DRONE, dragCdA: [0, 0, 0], rotorDrag: 0 };
/** height of the drone centre when resting level on the floor */
const REST_Y = DEFAULT_DRONE.colliderRadius - CENTER_COLLIDER_OFFSET[1];

function run(w: PhysicsWorld, seconds: number, cmd: readonly number[] = OFF, each?: (c: readonly Contact[]) => void) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    const c = w.step(DT, cmd);
    each?.(c);
  }
}

describe('rigid body truths', () => {
  it('hover throttle √(mg/4Tmax) balances gravity (vertical accel within 2 % of g)', () => {
    const w = new PhysicsWorld(EMPTY_LEVEL);
    w.reset(new Vector3(0, 20, 0), 0);
    const h = hoverThrottle();
    for (let i = 0; i < 4; i++) w.state.motors[i] = h;
    const cmd = [h, h, h, h];
    run(w, 0.2, cmd);
    const v0 = w.state.velocity.y;
    run(w, 0.1, cmd);
    const a = (w.state.velocity.y - v0) / 0.1;
    expect(Math.abs(a)).toBeLessThan(0.02 * GRAVITY);
    expect(tiltDeg(w.state)).toBeLessThan(1e-6);
  });

  it('free fall accelerates at g with motors off', () => {
    const w = new PhysicsWorld(EMPTY_LEVEL, NO_DRAG);
    w.reset(new Vector3(0, 500, 0), 0);
    run(w, 1);
    expect(w.state.velocity.y).toBeCloseTo(-GRAVITY, 6);
    expect(w.state.position.y).toBeCloseTo(500 - 0.5 * GRAVITY, 2);
    expect(w.state.velocity.x).toBe(0);
    expect(w.state.velocity.z).toBe(0);
  });

  it('falls with the analytic quadratic-drag profile v(t) = vt·tanh(g t / vt)', () => {
    const w = new PhysicsWorld(EMPTY_LEVEL);
    w.reset(new Vector3(0, 900, 0), 0);
    const p = DEFAULT_DRONE;
    const vt = Math.sqrt((2 * p.mass * GRAVITY) / (AIR_DENSITY * p.dragCdA[1]));
    for (const t of [0.5, 1, 2, 4, 8]) {
      run(w, t - w.time);
      const expected = vt * Math.tanh((GRAVITY * t) / vt);
      expect(-w.state.velocity.y).toBeCloseTo(expected, 1);
      expect(Math.abs(-w.state.velocity.y - expected) / expected).toBeLessThan(0.005);
    }
    expect(-w.state.velocity.y).toBeGreaterThan(0.99 * vt);
  });

  it('motors lag toward command with the up/down time constants', () => {
    const w = new PhysicsWorld(EMPTY_LEVEL);
    w.reset(new Vector3(0, 50, 0), 0);
    run(w, DEFAULT_DRONE.tauUp, [1, 1, 1, 1]);
    expect(w.state.motors[0]).toBeCloseTo(1 - Math.exp(-1), 3);
    run(w, 1, [1, 1, 1, 1]);
    run(w, DEFAULT_DRONE.tauDown, OFF);
    expect(w.state.motors[0]).toBeCloseTo(Math.exp(-1), 2);
  });

  it('thrust torques: lowering right motors rolls right, lowering front motors pitches nose down', () => {
    const h = hoverThrottle();
    const w = new PhysicsWorld(EMPTY_LEVEL);
    w.reset(new Vector3(0, 50, 0), 0);
    const roll = MOTOR_LAYOUT.map((m) => (m.position[0] > 0 ? h - 0.05 : h + 0.05));
    for (let i = 0; i < 4; i++) w.state.motors[i] = roll[i];
    w.step(DT, roll);
    expect(w.state.angularVelocity.z).toBeLessThan(0); // −ωz = right wing down
    expect(Math.abs(w.state.angularVelocity.x)).toBeLessThan(1e-9);

    w.reset(new Vector3(0, 50, 0), 0);
    const pitch = MOTOR_LAYOUT.map((m) => (m.position[2] < 0 ? h - 0.05 : h + 0.05));
    for (let i = 0; i < 4; i++) w.state.motors[i] = pitch[i];
    w.step(DT, pitch);
    expect(w.state.angularVelocity.x).toBeLessThan(0); // −ωx = nose down
    expect(Math.abs(w.state.angularVelocity.z)).toBeLessThan(1e-9);
  });

  it('yaw reaction: speeding up CCW props (spin +1) yaws the body clockwise from above (−Y)', () => {
    const h = hoverThrottle();
    const w = new PhysicsWorld(EMPTY_LEVEL);
    w.reset(new Vector3(0, 50, 0), 0);
    const cmd = MOTOR_LAYOUT.map((m) => (m.spin === 1 ? h + 0.05 : h - 0.05));
    for (let i = 0; i < 4; i++) w.state.motors[i] = cmd[i];
    run(w, 0.05, cmd);
    expect(w.state.angularVelocity.y).toBeLessThan(-0.1);
    // heading turned clockwise: forward (−Z) swings towards +X
    const fwd = new Vector3(0, 0, -1).applyQuaternion(w.state.orientation);
    expect(fwd.x).toBeGreaterThan(0);
    expect(Math.abs(w.state.angularVelocity.x) + Math.abs(w.state.angularVelocity.z)).toBeLessThan(1e-6);
  });

  it('gyroscopic term conserves |L| and energy for torque-free tumbling', () => {
    const w = new PhysicsWorld(EMPTY_LEVEL, NO_DRAG);
    w.reset(new Vector3(0, 900, 0), 0);
    w.state.angularVelocity.set(3, 10, -2);
    const I = DEFAULT_DRONE.inertia;
    const Lw = () => {
      const s = w.state.angularVelocity;
      return new Vector3(I[0] * s.x, I[1] * s.y, I[2] * s.z).applyQuaternion(w.state.orientation);
    };
    const erot = () => {
      const s = w.state.angularVelocity;
      return 0.5 * (I[0] * s.x * s.x + I[1] * s.y * s.y + I[2] * s.z * s.z);
    };
    const L0 = Lw();
    const E0 = erot();
    run(w, 2);
    expect(Lw().distanceTo(L0) / L0.length()).toBeLessThan(0.01);
    expect(Math.abs(erot() - E0) / E0).toBeLessThan(0.01);
    expect(w.state.orientation.length()).toBeCloseTo(1, 12);
  });

  it('ground effect: factor follows Cheeseman–Bennett, clamps at 1.4 and increases lift near the floor', () => {
    const R = DEFAULT_DRONE.propRadius;
    expect(groundEffectFactor(10, R)).toBeCloseTo(1, 5);
    expect(groundEffectFactor(R, R)).toBeCloseTo(1 / (1 - 1 / 16), 9);
    expect(groundEffectFactor(R / 4, R)).toBe(1.4);
    expect(groundEffectFactor(0.011, R)).toBeLessThanOrEqual(1.4);

    const h = hoverThrottle();
    const accelAt = (y: number) => {
      const w = new PhysicsWorld(EMPTY_LEVEL);
      w.reset(new Vector3(0, y, 0), 0);
      for (let i = 0; i < 4; i++) w.state.motors[i] = h;
      w.step(DT, [h, h, h, h]);
      return { a: w.state.velocity.y / DT, ge: w.groundEffect[0] };
    };
    const low = accelAt(REST_Y + 0.001);
    const high = accelAt(3);
    expect(low.ge).toBeGreaterThan(1);
    expect(high.ge).toBeCloseTo(1, 4);
    expect(low.a).toBeGreaterThan(high.a);
  });

  it('ground effect also applies above the top of a box below the rotor', () => {
    const level: LevelDef = {
      ...EMPTY_LEVEL,
      props: [
        {
          id: 'table',
          kind: 'table',
          position: [0, 0, 0],
          size: [2, 1, 2],
          colliders: [{ id: 'table', shape: { kind: 'box', center: [0, 0.5, 0], half: [1, 0.5, 1] } }],
        },
      ],
    };
    const w = new PhysicsWorld(level);
    w.reset(new Vector3(0, 1 + REST_Y + 0.001, 0), 0);
    const h = hoverThrottle();
    w.step(DT, [h, h, h, h]);
    expect(w.groundEffect[0]).toBeGreaterThan(1);
  });

  it('battery sags under load, drains with use, and scales thrust modestly', () => {
    const w = new PhysicsWorld(EMPTY_LEVEL);
    w.reset(new Vector3(0, 500, 0), 0);
    const full = DEFAULT_DRONE.battery.full;
    w.step(DT, OFF);
    expect(w.state.batteryVoltage).toBeCloseTo(full, 3);
    run(w, 0.3, [1, 1, 1, 1]);
    const loaded = w.state.batteryVoltage;
    expect(loaded).toBeLessThan(full - 0.2);
    expect(loaded).toBeGreaterThan(full * 0.95);
    // 4 minutes of hover-equivalent flight
    const h = hoverThrottle();
    w.reset(new Vector3(0, 500, 0), 0);
    w.consumed = 4 * 60 * 4 * h * h;
    w.step(DT, [h, h, h, h]);
    const v = w.state.batteryVoltage;
    expect(v).toBeLessThan(15.4);
    expect(v).toBeGreaterThan(DEFAULT_DRONE.battery.empty);
    // still has > 3:1 thrust-to-weight at full throttle
    const tw = (4 * DEFAULT_DRONE.maxThrustPerMotor * (v / full) ** 2) / (DEFAULT_DRONE.mass * GRAVITY);
    expect(tw).toBeGreaterThan(3);
  });
});

describe('collision response', () => {
  it('resting on the floor: no penetration, no jitter, no sinking, no energy gain', () => {
    const w = new PhysicsWorld(EMPTY_LEVEL);
    w.reset(new Vector3(0, 0.3, 0), 0);
    run(w, 2);
    const ys: number[] = [];
    let maxE = -Infinity;
    let minE = Infinity;
    run(w, 1, OFF, () => {
      ys.push(w.state.position.y);
      const e = energy(w.state, DEFAULT_DRONE);
      maxE = Math.max(maxE, e);
      minE = Math.min(minE, e);
    });
    const lo = Math.min(...ys);
    const hi = Math.max(...ys);
    expect(REST_Y - lo).toBeLessThan(0.001); // penetration < 1 mm
    expect(hi - lo).toBeLessThan(1e-5); // jitter < 10 µm
    expect(w.state.velocity.length()).toBeLessThan(0.02);
    expect(w.state.angularVelocity.length()).toBeLessThan(1e-3);
    expect(maxE - minE).toBeLessThan(1e-4);
    expect(tiltDeg(w.state)).toBeLessThan(0.01);
  });

  it('bounce: rebound speed = e·impact and apex ≈ e²·drop height; energy never increases', () => {
    const e = 0.25;
    const w = new PhysicsWorld(EMPTY_LEVEL, NO_DRAG);
    const drop = 1;
    w.reset(new Vector3(0, REST_Y + drop, 0), 0);
    const E0 = energy(w.state, NO_DRAG);
    let impact = 0;
    let rebound = 0;
    let apex = -Infinity;
    let bounced = false;
    let maxE = -Infinity;
    run(w, 1.2, OFF, (cs) => {
      maxE = Math.max(maxE, energy(w.state, NO_DRAG));
      if (!bounced && cs.length > 0 && cs[0].impactSpeed > 1) {
        impact = cs[0].impactSpeed;
        rebound = w.state.velocity.y;
        bounced = true;
      } else if (bounced && w.state.velocity.y >= 0) {
        apex = Math.max(apex, w.state.position.y - REST_Y);
      }
    });
    expect(bounced).toBe(true);
    expect(impact).toBeCloseTo(Math.sqrt(2 * GRAVITY * drop), 1);
    expect(rebound / impact).toBeCloseTo(e, 2);
    expect(apex / drop).toBeGreaterThan(e * e * 0.95);
    expect(apex / drop).toBeLessThan(e * e * 1.05);
    expect(maxE).toBeLessThanOrEqual(E0 + 1e-6);
  });

  it('no energy gain on tumbling impacts (prop strikes), across many random drops', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    for (let k = 0; k < 20; k++) {
      const w = new PhysicsWorld(EMPTY_LEVEL, NO_DRAG);
      w.reset(new Vector3(0, 0.6 + 0.4 * rnd(), 0), 0);
      w.state.orientation.setFromAxisAngle(new Vector3(rnd(), rnd(), rnd()).normalize(), Math.PI * rnd());
      w.state.angularVelocity.set(10 * rnd(), 10 * rnd(), 10 * rnd());
      w.state.velocity.set(2 * rnd(), -2 * Math.abs(rnd()), 2 * rnd());
      let prev = energy(w.state, NO_DRAG);
      const E0 = prev;
      let peak = E0;
      run(w, 1.5, OFF, () => {
        const E = energy(w.state, NO_DRAG);
        peak = Math.max(peak, E);
        prev = E;
      });
      // positional projection may lift by < slop-ish; allow 0.2 mJ
      expect(peak - E0).toBeLessThan(2e-4);
      expect(prev).toBeLessThan(E0);
    }
  });

  it('a prop strike creates angular impulse (the quad flips), a centred hit does not', () => {
    const w = new PhysicsWorld(EMPTY_LEVEL);
    // tilted 40° about body Z: the right-side props hit the floor first
    w.reset(new Vector3(0, 0.5, 0), 0);
    w.state.orientation.setFromAxisAngle(new Vector3(0, 0, 1), -0.7);
    w.state.velocity.set(0, -3, 0);
    let spun = 0;
    let propHit = false;
    for (let i = 0; i < 400 && !propHit; i++) {
      const cs = w.step(DT, OFF);
      if (cs.length > 0) {
        propHit = true;
        spun = w.state.angularVelocity.length();
      }
    }
    expect(propHit).toBe(true);
    expect(spun).toBeGreaterThan(5);

    const w2 = new PhysicsWorld(EMPTY_LEVEL);
    w2.reset(new Vector3(0, 0.5, 0), 0);
    w2.state.velocity.set(0, -3, 0);
    run(w2, 0.3);
    expect(w2.state.angularVelocity.length()).toBeLessThan(1e-6);
  });

  it('friction: sliding on the floor decelerates at about μg', () => {
    const w = new PhysicsWorld(EMPTY_LEVEL, NO_DRAG);
    w.reset(new Vector3(0, REST_Y, 0), 0);
    run(w, 0.2);
    w.state.velocity.set(3, 0, 0);
    run(w, 0.1);
    const v1 = w.state.velocity.x;
    run(w, 0.1);
    const decel = (v1 - w.state.velocity.x) / 0.1;
    // sliding on a sphere bottom also spins it up (rolling); decel is ≤ μg and substantial
    expect(decel).toBeGreaterThan(0.5);
    expect(decel).toBeLessThanOrEqual(0.5 * GRAVITY * 1.01);
  });

  const shapes: [string, LevelDef['props'][number]['colliders'][number]['shape'], Vector3, Vector3][] = [
    ['box', { kind: 'box', center: [0, 2, -2], half: [1, 1, 0.5], yaw: 0.3 }, new Vector3(0, 2, 0), new Vector3(0, 0, -4)],
    ['cylinder', { kind: 'cylinder', center: [0, 3, -2], radius: 0.25, halfHeight: 3 }, new Vector3(0, 2, 0), new Vector3(0, 0, -4)],
    ['torus', { kind: 'torus', center: [0, 2, -2], normal: [0, 0, 1], majorRadius: 0.82, tubeRadius: 0.07 }, new Vector3(0.8, 2, 0), new Vector3(0, 0, -4)],
  ];
  for (const [name, shape, start, vel] of shapes) {
    it(`fly into a ${name}: reported impact speed, no tunnelling, closing speed removed`, () => {
      const level: LevelDef = {
        ...EMPTY_LEVEL,
        props: [{ id: name, kind: 'crate', position: [0, 0, 0], size: [1, 1, 1], colliders: [{ id: name, shape }] }],
      };
      const w = new PhysicsWorld(level, NO_DRAG);
      w.reset(start, 0);
      // cancel gravity by giving the test a hover thrust
      const h = hoverThrottle(NO_DRAG);
      for (let i = 0; i < 4; i++) w.state.motors[i] = h;
      w.state.velocity.copy(vel);
      let impact = 0;
      let hitAt = -1;
      let maxDepth = 0;
      let awayAfter = 0;
      let towards = 0;
      const n = new Vector3();
      let minZ = Infinity;
      run(w, 1, [h, h, h, h], (cs) => {
        for (const c of cs) {
          if (c.colliderId !== name) continue;
          if (hitAt < 0) {
            hitAt = w.time;
            impact = c.impactSpeed;
            n.copy(c.normal);
          }
          maxDepth = Math.max(maxDepth, c.depth);
        }
        if (hitAt > 0 && awayAfter === 0 && w.time > hitAt + 0.03) {
          awayAfter = w.state.velocity.dot(n);
          towards = w.state.velocity.dot(vel) / vel.length();
        }
        minZ = Math.min(minZ, w.state.position.z);
      });
      expect(hitAt).toBeGreaterThan(0);
      expect(impact).toBeGreaterThan(1);
      expect(impact).toBeLessThanOrEqual(vel.length() + 0.05);
      expect(maxDepth).toBeLessThan(0.01);
      // most of the closing speed is gone (prop strikes turn much of it into spin / deflection)
      expect(towards).toBeLessThan(0.5 * vel.length());
      if (name !== 'torus') {
        expect(awayAfter).toBeGreaterThan(-0.1 * impact); // not driving into the surface
        expect(minZ).toBeGreaterThan(-2); // never passed through
      }
    });
  }

  it('head-on wall hit reports impactSpeed ≈ closing speed', () => {
    const w = new PhysicsWorld(EMPTY_LEVEL, NO_DRAG);
    w.reset(new Vector3(998, 5, 0), 0);
    const h = hoverThrottle(NO_DRAG);
    for (let i = 0; i < 4; i++) w.state.motors[i] = h;
    w.state.velocity.set(6, 0, 0);
    let impact = 0;
    run(w, 0.5, [h, h, h, h], (cs) => {
      for (const c of cs) if (c.colliderId === 'wall-east' && impact === 0) impact = c.impactSpeed;
    });
    expect(impact).toBeCloseTo(6, 1);
    expect(w.state.position.x).toBeLessThan(1000);
  });

  it('ceiling fan blades whack a hovering drone sideways (blade surface velocity)', () => {
    const w = new PhysicsWorld(LOFT_LEVEL);
    const fan = LOFT_LEVEL.props.find((p) => p.kind === 'fan');
    expect(fan).toBeDefined();
    const [fx, fy, fz] = fan!.position;
    // hover in the blade plane at 0.6 m radius, 45° ahead of blade 0 (fan turns CCW from above)
    const a = Math.PI / 4;
    w.reset(new Vector3(fx + 0.6 * Math.cos(a), fy - 0.03, fz - 0.6 * Math.sin(a)), 0);
    const h = hoverThrottle();
    let hitFan = 0;
    let maxImpact = 0;
    for (let i = 0; i < 1000 && hitFan === 0; i++) {
      for (let k = 0; k < 4; k++) w.state.motors[k] = h;
      const cs = w.step(DT, [h, h, h, h]);
      for (const c of cs)
        if (c.colliderId === 'fan') {
          hitFan++;
          maxImpact = Math.max(maxImpact, c.impactSpeed);
        }
    }
    expect(hitFan).toBeGreaterThan(0);
    // blade tip speed at r=0.6 m: 2π·1.4·0.6 ≈ 5.3 m/s
    expect(maxImpact).toBeGreaterThan(3);
    run(w, 0.02, [h, h, h, h]);
    const horiz = Math.hypot(w.state.velocity.x, w.state.velocity.z);
    expect(horiz).toBeGreaterThan(1);
    expect(w.fanAngle).toBeGreaterThan(0);
  });

  it('spawns and settles on the loft floor without drifting', () => {
    const w = new PhysicsWorld(LOFT_LEVEL);
    const start = w.state.position.clone();
    run(w, 2);
    expect(w.state.position.distanceTo(new Vector3(start.x, REST_Y, start.z))).toBeLessThan(0.002);
    expect(w.state.velocity.length()).toBeLessThan(0.02);
  });
});

describe('interpolation', () => {
  it('lerps position/motors and slerps orientation between prevState and state', () => {
    const w = new PhysicsWorld(EMPTY_LEVEL);
    w.reset(new Vector3(0, 10, 0), 0);
    w.state.angularVelocity.set(0, 20, 0);
    w.state.velocity.set(10, 0, 0);
    w.step(DT, [1, 1, 1, 1]);
    const out = createDroneState();
    w.interpolate(0, out);
    expect(out.position.distanceTo(w.prevState.position)).toBeLessThan(1e-12);
    expect(out.orientation.angleTo(w.prevState.orientation)).toBeLessThan(1e-6);
    w.interpolate(1, out);
    expect(out.position.distanceTo(w.state.position)).toBeLessThan(1e-12);
    w.interpolate(0.5, out);
    const mid = w.prevState.position.clone().lerp(w.state.position, 0.5);
    expect(out.position.distanceTo(mid)).toBeLessThan(1e-12);
    expect(out.motors[0]).toBeCloseTo((w.prevState.motors[0] + w.state.motors[0]) / 2, 12);
    const half = new Quaternion().slerpQuaternions(w.prevState.orientation, w.state.orientation, 0.5);
    expect(out.orientation.angleTo(half)).toBeLessThan(1e-6);
  });
});
