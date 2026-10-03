/**
 * Bird flocks (docs/12): boids-lite — each bird steers for a point on its flock's slow circle (the orbit wanders),
 * keeps apart from its neighbours and matches their heading. When the drone comes within SCARE_RADIUS of a flock
 * (or of any of its birds) the flock scatters: every bird flees away from the drone and climbs, then the flock
 * regroups on a new circle away from it. Flocks far from the drone move their home near it (streamed worlds).
 *
 * Pure and deterministic (own xorshift stream, polynomial trig); no allocation per update.
 */
import { dcos, dsin, TAU } from '../math';

export const SCARE_RADIUS = 22;
/** a flock stays scattered this long, s */
export const SCATTER_TIME = 7;
export const BIRD_STATE = { circling: 0, scattered: 1 } as const;

export interface FlockOptions {
  seed: number;
  flocks: number;
  birds: number;
  /** cruise speed, m/s (gulls ~10, pigeons ~12, swallows ~14) */
  speed: number;
  /** circle radius range, m */
  radius: [number, number];
  /** circling height above the ground, m */
  height: [number, number];
  /** homes are kept within this distance of the drone (m); farther ones move */
  keep: number;
  /** a new home lands this far from the drone, m [min, max] */
  place: [number, number];
  /** ground height for (x, z) */
  ground: (x: number, z: number) => number;
  /** may a flock make its home here (water for gulls, open land for others)? default: anywhere */
  accept?: (x: number, z: number) => boolean;
  /** fixed homes (x, z) to start from (City plazas); otherwise placed around the start point */
  homes?: readonly (readonly [number, number])[];
}

class Rand {
  private s: number;
  constructor(seed: number) {
    this.s = (seed >>> 0) || 0x2545f491;
  }
  next(): number {
    let x = this.s;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.s = x;
    return x / 4294967296;
  }
}

export class BirdFlocks {
  readonly flocks: number;
  readonly perFlock: number;
  readonly count: number;
  // per bird
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly z: Float64Array;
  readonly vx: Float64Array;
  readonly vy: Float64Array;
  readonly vz: Float64Array;
  /** wing-beat phase offset 0..1 (the renderer flaps by it) */
  readonly phase: Float32Array;
  // per flock
  readonly hx: Float64Array;
  readonly hz: Float64Array;
  readonly hy: Float64Array;
  readonly radius: Float64Array;
  readonly angle: Float64Array;
  readonly dir: Float64Array;
  readonly state: Uint8Array;
  readonly timer: Float64Array;
  /** scatter events since the last drain: flock index + 1 (0: none) */
  private readonly pending: Int32Array;
  private pendingN = 0;
  /** active birds per flock (budget); the rest are parked */
  active: number;
  activeFlocks: number;
  private readonly o: FlockOptions;
  private readonly rand: Rand;
  time = 0;
  scatters = 0;

  constructor(o: FlockOptions, startX: number, startZ: number) {
    this.o = o;
    this.flocks = o.flocks;
    this.perFlock = o.birds;
    this.count = o.flocks * o.birds;
    this.active = o.birds;
    this.activeFlocks = o.flocks;
    this.rand = new Rand(o.seed ^ 0x5bd1e995);
    const n = this.count;
    this.x = new Float64Array(n);
    this.y = new Float64Array(n);
    this.z = new Float64Array(n);
    this.vx = new Float64Array(n);
    this.vy = new Float64Array(n);
    this.vz = new Float64Array(n);
    this.phase = new Float32Array(n);
    const f = o.flocks;
    this.hx = new Float64Array(f);
    this.hz = new Float64Array(f);
    this.hy = new Float64Array(f);
    this.radius = new Float64Array(f);
    this.angle = new Float64Array(f);
    this.dir = new Float64Array(f);
    this.state = new Uint8Array(f);
    this.timer = new Float64Array(f);
    this.pending = new Int32Array(Math.max(1, f));
    for (let k = 0; k < f; k++) {
      const h = o.homes?.[k % Math.max(1, o.homes.length)];
      if (h) this.home(k, h[0], h[1]);
      else this.placeNear(k, startX, startZ, true);
      for (let i = 0; i < o.birds; i++) {
        const b = k * o.birds + i;
        const a = this.rand.next() * TAU;
        const r = this.rand.next() * 6;
        this.x[b] = this.hx[k]! + this.radius[k]! * dcos(this.angle[k]!) + r * dcos(a);
        this.z[b] = this.hz[k]! + this.radius[k]! * dsin(this.angle[k]!) + r * dsin(a);
        this.y[b] = this.hy[k]! + (this.rand.next() - 0.5) * 4;
        this.vx[b] = -dsin(this.angle[k]!) * o.speed * this.dir[k]!;
        this.vz[b] = dcos(this.angle[k]!) * o.speed * this.dir[k]!;
        this.vy[b] = 0;
        this.phase[b] = this.rand.next();
      }
    }
  }

  private home(k: number, x: number, z: number): void {
    const o = this.o;
    this.hx[k] = x;
    this.hz[k] = z;
    this.radius[k] = o.radius[0] + this.rand.next() * (o.radius[1] - o.radius[0]);
    this.hy[k] = o.ground(x, z) + o.height[0] + this.rand.next() * (o.height[1] - o.height[0]);
    this.angle[k] = this.rand.next() * TAU;
    this.dir[k] = this.rand.next() < 0.5 ? -1 : 1;
  }

  /** a new home `place` metres from (x, z), away from `awayX/Z` when given */
  private placeNear(k: number, x: number, z: number, anywhere: boolean, awayX = 0, awayZ = 0): void {
    const o = this.o;
    for (let t = 0; t < 12; t++) {
      let a = this.rand.next() * TAU;
      if (!anywhere) {
        // half-plane away from the scare
        const fa = Math.sqrt(awayX * awayX + awayZ * awayZ) > 1e-6 ? 1 : 0;
        if (fa) {
          const ux = awayX / Math.sqrt(awayX * awayX + awayZ * awayZ);
          const uz = awayZ / Math.sqrt(awayX * awayX + awayZ * awayZ);
          if (dcos(a) * ux + dsin(a) * uz < 0.2) a += Math.PI;
        }
      }
      const d = o.place[0] + this.rand.next() * (o.place[1] - o.place[0]);
      const px = x + dcos(a) * d;
      const pz = z + dsin(a) * d;
      if (!o.accept || o.accept(px, pz) || t === 11) {
        this.home(k, px, pz);
        return;
      }
    }
  }

  /** Advance by dt around the drone at (dx, dy, dz). */
  update(dt: number, dx: number, dy: number, dz: number): void {
    const h = Math.min(Math.max(dt, 0), 0.1);
    if (h === 0) return;
    this.time += h;
    const o = this.o;
    const per = this.perFlock;
    for (let k = 0; k < this.activeFlocks; k++) {
      // far from the drone: the flock moves its home closer (streamed worlds, the drone flew on)
      const fx = this.hx[k]! - dx;
      const fz = this.hz[k]! - dz;
      if (fx * fx + fz * fz > o.keep * o.keep && !o.homes) {
        this.placeNear(k, dx, dz, true);
        this.teleportFlock(k);
      }
      // scare: the drone within reach of the flock centre or any bird
      if (this.state[k] === BIRD_STATE.circling) {
        let near = false;
        const b0 = k * per;
        for (let i = 0; i < this.active && !near; i++) {
          const b = b0 + i;
          const ex = this.x[b]! - dx;
          const ey = this.y[b]! - dy;
          const ez = this.z[b]! - dz;
          if (ex * ex + ey * ey + ez * ez < SCARE_RADIUS * SCARE_RADIUS) near = true;
        }
        if (near) {
          this.state[k] = BIRD_STATE.scattered;
          this.timer[k] = SCATTER_TIME;
          this.scatters++;
          if (this.pendingN < this.pending.length) this.pending[this.pendingN++] = k + 1;
          // regroup away from the drone, a bit higher
          const ax = this.hx[k]! - dx;
          const az = this.hz[k]! - dz;
          this.placeNear(k, dx, dz, false, ax, az);
          this.hy[k] = this.hy[k]! + 8;
        }
      } else {
        this.timer[k] = this.timer[k]! - h;
        if (this.timer[k]! <= 0) this.state[k] = BIRD_STATE.circling;
      }
      this.angle[k] = this.angle[k]! + (this.dir[k]! * o.speed * h) / Math.max(5, this.radius[k]!);
      // the circle's centre wanders a little
      this.hx[k] = this.hx[k]! + dsin(this.time * 0.05 + k * 1.7) * 0.6 * h;
      this.hz[k] = this.hz[k]! + dcos(this.time * 0.043 + k * 2.3) * 0.6 * h;
      this.steer(k, h, dx, dy, dz);
    }
  }

  private teleportFlock(k: number): void {
    const per = this.perFlock;
    for (let i = 0; i < per; i++) {
      const b = k * per + i;
      const a = this.rand.next() * TAU;
      this.x[b] = this.hx[k]! + this.radius[k]! * dcos(this.angle[k]!) + 4 * dcos(a);
      this.z[b] = this.hz[k]! + this.radius[k]! * dsin(this.angle[k]!) + 4 * dsin(a);
      this.y[b] = this.hy[k]!;
    }
  }

  private steer(k: number, h: number, dx: number, dy: number, dz: number): void {
    const o = this.o;
    const per = this.perFlock;
    const b0 = k * per;
    const n = this.active;
    // flock averages (alignment / cohesion)
    let mx = 0, my = 0, mz = 0, ax = 0, az = 0;
    for (let i = 0; i < n; i++) {
      const b = b0 + i;
      mx += this.x[b]!;
      my += this.y[b]!;
      mz += this.z[b]!;
      ax += this.vx[b]!;
      az += this.vz[b]!;
    }
    mx /= n;
    my /= n;
    mz /= n;
    ax /= n;
    az /= n;
    const scattered = this.state[k] === BIRD_STATE.scattered;
    const speed = o.speed * (scattered ? 1.7 : 1);
    const a = this.angle[k]!;
    for (let i = 0; i < n; i++) {
      const b = b0 + i;
      // target: a point on the circle, spread a little per bird
      const off = (i / n - 0.5) * 0.5;
      const tx = this.hx[k]! + this.radius[k]! * dcos(a - this.dir[k]! * off);
      const tz = this.hz[k]! + this.radius[k]! * dsin(a - this.dir[k]! * off);
      const ty = this.hy[k]! + dsin(this.time * 0.7 + i) * 1.5;
      let sx = tx - this.x[b]!;
      let sy = ty - this.y[b]!;
      let sz = tz - this.z[b]!;
      let l = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1;
      let wx = (sx / l) * 1.0;
      let wy = (sy / l) * 0.8;
      let wz = (sz / l) * 1.0;
      // cohesion and alignment
      wx += (mx - this.x[b]!) * 0.01 + ax * 0.02;
      wy += (my - this.y[b]!) * 0.01;
      wz += (mz - this.z[b]!) * 0.01 + az * 0.02;
      // separation (n ≤ 16: all pairs)
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const c = b0 + j;
        const ex = this.x[b]! - this.x[c]!;
        const ey = this.y[b]! - this.y[c]!;
        const ez = this.z[b]! - this.z[c]!;
        const d2 = ex * ex + ey * ey + ez * ez;
        if (d2 < 9 && d2 > 1e-6) {
          const k2 = (9 - d2) / 9 / Math.sqrt(d2);
          wx += ex * k2 * 1.5;
          wy += ey * k2 * 1.5;
          wz += ez * k2 * 1.5;
        }
      }
      // fleeing: straight away from the drone and up
      if (scattered) {
        const fx = this.x[b]! - dx;
        const fy = this.y[b]! - dy;
        const fz = this.z[b]! - dz;
        const fl = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1;
        const urgency = Math.max(0, 1 - fl / (SCARE_RADIUS * 3));
        wx += (fx / fl) * 4 * urgency;
        wy += (fy / fl) * 2 * urgency + 0.6 * urgency;
        wz += (fz / fl) * 4 * urgency;
      }
      // keep clear of the ground
      const g = o.ground(this.x[b]!, this.z[b]!);
      if (this.y[b]! < g + 6) wy += (g + 6 - this.y[b]!) * 0.5;
      // steer the velocity towards the wish (bounded turn rate), keep the cruise speed
      l = Math.sqrt(wx * wx + wy * wy + wz * wz) || 1;
      const turn = Math.min(1, h * (scattered ? 5 : 2.2));
      this.vx[b] = this.vx[b]! + ((wx / l) * speed - this.vx[b]!) * turn;
      this.vy[b] = this.vy[b]! + ((wy / l) * speed * 0.5 - this.vy[b]!) * turn;
      this.vz[b] = this.vz[b]! + ((wz / l) * speed - this.vz[b]!) * turn;
      sx = this.vx[b]!;
      sy = this.vy[b]!;
      sz = this.vz[b]!;
      l = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1;
      const s = speed / l;
      this.vx[b] = sx * s;
      this.vy[b] = sy * s;
      this.vz[b] = sz * s;
      this.x[b] = this.x[b]! + this.vx[b]! * h;
      this.y[b] = this.y[b]! + this.vy[b]! * h;
      this.z[b] = this.z[b]! + this.vz[b]! * h;
    }
  }

  /** Flock centre (mean of its birds) → out[0..2]. */
  centre(k: number, out: Float64Array | number[]): void {
    let x = 0, y = 0, z = 0;
    const n = this.active;
    for (let i = 0; i < n; i++) {
      const b = k * this.perFlock + i;
      x += this.x[b]!;
      y += this.y[b]!;
      z += this.z[b]!;
    }
    out[0] = x / n;
    out[1] = y / n;
    out[2] = z / n;
  }

  /** Hands every scatter since the last drain (flock index) to `fn`. */
  drainScatters(fn: (flock: number) => void): void {
    for (let i = 0; i < this.pendingN; i++) fn(this.pending[i]! - 1);
    this.pendingN = 0;
  }
}
