/**
 * Live music playback: the current song's stems loop in phase, each through its own layer gain, plus the
 * song's hall ("space", rendered once from all stems) following the layers that feed it. Songs crossfade on
 * a level change. Stems render on first use (render.ts), progressively, and the last two songs stay cached.
 */
import { glide, Scope, type NodeStats } from '../graph';
import { fromDb } from '../mix';
import { musicMix, type MusicMix } from './director';
import { renderSpace, renderStem, spaceSend, stemFormat, type OfflineFactory } from './render';
import { STEMS, type Song, type StemName } from './songs';

export type Layer = StemName | 'space';
/** Render order: what the menu needs first; the hall last (it is made from the others). */
const RENDER_ORDER: readonly StemName[] = ['pad', 'arp', 'bass', 'beat', 'perc', 'lead'];
/** songs kept rendered: the current one and the last (lite: the current one only) */
const CACHE = { full: 2, lite: 1 };
const XFADE = 1.6;

/** Hall level for a layer mix: the send-weighted average of the layers that feed it. */
export function spaceLevel(song: Song, layers: Record<StemName, number>): number {
  let num = 0;
  let den = 0;
  for (const s of STEMS) {
    const w = spaceSend(s, song.space.reverb);
    num += w * layers[s];
    den += w;
  }
  return den > 0 ? num / den : 0;
}

interface Playing {
  song: Song;
  scope: Scope;
  out: GainNode;
  layers: Partial<Record<Layer, GainNode>>;
  t0: number;
  loop: number;
  /** ctx time after which the faded-out scope is disposed (Infinity while current) */
  disposeAt: number;
}

export class MusicPlayer {
  private readonly cache = new Map<string, Partial<Record<Layer, AudioBuffer>>>();
  private readonly rendering = new Map<string, Promise<void>>();
  private current: Playing | null = null;
  private fading: Playing[] = [];
  private mix: MusicMix = musicMix('menu');
  private enabled = true;
  private wanted: Song | null = null;
  private readonly filter: BiquadFilterNode;
  private readonly level: GainNode;
  /** stems finished rendering (diagnostics) */
  rendered = 0;

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly stats: NodeStats,
    root: Scope,
    out: AudioNode,
    private readonly offline: OfflineFactory | null,
    private lite: boolean,
  ) {
    this.filter = root.filter('lowpass', 18000, 0.5);
    this.level = root.gain(1);
    this.filter.connect(this.level).connect(out);
  }

  /** the song asked for (playing or still rendering) */
  get song(): Song | null {
    return this.wanted;
  }

  get playing(): boolean {
    return this.current !== null;
  }

  /** Music level gain and low-pass cutoff now (pause muffles: both drop). */
  get output(): { level: number; cutoff: number } {
    return { level: this.level.gain.value, cutoff: this.filter.frequency.value };
  }

  /** Layers of the playing song (diagnostics). */
  get layerCount(): number {
    return this.current ? Object.keys(this.current.layers).length : 0;
  }

  setLite(lite: boolean): void {
    if (lite === this.lite) return;
    this.lite = lite;
    this.cache.clear();
  }

  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    if (!on) this.stop();
    else if (this.wanted) {
      const w = this.wanted;
      this.wanted = null;
      this.setSong(w);
    }
  }

  /** Crossfades to `song` (renders its stems first when they are not cached). */
  setSong(song: Song): void {
    if (this.wanted?.id === song.id && (this.current?.song.id === song.id || this.rendering.has(song.id))) return;
    this.wanted = song;
    if (!this.enabled || !this.offline) return;
    this.fadeOutCurrent();
    void this.ensure(song);
  }

  setMix(mix: MusicMix): void {
    this.mix = mix;
    const now = this.ctx.currentTime;
    glide(this.filter.frequency, mix.cutoff, now, mix.glide * 0.5);
    glide(this.level.gain, fromDb(mix.gainDb), now, mix.glide);
    const p = this.current;
    if (!p) return;
    for (const s of STEMS) {
      const g = p.layers[s];
      if (g) glide(g.gain, mix.layers[s], now, mix.glide);
    }
    if (p.layers.space) glide(p.layers.space.gain, spaceLevel(p.song, mix.layers), now, mix.glide);
  }

  /** Housekeeping from the frame update: disposes songs that finished fading out (`force`: all of them). */
  tick(force = false): void {
    if (!this.fading.length) return;
    const now = force ? Infinity : this.ctx.currentTime;
    this.fading = this.fading.filter((p) => {
      if (now < p.disposeAt) return true;
      p.scope.dispose();
      return false;
    });
  }

  stop(): void {
    this.fadeOutCurrent();
  }

  dispose(): void {
    this.current?.scope.dispose();
    this.current = null;
    for (const p of this.fading) p.scope.dispose();
    this.fading = [];
  }

  /** Songs owning nodes: playing + fading out (leak checks). */
  get liveSongs(): number {
    return (this.current ? 1 : 0) + this.fading.length;
  }

  private fadeOutCurrent(): void {
    const p = this.current;
    if (!p) return;
    this.current = null;
    const now = this.ctx.currentTime;
    glide(p.out.gain, 0, now, XFADE / 4);
    p.disposeAt = now + XFADE;
    this.fading.push(p);
  }

  private ensure(song: Song): Promise<void> {
    let stems = this.cache.get(song.id);
    if (!stems) {
      stems = {};
      this.cache.set(song.id, stems);
      while (this.cache.size > (this.lite ? CACHE.lite : CACHE.full)) this.cache.delete(this.cache.keys().next().value!);
    }
    if (stems.space) {
      this.start(song, stems);
      return Promise.resolve();
    }
    const pending = this.rendering.get(song.id);
    if (pending) return pending;
    const job = this.renderAll(song, stems).finally(() => this.rendering.delete(song.id));
    this.rendering.set(song.id, job);
    return job;
  }

  private async renderAll(song: Song, stems: Partial<Record<Layer, AudioBuffer>>): Promise<void> {
    for (const name of [...RENDER_ORDER, 'space' as const]) {
      if (!stems[name]) {
        const fmt = stemFormat(this.lite, name);
        try {
          stems[name] = name === 'space' ? await renderSpace(song, stems, fmt, this.offline!) : await renderStem(song, name, fmt, this.offline!);
          this.rendered++;
        } catch (err) {
          console.warn('Music stem render failed', song.id, name, err);
          return;
        }
      }
      // start as soon as the pad exists; later stems join in phase
      if (this.wanted?.id !== song.id || !this.enabled) return;
      if (!this.current || this.current.song.id !== song.id) this.start(song, stems);
      else this.addLayer(this.current, name, stems[name]!);
    }
  }

  private start(song: Song, stems: Partial<Record<Layer, AudioBuffer>>): void {
    if (this.wanted?.id !== song.id || !this.enabled || !stems.pad) return;
    if (this.current?.song.id === song.id) return;
    this.fadeOutCurrent();
    const scope = new Scope(this.ctx, this.stats);
    const out = scope.gain(0);
    out.connect(this.filter);
    const p: Playing = { song, scope, out, layers: {}, t0: this.ctx.currentTime + 0.06, loop: stems.pad.duration, disposeAt: Infinity };
    this.current = p;
    for (const s of [...STEMS, 'space' as const]) if (stems[s]) this.addLayer(p, s, stems[s]);
    glide(out.gain, 1, this.ctx.currentTime, XFADE / 4);
  }

  private addLayer(p: Playing, name: Layer, buf: AudioBuffer): void {
    if (p.layers[name]) return;
    const g = p.scope.gain(0);
    g.connect(p.out);
    const src = p.scope.source(buf);
    src.loop = true;
    src.connect(g);
    const now = this.ctx.currentTime;
    const when = Math.max(now + 0.03, p.t0);
    src.start(when, (when - p.t0) % p.loop);
    p.layers[name] = g;
    const target = name === 'space' ? spaceLevel(p.song, this.mix.layers) : this.mix.layers[name];
    glide(g.gain, target, when, Math.max(0.3, this.mix.glide));
  }
}
