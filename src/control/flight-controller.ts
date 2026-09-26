/**
 * Betaflight-like flight controller running at the physics rate: simulated gyro, rate PIDs,
 * angle-mode outer loop, throttle curve and airmode mixer. Deterministic for a given seed.
 *
 * Pilot axes vs body axes (body: +X right, +Y up, -Z forward):
 *   roll  + (right wing down)   = −ω_z
 *   pitch + (nose down)         = −ω_x
 *   yaw   + (clockwise from top) = −ω_y
 */
import { Euler, Quaternion, Vector3 } from 'three';
import type { ControlInput, DroneState, FlightMode, RateProfile } from '../types';
import { type DroneParams, hoverThrottle } from '../physics/drone-params';
import { Rng } from '../physics/rng';
import { LowPass1 } from './filters';
import { Mixer } from './mixer';
import { Pid, type PidGains } from './pid';
import { RATE_PRESETS, actualRate, throttleCurve } from './rates';

const DEG = Math.PI / 180;

function clampS(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

/** Output unit: per-motor thrust fraction per rad/s of rate error. */
export const DEFAULT_PID: { roll: PidGains; pitch: PidGains; yaw: PidGains } = {
  roll: { kp: 0.16, ki: 1.2, kd: 0.0019, kf: 0.0, iLimit: 0.15, dCutoffHz: 80, relaxThreshold: 0.7 },
  pitch: { kp: 0.16, ki: 1.2, kd: 0.0019, kf: 0.0, iLimit: 0.15, dCutoffHz: 80, relaxThreshold: 0.7 },
  yaw: { kp: 0.35, ki: 2.5, kd: 0.0, kf: 0.0, iLimit: 0.2, dCutoffHz: 80, relaxThreshold: 0.7 },
};

export const GYRO_NOISE_DEG_S = 0.3;
export const GYRO_LPF_HZ = 100;
export const ANGLE_MAX_TILT_DEG = 55;
/** Angle-mode outer loop: rate setpoint (rad/s) per rad of tilt error. */
export const ANGLE_P = 10;
export const ANGLE_MAX_RATE = 8;
export const ARM_MAX_TILT_DEG = 60;
export const ARM_MAX_THROTTLE = 0.05;
const I_RELAX_THROTTLE = 0.05;
const I_RELAX_TAU = 0.05;
const THROTTLE_EXPO = 0.3;

export class FlightController {
  mode: FlightMode = 'angle';
  rates: RateProfile = { ...RATE_PRESETS.freestyle };
  readonly params: DroneParams;
  readonly pidRoll: Pid;
  readonly pidPitch: Pid;
  readonly pidYaw: Pid;
  readonly mixer = new Mixer();
  /** filtered gyro in pilot axes (roll, pitch, yaw) rad/s */
  readonly gyro = new Vector3();
  /** last rate setpoints in pilot axes (roll, pitch, yaw) rad/s */
  readonly setpoint = new Vector3();
  /** normalised hover command used as the throttle-curve midpoint */
  throttleMid: number;

  private _armed = false;
  private readonly rng: Rng;
  private readonly seed: number;
  private readonly lpfRoll = new LowPass1(GYRO_LPF_HZ);
  private readonly lpfPitch = new LowPass1(GYRO_LPF_HZ);
  private readonly lpfYaw = new LowPass1(GYRO_LPF_HZ);
  private readonly motorOut: number[] = [0, 0, 0, 0];

  private readonly euler = new Euler();
  private readonly qd = new Quaternion();
  private readonly qTmp = new Quaternion();
  private readonly qInv = new Quaternion();
  private readonly up = new Vector3();
  private readonly upD = new Vector3();
  private readonly axis = new Vector3();
  private static readonly X = new Vector3(1, 0, 0);
  private static readonly Y = new Vector3(0, 1, 0);
  private static readonly Z = new Vector3(0, 0, 1);

  constructor(params: DroneParams, seed = 1) {
    this.params = params;
    this.seed = seed;
    this.rng = new Rng(seed);
    this.pidRoll = new Pid({ ...DEFAULT_PID.roll });
    this.pidPitch = new Pid({ ...DEFAULT_PID.pitch });
    this.pidYaw = new Pid({ ...DEFAULT_PID.yaw });
    this.throttleMid = hoverThrottle(params);
  }

  get armed(): boolean {
    return this._armed;
  }

  /** Real FC rule: arming refused unless throttle < 0.05 and not upside down. Returns new armed state. */
  setArmed(armed: boolean, input: ControlInput, state: DroneState): boolean {
    if (!armed) {
      this._armed = false;
      return false;
    }
    if (this._armed) return true;
    if (input.throttle >= ARM_MAX_THROTTLE) return false;
    const upY = this.up.set(0, 1, 0).applyQuaternion(state.orientation).y;
    if (upY < Math.cos(ARM_MAX_TILT_DEG * DEG)) return false;
    this.resetLoops();
    this._armed = true;
    return true;
  }

  /** Clears filters, integrators and the noise stream; keeps the armed state. */
  reset(): void {
    this.resetLoops();
    this.rng.reseed(this.seed);
  }

  private resetLoops(): void {
    this.pidRoll.reset();
    this.pidPitch.reset();
    this.pidYaw.reset();
    this.lpfRoll.reset();
    this.lpfPitch.reset();
    this.lpfYaw.reset();
    this.gyro.set(0, 0, 0);
    this.setpoint.set(0, 0, 0);
  }

  /** Runs at physics rate; reads simulated gyro (noise+LPF) from state; returns motor commands 0..1. */
  update(dt: number, input: ControlInput, state: DroneState): readonly number[] {
    const w = state.angularVelocity;
    const noise = GYRO_NOISE_DEG_S * DEG;
    const gr = this.lpfRoll.update(-w.z + noise * this.rng.gaussian(), dt);
    const gp = this.lpfPitch.update(-w.x + noise * this.rng.gaussian(), dt);
    const gy = this.lpfYaw.update(-w.y + noise * this.rng.gaussian(), dt);
    this.gyro.set(gr, gp, gy);

    const out = this.motorOut;
    if (!this._armed) {
      this.pidRoll.reset();
      this.pidPitch.reset();
      this.pidYaw.reset();
      for (let i = 0; i < 4; i++) out[i] = 0;
      return out;
    }

    const sp = this.setpoint;
    sp.z = actualRate(input.yaw, this.rates) * DEG;
    if (this.mode === 'acro') {
      sp.x = actualRate(input.roll, this.rates) * DEG;
      sp.y = actualRate(input.pitch, this.rates) * DEG;
    } else {
      this.angleSetpoints(input, state);
    }

    const lowThrottle = input.throttle < I_RELAX_THROTTLE;
    const integrate = !this.mixer.saturated && !lowThrottle;
    const r = this.pidRoll.update(sp.x, gr, dt, integrate);
    const p = this.pidPitch.update(sp.y, gp, dt, integrate);
    const y = this.pidYaw.update(sp.z, gy, dt, integrate);
    if (lowThrottle) {
      this.pidRoll.relax(dt, I_RELAX_TAU);
      this.pidPitch.relax(dt, I_RELAX_TAU);
      this.pidYaw.relax(dt, I_RELAX_TAU);
    }

    const u = throttleCurve(input.throttle, this.throttleMid, THROTTLE_EXPO);
    const idle = this.params.idle;
    const thrust = this.mixer.mix(u * u, r, p, y, idle * idle);
    // thrust fraction → normalised rpm command (T ∝ u²): linear torque authority at any throttle
    for (let i = 0; i < 4; i++) out[i] = Math.sqrt(thrust[i]);
    return out;
  }

  /** Angle mode: tilt error between current and stick-commanded body-up vectors → roll/pitch rates. */
  private angleSetpoints(input: ControlInput, state: DroneState): void {
    const q = state.orientation;
    const maxTilt = ANGLE_MAX_TILT_DEG * DEG;
    this.euler.setFromQuaternion(q, 'YXZ');
    const qd = this.qd.setFromAxisAngle(FlightController.Y, this.euler.y);
    qd.multiply(this.qTmp.setFromAxisAngle(FlightController.X, -clampS(input.pitch) * maxTilt));
    qd.multiply(this.qTmp.setFromAxisAngle(FlightController.Z, -clampS(input.roll) * maxTilt));
    const up = this.up.set(0, 1, 0).applyQuaternion(q);
    const upD = this.upD.set(0, 1, 0).applyQuaternion(qd);
    const axis = this.axis.crossVectors(up, upD);
    const s = axis.length();
    const c = up.dot(upD);
    const angle = Math.atan2(s, c);
    if (s > 1e-9) axis.divideScalar(s);
    else if (c > 0) axis.set(0, 0, 0);
    else axis.set(1, 0, 0).applyQuaternion(q); // inverted: flip over body X
    const ab = axis.applyQuaternion(this.qInv.copy(q).invert());
    let rateX = ANGLE_P * angle * ab.x;
    let rateZ = ANGLE_P * angle * ab.z;
    const m = Math.hypot(rateX, rateZ);
    if (m > ANGLE_MAX_RATE) {
      rateX *= ANGLE_MAX_RATE / m;
      rateZ *= ANGLE_MAX_RATE / m;
    }
    this.setpoint.x = -rateZ;
    this.setpoint.y = -rateX;
  }
}
