/**
 * A tractor ploughing a field (docs/12): up and down rows 6 m apart along the field's long side, a half-circle
 * turn at each headland, 2.4 m/s, round and round. A kinematic collider like the cars. Pure; its pose is a function
 * of the clock.
 */
import type { MoverCollider, MoverSource } from './movers';
import { datan2, dcos, dsin, PI } from '../math';
import type { TractorField } from './countryside';

export const TRACTOR_SPEED = 2.4;
const ROW = 6;
const SIZE: readonly [number, number, number] = [2.4, 2.9, 4.6];

export class Tractor implements MoverSource {
  readonly field: TractorField;
  /** path samples in field-local metres (x across, z along) with cumulative length */
  private readonly px: number[] = [];
  private readonly pz: number[] = [];
  private readonly ps: number[] = [];
  readonly length: number;
  /** pose: centre (world), heading yaw, velocity */
  x = 0;
  y = 0;
  z = 0;
  yaw = 0;
  vx = 0;
  vz = 0;
  private readonly ground: (x: number, z: number) => number;
  private readonly mover: MoverCollider & { shape: { kind: 'box'; center: [number, number, number]; half: [number, number, number]; yaw: number } };

  constructor(field: TractorField, ground: (x: number, z: number) => number) {
    this.field = field;
    this.ground = ground;
    const rows = Math.max(2, Math.floor((field.halfW * 2) / ROW));
    const x0 = -((rows - 1) * ROW) / 2;
    const zEnd = field.halfL - ROW / 2;
    const push = (x: number, z: number): void => {
      const n = this.px.length;
      const ex = n === 0 ? 0 : x - this.px[n - 1]!;
      const ez = n === 0 ? 0 : z - this.pz[n - 1]!;
      const s = n === 0 ? 0 : this.ps[n - 1]! + Math.sqrt(ex * ex + ez * ez);
      this.px.push(x);
      this.pz.push(z);
      this.ps.push(s);
    };
    // there and back: up the rows, then down them again (a closed loop)
    const order: number[] = [];
    for (let r = 0; r < rows; r++) order.push(r);
    for (let r = rows - 2; r > 0; r--) order.push(r);
    for (let k = 0; k < order.length; k++) {
      const r = order[k]!;
      const up = k % 2 === 0;
      const x = x0 + r * ROW;
      push(x, up ? -zEnd : zEnd);
      push(x, up ? zEnd : -zEnd);
      // headland turn to the next row: a half circle (8 steps)
      const next = order[(k + 1) % order.length]!;
      const nx = x0 + next * ROW;
      const cx = (x + nx) / 2;
      const rad = Math.abs(nx - x) / 2;
      const zc = up ? zEnd : -zEnd;
      const dir = nx > x ? 1 : -1;
      for (let i = 1; i < 8; i++) {
        const a = (i / 8) * PI;
        push(cx - dir * rad * dcos(a), zc + (up ? 1 : -1) * rad * dsin(a));
      }
    }
    push(this.px[0]!, this.pz[0]!);
    this.length = this.ps[this.ps.length - 1]!;
    this.mover = {
      id: 'tractor:0',
      shape: { kind: 'box', center: [0, 0, 0], half: [SIZE[0] / 2, SIZE[1] / 2, SIZE[2] / 2], yaw: 0 },
      bound: Math.sqrt(SIZE[0] * SIZE[0] + SIZE[1] * SIZE[1] + SIZE[2] * SIZE[2]) / 2,
      restitution: 0.3,
      friction: 0.6,
      velocity: [0, 0, 0],
    };
    this.update(0);
  }

  /** Pose at clock `t` (s). */
  update(t: number): void {
    let s = (t * TRACTOR_SPEED) % this.length;
    if (s < 0) s += this.length;
    const ps = this.ps;
    let i = 0;
    let lo = 0;
    let hi = ps.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (ps[mid]! <= s) lo = mid;
      else hi = mid;
    }
    i = lo;
    const k = (s - ps[i]!) / Math.max(1e-9, ps[i + 1]! - ps[i]!);
    const lx = this.px[i]! + (this.px[i + 1]! - this.px[i]!) * k;
    const lz = this.pz[i]! + (this.pz[i + 1]! - this.pz[i]!) * k;
    const dx = this.px[i + 1]! - this.px[i]!;
    const dz = this.pz[i + 1]! - this.pz[i]!;
    const f = this.field;
    const c = dcos(f.yaw);
    const sn = dsin(f.yaw);
    // field-local → world: R_y(yaw)
    this.x = f.x + c * lx + sn * lz;
    this.z = f.z - sn * lx + c * lz;
    const wx = c * dx + sn * dz;
    const wz = -sn * dx + c * dz;
    const l = Math.sqrt(wx * wx + wz * wz) || 1;
    this.yaw = datan2(wx, wz);
    this.vx = (wx / l) * TRACTOR_SPEED;
    this.vz = (wz / l) * TRACTOR_SPEED;
    this.y = this.ground(this.x, this.z);
  }

  queryMovers(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, out: MoverCollider[]): number {
    const b = 3;
    if (this.x + b < minX || this.x - b > maxX || this.z + b < minZ || this.z - b > maxZ || this.y > maxY || this.y + SIZE[1] < minY) return 0;
    const m = this.mover;
    m.shape.center[0] = this.x;
    m.shape.center[1] = this.y + SIZE[1] / 2;
    m.shape.center[2] = this.z;
    m.shape.yaw = this.yaw;
    m.velocity[0] = this.vx;
    m.velocity[2] = this.vz;
    if (out.length === 0) out.push(m);
    else out[0] = m;
    return 1;
  }
}
