/**
 * Node ownership for the audio graph: every node is created through a Scope, which counts it and
 * disconnects (and stops) everything it owns on dispose. Level-lifetime parts (ambience, music stems) live
 * in a scope that is disposed on every level switch, so a switch can never leak nodes.
 */

export interface NodeStats {
  created: number;
  released: number;
}

/** Live node count (created − released). */
export function liveNodes(s: NodeStats): number {
  return s.created - s.released;
}

type Source = AudioScheduledSourceNode;

export class Scope {
  private nodes: AudioNode[] = [];
  private sources = new Set<Source>();
  private disposed = false;
  private cleanups: (() => void)[] = [];

  constructor(
    readonly ctx: BaseAudioContext,
    readonly stats: NodeStats,
  ) {}

  get alive(): boolean {
    return !this.disposed;
  }

  get size(): number {
    return this.nodes.length;
  }

  add<T extends AudioNode>(n: T): T {
    this.nodes.push(n);
    this.stats.created++;
    return n;
  }

  gain(value = 1): GainNode {
    const g = this.add(this.ctx.createGain());
    g.gain.value = value;
    return g;
  }

  filter(type: BiquadFilterType, freq: number, q = 0.707, gainDb = 0): BiquadFilterNode {
    const f = this.add(this.ctx.createBiquadFilter());
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    if (gainDb) f.gain.value = gainDb;
    return f;
  }

  osc(type: OscillatorType, freq: number): OscillatorNode {
    const o = this.add(this.ctx.createOscillator());
    o.type = type;
    o.frequency.value = freq;
    this.sources.add(o);
    return o;
  }

  wave(wave: PeriodicWave, freq: number): OscillatorNode {
    const o = this.add(this.ctx.createOscillator());
    o.setPeriodicWave(wave);
    o.frequency.value = freq;
    this.sources.add(o);
    return o;
  }

  /** A looping buffer player started at a random offset (decorrelates beds sharing one noise buffer). */
  loop(buffer: AudioBuffer, start = true, offset = Math.random() * buffer.duration): AudioBufferSourceNode {
    const s = this.add(this.ctx.createBufferSource());
    s.buffer = buffer;
    s.loop = true;
    this.sources.add(s);
    if (start) s.start(0, offset % buffer.duration);
    return s;
  }

  /** One buffer source owned by the scope (not looping, not started). */
  source(buffer: AudioBuffer): AudioBufferSourceNode {
    const s = this.add(this.ctx.createBufferSource());
    s.buffer = buffer;
    this.sources.add(s);
    return s;
  }

  panner(model: PanningModelType, ref = 1.5, rolloff = 1, max = 2000): PannerNode {
    const p = this.add(this.ctx.createPanner());
    p.panningModel = model;
    p.distanceModel = 'inverse';
    p.refDistance = ref;
    p.rolloffFactor = rolloff;
    p.maxDistance = max;
    return p;
  }

  shaper(curve: Float32Array<ArrayBuffer>): WaveShaperNode {
    const w = this.add(this.ctx.createWaveShaper());
    w.curve = curve;
    w.oversample = 'none';
    return w;
  }

  convolver(ir: AudioBuffer): ConvolverNode {
    const c = this.add(this.ctx.createConvolver());
    c.normalize = false;
    c.buffer = ir;
    return c;
  }

  delay(seconds: number, max = 2): DelayNode {
    const d = this.add(this.ctx.createDelay(max));
    d.delayTime.value = seconds;
    return d;
  }

  /**
   * Runs `fn` when the scope is disposed: for connections from nodes outside the scope into it, which its own
   * disconnects do not cut (a live node feeding a released one keeps it, its buffers and its processing alive).
   */
  onDispose(fn: () => void): void {
    this.cleanups.push(fn);
  }

  /** Stops every source and disconnects every node; the scope cannot be used afterwards. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const fn of this.cleanups) {
      try {
        fn();
      } catch {
        /* already disconnected */
      }
    }
    this.cleanups = [];
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* never started / already stopped */
      }
    }
    for (const n of this.nodes) {
      try {
        n.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    this.stats.released += this.nodes.length;
    this.nodes = [];
    this.sources.clear();
  }
}

/** setTargetAtTime that ignores non-finite targets (a NaN would kill the param for good). */
export function glide(p: AudioParam, value: number, now: number, tc: number): void {
  if (Number.isFinite(value)) p.setTargetAtTime(value, now, tc);
}

/**
 * Moves a PannerNode to (x, y, z). Plain value writes, never ramps: an automated panner position (or
 * listener) switches Chrome's panner to per-sample spatialisation for good — about 8× the cost. Positions
 * update at the frame rate, which is smooth at a 128-sample render quantum.
 */
export function placePanner(p: PannerNode, x: number, y: number, z: number): void {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
  if (p.positionX) {
    p.positionX.value = x;
    p.positionY.value = y;
    p.positionZ.value = z;
  } else {
    (p as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(x, y, z);
  }
}

/** Puts the listener at (x, y, z) facing f with up u (plain writes, see placePanner); legacy fallback. */
export function placeListener(l: AudioListener, x: number, y: number, z: number, fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void {
  if (![x, y, z, fx, fy, fz, ux, uy, uz].every(Number.isFinite)) return;
  if (l.positionX) {
    l.positionX.value = x;
    l.positionY.value = y;
    l.positionZ.value = z;
    l.forwardX.value = fx;
    l.forwardY.value = fy;
    l.forwardZ.value = fz;
    l.upX.value = ux;
    l.upY.value = uy;
    l.upZ.value = uz;
  } else {
    const legacy = l as unknown as { setPosition(x: number, y: number, z: number): void; setOrientation(a: number, b: number, c: number, d: number, e: number, f: number): void };
    legacy.setPosition(x, y, z);
    legacy.setOrientation(fx, fy, fz, ux, uy, uz);
  }
}

/** Soft-clip curve (tanh) for drive stages, normalised to ±1. */
export function softClipCurve(drive: number, n = 1024): Float32Array<ArrayBuffer> {
  const c = new Float32Array(n);
  const k = Math.max(0.01, drive);
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(k * x) / norm;
  }
  return c;
}

/** Output ceiling: unity below `knee`, a tanh shoulder above, never past ±(knee + (1 − knee)·tanh 1). */
export function ceilingCurve(knee = 0.8, n = 2048): Float32Array<ArrayBuffer> {
  const c = new Float32Array(n);
  const room = 1 - knee;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    c[i] = a <= knee ? x : Math.sign(x) * (knee + room * Math.tanh((a - knee) / room));
  }
  return c;
}
