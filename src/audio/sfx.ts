/**
 * One-shot playback through pooled voices. A voice is a gain (and, for positional voices, a PannerNode)
 * that lives as long as the engine; a hit only adds one AudioBufferSourceNode, which disconnects itself
 * when it ends. The oldest voice is stolen when the pool is busy.
 */
import { placePanner, type NodeStats, type Scope } from './graph';
import type { SfxId } from './sfx-bank';

interface Voice {
  gain: GainNode;
  panner: PannerNode | null;
  src: AudioBufferSourceNode | null;
  started: number;
}

export class VoicePool {
  private readonly voices: Voice[] = [];
  private next = 0;

  constructor(
    private readonly scope: Scope,
    out: AudioNode,
    size: number,
    positional: PanningModelType | null,
    ref = 2,
    send?: { node: AudioNode; amount: number },
  ) {
    for (let i = 0; i < size; i++) {
      const gain = scope.gain(0);
      let panner: PannerNode | null = null;
      if (positional) {
        panner = scope.panner(positional, ref, 1, 4000);
        gain.connect(panner).connect(out);
        if (send) panner.connect(scope.gain(send.amount)).connect(send.node);
      } else {
        gain.connect(out);
        if (send) gain.connect(scope.gain(send.amount)).connect(send.node);
      }
      this.voices.push({ gain, panner, src: null, started: 0 });
    }
  }

  get stats(): NodeStats {
    return this.scope.stats;
  }

  /** Voices still playing (diagnostics). */
  get busy(): number {
    return this.voices.filter((v) => v.src).length;
  }

  play(buffer: AudioBuffer, gain: number, rate = 1, when = 0, x?: number, y?: number, z?: number): void {
    const ctx = this.scope.ctx;
    const now = ctx.currentTime;
    // a free voice, else the oldest
    let v = this.voices.find((x) => !x.src);
    if (!v) {
      v = this.voices[this.next]!;
      this.next = (this.next + 1) % this.voices.length;
      this.release(v);
    }
    const src = ctx.createBufferSource();
    this.stats.created++;
    src.buffer = buffer;
    src.playbackRate.value = rate;
    v.gain.gain.cancelScheduledValues(now);
    v.gain.gain.setValueAtTime(gain, Math.max(now, when));
    if (v.panner && x !== undefined) placePanner(v.panner, x, y ?? 0, z ?? 0, now, 0.001);
    src.connect(v.gain);
    v.src = src;
    v.started = now;
    const voice = v;
    src.onended = () => {
      if (voice.src === src) this.release(voice);
    };
    src.start(Math.max(now, when));
  }

  private release(v: Voice): void {
    const s = v.src;
    if (!s) return;
    v.src = null;
    s.onended = null;
    try {
      s.stop();
    } catch {
      /* not started / already ended */
    }
    s.disconnect();
    this.stats.released++;
  }

  stopAll(): void {
    for (const v of this.voices) this.release(v);
  }
}

/** Effects bank lookup + the pools that play it. */
export class SfxPlayer {
  constructor(
    private readonly bank: Map<SfxId, AudioBuffer>,
    private readonly pools: { world: VoicePool; sfx: VoicePool; ui: VoicePool; voice: VoicePool },
  ) {}

  has(id: SfxId): boolean {
    return this.bank.has(id);
  }

  /** Positional effect at (x, y, z) on the effects bus. */
  at(id: SfxId, x: number, y: number, z: number, gain = 1, rate = 1, when = 0): void {
    const b = this.bank.get(id);
    if (b) this.pools.world.play(b, gain, rate, when, x, y, z);
  }

  /** Non-positional effect on a bus. */
  play(id: SfxId, bus: 'sfx' | 'ui' | 'voice', gain = 1, rate = 1, when = 0): void {
    const b = this.bank.get(id);
    if (b) this.pools[bus].play(b, gain, rate, when);
  }

  stopAll(): void {
    for (const p of Object.values(this.pools)) p.stopAll();
  }
}
