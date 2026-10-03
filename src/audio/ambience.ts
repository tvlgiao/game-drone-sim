/**
 * Level ambience at run time: noise beds (wind, room tone, traffic…), positional loops (fan, neon, windows,
 * tractor, the nearest river), scattered one-shots (birds, horns, cowbells) and the speed rush. Built per
 * level inside its own Scope; reacts to altitude, speed and the world probe.
 */
import { windAt, type AmbienceProfile, type BedDef, type EmitterDef, type EventDef } from './ambience-profiles';
import type { NoiseColour } from './dsp';
import { glide, placePanner, type Scope } from './graph';
import { windRush } from './mix';
import type { AudioProbe, Spot } from './probe';
import type { SfxId } from './sfx-bank';
import type { VoicePool } from './sfx';

export interface AmbienceDeps {
  scope: Scope;
  out: AudioNode;
  noise: Record<NoiseColour, AudioBuffer>;
  bank: Map<SfxId, AudioBuffer>;
  pool: VoicePool;
  model: PanningModelType;
  probe: AudioProbe;
  random?: () => number;
}

export interface AmbienceFrame {
  /** listener */
  lx: number;
  ly: number;
  lz: number;
  /** drone height above ground and speed */
  agl: number;
  speed: number;
  /** air rush weight of the camera (FPV 1, chase 0.6, LOS 0) */
  rushWeight: number;
  now: number;
  dt: number;
}

interface Bed {
  def: BedDef;
  gain: GainNode;
  filter: BiquadFilterNode;
}

/** Slow gust signal 0..1 (sum of incommensurate sines; deterministic). */
export function gust(t: number, seed = 0): number {
  return 0.5 + 0.5 * Math.sin(t * 0.37 + seed) * Math.sin(t * 0.11 + 1.3 + seed * 0.7) + 0.1 * Math.sin(t * 1.3 + seed * 2.1);
}

const PROBE_PERIOD = 0.33;

export class Ambience {
  private readonly beds: Bed[] = [];
  private readonly riverGain: GainNode | null = null;
  private readonly riverPanner: PannerNode | null = null;
  private readonly rushGain: GainNode;
  private readonly rushFilter: BiquadFilterNode;
  private readonly nextEvent: number[];
  private readonly water: Spot = { x: 0, y: 0, z: 0, near: 0 };
  private readonly village: Spot = { x: 0, y: 0, z: 0, near: 0 };
  private probeAt = -Infinity;
  private readonly random: () => number;
  /** last levels for tests / diagnostics */
  readonly last = { wind: 0, river: 0, rush: 0, village: 0, events: 0 };

  constructor(
    readonly profile: AmbienceProfile,
    private readonly d: AmbienceDeps,
  ) {
    const s = d.scope;
    this.random = d.random ?? Math.random;
    for (const def of profile.beds) {
      const src = s.loop(d.noise[def.noise]);
      const filter = s.filter(def.filter, def.freq, def.q);
      const gain = s.gain(0);
      src.connect(filter).connect(gain).connect(d.out);
      if (def.hum) {
        const hum = s.osc('sawtooth', def.hum);
        const hlp = s.filter('lowpass', 240, 1.2);
        const hg = s.gain(0.25);
        hum.connect(hlp).connect(hg).connect(gain);
        hum.start();
      }
      this.beds.push({ def, gain, filter });
    }
    for (const e of profile.emitters) this.emitter(e);
    if (profile.river) {
      // rushing water: a broad mid hiss (not the top octave) over a low rumble
      const src = s.loop(d.noise.pink);
      const bp = s.filter('bandpass', 750, 0.4);
      const lp = s.filter('lowpass', 4200, 0.6);
      const lo = s.loop(d.noise.brown);
      const lg = s.gain(0.5);
      this.riverGain = s.gain(0);
      this.riverPanner = s.panner(d.model, 12, 1, 2000);
      src.connect(bp).connect(lp).connect(this.riverGain);
      lo.connect(lg).connect(this.riverGain);
      this.riverGain.connect(this.riverPanner).connect(d.out);
    }
    const rush = s.loop(d.noise.pink);
    this.rushFilter = s.filter('bandpass', 600, 0.7);
    this.rushGain = s.gain(0);
    rush.connect(this.rushFilter).connect(this.rushGain).connect(d.out);
    // first one-shots come early, then at their own pace
    this.nextEvent = profile.events.map((e) => e.every[0] * (0.3 + 0.5 * this.random()));
  }

  private emitter(e: EmitterDef): void {
    const s = this.d.scope;
    const p = s.panner(this.d.model, e.ref, 1.2, 500);
    placePanner(p, e.position[0], e.position[1], e.position[2], 0, 0.001);
    const g = s.gain(e.gain);
    g.connect(p).connect(this.d.out);
    switch (e.kind) {
      case 'fan': {
        // ceiling fan: a broad whoosh pulsing at the blade rate (3 blades × 2.4 rev/s)
        const src = s.loop(this.d.noise.pink);
        const bp = s.filter('bandpass', 650, 0.8);
        const am = s.gain(0.55);
        const lfo = s.osc('sine', 7.2);
        const depth = s.gain(0.45);
        lfo.connect(depth).connect(am.gain);
        lfo.start();
        const hum = s.osc('triangle', 48);
        const hg = s.gain(0.05);
        hum.connect(hg).connect(g);
        hum.start();
        src.connect(bp).connect(am).connect(g);
        break;
      }
      case 'neon': {
        // transformer buzz: 120 Hz rich hum, band-passed
        const a = s.osc('sawtooth', 120);
        const b = s.osc('square', 240.4);
        const bp = s.filter('bandpass', 360, 1.5);
        const bg = s.gain(0.3);
        a.connect(bp);
        b.connect(bg).connect(bp);
        bp.connect(g);
        a.start();
        b.start();
        break;
      }
      case 'window':
        // the city outside, through the glass: one shared source feeds every window's panner
        this.outside().connect(g);
        break;
      case 'tractor': {
        const buf = this.d.bank.get('tractor');
        if (!buf) return;
        const src = s.loop(buf);
        const lp = s.filter('lowpass', 900, 0.7);
        src.connect(lp).connect(g);
        break;
      }
    }
  }

  private outsideBus: GainNode | null = null;

  /** Low city rumble heard through the windows (shared by all of them). */
  private outside(): GainNode {
    if (this.outsideBus) return this.outsideBus;
    const s = this.d.scope;
    const bus = s.gain(1);
    s.loop(this.d.noise.brown).connect(s.filter('lowpass', 480, 0.6)).connect(bus);
    s.loop(this.d.noise.pink).connect(s.filter('bandpass', 900, 0.5)).connect(s.gain(0.12)).connect(bus);
    this.outsideBus = bus;
    return bus;
  }

  update(f: AmbienceFrame): void {
    const now = f.now;
    const p = this.profile;
    const windK = windAt(p, f.agl);
    for (const b of this.beds) {
      const g = b.def.gust ? 1 - b.def.gust * 0.5 + b.def.gust * 0.6 * gust(now, b.def.freq * 0.001) : 1;
      let level = b.def.gain * g;
      if (b.def.id === 'wind') {
        level *= windK;
        glide(b.filter.frequency, 380 + 260 * gust(now) + 140 * Math.min(2, f.agl / 100), now, 0.3);
        this.last.wind = level;
      } else if (b.def.perHundred) level *= Math.max(0.05, 1 + b.def.perHundred * Math.min(2, f.agl / 100));
      glide(b.gain.gain, level, now, 0.25);
    }

    const rush = windRush(f.speed) * p.rush * f.rushWeight;
    glide(this.rushGain.gain, rush * 0.38, now, 0.12);
    glide(this.rushFilter.frequency, 450 + 2400 * Math.sqrt(rush), now, 0.12);
    this.last.rush = rush;

    if (now - this.probeAt >= PROBE_PERIOD) {
      this.probeAt = now;
      if (p.river) this.d.probe.water(f.lx, f.lz, this.water);
      if (p.village) this.d.probe.village(f.lx, f.lz, this.village);
      this.last.village = this.village.near;
    }
    if (this.riverGain && this.riverPanner) {
      const near = this.water.near;
      glide(this.riverGain.gain, near > 0 ? 0.4 * near : 0, now, 0.6);
      if (near > 0) placePanner(this.riverPanner, this.water.x, this.water.y, this.water.z, now, 0.5);
      this.last.river = near;
    }

    for (let i = 0; i < p.events.length; i++) {
      if (now < this.nextEvent[i]!) continue;
      const e = p.events[i]!;
      this.nextEvent[i] = now + e.every[0] + this.random() * (e.every[1] - e.every[0]);
      this.fire(e, f);
    }
  }

  private fire(e: EventDef, f: AmbienceFrame): void {
    let ax = f.lx;
    let ay = f.ly;
    let az = f.lz;
    let w = 1;
    if (e.near === 'village') {
      if (this.village.near < 0.15) return;
      ax = this.village.x;
      ay = this.village.y;
      az = this.village.z;
      w = this.village.near;
    } else if (e.near === 'street') {
      ay = f.ly - f.agl;
    } else if (e.near === 'river') {
      if (this.water.near < 0.15) return;
      ax = this.water.x;
      ay = this.water.y;
      az = this.water.z;
    }
    const id = e.sounds[Math.floor(this.random() * e.sounds.length)]!;
    const buf = this.d.bank.get(id);
    if (!buf) return;
    const a = this.random() * Math.PI * 2;
    const r = e.distance[0] + this.random() * (e.distance[1] - e.distance[0]);
    const h = e.height[0] + this.random() * (e.height[1] - e.height[0]);
    const rate = 1 + (this.random() * 2 - 1) * e.pitch;
    this.d.pool.play(buf, e.gain * w * (0.7 + 0.3 * this.random()), rate, 0, ax + Math.cos(a) * r, ay + h, az + Math.sin(a) * r);
    this.last.events++;
  }
}
