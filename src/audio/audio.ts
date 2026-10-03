/** Fully synthesised WebAudio: per-motor whine, prop wash, wind, and event SFX. No sample files. */
import type { GameEvent } from '../types';

const MOTOR_F_IDLE = 180;
const MOTOR_F_MAX = 900;
/** Parameter smoothing time constant (s) for setTargetAtTime. */
const SMOOTH = 0.04;
const UPDATE_INTERVAL = 1 / 60;
/** wind bed gain at ambience 1 (the speed rush peaks at 0.35) */
const AMBIENT_WIND = 0.06;
/** Slight per-motor detune so four motors beat against each other like a real quad. */
const DETUNE = [1, 1.013, 0.991, 1.021];

interface MotorVoice {
  saw: OscillatorNode;
  harm: OscillatorNode;
  filter: BiquadFilterNode;
  gain: GainNode;
}

type AudioCtor = typeof AudioContext;

function audioCtor(): AudioCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

export class GameAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private motorBus: GainNode | null = null;
  private voices: MotorVoice[] = [];
  private washGain: GainNode | null = null;
  private washFilter: BiquadFilterNode | null = null;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private noise: AudioBuffer | null = null;
  private volume = 0.7;
  private lastUpdate = 0;
  private ambience = 0;
  private failed = false;
  private wantRunning = false;

  /** Creates (first call) and resumes the AudioContext. Call from a user gesture. */
  async resume(): Promise<void> {
    if (this.failed) return;
    this.wantRunning = true;
    if (!this.ctx) {
      const Ctor = audioCtor();
      if (!Ctor) {
        this.failed = true;
        return;
      }
      try {
        this.ctx = new Ctor({ latencyHint: 'interactive' });
        this.build(this.ctx);
      } catch {
        this.failed = true;
        this.ctx = null;
        return;
      }
    }
    if (this.ctx.state !== 'running') {
      try {
        await this.ctx.resume();
        // a suspend() issued while resume() was pending wins
        if (!this.wantRunning) await this.ctx.suspend();
      } catch {
        /* resume blocked until a later gesture */
      }
    }
  }

  /** AudioContext state for diagnostics/tests: 'none' before the first gesture. */
  get state(): AudioContextState | 'none' {
    return this.ctx ? this.ctx.state : 'none';
  }

  get ready(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  /** Outdoor levels: a light wind bed (EnvDef.ambience, 0..1) under the speed-driven rush; rooms are still. */
  setAmbience(kind: 'room' | 'wind', gain: number): void {
    this.ambience = kind === 'wind' ? Math.min(1, Math.max(0, gain)) : 0;
  }

  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, v));
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.05);
  }

  /** Motor sound from lagged motor speeds 0..1; call every frame (internally rate-limited). */
  update(motors: readonly number[], armed: boolean, speed: number): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    if (now - this.lastUpdate < UPDATE_INTERVAL) return;
    this.lastUpdate = now;

    let sum = 0;
    for (let i = 0; i < this.voices.length; i++) {
      const u = Math.min(1, Math.max(0, motors[i] ?? 0));
      sum += u;
      const v = this.voices[i]!;
      const f = (MOTOR_F_IDLE + (MOTOR_F_MAX - MOTOR_F_IDLE) * u) * DETUNE[i]!;
      v.saw.frequency.setTargetAtTime(f, now, SMOOTH);
      v.harm.frequency.setTargetAtTime(f * 2.02, now, SMOOTH);
      v.filter.frequency.setTargetAtTime(600 + 5200 * u, now, SMOOTH);
      // Fade in over the first few % of rpm so a spinning-down motor tails off smoothly.
      const presence = Math.min(1, u / 0.06);
      const level = (armed || u > 0.01 ? presence : 0) * (0.05 + 0.1 * u);
      v.gain.gain.setTargetAtTime(level, now, armed ? SMOOTH : 0.25);
    }
    const thrust = sum / Math.max(1, this.voices.length);
    if (this.washGain && this.washFilter) {
      this.washGain.gain.setTargetAtTime(thrust > 0.01 ? 0.02 + 0.28 * thrust * thrust : 0, now, 0.08);
      this.washFilter.frequency.setTargetAtTime(700 + 2600 * thrust, now, 0.08);
    }
    if (this.windGain && this.windFilter) {
      const s = Math.min(1, Math.max(0, speed / 25));
      // slow gusts on the ambient bed
      const gust = 0.75 + 0.25 * Math.sin(now * 0.37) * Math.sin(now * 0.11 + 1.3);
      const bed = AMBIENT_WIND * this.ambience * gust;
      this.windGain.gain.setTargetAtTime(Math.max(0.35 * s * s, bed), now, 0.15);
      this.windFilter.frequency.setTargetAtTime(300 + 1800 * Math.max(s, this.ambience * 0.15 * gust), now, 0.15);
    }
  }

  /** Mutes motor/wind beds (pause menu) without touching SFX. */
  setMotorsMuted(muted: boolean): void {
    if (!this.ctx || !this.motorBus) return;
    this.motorBus.gain.setTargetAtTime(muted ? 0 : 1, this.ctx.currentTime, 0.08);
  }

  handleEvent(e: GameEvent): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime + 0.005;
    switch (e.type) {
      case 'ring-passed': {
        const base = 659.25 * Math.pow(2, Math.min(e.index, 16) / 12);
        this.tone(base, t, 0.35, 'triangle', 0.22);
        this.tone(base * 1.5, t + 0.075, 0.5, 'triangle', 0.2);
        this.tone(base * 3, t + 0.075, 0.35, 'sine', 0.05);
        break;
      }
      case 'crash':
        this.thump(t, Math.min(1, 0.5 + e.speed / 12));
        this.noiseBurst(t, 0.45, 'bandpass', 1800, 0.55, 0.8);
        this.noiseBurst(t + 0.02, 0.25, 'highpass', 4000, 0.18, 0.5);
        break;
      case 'collision': {
        const k = Math.min(1, e.contact.impactSpeed / 5);
        this.noiseBurst(t, 0.05, 'highpass', 2500, 0.15 + 0.3 * k, 2);
        this.tone(1400 + 800 * k, t, 0.04, 'square', 0.04 * (0.5 + k));
        break;
      }
      case 'countdown':
        this.tone(587.33, t, 0.16, 'square', 0.12);
        break;
      case 'race-start':
        this.tone(1174.66, t, 0.45, 'square', 0.14);
        this.tone(1174.66 * 1.5, t, 0.45, 'sine', 0.06);
        break;
      case 'race-finish': {
        const notes = [523.25, 659.25, 783.99, 1046.5];
        notes.forEach((f, i) => this.tone(f, t + i * 0.11, 0.3, 'triangle', 0.2));
        const chord = t + notes.length * 0.11;
        for (const f of [523.25, 659.25, 783.99, 1046.5]) this.tone(f, chord, 1.3, 'sawtooth', 0.045, 2400);
        if (e.best) this.tone(2093, chord + 0.15, 0.9, 'sine', 0.08);
        break;
      }
      case 'respawn':
        this.sweep(t, 300, 1200, 0.25, 0.08);
        break;
      case 'armed':
        this.tone(e.armed ? 880 : 440, t, 0.08, 'square', 0.08);
        this.tone(e.armed ? 1318.5 : 330, t + 0.09, 0.1, 'square', 0.08);
        break;
    }
  }

  /** Silences everything immediately (tab hidden, quit); resume() brings it back. */
  async suspend(): Promise<void> {
    this.wantRunning = false;
    if (this.ctx && this.ctx.state === 'running') {
      try {
        await this.ctx.suspend();
      } catch {
        /* already closed */
      }
    }
  }

  dispose(): void {
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx) void ctx.close().catch(() => undefined);
  }

  private build(ctx: AudioContext): void {
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.2;
    comp.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(comp);
    this.sfxBus = ctx.createGain();
    this.sfxBus.connect(this.master);
    this.motorBus = ctx.createGain();
    this.motorBus.connect(this.master);

    // One shared lowpass tames the saw buzz; per-motor filters track rpm.
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 7000;
    tone.connect(this.motorBus);
    for (let i = 0; i < 4; i++) {
      const saw = ctx.createOscillator();
      saw.type = 'sawtooth';
      saw.frequency.value = MOTOR_F_IDLE * DETUNE[i]!;
      const harm = ctx.createOscillator();
      harm.type = 'triangle';
      harm.frequency.value = MOTOR_F_IDLE * 2.02;
      const harmGain = ctx.createGain();
      harmGain.gain.value = 0.35;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.Q.value = 3;
      filter.frequency.value = 800;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      saw.connect(filter);
      harm.connect(harmGain).connect(filter);
      filter.connect(gain).connect(tone);
      saw.start();
      harm.start();
      this.voices.push({ saw, harm, filter, gain });
    }

    this.noise = this.makeNoise(ctx);
    const wash = this.loopNoise(ctx, 'bandpass', 1200, 0.8);
    this.washFilter = wash.filter;
    this.washGain = wash.gain;
    const wind = this.loopNoise(ctx, 'lowpass', 400, 0.5);
    this.windFilter = wind.filter;
    this.windGain = wind.gain;
  }

  private makeNoise(ctx: AudioContext): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * 2);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    // Pink-ish noise (Paul Kellet's economy filter) sounds more like air than white noise.
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.25;
    }
    return buf;
  }

  private loopNoise(ctx: AudioContext, type: BiquadFilterType, freq: number, q: number): { filter: BiquadFilterNode; gain: GainNode } {
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(this.motorBus!);
    src.start(0, Math.random() * 1.5);
    return { filter, gain };
  }

  private tone(freq: number, t: number, dur: number, type: OscillatorType, peak: number, lowpass?: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let out: AudioNode = osc;
    if (lowpass) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = lowpass;
      out = osc.connect(f);
    }
    out.connect(g).connect(this.sfxBus!);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  private sweep(t: number, from: number, to: number, dur: number, peak: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + dur * 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.sfxBus!);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  private thump(t: number, strength: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(140, t);
    osc.frequency.exponentialRampToValueAtTime(38, t + 0.3);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.9 * strength, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    osc.connect(g).connect(this.sfxBus!);
    osc.start(t);
    osc.stop(t + 0.45);
  }

  private noiseBurst(t: number, dur: number, type: BiquadFilterType, freq: number, peak: number, q: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.sfxBus!);
    src.start(t, Math.random() * 1.2);
    src.stop(t + dur + 0.05);
  }
}
