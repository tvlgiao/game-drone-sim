/**
 * A level's ambient life as the rest of the game sees it (docs/12): the moving colliders physics tests every step,
 * the spatial-audio emitters (cars, flocks, turbines, herds, the tractor) and a small event bus (a car honks at the
 * drone, a flock takes off). The level view registers what it animates; physics, audio and tests only read. Pure:
 * no DOM, no three.js, no allocation on the per-frame paths once the output arrays have grown.
 */
import { MoverSet } from './movers';
import type { TrafficSim, TrafficEmitter } from '../traffic/traffic-sim';

export type LifeEmitterKind = 'car' | 'flock' | 'turbine' | 'herd' | 'tractor' | 'smoke' | 'signal';

/** One sound source: where, how fast it moves, how loud it is (0..1, the source's own scale). */
export interface LifeEmitter {
  kind: LifeEmitterKind;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** car: m/s; flock: flap rate; turbine: rotor rev/s */
  speed: number;
  /** 0..1 */
  intensity: number;
  /** car: vehicle type (VEHICLE); others 0 */
  variant: number;
  distance: number;
}

/** Anything that can list its emitters (bird flocks, turbines, …). */
export interface EmitterSource {
  /** appends emitters to `out` from index `n` on; returns the new count */
  collectEmitters(out: LifeEmitter[], n: number): number;
}

export type LifeEventType = 'horn' | 'flock-scatter' | 'flock-land';
export interface LifeEvent {
  type: LifeEventType;
  x: number;
  y: number;
  z: number;
}
type Listener = (e: Readonly<LifeEvent>) => void;

const newEmitter = (): LifeEmitter => ({ kind: 'car', x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, speed: 0, intensity: 0, variant: 0, distance: 0 });

export class LifeHub {
  /** kinematic colliders (PhysicsWorld queries them around the drone every step) */
  readonly movers = new MoverSet();
  private readonly traffic: TrafficSim[] = [];
  private readonly sources: EmitterSource[] = [];
  private readonly listeners: Map<LifeEventType, Listener[]> = new Map();
  private readonly ev: LifeEvent = { type: 'horn', x: 0, y: 0, z: 0 };
  private readonly carScratch: TrafficEmitter[] = [];
  private readonly all: LifeEmitter[] = [];

  /** A traffic simulation joins the level: its cars become colliders and car emitters. */
  addTraffic(sim: TrafficSim): void {
    if (this.traffic.includes(sim)) return;
    this.traffic.push(sim);
    this.movers.add(sim);
  }

  removeTraffic(sim: TrafficSim): void {
    const i = this.traffic.indexOf(sim);
    if (i >= 0) this.traffic.splice(i, 1);
    this.movers.remove(sim);
  }

  addSource(s: EmitterSource): void {
    if (!this.sources.includes(s)) this.sources.push(s);
  }

  removeSource(s: EmitterSource): void {
    const i = this.sources.indexOf(s);
    if (i >= 0) this.sources.splice(i, 1);
  }

  /** the traffic simulations running in this level (City streets, rural roads) */
  get trafficSims(): readonly TrafficSim[] {
    return this.traffic;
  }

  /**
   * Audio hook: the `max` cars nearest to the listener at (x, y, z), nearest first, in `out` (objects reused).
   * Returns the count. Position (car centre), velocity, speed, vehicle type, braking.
   */
  getTrafficEmitters(x: number, y: number, z: number, max: number, out: TrafficEmitter[]): number {
    if (this.traffic.length === 1) return this.traffic[0]!.nearestEmitters(x, y, z, max, out);
    let n = 0;
    for (const sim of this.traffic) {
      const m = sim.nearestEmitters(x, y, z, max, this.carScratch);
      for (let i = 0; i < m; i++) {
        const e = this.carScratch[i]!;
        // merge into the sorted prefix of out
        if (n === max && e.distance >= out[n - 1]!.distance) continue;
        let k = n < max ? n++ : n - 1;
        while (out.length <= k) out.push({ x: 0, y: 0, z: 0, vx: 0, vz: 0, speed: 0, type: 0, braking: false, distance: 0 });
        const slot = out[k]!;
        while (k > 0 && out[k - 1]!.distance > e.distance) {
          out[k] = out[k - 1]!;
          k--;
        }
        out[k] = slot;
        Object.assign(slot, e);
      }
    }
    return n;
  }

  /**
   * Audio hook: every ambient emitter (cars, flocks, turbines, herds, the tractor) nearest to (x, y, z) first, at
   * most `max`, in `out` (objects reused). Returns the count.
   */
  emitters(x: number, y: number, z: number, max: number, out: LifeEmitter[]): number {
    const all = this.all;
    let n = 0;
    for (const sim of this.traffic) {
      const m = sim.nearestEmitters(x, y, z, max, this.carScratch);
      for (let i = 0; i < m; i++) {
        const c = this.carScratch[i]!;
        while (all.length <= n) all.push(newEmitter());
        const e = all[n++]!;
        e.kind = 'car';
        e.x = c.x;
        e.y = c.y;
        e.z = c.z;
        e.vx = c.vx;
        e.vy = 0;
        e.vz = c.vz;
        e.speed = c.speed;
        e.intensity = Math.min(1, 0.25 + c.speed / 14);
        e.variant = c.type;
      }
    }
    for (const s of this.sources) {
      while (all.length < n + 64) all.push(newEmitter());
      n = s.collectEmitters(all, n);
    }
    for (let i = 0; i < n; i++) {
      const e = all[i]!;
      const dx = e.x - x;
      const dy = e.y - y;
      const dz = e.z - z;
      e.distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    // partial selection: the `max` nearest, in order (insertion; n is small)
    let k = 0;
    for (let i = 0; i < n; i++) {
      const e = all[i]!;
      if (k === max && e.distance >= out[k - 1]!.distance) continue;
      let j = k < max ? k++ : k - 1;
      while (out.length <= j) out.push(newEmitter());
      while (j > 0 && out[j - 1]!.distance > e.distance) {
        Object.assign(out[j]!, out[j - 1]!);
        j--;
      }
      Object.assign(out[j]!, e);
    }
    return k;
  }

  /** Subscribe to an ambient event; returns the unsubscribe function. The event object is reused: copy what you keep. */
  on(type: LifeEventType, fn: Listener): () => void {
    let list = this.listeners.get(type);
    if (!list) {
      list = [];
      this.listeners.set(type, list);
    }
    list.push(fn);
    return () => {
      const l = this.listeners.get(type);
      const i = l ? l.indexOf(fn) : -1;
      if (l && i >= 0) l.splice(i, 1);
    };
  }

  emit(type: LifeEventType, x: number, y: number, z: number): void {
    const list = this.listeners.get(type);
    if (!list || list.length === 0) return;
    const e = this.ev;
    e.type = type;
    e.x = x;
    e.y = y;
    e.z = z;
    for (let i = 0; i < list.length; i++) list[i]!(e);
  }

  /** Called by the level view after it ticked the simulations: forwards their events (horns) to listeners. */
  flushTrafficEvents(): void {
    for (const sim of this.traffic) sim.drainEvents(this.forwardHorn);
  }

  private readonly forwardHorn = (_t: string, x: number, y: number, z: number): void => this.emit('horn', x, y, z);

  /** Level switch: nothing registered survives. */
  clear(): void {
    for (const sim of [...this.traffic]) this.removeTraffic(sim);
    this.sources.length = 0;
    this.listeners.clear();
  }
}
