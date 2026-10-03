/**
 * Traffic simulation on a lane network (City streets, rural roads): a fixed pool of cars that spawn on lanes
 * within `radius` of a focus point (the drone) and despawn past it, follow each other with the intelligent driver
 * model (spacing, smooth braking), stop at the stop line on red (and on yellow when they can), never enter an
 * intersection that cross traffic still occupies or whose exit lane is full, turn along Bézier connectors and
 * brake (and honk) for a drone hovering in their lane.
 *
 * Structure of arrays, no allocation per update (tested). Deterministic: the same seed, the same dt sequence and
 * the same focus path give the same traffic (its own xorshift stream). Pure: no DOM, no three.js; the
 * renderer reads the poses (`x`, `z`, `yaw`, …), physics the kinematic colliders (`queryMovers`), audio the
 * emitters (`nearestEmitters`) and events (`drainEvents`).
 */
import { datan2, dcos, dsin } from '../math';
import { EDGE_CONNECTOR, EDGE_LANE, pointAt, TURN, type Network } from './network';
import { SIGNAL, type SignalPlan } from './signals';
import { pickPaint, pickVehicle, STANDSTILL_GAP, VEHICLES, VEHICLE_TYPES } from './vehicles';
import type { MoverCollider, MoverSource } from '../life/movers';

export interface TrafficOptions {
  seed: number;
  /** pool size = most cars alive at once */
  maxCars: number;
  /** cars live within this distance of the focus (m); they despawn past radius + DESPAWN_MARGIN */
  radius: number;
  /** vehicle types allowed (default: all) */
  vehicles?: readonly number[];
  /** after the first fill, new cars appear no nearer than this share of the radius (no pop-in under the drone) */
  spawnInner?: number;
  /** edges whose cars are not colliders (a race ring reaches down to the lane): 1 = skip */
  noCollide?: Uint8Array | null;
  /** turn weights at intersections (straight, right, left) */
  turnWeights?: readonly [number, number, number];
}

export const DESPAWN_MARGIN = 40;
/** max sub-step, s */
const STEP = 1 / 30;
/** a car stopping for the drone looks this far ahead, m */
const DRONE_LOOKAHEAD = 35;
/** the drone counts as an obstacle below this height over the road, m */
const DRONE_BLOCK_AGL = 3.6;
/** how long after leaving a lane a car still counts against its siblings on the other connectors, m of rear travel */
const GROUP_CLEAR = 14;
const HORN_DECEL = 4.5;
const HORN_COOLDOWN = 6;
const MAX_EVENTS = 32;

export const CAR_FLAG = { brake: 1, committed: 2, occupying: 4, stopped: 8 } as const;

export interface TrafficEmitter {
  x: number;
  y: number;
  z: number;
  vx: number;
  vz: number;
  speed: number;
  type: number;
  braking: boolean;
  distance: number;
}

export type TrafficEventType = 'horn';

interface PooledMover extends MoverCollider {
  shape: { kind: 'box'; center: [number, number, number]; half: [number, number, number]; yaw: number };
}

/** xorshift32: the simulation's own deterministic random stream */
class Rand {
  private s: number;
  constructor(seed: number) {
    this.s = (seed >>> 0) || 0x9e3779b9;
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

export class TrafficSim implements MoverSource {
  readonly net: Network;
  readonly signals: SignalPlan | null;
  readonly capacity: number;
  radius: number;
  time = 0;
  /** cars alive */
  count = 0;

  // per car (slot)
  readonly alive: Uint8Array;
  readonly type: Uint8Array;
  readonly paint: Uint8Array;
  readonly flags: Uint8Array;
  readonly edge: Int32Array;
  readonly prevEdge: Int32Array;
  readonly nextEdge: Int32Array;
  /** front bumper's arc length on `edge` */
  readonly s: Float64Array;
  readonly v: Float64Array;
  readonly acc: Float64Array;
  /** pose: body centre, heading yaw (rotation about +Y of a model whose front is +Z), velocity */
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly z: Float64Array;
  readonly yaw: Float64Array;
  readonly vx: Float64Array;
  readonly vz: Float64Array;
  private readonly ahead: Int32Array;
  private readonly behind: Int32Array;
  private readonly groupAhead: Int32Array;
  private readonly occNode: Int32Array;
  private readonly hint: Int32Array;
  private readonly horn: Float64Array;
  /** per car: distance to its obstacle in the current step (hard clamp) */
  private readonly limit: Float64Array;
  // per edge
  private readonly head: Int32Array;
  private readonly tail: Int32Array;
  private readonly lastExit: Int32Array;
  // per node × approach: cars inside the box, the left turners among them, the lane arriving there
  private readonly occ: Int16Array;
  private readonly occLeft: Int16Array;
  private readonly laneIn: Int32Array;
  /** per car: turning left through the box it occupies */
  private readonly occIsLeft: Uint8Array;

  private readonly rand: Rand;
  private readonly allowed: readonly number[] | null;
  private readonly spawnInner: number;
  private readonly noCollide: Uint8Array | null;
  private readonly turnW: readonly [number, number, number];
  private warm = false;
  private readonly p = new Float64Array(3);
  private readonly q = new Float64Array(3);
  private readonly movers: PooledMover[] = [];
  // focus (the drone)
  private fx = 0;
  /** focus height (stats) */
  focusY = 1e9;
  private fz = 0;
  private fAgl = 1e9;
  /** cars that entered an intersection on red without having committed on yellow (must stay 0) */
  redRuns = 0;
  /** cars stopped by the hard stop-line clamp (an IDM overshoot; should stay ~0) */
  clamps = 0;
  spawned = 0;
  despawned = 0;
  // events ring
  private readonly evType: Uint8Array = new Uint8Array(MAX_EVENTS);
  private readonly evPos: Float64Array = new Float64Array(MAX_EVENTS * 3);
  private evCount = 0;

  constructor(net: Network, signals: SignalPlan | null, o: TrafficOptions) {
    this.net = net;
    this.signals = signals;
    const n = Math.max(1, o.maxCars);
    this.capacity = n;
    this.radius = o.radius;
    this.rand = new Rand(o.seed ^ 0x7a3f_19c5);
    this.allowed = o.vehicles ?? null;
    this.spawnInner = o.spawnInner ?? 0.6;
    this.noCollide = o.noCollide ?? null;
    this.turnW = o.turnWeights ?? [0.56, 0.22, 0.22];
    this.alive = new Uint8Array(n);
    this.type = new Uint8Array(n);
    this.paint = new Uint8Array(n);
    this.flags = new Uint8Array(n);
    this.edge = new Int32Array(n).fill(-1);
    this.prevEdge = new Int32Array(n).fill(-1);
    this.nextEdge = new Int32Array(n).fill(-1);
    this.s = new Float64Array(n);
    this.v = new Float64Array(n);
    this.acc = new Float64Array(n);
    this.x = new Float64Array(n);
    this.y = new Float64Array(n);
    this.z = new Float64Array(n);
    this.yaw = new Float64Array(n);
    this.vx = new Float64Array(n);
    this.vz = new Float64Array(n);
    this.ahead = new Int32Array(n).fill(-1);
    this.behind = new Int32Array(n).fill(-1);
    this.groupAhead = new Int32Array(n).fill(-1);
    this.occNode = new Int32Array(n).fill(-1);
    this.hint = new Int32Array(n);
    this.horn = new Float64Array(n);
    this.limit = new Float64Array(n);
    const ne = net.edges.length;
    this.head = new Int32Array(ne).fill(-1);
    this.tail = new Int32Array(ne).fill(-1);
    this.lastExit = new Int32Array(ne).fill(-1);
    this.occ = new Int16Array(Math.max(1, net.nodes.length) * 4);
    this.occLeft = new Int16Array(this.occ.length);
    this.laneIn = new Int32Array(this.occ.length).fill(-1);
    for (const e of net.edges) if (e.kind === EDGE_LANE && e.node >= 0) this.laneIn[e.node * 4 + e.approach] = e.id;
    this.occIsLeft = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      this.movers.push({
        id: `car:${i}`,
        shape: { kind: 'box', center: [0, 0, 0], half: [1, 1, 1], yaw: 0 },
        bound: 1,
        restitution: 0.35,
        friction: 0.6,
        velocity: [0, 0, 0],
      });
    }
  }

  /** target number of cars (≤ capacity) */
  target = Infinity;

  len(c: number): number {
    return VEHICLES[this.type[c]!]!.length;
  }

  /**
   * Advance by `dt` seconds around the focus (drone) at (fx, fy, fz), `agl` metres over the road there.
   * Spawns / despawns, moves every car, then updates the poses and colliders.
   */
  update(dt: number, fx: number, fy: number, fz: number, agl = fy): void {
    this.fx = fx;
    this.focusY = fy;
    this.fz = fz;
    this.fAgl = agl;
    let left = Math.min(Math.max(0, dt), 0.25);
    this.despawnFar();
    this.fill();
    while (left > 1e-9) {
      const h = Math.min(STEP, left);
      this.step(h);
      left -= h;
    }
    this.poses();
  }

  /** Drops every car (level reset). */
  clear(): void {
    for (let c = 0; c < this.capacity; c++) if (this.alive[c]) this.remove(c);
    this.warm = false;
  }

  // ---------------------------------------------------------------- spawning

  private despawnFar(): void {
    const r = this.radius + DESPAWN_MARGIN;
    const r2 = r * r;
    for (let c = 0; c < this.capacity; c++) {
      if (!this.alive[c]) continue;
      const dx = this.x[c]! - this.fx;
      const dz = this.z[c]! - this.fz;
      if (dx * dx + dz * dz > r2) this.remove(c);
    }
  }

  private fill(): void {
    const want = Math.min(this.capacity, this.target);
    if (this.count >= want) {
      this.warm = true;
      return;
    }
    const sp = this.net.spawnable;
    if (sp.length === 0) return;
    const R = this.radius;
    // after a jump (respawn, teleport) almost nothing is left: fill the whole disc at once
    if (this.count < want * 0.25) this.warm = false;
    const inner = this.warm ? R * this.spawnInner : 0;
    const tries = this.warm ? 48 : 6000;
    for (let k = 0; k < tries && this.count < want; k++) {
      const e = this.net.edges[sp[Math.floor(this.rand.next() * sp.length)]!]!;
      const type = pickVehicle(this.rand.next(), this.allowed);
      const L = VEHICLES[type]!.length;
      if (e.length < L + 8) continue;
      const s = L + 2 + this.rand.next() * (e.length - L - 7);
      pointAt(e, s, this.p);
      const dx = this.p[0]! - this.fx;
      const dz = this.p[2]! - this.fz;
      const d2 = dx * dx + dz * dz;
      if (d2 > R * R || d2 < inner * inner) continue;
      if (!this.roomAt(e.id, s, L)) continue;
      this.spawnAt(e.id, s, type);
    }
    this.warm = true;
  }

  /** true when a car of length L fits with its front at s on edge e (gaps to the neighbours on that edge) */
  private roomAt(e: number, s: number, L: number): boolean {
    for (let c = this.head[e]!; c >= 0; c = this.behind[c]!) {
      const sc = this.s[c]!;
      const lc = this.len(c);
      // c ahead: its rear must clear our front by a following gap; c behind: our rear must clear its front
      if (sc >= s ? sc - lc - s < 8 : s - L - sc < 8) return false;
    }
    // cars on the previous edges whose rear still hangs into this one, or cars about to enter: keep the first metres free
    return s - L > 3;
  }

  private spawnAt(e: number, s: number, type: number): number {
    let c = -1;
    for (let i = 0; i < this.capacity; i++) {
      if (!this.alive[i]) {
        c = i;
        break;
      }
    }
    if (c < 0) return -1;
    this.alive[c] = 1;
    this.type[c] = type;
    this.paint[c] = pickPaint(type, this.rand.next());
    this.flags[c] = 0;
    this.edge[c] = e;
    this.prevEdge[c] = -1;
    this.s[c] = s;
    const edge = this.net.edges[e]!;
    this.v[c] = Math.min(VEHICLES[type]!.v0, edge.limit) * (0.55 + 0.3 * this.rand.next());
    this.acc[c] = 0;
    this.hint[c] = 0;
    this.horn[c] = 0;
    this.groupAhead[c] = -1;
    this.occNode[c] = -1;
    this.insertSorted(c, e);
    this.nextEdge[c] = this.chooseNext(e);
    // a slower start behind a close leader
    const lead = this.ahead[c]!;
    if (lead >= 0 && this.s[lead]! - this.len(lead) - s < 20) this.v[c] = Math.min(this.v[c]!, this.v[lead]!);
    this.count++;
    this.spawned++;
    this.pose(c);
    return c;
  }

  private remove(c: number): void {
    const e = this.edge[c]!;
    if (e >= 0) this.unlink(c, e);
    this.release(c);
    this.alive[c] = 0;
    this.edge[c] = -1;
    this.count--;
    this.despawned++;
  }

  // ---------------------------------------------------------------- queues

  private insertSorted(c: number, e: number): void {
    // walk from the front (largest s) to the first car behind us
    let a = -1;
    let b = this.head[e]!;
    while (b >= 0 && this.s[b]! > this.s[c]!) {
      a = b;
      b = this.behind[b]!;
    }
    this.ahead[c] = a;
    this.behind[c] = b;
    if (a >= 0) this.behind[a] = c;
    else this.head[e] = c;
    if (b >= 0) this.ahead[b] = c;
    else this.tail[e] = c;
  }

  private append(c: number, e: number): void {
    const t = this.tail[e]!;
    this.ahead[c] = t;
    this.behind[c] = -1;
    if (t >= 0) this.behind[t] = c;
    else this.head[e] = c;
    this.tail[e] = c;
  }

  private unlink(c: number, e: number): void {
    const a = this.ahead[c]!;
    const b = this.behind[c]!;
    if (a >= 0) this.behind[a] = b;
    else this.head[e] = b;
    if (b >= 0) this.ahead[b] = a;
    else this.tail[e] = a;
    this.ahead[c] = -1;
    this.behind[c] = -1;
  }

  private chooseNext(e: number): number {
    const edge = this.net.edges[e]!;
    const n = edge.next.length;
    if (n === 0) return -1;
    if (n === 1 || edge.kind === EDGE_CONNECTOR) return edge.next[0]!;
    let total = 0;
    for (let i = 0; i < n; i++) total += this.turnW[edge.turns[i]!] ?? 0.1;
    let u = this.rand.next() * total;
    for (let i = 0; i < n; i++) {
      u -= this.turnW[edge.turns[i]!] ?? 0.1;
      if (u < 0) return edge.next[i]!;
    }
    return edge.next[n - 1]!;
  }

  // ---------------------------------------------------------------- driving

  /** rear position of car `x` measured from the start of the connectors leaving lane `lane` (Infinity: not in that group) */
  private groupRear(x: number, lane: number): number {
    if (x < 0 || !this.alive[x]) return Infinity;
    const e = this.net.edges[this.edge[x]!]!;
    if (e.kind === EDGE_CONNECTOR && e.from === lane) return this.s[x]! - this.len(x);
    const pe = this.prevEdge[x]!;
    if (pe >= 0) {
      const p = this.net.edges[pe]!;
      if (p.kind === EDGE_CONNECTOR && p.from === lane) return p.length + this.s[x]! - this.len(x);
    }
    return Infinity;
  }

  /** May car c (head of lane e, front `dEnd` from its end) cross into the intersection now? */
  private mayEnter(c: number, e: number, dEnd: number): boolean {
    const edge = this.net.edges[e]!;
    if (edge.kind !== EDGE_LANE || edge.node < 0 || !this.signals) return this.exitHasRoom(c);
    const st = this.signals.state(edge.node, edge.approach, this.time);
    if (st === SIGNAL.red) {
      if (!(this.flags[c]! & CAR_FLAG.committed)) return false;
    } else if (st === SIGNAL.yellow && !(this.flags[c]! & CAR_FLAG.committed)) {
      const v = this.v[c]!;
      const b = VEHICLES[this.type[c]!]!.decel;
      // too close to stop comfortably: go (and stay committed into the red); a left turner still yields below
      if (!(dEnd < (v * v) / (2 * b) + v * 0.15 && v > 2)) return false;
      this.flags[c] |= CAR_FLAG.committed;
    }
    if (this.boxClear(c, edge) && this.exitHasRoom(c)) return true;
    // waiting on the line after all: a yellow commitment is void (it would carry the car through the red later)
    this.flags[c] &= ~CAR_FLAG.committed;
    return false;
  }

  /**
   * The intersection lets car c (arriving on `lane`) in: no cross traffic left in the box, no oncoming left turner
   * in it, and a left turner also waits for the oncoming lane to be empty of cars about to come through.
   */
  private boxClear(c: number, lane: { node: number; approach: number }): boolean {
    const base = lane.node * 4;
    const a = lane.approach;
    const opp = (a + 2) & 3;
    if (this.occ[base + ((a + 1) & 3)]! > 0 || this.occ[base + ((a + 3) & 3)]! > 0) return false;
    const n1 = this.nextEdge[c]!;
    const left = n1 >= 0 && this.net.edges[n1]!.turn === TURN.left;
    if (!left) return this.occLeft[base + opp]! === 0;
    if (this.occ[base + opp]! > 0) return false;
    const inLane = this.laneIn[base + opp]!;
    if (inLane < 0) return true;
    const h = this.head[inLane]!;
    if (h < 0) return true;
    const hn = this.nextEdge[h]!;
    // oncoming left turners do not cross our path
    if (hn >= 0 && this.net.edges[hn]!.turn === TURN.left) return true;
    const dEnd = this.net.edges[inLane]!.length - this.s[h]!;
    return !(dEnd < 38 && (this.v[h]! > 1.5 || dEnd < 4));
  }

  private exitHasRoom(c: number): boolean {
    const n1 = this.nextEdge[c]!;
    if (n1 < 0) return true;
    const e1 = this.net.edges[n1]!;
    const out = e1.kind === EDGE_CONNECTOR ? e1.next[0]! : -1;
    if (out < 0) return true;
    const t = this.tail[out]!;
    if (t < 0) return true;
    return this.s[t]! - this.len(t) > this.len(c) + 3;
  }

  /** Gap (m) to whatever car c must not hit next, and that obstacle's speed → this.q[0], this.q[1]. */
  private leader(c: number): void {
    const e = this.edge[c]!;
    const edge = this.net.edges[e]!;
    const s = this.s[c]!;
    let gap = Infinity;
    let lv = 0;
    const a = this.ahead[c]!;
    if (a >= 0) {
      gap = this.s[a]! - this.len(a) - s;
      lv = this.v[a]!;
    } else {
      const dEnd = edge.length - s;
      if (edge.kind === EDGE_LANE && !this.mayEnter(c, e, dEnd)) {
        gap = dEnd - 0.4;
        lv = 0;
      } else {
        const n1 = this.nextEdge[c]!;
        if (n1 >= 0) {
          const t1 = this.tail[n1]!;
          if (t1 >= 0) {
            gap = dEnd + this.s[t1]! - this.len(t1);
            lv = this.v[t1]!;
          } else {
            const e1 = this.net.edges[n1]!;
            const n2 = e1.kind === EDGE_CONNECTOR ? e1.next[0]! : this.firstNext(n1);
            if (n2 >= 0 && dEnd + e1.length < 90) {
              const t2 = this.tail[n2]!;
              if (t2 >= 0) {
                gap = dEnd + e1.length + this.s[t2]! - this.len(t2);
                lv = this.v[t2]!;
              }
            }
          }
          // siblings: the last car that left this lane onto another connector
          if (edge.kind === EDGE_LANE) {
            const x = this.lastExit[e]!;
            if (x >= 0 && x !== c && this.edge[x] !== n1) {
              const r = this.groupRear(x, e);
              if (r < GROUP_CLEAR && dEnd + r < gap) {
                gap = dEnd + r;
                lv = this.v[x]!;
              }
            }
          }
        }
      }
    }
    // on a connector: the car that left the same lane just before us, if it took another connector
    if (edge.kind === EDGE_CONNECTOR) {
      const x = this.groupAhead[c]!;
      if (x >= 0 && this.edge[x] !== e) {
        const r = this.groupRear(x, edge.from);
        if (r < GROUP_CLEAR + 4 && r - s < gap) {
          gap = r - s;
          lv = this.v[x]!;
        }
      }
    }
    // the drone hovering low over the road ahead
    if (this.fAgl < DRONE_BLOCK_AGL) {
      const yawc = this.yaw[c]!;
      const hx = this.vx[c]!;
      const hz = this.vz[c]!;
      const sp = Math.sqrt(hx * hx + hz * hz);
      // heading from the pose (velocity may be 0 when stopped): reuse the last pose's front direction
      const L = this.len(c);
      const fxc = this.x[c]! + (sp > 0.1 ? (hx / sp) * L * 0.5 : 0);
      const fzc = this.z[c]! + (sp > 0.1 ? (hz / sp) * L * 0.5 : 0);
      if (sp > 0.1 || yawc !== 0) {
        const ux = sp > 0.1 ? hx / sp : 0;
        const uz = sp > 0.1 ? hz / sp : 1;
        const dx = this.fx - fxc;
        const dz = this.fz - fzc;
        const along = dx * ux + dz * uz;
        const lat = Math.abs(-dx * uz + dz * ux);
        if (along > -0.5 && along < DRONE_LOOKAHEAD && lat < VEHICLES[this.type[c]!]!.width / 2 + 1.1) {
          const g = along - 0.8;
          if (g < gap) {
            gap = g;
            lv = 0;
          }
        }
      }
    }
    this.q[0] = gap;
    this.q[1] = lv;
  }

  private firstNext(e: number): number {
    const edge = this.net.edges[e]!;
    return edge.next.length > 0 ? edge.next[0]! : -1;
  }

  private step(h: number): void {
    this.time += h;
    // accelerations from the current state (all cars see the same snapshot)
    for (let c = 0; c < this.capacity; c++) {
      if (!this.alive[c]) continue;
      const spec = VEHICLES[this.type[c]!]!;
      const edge = this.net.edges[this.edge[c]!]!;
      const v = this.v[c]!;
      const v0 = Math.min(spec.v0, edge.limit);
      this.leader(c);
      const gap = this.q[0]!;
      const lv = this.q[1]!;
      const r = v / v0;
      const r2 = r * r;
      let acc = spec.accel * (1 - r2 * r2);
      if (gap < 200) {
        const ab = Math.sqrt(spec.accel * spec.decel);
        const sStar = STANDSTILL_GAP + Math.max(0, v * spec.headway + (v * (v - lv)) / (2 * ab));
        const g = Math.max(gap, 0.05);
        const k = sStar / g;
        acc -= spec.accel * k * k;
      }
      // brakes have limits
      if (acc < -9) acc = -9;
      const prevAcc = this.acc[c]!;
      this.acc[c] = acc;
      if (acc < -HORN_DECEL && prevAcc > -HORN_DECEL && this.fAgl < DRONE_BLOCK_AGL && this.time - this.horn[c]! > HORN_COOLDOWN) {
        const dx = this.x[c]! - this.fx;
        const dz = this.z[c]! - this.fz;
        if (dx * dx + dz * dz < 45 * 45) {
          this.horn[c] = this.time;
          this.event(0, this.x[c]!, this.y[c]! + 1, this.z[c]!);
        }
      }
      let f = this.flags[c]! & ~(CAR_FLAG.brake | CAR_FLAG.stopped);
      if (acc < -0.6 || (v < 0.3 && gap < 12)) f |= CAR_FLAG.brake;
      if (v < 0.05) f |= CAR_FLAG.stopped;
      this.flags[c] = f;
      // remember the hard limit: never past the obstacle (keeps cars from overlapping when the IDM overshoots)
      this.limit[c] = gap;
    }
    // integrate, front to back within an edge does not matter: every move is clamped by the snapshot gap
    for (let c = 0; c < this.capacity; c++) {
      if (!this.alive[c]) continue;
      let v = this.v[c]! + this.acc[c]! * h;
      if (v < 0) v = 0;
      let ds = v * h;
      const lim = this.limit[c]!;
      if (ds > lim - 0.02) {
        ds = Math.max(0, lim - 0.02);
        if (lim < 1) {
          v = 0;
          this.clamps++;
        }
      }
      this.v[c] = v;
      this.advance(c, ds);
    }
  }

  /** Frees the intersection car c occupies. */
  private release(c: number): void {
    const k = this.occNode[c]!;
    if (k < 0) return;
    this.occ[k]!--;
    if (this.occIsLeft[c]) this.occLeft[k]!--;
    this.occNode[c] = -1;
    this.occIsLeft[c] = 0;
    this.flags[c] &= ~CAR_FLAG.occupying;
  }

  /** Moves car c forward by ds, crossing onto the next edges as needed. */
  private advance(c: number, ds: number): void {
    let s = this.s[c]! + ds;
    let e = this.edge[c]!;
    let edge = this.net.edges[e]!;
    while (s >= edge.length) {
      const n = this.nextEdge[c]!;
      if (n < 0) {
        // dead end (rural road ends): the car leaves the simulation
        this.remove(c);
        return;
      }
      // leaving a lane into a connector: the signal and the box must allow it now (cars ahead in this same step
      // may just have taken the box); otherwise the car waits on its stop line
      if (edge.kind === EDGE_LANE && edge.node >= 0 && this.signals) {
        const st = this.signals.state(edge.node, edge.approach, this.time);
        const committed = (this.flags[c]! & CAR_FLAG.committed) !== 0;
        if ((st === SIGNAL.red && !committed) || !this.boxClear(c, edge)) {
          if (st === SIGNAL.red && !committed) this.redRuns++;
          s = edge.length - 0.01;
          this.v[c] = 0;
          // stopped on the line: a yellow commitment is void (it would carry the car through the red later)
          this.flags[c] &= ~CAR_FLAG.committed;
          this.clamps++;
          break;
        }
        this.release(c);
        const k = edge.node * 4 + edge.approach;
        this.occ[k]!++;
        this.occNode[c] = k;
        if (this.net.edges[n]!.turn === TURN.left) {
          this.occLeft[k]!++;
          this.occIsLeft[c] = 1;
        }
        this.flags[c] |= CAR_FLAG.occupying;
      }
      s -= edge.length;
      if (edge.kind === EDGE_LANE) {
        this.groupAhead[c] = this.lastExit[e]!;
        this.lastExit[e] = c;
      }
      this.unlink(c, e);
      this.prevEdge[c] = e;
      e = n;
      edge = this.net.edges[e]!;
      this.edge[c] = e;
      this.hint[c] = 0;
      this.append(c, e);
      this.flags[c] &= ~CAR_FLAG.committed;
      this.nextEdge[c] = this.chooseNext(e);
    }
    this.s[c] = s;
    // the whole car has left the box: release it
    if (this.occNode[c]! >= 0 && edge.kind === EDGE_LANE && s >= this.len(c)) this.release(c);
  }

  // ---------------------------------------------------------------- poses

  private poses(): void {
    for (let c = 0; c < this.capacity; c++) if (this.alive[c]) this.pose(c);
  }

  private pose(c: number): void {
    const e = this.net.edges[this.edge[c]!]!;
    const s = this.s[c]!;
    const L = this.len(c);
    this.hint[c] = pointAt(e, s, this.p, this.hint[c]!);
    const rs = s - L;
    if (rs >= 0 || this.prevEdge[c]! < 0) pointAt(e, rs, this.q);
    else {
      const pe = this.net.edges[this.prevEdge[c]!]!;
      pointAt(pe, pe.length + rs, this.q);
    }
    let dx = this.p[0]! - this.q[0]!;
    let dz = this.p[2]! - this.q[2]!;
    const l = Math.sqrt(dx * dx + dz * dz);
    if (l < 1e-6) {
      // spawned with the rear clamped to the edge start: use the edge direction
      pointAt(e, s + 1, this.q);
      dx = this.q[0]! - this.p[0]!;
      dz = this.q[2]! - this.p[2]!;
      const l2 = Math.sqrt(dx * dx + dz * dz) || 1;
      dx /= l2;
      dz /= l2;
      this.x[c] = this.p[0]! - dx * L * 0.5;
      this.z[c] = this.p[2]! - dz * L * 0.5;
    } else {
      dx /= l;
      dz /= l;
      this.x[c] = (this.p[0]! + this.q[0]!) * 0.5;
      this.z[c] = (this.p[2]! + this.q[2]!) * 0.5;
    }
    this.y[c] = (this.p[1]! + this.q[1]!) * 0.5;
    this.yaw[c] = datan2(dx, dz);
    const v = this.v[c]!;
    this.vx[c] = dx * v;
    this.vz[c] = dz * v;
  }

  // ---------------------------------------------------------------- consumers

  /** Kinematic colliders (oriented boxes moving at the car's velocity) overlapping the box [min, max]. */
  queryMovers(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, out: MoverCollider[]): number {
    let n = 0;
    for (let c = 0; c < this.capacity; c++) {
      if (!this.alive[c]) continue;
      if (this.noCollide && this.noCollide[this.edge[c]!]) continue;
      const spec = VEHICLES[this.type[c]!]!;
      const b = spec.length * 0.5 + 0.2;
      const x = this.x[c]!;
      const z = this.z[c]!;
      const y = this.y[c]!;
      if (x + b < minX || x - b > maxX || z + b < minZ || z - b > maxZ || y > maxY || y + spec.height < minY) continue;
      const m = this.movers[c]!;
      const sh = m.shape;
      sh.center[0] = x;
      sh.center[1] = y + spec.height * 0.5;
      sh.center[2] = z;
      sh.half[0] = spec.width * 0.5;
      sh.half[1] = spec.height * 0.5;
      sh.half[2] = spec.length * 0.5;
      sh.yaw = this.yaw[c]!;
      m.bound = Math.sqrt(sh.half[0] * sh.half[0] + sh.half[1] * sh.half[1] + sh.half[2] * sh.half[2]);
      m.velocity[0] = this.vx[c]!;
      m.velocity[1] = 0;
      m.velocity[2] = this.vz[c]!;
      if (n < out.length) out[n] = m;
      else out.push(m);
      n++;
    }
    return n;
  }

  /**
   * The `max` cars nearest to (x, y, z) into `out` (objects reused; the array grows once), nearest first.
   * Returns how many were written. For spatial audio (engine hum, tyre noise, brakes).
   */
  nearestEmitters(x: number, y: number, z: number, max: number, out: TrafficEmitter[]): number {
    let n = 0;
    for (let c = 0; c < this.capacity; c++) {
      if (!this.alive[c]) continue;
      const dx = this.x[c]! - x;
      const dy = this.y[c]! - y;
      const dz = this.z[c]! - z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (n === max && d >= out[n - 1]!.distance) continue;
      // insertion into the sorted prefix
      let i = n < max ? n++ : n - 1;
      while (out.length <= i) out.push({ x: 0, y: 0, z: 0, vx: 0, vz: 0, speed: 0, type: 0, braking: false, distance: 0 });
      const slot = out[i]!;
      while (i > 0 && out[i - 1]!.distance > d) {
        out[i] = out[i - 1]!;
        i--;
      }
      out[i] = slot;
      slot.x = this.x[c]!;
      slot.y = this.y[c]!;
      slot.z = this.z[c]!;
      slot.vx = this.vx[c]!;
      slot.vz = this.vz[c]!;
      slot.speed = this.v[c]!;
      slot.type = this.type[c]!;
      slot.braking = (this.flags[c]! & CAR_FLAG.brake) !== 0;
      slot.distance = d;
    }
    return n;
  }

  private event(type: number, x: number, y: number, z: number): void {
    const i = this.evCount % MAX_EVENTS;
    this.evType[i] = type;
    this.evPos[i * 3] = x;
    this.evPos[i * 3 + 1] = y;
    this.evPos[i * 3 + 2] = z;
    this.evCount++;
  }

  /** Hands every event since the last drain to `fn` (type, position) and clears them. */
  drainEvents(fn: (type: TrafficEventType, x: number, y: number, z: number) => void): void {
    const n = Math.min(this.evCount, MAX_EVENTS);
    const start = this.evCount - n;
    for (let k = start; k < this.evCount; k++) {
      const i = k % MAX_EVENTS;
      fn('horn', this.evPos[i * 3]!, this.evPos[i * 3 + 1]!, this.evPos[i * 3 + 2]!);
    }
    this.evCount = 0;
  }

  /** Cars per vehicle type alive now (tests, stats). */
  countByType(out: Int32Array = new Int32Array(VEHICLE_TYPES)): Int32Array {
    out.fill(0);
    for (let c = 0; c < this.capacity; c++) if (this.alive[c]) out[this.type[c]!]!++;
    return out;
  }
}

/** Oriented-box overlap of two cars in the ground plane (separating axis test), for tests and checks. */
export function carsOverlap(sim: TrafficSim, a: number, b: number, margin = 0): boolean {
  const sa = VEHICLES[sim.type[a]!]!;
  const sb = VEHICLES[sim.type[b]!]!;
  const ax = sim.x[a]!;
  const az = sim.z[a]!;
  const bx = sim.x[b]!;
  const bz = sim.z[b]!;
  const dx = bx - ax;
  const dz = bz - az;
  const ra = Math.sqrt(sa.length * sa.length + sa.width * sa.width) / 2;
  const rb = Math.sqrt(sb.length * sb.length + sb.width * sb.width) / 2;
  if (dx * dx + dz * dz > (ra + rb) * (ra + rb)) return false;
  // axes: each box's forward (sin yaw, cos yaw) and right
  const axes: [number, number][] = [];
  for (const [yaw] of [[sim.yaw[a]!], [sim.yaw[b]!]]) {
    const fx = dsin(yaw!);
    const fz = dcos(yaw!);
    axes.push([fx, fz], [fz, -fx]);
  }
  const fa = [dsin(sim.yaw[a]!), dcos(sim.yaw[a]!)];
  const fb = [dsin(sim.yaw[b]!), dcos(sim.yaw[b]!)];
  for (const [ux, uz] of axes) {
    const pa = (sa.length / 2) * Math.abs(fa[0]! * ux + fa[1]! * uz) + (sa.width / 2) * Math.abs(fa[1]! * ux - fa[0]! * uz);
    const pb = (sb.length / 2) * Math.abs(fb[0]! * ux + fb[1]! * uz) + (sb.width / 2) * Math.abs(fb[1]! * ux - fb[0]! * uz);
    if (Math.abs(dx * ux + dz * uz) > pa + pb - margin) return false;
  }
  return true;
}
