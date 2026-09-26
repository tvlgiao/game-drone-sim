/** Quad-X mixer in the thrust domain with airmode (authority kept at zero and full throttle). */
import { MOTOR_LAYOUT, type MotorSpec } from '../physics/drone-params';

export interface MixRow {
  /** + roll command (right wing down) */
  roll: number;
  /** + pitch command (nose down) */
  pitch: number;
  /** + yaw command (clockwise seen from above) */
  yaw: number;
}

/**
 * Mix factors derived from geometry: roll right lowers right motors, pitch forward lowers front
 * motors (-Z), yaw right speeds up CCW props whose reaction torque turns the body clockwise.
 */
export function mixTable(layout: readonly MotorSpec[] = MOTOR_LAYOUT): MixRow[] {
  return layout.map((m) => ({ roll: -Math.sign(m.position[0]), pitch: Math.sign(m.position[2]), yaw: m.spin }));
}

export class Mixer {
  readonly table: readonly MixRow[];
  /** thrust fractions 0..1 of the last mix */
  readonly output: number[];
  /** true when the last mix had to scale down roll/pitch/yaw to fit */
  saturated = false;

  constructor(layout: readonly MotorSpec[] = MOTOR_LAYOUT) {
    this.table = mixTable(layout);
    this.output = layout.map(() => 0);
  }

  /**
   * Collective thrust fraction + axis commands → per-motor thrust fractions in [floor, 1].
   * Airmode: the differential part is preserved by shifting the collective (and scaled only when
   * its span exceeds the available range, yaw sacrificed first).
   */
  mix(throttle: number, roll: number, pitch: number, yaw: number, floor: number): readonly number[] {
    const t = this.table;
    const out = this.output;
    const n = t.length;
    const avail = 1 - floor;
    let rpMin = Infinity;
    let rpMax = -Infinity;
    let yMin = Infinity;
    let yMax = -Infinity;
    for (let i = 0; i < n; i++) {
      const rp = roll * t[i].roll + pitch * t[i].pitch;
      const y = yaw * t[i].yaw;
      if (rp < rpMin) rpMin = rp;
      if (rp > rpMax) rpMax = rp;
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
    let rpScale = 1;
    let yScale = 1;
    const rpSpan = rpMax - rpMin;
    const ySpan = yMax - yMin;
    this.saturated = false;
    if (rpSpan + ySpan > avail) {
      this.saturated = true;
      if (rpSpan >= avail) {
        rpScale = avail / rpSpan;
        yScale = 0;
      } else {
        yScale = (avail - rpSpan) / ySpan;
      }
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < n; i++) {
      const a = (roll * t[i].roll + pitch * t[i].pitch) * rpScale + yaw * t[i].yaw * yScale;
      out[i] = a;
      if (a < lo) lo = a;
      if (a > hi) hi = a;
    }
    const thr = throttle < 0 ? 0 : throttle > 1 ? 1 : throttle;
    let shift = thr;
    if (thr + lo < floor) shift = floor - lo;
    else if (thr + hi > 1) shift = 1 - hi;
    for (let i = 0; i < n; i++) {
      const v = out[i] + shift;
      out[i] = v < floor ? floor : v > 1 ? 1 : v;
    }
    return out;
  }
}
