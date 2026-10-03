/**
 * A WebAudio stand-in for Node: records every node, connection and parameter move, renders nothing.
 * Parameter automation lands immediately (a glide's target becomes the value), which is what the mix tests
 * read. `endSources()` fires `onended` on every started one-shot (real contexts do it asynchronously).
 */

export class FakeParam {
  private v: number;
  /** a plain `.value` write is recorded as a 'set' (what browsers do) */
  get value(): number {
    return this.v;
  }
  set value(x: number) {
    this.v = x;
    this.calls.push({ kind: 'set', value: x, time: -1 });
    if (this.calls.length > 64) this.calls.shift();
  }
  /** every automation call, newest last */
  readonly calls: { kind: string; value: number; time: number }[] = [];
  constructor(v = 0) {
    this.v = v;
  }
  private rec(kind: string, value: number, time: number): this {
    this.calls.push({ kind, value, time });
    if (this.calls.length > 64) this.calls.shift();
    return this;
  }
  setValueAtTime(v: number, t: number): this {
    this.v = v;
    return this.rec('set', v, t);
  }
  linearRampToValueAtTime(v: number, t: number): this {
    this.v = v;
    return this.rec('linear', v, t);
  }
  exponentialRampToValueAtTime(v: number, t: number): this {
    this.v = v;
    return this.rec('exp', v, t);
  }
  setTargetAtTime(v: number, t: number, _tc: number): this {
    if (!Number.isFinite(v)) throw new TypeError('non-finite target');
    this.v = v;
    return this.rec('target', v, t);
  }
  cancelScheduledValues(t: number): this {
    return this.rec('cancel', 0, t);
  }
  setValueCurveAtTime(c: ArrayLike<number>, t: number): this {
    this.v = c[c.length - 1] ?? this.v;
    return this.rec('curve', this.v, t);
  }
}

let nextId = 1;

export class FakeNode {
  readonly id = nextId++;
  readonly outputs = new Set<FakeNode | FakeParam>();
  disconnected = false;
  /** released by its owner (a parameterless disconnect): nothing should still feed it */
  released = false;
  constructor(
    readonly ctx: FakeContext,
    readonly kind: string,
  ) {
    ctx.nodes.push(this);
  }
  connect<T extends FakeNode | FakeParam>(dest: T): T {
    if (this.ctx.closed) throw new Error('context closed');
    this.outputs.add(dest);
    this.disconnected = false;
    return dest;
  }
  disconnect(dest?: FakeNode | FakeParam): void {
    if (dest) {
      this.outputs.delete(dest);
      return;
    }
    this.outputs.clear();
    this.disconnected = true;
    this.released = true;
  }
}

class FakeScheduled extends FakeNode {
  started = false;
  stopped = false;
  onended: (() => void) | null = null;
  start(): void {
    if (this.started) throw new Error('InvalidStateError: start twice');
    this.started = true;
    this.ctx.started.add(this);
  }
  stop(): void {
    if (!this.started) throw new Error('InvalidStateError: stop before start');
    this.stopped = true;
  }
}

export class FakeBuffer {
  private readonly data: Float32Array[];
  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  get duration(): number {
    return this.length / this.sampleRate;
  }
  getChannelData(c: number): Float32Array {
    return this.data[c]!;
  }
  copyToChannel(src: Float32Array, c: number): void {
    this.data[c]!.set(src.subarray(0, this.length));
  }
}

const P = (v = 0): FakeParam => new FakeParam(v);

export class FakeContext {
  readonly nodes: FakeNode[] = [];
  readonly started = new Set<FakeScheduled>();
  currentTime = 0;
  state: 'running' | 'suspended' | 'closed' = 'running';
  closed = false;
  readonly destination: FakeNode;
  readonly listener = { positionX: P(), positionY: P(), positionZ: P(), forwardX: P(), forwardY: P(), forwardZ: P(-1), upX: P(), upY: P(1), upZ: P() };
  /** OfflineAudioContext role: length / channels of the render */
  constructor(
    readonly sampleRate = 48000,
    readonly offline: { channels: number; length: number } | null = null,
  ) {
    this.destination = new FakeNode(this, 'destination');
  }
  async resume(): Promise<void> {
    this.state = 'running';
  }
  async suspend(): Promise<void> {
    this.state = 'suspended';
  }
  async close(): Promise<void> {
    this.state = 'closed';
    this.closed = true;
  }
  addEventListener(): void {}
  async startRendering(): Promise<FakeBuffer> {
    const o = this.offline ?? { channels: 2, length: 128 };
    const b = new FakeBuffer(o.channels, o.length, this.sampleRate);
    // a little signal so normalisers have something to measure
    for (let c = 0; c < o.channels; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < d.length; i += 64) d[i] = 0.1;
    }
    return b;
  }
  createGain() {
    return Object.assign(new FakeNode(this, 'gain'), { gain: P(1) });
  }
  createBiquadFilter() {
    return Object.assign(new FakeNode(this, 'biquad'), { type: 'lowpass', frequency: P(350), Q: P(1), gain: P(), detune: P() });
  }
  createOscillator() {
    return Object.assign(new FakeScheduled(this, 'osc'), { type: 'sine', frequency: P(440), detune: P(), setPeriodicWave() {} });
  }
  createBufferSource() {
    return Object.assign(new FakeScheduled(this, 'buffer'), { buffer: null as FakeBuffer | null, loop: false, loopStart: 0, loopEnd: 0, playbackRate: P(1), detune: P() });
  }
  createPanner() {
    return Object.assign(new FakeNode(this, 'panner'), {
      panningModel: 'equalpower',
      distanceModel: 'inverse',
      refDistance: 1,
      rolloffFactor: 1,
      maxDistance: 10000,
      positionX: P(),
      positionY: P(),
      positionZ: P(),
      orientationX: P(1),
      orientationY: P(),
      orientationZ: P(),
    });
  }
  createStereoPanner() {
    return Object.assign(new FakeNode(this, 'stereo'), { pan: P() });
  }
  createConvolver() {
    return Object.assign(new FakeNode(this, 'convolver'), { buffer: null as FakeBuffer | null, normalize: true });
  }
  createDynamicsCompressor() {
    return Object.assign(new FakeNode(this, 'compressor'), { threshold: P(-24), knee: P(30), ratio: P(12), attack: P(0.003), release: P(0.25), reduction: 0 });
  }
  createWaveShaper() {
    return Object.assign(new FakeNode(this, 'shaper'), { curve: null as Float32Array | null, oversample: 'none' });
  }
  createDelay() {
    return Object.assign(new FakeNode(this, 'delay'), { delayTime: P() });
  }
  createChannelMerger() {
    return new FakeNode(this, 'merger');
  }
  createPeriodicWave() {
    return {};
  }
  createBuffer(channels: number, length: number, sampleRate: number) {
    return new FakeBuffer(channels, length, sampleRate);
  }

  /** Fires onended for every started source (one-shots finishing). */
  endSources(): void {
    for (const s of [...this.started]) {
      this.started.delete(s);
      s.onended?.();
    }
  }

  /** Nodes that still feed something (not disconnected, with outputs), the destination excluded. */
  get connected(): number {
    return this.nodes.filter((n) => n !== this.destination && n.outputs.size > 0).length;
  }

  /** Nodes reachable upstream of the destination (the live graph). */
  /**
   * Connections from a node still in use into a released one: in a real context they keep the released node (and
   * its buffers, its processing) alive.
   */
  edgesIntoReleased(): { from: string; to: string }[] {
    const out: { from: string; to: string }[] = [];
    for (const n of this.nodes) {
      if (n.released) continue;
      for (const o of n.outputs) if (o instanceof FakeNode && o.released) out.push({ from: n.kind, to: o.kind });
    }
    return out;
  }

  liveGraph(): Set<FakeNode> {
    const into = new Map<FakeNode, FakeNode[]>();
    for (const n of this.nodes)
      for (const o of n.outputs)
        if (o instanceof FakeNode) {
          const l = into.get(o) ?? [];
          l.push(n);
          into.set(o, l);
        }
    const seen = new Set<FakeNode>();
    const stack = [this.destination];
    while (stack.length) {
      const n = stack.pop()!;
      for (const up of into.get(n) ?? []) {
        if (seen.has(up)) continue;
        seen.add(up);
        stack.push(up);
      }
    }
    return seen;
  }

  /** Node kinds along the first path from `from` to the destination (routing checks). */
  path(from: FakeNode): string[] {
    const prev = new Map<FakeNode, FakeNode | null>([[from, null]]);
    const queue = [from];
    while (queue.length) {
      const n = queue.shift()!;
      if (n === this.destination) {
        const out: string[] = [];
        for (let c: FakeNode | null = n; c; c = prev.get(c) ?? null) out.unshift(c.kind);
        return out;
      }
      for (const o of n.outputs)
        if (o instanceof FakeNode && !prev.has(o)) {
          prev.set(o, n);
          queue.push(o);
        }
    }
    return [];
  }
}

/** OfflineAudioContext factory over FakeContext (stems / effects "render" instantly). */
export const fakeOffline = (channels: number, length: number, sampleRate: number) => new FakeContext(sampleRate, { channels, length: Math.min(length, 4096) }) as unknown as OfflineAudioContext;
