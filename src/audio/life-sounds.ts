/**
 * The living world's sound (docs/12 §7): the nearest cars as continuous voices (engine hum by speed, tyre noise,
 * a hand-made Doppler shift), wind turbines and the tractor as positional loops, cowbells / bleats near a herd,
 * horns and wing flaps on the hub's events. A fixed pool of voices is built with the level's scope and reassigned
 * every audio update to the nearest sources: no node and no object is created per frame, and the whole set goes
 * with the level (its scope is disposed, its event subscriptions dropped).
 */
import { glide, placePanner, type Scope } from './graph';
import type { NoiseColour } from './dsp';
import { dopplerFactor } from './mix';
import type { SfxId } from './sfx-bank';

/** What the audio needs of a car (TrafficEmitter, docs/12 §7). */
export interface CarSource {
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

/** What the audio needs of an ambient emitter (LifeEmitter, docs/12 §7). */
export interface AmbientSource {
  kind: string;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  speed: number;
  intensity: number;
  variant: number;
  distance: number;
}

/** The level's life hub as the audio sees it (`LevelRuntime.life`). */
export interface LifeHubLike {
  getTrafficEmitters(x: number, y: number, z: number, max: number, out: CarSource[]): number;
  emitters(x: number, y: number, z: number, max: number, out: AmbientSource[]): number;
  on(type: 'horn' | 'flock-scatter', fn: (e: Readonly<{ x: number; y: number; z: number }>) => void): () => void;
}

/** Voice counts per tier: lite (low tier, Quest, phones) and full. */
export const LIFE_VOICES = { lite: { cars: 6, ambient: 2 }, full: { cars: 12, ambient: 4 } } as const;

/** a source keeps its voice while its predicted position stays within this of the voice's (m) */
const MATCH_RADIUS = 6;
/** cowbells / bleats only from a herd this close (m) */
const HERD_RANGE = 80;

/**
 * Pure voice assignment: `slots` voices, each following one source from update to update. Sources arrive nearest
 * first; a source keeps the voice whose last position (moved on by its velocity) is nearest within MATCH_RADIUS,
 * a new source takes a free voice, and a voice whose source is gone falls silent. Allocation-free after
 * construction.
 */
export class SlotAssigner {
  /** source index → voice (valid for the last `assign`'s sources; -1 without one) */
  readonly slotOf: Int32Array;
  /** voice → source index in the last `assign` (-1: silent) */
  readonly sourceOf: Int32Array;
  /** voice was (re)taken by a new source in the last `assign` */
  readonly fresh: Uint8Array;
  private readonly px: Float64Array;
  private readonly py: Float64Array;
  private readonly pz: Float64Array;
  private readonly vx: Float64Array;
  private readonly vz: Float64Array;
  private readonly key: Int32Array;
  private readonly active: Uint8Array;

  constructor(readonly slots: number, private readonly radius = MATCH_RADIUS) {
    this.slotOf = new Int32Array(slots).fill(-1);
    this.sourceOf = new Int32Array(slots).fill(-1);
    this.fresh = new Uint8Array(slots);
    this.px = new Float64Array(slots);
    this.py = new Float64Array(slots);
    this.pz = new Float64Array(slots);
    this.vx = new Float64Array(slots);
    this.vz = new Float64Array(slots);
    this.key = new Int32Array(slots);
    this.active = new Uint8Array(slots);
  }

  /** voices following a source now */
  get busy(): number {
    let n = 0;
    for (let s = 0; s < this.slots; s++) n += this.active[s]!;
    return n;
  }

  /**
   * Assigns the first `n` sources (at most `slots`; `key(i)` = a kind / type that must match to keep a voice)
   * after `dt` seconds. Sources need x, y, z and may carry vx / vz.
   */
  assign(src: readonly { x: number; y: number; z: number; vx?: number; vz?: number }[], n: number, dt: number, key: (i: number) => number = () => 0): void {
    const m = Math.min(n, this.slots);
    const r2 = this.radius * this.radius;
    this.sourceOf.fill(-1);
    this.slotOf.fill(-1);
    this.fresh.fill(0);
    // 1. keep: each source (nearest first) takes the closest active voice it can still be
    for (let i = 0; i < m; i++) {
      const e = src[i]!;
      const k = key(i);
      let best = -1;
      let bd = r2;
      for (let s = 0; s < this.slots; s++) {
        if (!this.active[s] || this.sourceOf[s] !== -1 || this.key[s] !== k) continue;
        const dx = e.x - (this.px[s]! + this.vx[s]! * dt);
        const dy = e.y - this.py[s]!;
        const dz = e.z - (this.pz[s]! + this.vz[s]! * dt);
        const d = dx * dx + dy * dy + dz * dz;
        if (d <= bd) {
          bd = d;
          best = s;
        }
      }
      if (best >= 0) {
        this.slotOf[i] = best;
        this.sourceOf[best] = i;
      }
    }
    // 2. new sources take the free voices (silent ones first, then those whose source is gone)
    for (let i = 0; i < m; i++) {
      if (this.slotOf[i] !== -1) continue;
      let s = -1;
      for (let t = 0; t < this.slots; t++) {
        if (this.sourceOf[t] !== -1) continue;
        if (!this.active[t]) {
          s = t;
          break;
        }
        if (s < 0) s = t;
      }
      if (s < 0) break;
      this.slotOf[i] = s;
      this.sourceOf[s] = i;
      this.fresh[s] = 1;
      this.key[s] = key(i);
    }
    // 3. state for the next update
    for (let s = 0; s < this.slots; s++) {
      const i = this.sourceOf[s]!;
      if (i < 0) {
        this.active[s] = 0;
        continue;
      }
      const e = src[i]!;
      this.active[s] = 1;
      this.px[s] = e.x;
      this.py[s] = e.y;
      this.pz[s] = e.z;
      this.vx[s] = e.vx ?? 0;
      this.vz[s] = e.vz ?? 0;
    }
  }

  /** Level switch: every voice free. */
  clear(): void {
    this.active.fill(0);
    this.sourceOf.fill(-1);
    this.slotOf.fill(-1);
  }
}

/** Doppler factor for a source at (dx, dy, dz) from the listener, moving with (vx, vz) relative to it: >1 approaching. */
export function doppler(dx: number, dy: number, dz: number, vx: number, vz: number): number {
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (d < 1e-3) return 1;
  // radial speed towards the listener (positive when approaching)
  return dopplerFactor(-(dx * vx + dz * vz) / d);
}

/** Engine hum fundamental (Hz) for a car at `speed` m/s of vehicle `type` (bigger types lower). */
export function engineHz(speed: number, type: number): number {
  const base = type === 4 ? 32 : type === 3 || type === 2 ? 38 : 44; // bus / van, SUV / others
  return base + Math.min(30, speed) * 3.1;
}

interface CarVoice {
  osc: OscillatorNode;
  tyre: AudioBufferSourceNode;
  engine: GainNode;
  road: GainNode;
  amp: GainNode;
  panner: PannerNode;
}

interface AmbientVoice {
  src: AudioBufferSourceNode;
  filter: BiquadFilterNode;
  lfo: OscillatorNode;
  depth: GainNode;
  amp: GainNode;
  panner: PannerNode;
}

export interface LifeSoundsDeps {
  scope: Scope;
  /** the level's ambience output (fades with the level, on the ambience bus) */
  out: AudioNode;
  noise: Record<NoiseColour, AudioBuffer>;
  /** a positional one-shot on the ambience bus */
  play: (id: SfxId, x: number, y: number, z: number, gain: number, rate: number) => void;
  lite: boolean;
  model: PanningModelType;
  random: () => number;
}

export class LifeSounds {
  readonly cars: SlotAssigner;
  readonly ambient: SlotAssigner;
  private readonly carVoices: CarVoice[] = [];
  private readonly ambientVoices: AmbientVoice[] = [];
  private readonly carOut: CarSource[] = [];
  private readonly allOut: AmbientSource[] = [];
  private readonly loops: AmbientSource[] = [];
  private readonly off: (() => void)[] = [];
  private nextHerd = 0;
  private lastX = 0;
  private lastZ = 0;
  private now = 0;
  /** last update: voices sounding, for diagnostics / tests */
  readonly last = { cars: 0, ambient: 0, horns: 0, wings: 0 };

  constructor(
    private readonly hub: LifeHubLike,
    private readonly d: LifeSoundsDeps,
  ) {
    const counts = d.lite ? LIFE_VOICES.lite : LIFE_VOICES.full;
    this.cars = new SlotAssigner(counts.cars);
    this.ambient = new SlotAssigner(counts.ambient);
    const s = d.scope;
    for (let i = 0; i < counts.cars; i++) {
      const osc = s.osc('sawtooth', 50);
      const lp = s.filter('lowpass', 520, 0.9);
      const engine = s.gain(0.3);
      const tyre = s.loop(d.noise.pink);
      const bp = s.filter('bandpass', 950, 0.6);
      const road = s.gain(0);
      const amp = s.gain(0);
      const panner = s.panner(d.model, 7, 1.1, 600);
      osc.connect(lp).connect(engine).connect(amp);
      tyre.connect(bp).connect(road).connect(amp);
      amp.connect(panner).connect(d.out);
      osc.start();
      this.carVoices.push({ osc, tyre, engine, road, amp, panner });
    }
    for (let i = 0; i < counts.ambient; i++) {
      const src = s.loop(d.noise.pink);
      const filter = s.filter('bandpass', 400, 0.8);
      const am = s.gain(0.6);
      const lfo = s.osc('sine', 2);
      const depth = s.gain(0.4);
      lfo.connect(depth).connect(am.gain);
      lfo.start();
      const amp = s.gain(0);
      const panner = s.panner(d.model, 12, 1, 900);
      src.connect(filter).connect(am).connect(amp);
      amp.connect(panner).connect(d.out);
      this.ambientVoices.push({ src, filter, lfo, depth, amp, panner });
    }
    this.off.push(
      hub.on('horn', (e) => {
        this.last.horns++;
        d.play(this.d.random() < 0.5 ? 'horn-1' : 'horn-2', e.x, e.y, e.z, 0.75, 0.96 + 0.08 * this.d.random());
      }),
      hub.on('flock-scatter', (e) => {
        this.last.wings++;
        d.play('wings', e.x, e.y, e.z, 0.7, 0.9 + 0.2 * this.d.random());
      }),
    );
  }

  /** One audio update: listener at (lx, ly, lz), `now` the context time, `dt` since the last update. */
  update(lx: number, ly: number, lz: number, now: number, dt: number): void {
    this.now = now;
    // the listener's own motion (camera / drone) for the Doppler shift
    const lvx = dt > 0 ? (lx - this.lastX) / dt : 0;
    const lvz = dt > 0 ? (lz - this.lastZ) / dt : 0;
    this.lastX = lx;
    this.lastZ = lz;
    this.updateCars(lx, ly, lz, lvx, lvz, now, dt);
    this.updateAmbient(lx, ly, lz, now, dt);
  }

  private updateCars(lx: number, ly: number, lz: number, lvx: number, lvz: number, now: number, dt: number): void {
    const out = this.carOut;
    const n = this.hub.getTrafficEmitters(lx, ly, lz, this.cars.slots, out);
    this.cars.assign(out, n, dt, (i) => out[i]!.type);
    let sounding = 0;
    for (let s = 0; s < this.carVoices.length; s++) {
      const v = this.carVoices[s]!;
      const i = this.cars.sourceOf[s]!;
      if (i < 0) {
        glide(v.amp.gain, 0, now, 0.25);
        continue;
      }
      sounding++;
      const c = out[i]!;
      // a voice taken over by another car jumps there silently, then fades in
      if (this.cars.fresh[s]) v.amp.gain.setValueAtTime(0, now);
      placePanner(v.panner, c.x, c.y + 0.6, c.z);
      const f = doppler(c.x - lx, c.y - ly, c.z - lz, c.vx - lvx, c.vz - lvz);
      glide(v.osc.frequency, engineHz(c.speed, c.type) * f, now, 0.08);
      glide(v.tyre.playbackRate, f * (0.85 + Math.min(1, c.speed / 20) * 0.3), now, 0.08);
      const roll = Math.min(1, c.speed / 14);
      glide(v.road.gain, 0.15 + 0.6 * roll + (c.braking ? 0.15 : 0), now, 0.1);
      glide(v.engine.gain, 0.22 + 0.18 * roll, now, 0.1);
      glide(v.amp.gain, 0.35 + 0.35 * roll, now, this.cars.fresh[s] ? 0.3 : 0.1);
    }
    this.last.cars = sounding;
  }

  private updateAmbient(lx: number, ly: number, lz: number, now: number, dt: number): void {
    const all = this.allOut;
    const n = this.hub.emitters(lx, ly, lz, 16, all);
    // continuous loops: turbines and the tractor; a herd near enough rings a bell now and then
    const loops = this.loops;
    let m = 0;
    let herd = -1;
    for (let i = 0; i < n; i++) {
      const e = all[i]!;
      if (e.kind === 'turbine' || e.kind === 'tractor') {
        while (loops.length <= m) loops.push({ kind: '', x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, speed: 0, intensity: 0, variant: 0, distance: 0 });
        Object.assign(loops[m++]!, e);
        if (m === this.ambient.slots) break;
      } else if (e.kind === 'herd' && herd < 0 && e.distance < HERD_RANGE) herd = i;
    }
    this.ambient.assign(loops, m, dt, (i) => (loops[i]!.kind === 'turbine' ? 1 : 2));
    let sounding = 0;
    for (let s = 0; s < this.ambientVoices.length; s++) {
      const v = this.ambientVoices[s]!;
      const i = this.ambient.sourceOf[s]!;
      if (i < 0) {
        glide(v.amp.gain, 0, now, 0.4);
        continue;
      }
      sounding++;
      const e = loops[i]!;
      placePanner(v.panner, e.x, e.y, e.z);
      if (this.ambient.fresh[s]) {
        v.amp.gain.setValueAtTime(0, now);
        if (e.kind === 'turbine') {
          // blade whoosh: a low broad swish pulsing three times a revolution
          v.filter.frequency.setValueAtTime(340, now);
          v.filter.Q.setValueAtTime(0.7, now);
          v.depth.gain.setValueAtTime(0.5, now);
        } else {
          // diesel: a narrow low growl with a fast chug
          v.filter.frequency.setValueAtTime(170, now);
          v.filter.Q.setValueAtTime(2.2, now);
          v.depth.gain.setValueAtTime(0.3, now);
        }
      }
      glide(v.lfo.frequency, e.kind === 'turbine' ? Math.max(0.3, e.speed * 3) : 8 + 4 * e.intensity, now, 0.3);
      glide(v.amp.gain, (e.kind === 'turbine' ? 0.55 : 0.5) * Math.max(0.2, e.intensity), now, this.ambient.fresh[s] ? 0.5 : 0.2);
    }
    this.last.ambient = sounding;
    if (herd >= 0 && now >= this.nextHerd) {
      const e = all[herd]!;
      const r = this.d.random;
      // cows ring bells, sheep (variant 1) bleat; either from somewhere in the herd
      const id = e.variant === 1 ? 'bleat' : r() < 0.5 ? 'cowbell-1' : 'cowbell-2';
      this.d.play(id, e.x + (r() - 0.5) * 8, e.y + 0.8, e.z + (r() - 0.5) * 8, 0.35 + 0.3 * e.intensity, 0.94 + 0.12 * r());
      this.nextHerd = now + 1.5 + 3.5 * r();
    }
  }

  /** Level switch: the voices fall silent and the hub's events are no longer heard (the scope goes with the level). */
  detach(): void {
    for (const f of this.off) f();
    this.off.length = 0;
    this.cars.clear();
    this.ambient.clear();
    for (const v of this.carVoices) glide(v.amp.gain, 0, this.now, 0.05);
    for (const v of this.ambientVoices) glide(v.amp.gain, 0, this.now, 0.05);
  }
}
