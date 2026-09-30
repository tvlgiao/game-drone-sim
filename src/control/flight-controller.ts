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
import type { ControlInput, DroneState, FlightMode, AxisRates } from '../types';
import { type DroneParams, GRAVITY, hoverThrottle } from '../physics/drone-params';
import { Rng } from '../physics/rng';
import { LowPass1 } from './filters';
import { Mixer } from './mixer';
import { Pid, type PidGains } from './pid';
import { RATE_PRESETS, actualRate, axisRatesFrom, throttleCurve } from './rates';

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
/** Altitude hold (DJI 'A/Atti' with barometer): stick → climb rate, PI on vertical speed. */
const ALT_MAX_CLIMB = 3; // m/s at full stick up
const ALT_MAX_SINK = 2.5; // m/s at full stick down
const ALT_DEADBAND = 0.08;
const ALT_KP = 4; // (m/s²)/(m/s)
const ALT_KI = 3;
const ALT_I_LIMIT = 4; // m/s²
const BARO_NOISE = 0.03; // m/s vertical-speed estimate noise
const ALT_POS_KP = 1.5; // (m/s)/m: altitude error → climb rate while the stick is centred
const ALT_POS_MAX_V = 1; // m/s
/** Position hold (DJI 'P' with GPS/optical flow): pitch/roll stick → horizontal speed, centre brakes. */
export const POS_MAX_SPEED = 4; // m/s at full stick
const POS_KV = 1.6; // (m/s²)/(m/s) speed error → acceleration
const POS_DEADBAND = 0.05;

export class FlightController {
  mode: FlightMode = 'angle';
  /** per-axis Betaflight Actual rates */
  rates: AxisRates = axisRatesFrom(RATE_PRESETS.freestyle);
  /** Angle mode tilt limit (deg), Betaflight angle_limit */
  angleMaxTiltDeg = ANGLE_MAX_TILT_DEG;
  /** throttle curve expo around the mid point (Betaflight thr_expo) */
  throttleExpo = THROTTLE_EXPO;
  /** throttle output scale 0.25..1 (Betaflight throttle_limit "scale") */
  throttleLimit = 1;
  /** DJI-style altitude hold: throttle stick commands climb rate, centre holds altitude */
  altitudeHold = false;
  /**
   * Angle mode only: pitch/roll stick commands horizontal speed in the heading frame and a centred
   * stick brakes to a stop (no drifting on momentum), like a DJI in P mode.
   */
  positionHold = false;
  private readonly holdInput: ControlInput = { throttle: 0, yaw: 0, pitch: 0, roll: 0 };
  private altI = 0;
  /** barometric altitude target captured when the stick returns to centre (NaN = not holding) */
  private holdZ = Number.NaN;
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

  /** Collective thrust fraction (0..1 per motor) that tracks the stick's climb-rate command. */
  private altitudeCollective(dt: number, throttle: number, state: DroneState): number {
    const s = (throttle - 0.5) * 2;
    const a = Math.abs(s);
    const shaped = a < ALT_DEADBAND ? 0 : (Math.sign(s) * (a - ALT_DEADBAND)) / (1 - ALT_DEADBAND);
    let vzCmd = shaped >= 0 ? shaped * ALT_MAX_CLIMB : shaped * ALT_MAX_SINK;
    if (shaped === 0 && throttle >= I_RELAX_THROTTLE) {
      // stick centred: hold the altitude captured once the climb/sink has been braked
      if (Number.isNaN(this.holdZ) && Math.abs(state.velocity.y) < 0.3) this.holdZ = state.position.y;
      if (!Number.isNaN(this.holdZ)) {
        const e = this.holdZ - state.position.y;
        vzCmd = Math.max(-ALT_POS_MAX_V, Math.min(ALT_POS_MAX_V, ALT_POS_KP * e));
      }
    } else {
      this.holdZ = Number.NaN;
    }
    const vz = state.velocity.y + this.rng.gaussian() * BARO_NOISE;
    const err = vzCmd - vz;
    const q = state.orientation;
    const cosTilt = Math.max(0.35, 1 - 2 * (q.x * q.x + q.z * q.z));
    const p = this.params;
    const aCmd = ALT_KP * err + this.altI;
    const frac = (p.mass * (GRAVITY + aCmd)) / (4 * p.maxThrustPerMotor * cosTilt);
    const out = frac < 0 ? 0 : frac > 1 ? 1 : frac;
    // integrate only while unsaturated; bleed off while the stick sits at the bottom (landed/idle)
    if (throttle < I_RELAX_THROTTLE) this.altI *= Math.exp(-dt / 0.2);
    else if (out === frac) this.altI = Math.max(-ALT_I_LIMIT, Math.min(ALT_I_LIMIT, this.altI + ALT_KI * err * dt));
    return out;
  }

  private resetLoops(): void {
    this.altI = 0;
    this.holdZ = Number.NaN;
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
    sp.z = actualRate(input.yaw, this.rates.yaw) * DEG;
    if (this.mode === 'acro') {
      sp.x = actualRate(input.roll, this.rates.roll) * DEG;
      sp.y = actualRate(input.pitch, this.rates.pitch) * DEG;
    } else {
      this.angleSetpoints(this.positionHold ? this.velocityToTilt(input, state) : input, state);
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

    const u = throttleCurve(input.throttle, this.throttleMid, this.throttleExpo) * this.throttleLimit;
    const idle = this.params.idle;
    const collective = this.altitudeHold ? this.altitudeCollective(dt, input.throttle, state) : u * u;
    const thrust = this.mixer.mix(collective, r, p, y, idle * idle);
    // thrust fraction → normalised rpm command (T ∝ u²): linear torque authority at any throttle
    for (let i = 0; i < 4; i++) out[i] = Math.sqrt(thrust[i]);
    return out;
  }

  /** Position hold: stick → speed command, speed error → tilt (as an Angle-mode stick deflection). */
  private velocityToTilt(input: ControlInput, state: DroneState): ControlInput {
    const h = this.holdInput;
    h.throttle = input.throttle;
    h.yaw = input.yaw;
    this.euler.setFromQuaternion(state.orientation, 'YXZ');
    const yaw = this.euler.y;
    const s = Math.sin(yaw);
    const c = Math.cos(yaw);
    const v = state.velocity;
    // heading frame: forward = (−sin, 0, −cos), right = (cos, 0, −sin)
    const vf = -s * v.x - c * v.z;
    const vr = c * v.x - s * v.z;
    const dz = (x: number): number => (Math.abs(x) < POS_DEADBAND ? 0 : (x - Math.sign(x) * POS_DEADBAND) / (1 - POS_DEADBAND));
    const af = POS_KV * (dz(clampS(input.pitch)) * POS_MAX_SPEED - vf);
    const ar = POS_KV * (dz(clampS(input.roll)) * POS_MAX_SPEED - vr);
    const maxTilt = this.angleMaxTiltDeg * DEG;
    h.pitch = clampS(Math.atan(af / GRAVITY) / maxTilt);
    h.roll = clampS(Math.atan(ar / GRAVITY) / maxTilt);
    return h;
  }

  /** Angle mode: tilt error between current and stick-commanded body-up vectors → roll/pitch rates. */
  private angleSetpoints(input: ControlInput, state: DroneState): void {
    const q = state.orientation;
    const maxTilt = this.angleMaxTiltDeg * DEG;
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
