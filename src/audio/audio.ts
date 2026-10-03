/**
 * The game's audio engine (design: docs/11-audio.md). Fully synthesised in WebAudio — no sample files:
 *
 *   sources → buses (music · sfx · ambience · ui · voice) → master → limiter → output
 *
 * - motor.ts: per-motor prop / whine / wash voices driven by the physics, FPV or spatial (LOS / chase)
 * - sfx-bank.ts + sfx.ts: one-shots rendered once offline, played through pooled voices
 * - ambience*.ts: per-level beds, positional loops and one-shots, reactive to height / speed / the world
 * - music/: an original adaptive soundtrack per level, rendered to looping stems, layered by game state
 *
 * main.ts drives it with setLevel / applySettings / frame / handleEvent; everything else is internal.
 */
import type { FormFactor, NativeShell } from '../core/device';
import type { CameraMode, DroneState, GameEvent, LevelId, QualityTier, RaceSnapshot, RaceStatus, TerrainField } from '../types';
import { Ambience, type AmbienceFrame } from './ambience';
import { ambienceFor, profileSounds, type AmbienceProfile } from './ambience-profiles';
import { impulseResponse, noise, type NoiseColour } from './dsp';
import { ceilingCurve, glide, liveNodes, placeListener, Scope, type NodeStats } from './graph';
import { BUSES, busGains, crashDuckDb, duckGain, masterGain, motorDuckDb, type BusName, type MixSettings } from './mix';
import { MotorSound, type MotorFrame } from './motor';
import { MusicDirector, type MusicInputs, type MusicState } from './music/director';
import { MusicPlayer } from './music/player';
import type { OfflineFactory } from './music/render';
import { songFor } from './music/songs';
import { FLAT_PROBE, levelProbe, type AudioProbe } from './probe';
import { CORE_SFX, renderBank, type SfxId } from './sfx-bank';
import { SfxPlayer, VoicePool } from './sfx';
import { CRASH_SFX, surfaceOf, type Surface } from './surface';

type AudioCtor = typeof AudioContext;

function audioCtor(): AudioCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

function defaultOffline(): OfflineFactory | null {
  if (typeof OfflineAudioContext === 'undefined') return null;
  return (channels, length, sampleRate) => new OfflineAudioContext(channels, length, sampleRate);
}

export interface AudioOptions {
  /** live context factory (tests, offline recordings); default: a new AudioContext on the first gesture */
  createContext?: () => BaseAudioContext;
  /** offline renderer for music stems and effects; null disables both */
  offline?: OfflineFactory | null;
  random?: () => number;
}

/** Sound settings the engine reads (a subset of Settings). */
export interface AudioSettings {
  volume: number;
  musicOn: boolean;
  musicVolume: number;
  sfxVolume: number;
  ambienceVolume: number;
  analogVideo: boolean;
  analogStrength: number;
}

/** The level parts the engine needs. */
export interface AudioLevel {
  def: { id: LevelId };
  terrain: TerrainField | null;
}

/** Anything with a world matrix: the rendered camera (in a headset, the head pose). */
export interface Eye {
  matrixWorld: { elements: ArrayLike<number> };
}

/** Engine tier: lite = mono 24 kHz stems, equal-power emitters, fewer loops (phones, medium / low quality). */
export interface AudioTier {
  lite: boolean;
  /** HRTF on the motor and positional effects (desktop, Quest); equal-power on phones / tablets */
  hrtf: boolean;
}

export function audioTier(quality: QualityTier, form: FormFactor): AudioTier {
  return { lite: quality === 'medium' || quality === 'low' || form === 'phone', hrtf: form === 'desktop' };
}

const FLYING: ReadonlySet<RaceStatus> = new Set(['countdown', 'racing', 'freefly']);
const UPDATE_INTERVAL = 1 / 90;
/** cells of the reference 4S pack; per-cell warning thresholds match the HUD */
const CELLS = 4;
const CELL_WARN = 3.55;
const CELL_CRIT = 3.3;
const COMBO_WINDOW = 2.6;
/** pentatonic climb of the ring chime with the combo */
const COMBO_STEPS = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];
/** matrixWorld entries the listener uses: up (4–6), back (8–10), position (12–14) */
const EYE_INDICES = [4, 5, 6, 8, 9, 10, 12, 13, 14] as const;

export class GameAudio {
  private ctx: BaseAudioContext | null = null;
  private failed = false;
  private wantRunning = false;
  private nativePaused = false;
  private readonly stats: NodeStats = { created: 0, released: 0 };
  private root: Scope | null = null;
  private master: GainNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private readonly buses = {} as Record<BusName, GainNode>;
  private musicDuck: GainNode | null = null;
  private ambienceState: GainNode | null = null;
  private reverbIn: GainNode | null = null;
  private reverbOut: GainNode | null = null;
  private noise: Record<NoiseColour, AudioBuffer> | null = null;
  private readonly bank = new Map<SfxId, AudioBuffer>();
  private sfx: SfxPlayer | null = null;
  private ambientPool: VoicePool | null = null;
  private motor: MotorSound | null = null;
  private music: MusicPlayer | null = null;
  private readonly director = new MusicDirector();
  private levelScope: Scope | null = null;
  private ambience: Ambience | null = null;
  private retiring: { scope: Scope; at: number }[] = [];
  private level: AudioLevel | null = null;
  private profile: AmbienceProfile | null = null;
  private probe: AudioProbe = FLAT_PROBE;
  private levelToken = 0;
  private tier: AudioTier = { lite: false, hrtf: true };
  private native: NativeShell = null;
  private readonly offline: OfflineFactory | null;
  private readonly random: () => number;
  private readonly createContext?: () => BaseAudioContext;
  private mixSettings: MixSettings = { master: 0.7, music: 0.6, musicOn: true, sfx: 1, ambience: 0.7 };
  private link = 0;
  private motorsMuted = false;
  private lastUpdate = -Infinity;
  private status: RaceStatus = 'menu';
  private totalRings = 0;
  private crashAt = -Infinity;
  private stingerAt = -Infinity;
  private comboAt = -Infinity;
  private combo = -1;
  private lastCountdown = { n: -1, at: -Infinity };
  private lastTick = -Infinity;
  private lastHit: { id: string; at: number } = { id: '', at: -Infinity };
  private lowBattFor = 0;
  private battAt = -Infinity;
  private uiAt = -Infinity;
  private readonly mf: MotorFrame = { motors: [0, 0, 0, 0], armed: false, px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0, lx: 0, ly: 0, lz: 0, fpv: true, dt: 0 };
  private readonly af: AmbienceFrame = { lx: 0, ly: 0, lz: 0, agl: 0, speed: 0, rushWeight: 1, now: 0, dt: 0 };
  private readonly mi: MusicInputs = { status: 'menu', nextRing: 0, totalRings: 0, time: 0, bestTime: null };
  private readonly dronePos = { x: 0, y: 0, z: 0 };
  private readonly lastEye = new Float64Array(16).fill(Number.NaN);

  constructor(opts: AudioOptions = {}) {
    this.createContext = opts.createContext;
    this.offline = opts.offline === undefined ? defaultOffline() : opts.offline;
    this.random = opts.random ?? Math.random;
  }

  // --- lifecycle ---------------------------------------------------------------------------------------------

  /** Creates (first call) and resumes the AudioContext. Call from a user gesture. */
  async resume(): Promise<void> {
    if (this.failed) return;
    this.wantRunning = true;
    if (!this.ctx) {
      try {
        this.ctx = this.createContext ? this.createContext() : this.newContext();
      } catch {
        this.ctx = null;
      }
      if (!this.ctx) {
        this.failed = true;
        return;
      }
      try {
        this.build(this.ctx);
      } catch (err) {
        console.warn('Audio graph failed to build', err);
        this.failed = true;
        this.ctx = null;
        return;
      }
    }
    const ctx = this.ctx;
    if (ctx.state !== 'running' && !this.nativePaused && 'resume' in ctx) {
      try {
        await (ctx as AudioContext).resume();
        // a suspend() issued while resume() was pending wins
        if (!this.wantRunning) await (ctx as AudioContext).suspend();
      } catch {
        /* resume blocked until a later gesture */
      }
    }
  }

  private newContext(): AudioContext | null {
    const Ctor = audioCtor();
    if (!Ctor) return null;
    // iOS game norm: the "ambient" session respects the ring / silent switch and mixes with other apps' audio
    const nav = typeof navigator !== 'undefined' ? (navigator as unknown as { audioSession?: { type: string } }) : null;
    if (nav?.audioSession) {
      try {
        nav.audioSession.type = 'ambient';
      } catch {
        /* read-only on some engines */
      }
    }
    const ctx = new Ctor({ latencyHint: 'interactive' });
    // interruptions (a call on iOS, another app taking the output): come back on the next gesture
    ctx.addEventListener?.('statechange', () => {
      if (ctx.state !== 'running' && this.wantRunning && !this.nativePaused && typeof window !== 'undefined') {
        const again = (): void => void this.resume();
        window.addEventListener('pointerup', again, { once: true });
        window.addEventListener('keydown', again, { once: true });
      }
    });
    return ctx;
  }

  /** AudioContext state for diagnostics/tests: 'none' before the first gesture. */
  get state(): AudioContextState | 'none' {
    return this.ctx ? this.ctx.state : 'none';
  }

  get ready(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  /** Silences everything immediately (tab hidden, quit); resume() brings it back. */
  async suspend(): Promise<void> {
    this.wantRunning = false;
    const ctx = this.ctx as AudioContext | null;
    if (ctx && ctx.state === 'running' && 'suspend' in ctx) {
      try {
        await ctx.suspend();
      } catch {
        /* already closed */
      }
    }
  }

  dispose(): void {
    const ctx = this.ctx;
    this.ctx = null;
    this.music?.dispose();
    this.levelScope?.dispose();
    for (const r of this.retiring) r.scope.dispose();
    this.retiring = [];
    this.root?.dispose();
    if (ctx && 'close' in ctx) void (ctx as AudioContext).close().catch(() => undefined);
  }

  /**
   * Device facts: quality tier and form pick the engine tier; a native shell gets app pause / resume
   * (Capacitor) on top of the page visibility main.ts already handles.
   */
  configure(c: { tier?: QualityTier; form?: FormFactor; native?: NativeShell }): void {
    if (c.tier && c.form) {
      this.tier = audioTier(c.tier, c.form);
      this.music?.setLite(this.tier.lite);
    }
    if (c.native && !this.native) {
      this.native = c.native;
      void import('@capacitor/app')
        .then(({ App }) => {
          void App.addListener('pause', () => {
            this.nativePaused = true;
            const ctx = this.ctx as AudioContext | null;
            if (ctx?.state === 'running') void ctx.suspend().catch(() => undefined);
          });
          void App.addListener('resume', () => {
            this.nativePaused = false;
            if (this.wantRunning) void this.resume();
          });
        })
        .catch(() => undefined);
    }
  }

  // --- settings ----------------------------------------------------------------------------------------------

  applySettings(s: AudioSettings): void {
    this.mixSettings = { master: s.volume, music: s.musicVolume, musicOn: s.musicOn, sfx: s.sfxVolume, ambience: s.ambienceVolume };
    this.link = s.analogVideo ? 0.25 + 0.45 * s.analogStrength : 0;
    this.applyMix();
  }

  /** Master volume (0..1). */
  setVolume(v: number): void {
    this.mixSettings = { ...this.mixSettings, master: v };
    this.applyMix();
  }

  /** Legacy: the old wind slider now drives the whole ambience bus. */
  setWindVolume(v: number): void {
    this.mixSettings = { ...this.mixSettings, ambience: v };
    this.applyMix();
  }

  /** Legacy no-op: ambience now follows the level (setLevel). */
  setAmbience(_kind: 'room' | 'wind', _gain: number): void {}

  private applyMix(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const now = ctx.currentTime;
    glide(this.master.gain, masterGain(this.mixSettings), now, 0.05);
    const g = busGains(this.mixSettings);
    for (const b of BUSES) glide(this.buses[b].gain, g[b], now, 0.05);
    this.music?.setEnabled(this.mixSettings.musicOn && this.mixSettings.music > 0);
    this.motor?.setLink(this.link);
  }

  // --- level ---------------------------------------------------------------------------------------------------

  /** Switches ambience, reverb and music to `level` (old level fades out and is disposed). */
  setLevel(level: AudioLevel): void {
    this.level = level;
    this.levelToken++;
    if (this.ctx) this.buildLevel();
  }

  private buildLevel(): void {
    const ctx = this.ctx!;
    const level = this.level;
    if (!level || !this.root) return;
    const token = this.levelToken;
    const now = ctx.currentTime;
    if (this.levelScope) {
      const old = this.levelScope;
      this.levelScope = null;
      this.ambience = null;
      this.retiring.push({ scope: old, at: now + 0.6 });
      const fade = this.levelFade.get(old);
      if (fade) glide(fade.gain, 0, now, 0.12);
    }
    this.profile = ambienceFor(level.def.id, this.tier.lite);
    this.probe = level.terrain ? levelProbe(level, this.tier.lite) : FLAT_PROBE;
    this.music?.setSong(songFor(level.def.id));
    const profile = this.profile;
    const needed = profileSounds(profile).filter((id) => !this.bank.has(id));
    const make = (): void => {
      if (token !== this.levelToken || !this.ctx || !this.root) return;
      this.makeLevelScope(profile);
    };
    if (needed.length && this.offline) void renderBank(needed, this.bankRate(), this.offline, this.bank).then(make);
    else make();
  }

  private readonly levelFade = new WeakMap<Scope, GainNode>();

  private makeLevelScope(profile: AmbienceProfile): void {
    const ctx = this.ctx!;
    const scope = new Scope(ctx, this.stats);
    const fade = scope.gain(0);
    fade.connect(this.ambienceState!);
    glide(fade.gain, 1, ctx.currentTime, 0.5);
    this.levelFade.set(scope, fade);
    // the level's space: convolution reverb on the effects (motor, impacts, one-shots)
    // lite: a shorter mono room (one convolution instead of two, ~⅓ of the cost)
    const lite = this.tier.lite;
    const [l, r] = impulseResponse(profile.reverb, ctx.sampleRate, lite ? 0.6 : 1);
    const ir = ctx.createBuffer(lite ? 1 : 2, l.length, ctx.sampleRate);
    ir.copyToChannel(l, 0);
    if (!lite) ir.copyToChannel(r, 1);
    const conv = scope.convolver(ir);
    if (lite) {
      conv.channelCount = 1;
      conv.channelCountMode = 'explicit';
    }
    this.reverbIn!.connect(conv);
    conv.connect(this.reverbOut!);
    glide(this.reverbOut!.gain, profile.reverbMix, ctx.currentTime, 0.2);
    this.ambience = new Ambience(profile, {
      scope,
      out: fade,
      noise: this.noise!,
      bank: this.bank,
      pool: this.ambientPool!,
      // beds and emitters are broad sources: equal-power panning reads the same and costs a fraction of HRTF
      model: 'equalpower',
      probe: this.probe,
      random: this.random,
    });
    this.levelScope = scope;
  }

  // --- graph ---------------------------------------------------------------------------------------------------

  private bankRate(): number {
    return this.tier.lite ? Math.min(32000, this.ctx!.sampleRate) : this.ctx!.sampleRate;
  }

  private build(ctx: BaseAudioContext): void {
    const root = new Scope(ctx, this.stats);
    this.root = root;
    // master → limiter (brick-wall-ish: fast attack, high ratio, just under 0 dBFS)
    const limiter = root.add(ctx.createDynamicsCompressor());
    limiter.threshold.value = -4;
    limiter.knee.value = 2;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.12;
    // the compressor's attack lets transients through: a soft ceiling (linear to −2 dBFS) catches them
    const ceiling = root.shaper(ceilingCurve());
    limiter.connect(ceiling).connect(ctx.destination);
    this.limiter = limiter;
    // a gentle glue compressor before it keeps the dynamics in check without pumping
    const glue = root.add(ctx.createDynamicsCompressor());
    glue.threshold.value = -18;
    glue.knee.value = 10;
    glue.ratio.value = 2.5;
    glue.attack.value = 0.01;
    glue.release.value = 0.25;
    glue.connect(limiter);
    this.master = root.gain(masterGain(this.mixSettings));
    this.master.connect(glue);
    const g = busGains(this.mixSettings);
    for (const b of BUSES) {
      this.buses[b] = root.gain(g[b]);
      this.buses[b].connect(this.master);
    }
    this.musicDuck = root.gain(1);
    this.musicDuck.connect(this.buses.music);
    this.ambienceState = root.gain(0.6);
    this.ambienceState.connect(this.buses.ambience);
    this.reverbIn = root.gain(1);
    this.reverbOut = root.gain(0.25);
    this.reverbOut.connect(this.buses.sfx);

    const len = Math.round(ctx.sampleRate * (this.tier.lite ? 3 : 4));
    const mk = (c: NoiseColour, seed: number): AudioBuffer => {
      const d = noise(len, c, seed);
      const b = ctx.createBuffer(1, d.length, ctx.sampleRate);
      b.copyToChannel(d, 0);
      return b;
    };
    this.noise = { white: mk('white', 3), pink: mk('pink', 5), brown: mk('brown', 9) };

    const model: PanningModelType = this.tier.hrtf ? 'HRTF' : 'equalpower';
    this.motor = new MotorSound(root, this.buses.sfx, this.reverbIn, this.noise.pink, this.tier.hrtf, this.random);
    this.motor.setLink(this.link);
    this.motor.setMuted(this.motorsMuted);
    const world = new VoicePool(root, this.buses.sfx, this.tier.lite ? 4 : 6, model, 3, { node: this.reverbIn, amount: 0.5 });
    this.ambientPool = new VoicePool(root, this.ambienceState, this.tier.lite ? 3 : 5, 'equalpower', 6, { node: this.reverbIn, amount: 0.4 });
    this.sfx = new SfxPlayer(this.bank, {
      world,
      sfx: new VoicePool(root, this.buses.sfx, 4, null),
      ui: new VoicePool(root, this.buses.ui, 3, null),
      voice: new VoicePool(root, this.buses.voice, 3, null),
    });
    this.music = new MusicPlayer(ctx, this.stats, root, this.musicDuck, this.offline, this.tier.lite);
    this.music.setEnabled(this.mixSettings.musicOn && this.mixSettings.music > 0);
    this.music.setMix(this.director.current());
    if (this.offline) void renderBank(CORE_SFX, this.bankRate(), this.offline, this.bank);
    if (this.level) this.buildLevel();
  }

  // --- per frame -------------------------------------------------------------------------------------------------

  /** Mutes the motor (pause menu) without touching music or effects. */
  setMotorsMuted(muted: boolean): void {
    this.motorsMuted = muted;
    this.motor?.setMuted(muted);
  }

  /** Legacy per-frame update (store preview page): motors only, heard from the camera on the quad. */
  update(motors: readonly number[], armed: boolean, speed: number): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !this.motor) return;
    const now = ctx.currentTime;
    const dt = now - this.lastUpdate;
    if (dt < UPDATE_INTERVAL) return;
    this.lastUpdate = now;
    const f = this.mf;
    f.motors = motors;
    f.armed = armed;
    f.fpv = true;
    f.dt = Math.min(0.1, dt);
    f.vx = f.vy = 0;
    f.vz = -speed;
    this.motor.update(f);
  }

  /**
   * Everything per frame: motors from the physics, the listener from the rendered camera (the headset in
   * VR), ambience from height / speed / the world, music from the race, battery warnings, ducking.
   */
  frame(drone: Pick<DroneState, 'position' | 'velocity' | 'motors' | 'armed' | 'batteryVoltage'>, race: Pick<RaceSnapshot, 'status' | 'nextRing' | 'totalRings' | 'time' | 'bestTime'>, camera: CameraMode, eye: Eye): void {
    const ctx = this.ctx;
    this.status = race.status;
    this.totalRings = race.totalRings;
    this.dronePos.x = drone.position.x;
    this.dronePos.y = drone.position.y;
    this.dronePos.z = drone.position.z;
    if (!ctx || ctx.state !== 'running' || !this.motor) return;
    const now = ctx.currentTime;
    const dt = now - this.lastUpdate;
    if (dt < UPDATE_INTERVAL) return;
    this.lastUpdate = now;
    const step = Math.min(0.1, dt);

    // listener = rendered camera (FPV cam, chase cam, the pilot's eyes or the headset)
    const e = eye.matrixWorld.elements;
    const lx = e[12]!;
    const ly = e[13]!;
    const lz = e[14]!;
    // param writes cross to the audio thread: skip them while the eye holds still (menus, LOS hover)
    const le = this.lastEye;
    let moved = false;
    for (const i of EYE_INDICES) if (!(Math.abs(le[i]! - e[i]!) <= 1e-4)) moved = true;
    if (moved) {
      for (const i of EYE_INDICES) le[i] = e[i]!;
      placeListener(ctx.listener, lx, ly, lz, -e[8]!, -e[9]!, -e[10]!, e[4]!, e[5]!, e[6]!);
    }

    const fpv = camera === 'fpv';
    const p = drone.position;
    const v = drone.velocity;
    const f = this.mf;
    f.motors = drone.motors;
    f.armed = drone.armed;
    f.px = p.x;
    f.py = p.y;
    f.pz = p.z;
    f.vx = v.x;
    f.vy = v.y;
    f.vz = v.z;
    f.lx = lx;
    f.ly = ly;
    f.lz = lz;
    f.fpv = fpv;
    f.dt = step;
    this.motor.update(f);

    const speed = Math.hypot(v.x, v.y, v.z);
    if (this.ambience) {
      const a = this.af;
      a.lx = lx;
      a.ly = ly;
      a.lz = lz;
      a.agl = Math.max(0, p.y - this.probe.ground(p.x, p.z));
      a.speed = FLYING.has(race.status) ? speed : 0;
      a.rushWeight = camera === 'fpv' ? 1 : camera === 'chase' ? 0.6 : 0;
      a.now = now;
      a.dt = step;
      this.ambience.update(a);
    }
    const st = race.status;
    glide(this.ambienceState!.gain, st === 'paused' ? 0.3 : st === 'menu' ? 0.6 : 1, now, 0.3);

    // music: state machine + ducks (loud motor, crash, stingers)
    const mi = this.mi;
    mi.status = st;
    mi.nextRing = race.nextRing;
    mi.totalRings = race.totalRings;
    mi.time = race.time;
    mi.bestTime = race.bestTime;
    const mix = this.director.update(mi);
    if (mix && this.music) this.music.setMix(mix);
    this.music?.tick();
    let mean = 0;
    for (let i = 0; i < 4; i++) mean += drone.motors[i] ?? 0;
    mean /= 4;
    const stinger = now - this.stingerAt < 3 ? -7 : 0;
    glide(this.musicDuck!.gain, duckGain(motorDuckDb(mean, fpv), crashDuckDb(now - this.crashAt), stinger), now, 0.15);

    this.battery(drone, step, now);
    this.reap(now);
  }

  private battery(drone: Pick<DroneState, 'armed' | 'batteryVoltage'>, dt: number, now: number): void {
    const cell = drone.batteryVoltage / CELLS;
    if (!drone.armed || !FLYING.has(this.status) || cell >= CELL_WARN) {
      this.lowBattFor = 0;
      return;
    }
    // ignore sag blips: the warning starts after a second below the line, like an FC's voltage filter
    this.lowBattFor += dt;
    if (this.lowBattFor < 1) return;
    const crit = cell < CELL_CRIT;
    if (now - this.battAt < (crit ? 1.6 : 4)) return;
    this.battAt = now;
    this.sfx?.play(crit ? 'batt-crit' : 'batt-low', 'voice', 0.8);
  }

  private reap(now: number): void {
    if (!this.retiring.length) return;
    this.retiring = this.retiring.filter((r) => {
      if (now < r.at) return true;
      r.scope.dispose();
      return false;
    });
  }

  // --- events --------------------------------------------------------------------------------------------------

  /** Countdown beep (n > 0) or GO (n ≤ 0); repeated calls for the same number are ignored. */
  countdown(n: number): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !this.sfx) return;
    const now = ctx.currentTime;
    const k = Math.max(0, Math.round(n));
    if (this.lastCountdown.n === k && now - this.lastCountdown.at < 0.7) return;
    this.lastCountdown = { n: k, at: now };
    if (k > 0) this.sfx.play('beep', 'voice', 0.9);
    else this.sfx.play('go', 'voice', 0.9);
  }

  handleEvent(e: GameEvent): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !this.sfx) return;
    const now = ctx.currentTime;
    const sfx = this.sfx;
    const d = this.dronePos;
    switch (e.type) {
      case 'ring-passed': {
        this.combo = now - this.comboAt < COMBO_WINDOW ? this.combo + 1 : 0;
        this.comboAt = now;
        const semis = COMBO_STEPS[Math.min(this.combo, COMBO_STEPS.length - 1)]!;
        const sector = (e.index + 1) % 4 === 0 && e.index + 1 < this.totalRings;
        sfx.play(sector ? 'chime-sector' : 'chime', 'sfx', 0.7, Math.pow(2, semis / 12));
        break;
      }
      case 'collision': {
        const c = e.contact;
        this.lastHit = { id: c.colliderId, at: now };
        if (now - this.lastTick < 0.06) break;
        this.lastTick = now;
        const k = Math.min(1, c.impactSpeed / 4);
        const tick = (['tick-1', 'tick-2', 'tick-3'] as const)[Math.floor(this.random() * 3)]!;
        sfx.at(tick, c.point.x, c.point.y, c.point.z, 0.25 + 0.55 * k, 0.9 + 0.25 * this.random());
        if (c.impactSpeed > 1.2) sfx.at('bump', c.point.x, c.point.y, c.point.z, 0.3 + 0.5 * k, 0.85 + 0.3 * this.random());
        break;
      }
      case 'crash': {
        const p = e.position;
        const ground = this.probe.surface(p.x, p.y, p.z);
        const id = now - this.lastHit.at < 0.3 ? this.lastHit.id : 'ground';
        const surface: Surface = surfaceOf(id, this.level?.def.id ?? 'training', ground);
        const strength = Math.min(1, Math.max(0.35, e.speed / 10));
        sfx.at(CRASH_SFX[surface], p.x, p.y, p.z, strength, 0.92 + 0.16 * this.random());
        this.crashAt = now;
        break;
      }
      case 'respawn':
        sfx.play('respawn', 'sfx', 0.45);
        break;
      case 'armed':
        // ESC tones come out of the motors themselves
        sfx.at(e.armed ? 'arm' : 'disarm', d.x, d.y, d.z, 0.6);
        break;
      case 'countdown':
        this.countdown(e.value);
        break;
      case 'race-start':
        this.countdown(0);
        break;
      case 'race-finish':
        this.stingerAt = now;
        sfx.play(e.best ? 'stinger-best' : 'stinger-lap', 'sfx', 0.85);
        break;
      case 'out-of-bounds':
        sfx.play('oob', 'voice', 0.75);
        break;
      case 'in-bounds':
        sfx.play('inbounds', 'voice', 0.6);
        break;
    }
  }

  /** Menu sounds: hover / focus moves, selects and backs, from the menus' DOM (no menu code changes). */
  ui(kind: 'hover' | 'select' | 'back'): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !this.sfx) return;
    const now = ctx.currentTime;
    if (kind === 'hover' && now - this.uiAt < 0.06) return;
    if (kind !== 'hover') this.uiAt = now + 0.06;
    else this.uiAt = now;
    this.sfx.play(kind === 'hover' ? 'ui-hover' : kind === 'select' ? 'ui-select' : 'ui-back', 'ui', kind === 'hover' ? 0.5 : 0.8);
  }

  /** Listens to the menus under `root`: focus moves (pointer, keys, pad) tick, buttons click. */
  attachUi(root: HTMLElement): () => void {
    const BACK = new Set(['back', 'menu', 'cancel', 'resume']);
    const onClick = (ev: Event): void => {
      const el = (ev.target as HTMLElement | null)?.closest?.<HTMLElement>('[data-act], [data-dir]');
      if (!el) return;
      // value arrows tick; buttons select or go back
      this.ui(el.dataset.dir ? 'hover' : BACK.has(el.dataset.act ?? '') ? 'back' : 'select');
    };
    root.addEventListener('click', onClick);
    let obs: MutationObserver | null = null;
    if (typeof MutationObserver !== 'undefined') {
      obs = new MutationObserver((list) => {
        for (const m of list) {
          const t = m.target as HTMLElement;
          if (t.classList?.contains('is-focused') && !(m.oldValue ?? '').includes('is-focused') && t.hasAttribute('data-nav')) {
            this.ui('hover');
            return;
          }
        }
      });
      obs.observe(root, { subtree: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true });
    }
    return () => {
      root.removeEventListener('click', onClick);
      obs?.disconnect();
    };
  }

  // --- diagnostics ---------------------------------------------------------------------------------------------

  /** Mix and graph state for tests and the e2e hook. */
  debug(): {
    state: AudioContextState | 'none';
    master: number;
    buses: Record<BusName, number>;
    target: { master: number; buses: Record<BusName, number> };
    music: { state: MusicState; song: string | null; playing: boolean; duck: number; stems: number; level: number; cutoff: number };
    nodes: number;
    created: number;
    released: number;
    level: LevelId | null;
    ambience: { wind: number; river: number; rush: number; village: number; events: number } | null;
    motor: MotorSound['last'] | null;
    bank: number;
  } {
    const buses = {} as Record<BusName, number>;
    for (const b of BUSES) buses[b] = this.buses[b]?.gain.value ?? 0;
    return {
      state: this.state,
      master: this.master?.gain.value ?? 0,
      buses,
      target: { master: masterGain(this.mixSettings), buses: busGains(this.mixSettings) },
      music: {
        state: this.director.state,
        song: this.music?.song?.id ?? null,
        playing: this.music?.playing ?? false,
        duck: this.musicDuck?.gain.value ?? 1,
        stems: this.music?.rendered ?? 0,
        level: this.music?.output.level ?? 0,
        cutoff: this.music?.output.cutoff ?? 0,
      },
      nodes: liveNodes(this.stats),
      created: this.stats.created,
      released: this.stats.released,
      level: this.level?.def.id ?? null,
      ambience: this.ambience ? { ...this.ambience.last } : null,
      motor: this.motor ? this.motor.last : null,
      bank: this.bank.size,
    };
  }

  /** Disposes scopes whose fade-out is due (tests advance time and call this). */
  flush(): void {
    if (this.ctx) {
      this.reap(Infinity);
      this.music?.tick(true);
    }
  }

  /** limiter gain reduction (dB, ≤ 0), for the CPU / loudness report */
  get reduction(): number {
    return this.limiter?.reduction ?? 0;
  }
}
