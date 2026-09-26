/** Single-axis rate PID: D on measurement with its own LPF, clamped integral with relax. */
import { LowPass1 } from './filters';

export interface PidGains {
  kp: number;
  ki: number;
  kd: number;
  /** feed-forward on setpoint rate of change */
  kf: number;
  /** |integral| limit, output units */
  iLimit: number;
  dCutoffHz: number;
  /** I-term relax: integration fades out while |setpoint − LPF(setpoint)| approaches this (rad/s) */
  relaxThreshold: number;
}

const RELAX_CUTOFF_HZ = 15;

export class Pid {
  gains: PidGains;
  integral = 0;
  /** last terms, for telemetry */
  p = 0;
  d = 0;
  f = 0;
  private prevMeas = 0;
  private prevSp = 0;
  private primed = false;
  private readonly dLpf: LowPass1;
  private readonly fLpf: LowPass1;
  private readonly spLpf = new LowPass1(RELAX_CUTOFF_HZ);

  constructor(gains: PidGains) {
    this.gains = gains;
    this.dLpf = new LowPass1(gains.dCutoffHz);
    this.fLpf = new LowPass1(gains.dCutoffHz);
  }

  /** Returns the control output. `integrate=false` freezes I (anti-windup on saturation). */
  update(setpoint: number, measurement: number, dt: number, integrate: boolean): number {
    const g = this.gains;
    const err = setpoint - measurement;
    const spHp = Math.abs(setpoint - this.spLpf.update(setpoint, dt));
    const relax = g.relaxThreshold > 0 ? Math.max(0, 1 - spHp / g.relaxThreshold) : 1;
    if (integrate) {
      const i = this.integral + g.ki * err * relax * dt;
      this.integral = i > g.iLimit ? g.iLimit : i < -g.iLimit ? -g.iLimit : i;
    }
    const dMeas = this.primed ? (measurement - this.prevMeas) / dt : 0;
    const dSp = this.primed ? (setpoint - this.prevSp) / dt : 0;
    this.prevMeas = measurement;
    this.prevSp = setpoint;
    this.primed = true;
    this.p = g.kp * err;
    this.d = -g.kd * this.dLpf.update(dMeas, dt);
    this.f = g.kf * this.fLpf.update(dSp, dt);
    return this.p + this.integral + this.d + this.f;
  }

  /** Decay the integral toward zero with time constant tau (seconds). */
  relax(dt: number, tau: number): void {
    this.integral *= Math.exp(-dt / tau);
  }

  reset(): void {
    this.integral = 0;
    this.p = 0;
    this.d = 0;
    this.f = 0;
    this.primed = false;
    this.dLpf.reset();
    this.fLpf.reset();
    this.spLpf.reset();
  }
}
