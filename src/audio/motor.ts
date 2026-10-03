/**
 * Quad motor sound, driven per motor by the physics' motor speeds:
 *
 *  - tonal: one oscillator per motor at the shaft rate with a custom harmonic spectrum (blade-pass family
 *    strong, imbalance harmonics weak), so each prop's pitch is its true blade-pass frequency
 *  - ESC / winding whine at 7× the shaft rate (12N14P), louder under load
 *  - broadband prop wash (pink noise) shaped by thrust and amplitude-modulated at the blade-pass rate
 *  - a soft-clip drive whose amount follows load: the buzz of a punch-out
 *  - throttle punch transients and a rare desync chirp on a punch from idle
 *
 * Two output paths: FPV (close, dry, optional analog video-link colour) and external (PannerNode with
 * distance, air absorption and Doppler) for LOS / chase. Every parameter moves with setTargetAtTime.
 */
import { glide, placePanner, Scope, softClipCurve } from './graph';
import { airCutoff, bladePassHz, dopplerFactor, escWhineHz, motorRpm, shaftHz } from './mix';

export interface MotorFrame {
  motors: readonly number[];
  armed: boolean;
  /** drone position / velocity (world) */
  px: number;
  py: number;
  pz: number;
  vx: number;
  vy: number;
  vz: number;
  /** listener position */
  lx: number;
  ly: number;
  lz: number;
  fpv: boolean;
  dt: number;
}

/** Harmonic amplitudes of the prop voice at the shaft rate (index = harmonic). */
export function propSpectrum(n = 48, blades = 3): Float32Array<ArrayBuffer> {
  const a = new Float32Array(n + 1);
  for (let k = 1; k <= n; k++) {
    if (k % blades === 0) {
      const m = k / blades;
      // blade-pass family: the fundamental and a slowly falling series, 2nd a touch hot (thrust ripple)
      a[k] = (m === 2 ? 1.25 : 1) / Math.pow(m, 0.85);
    } else {
      // imbalance / shaft harmonics: faint, they give the "wobble" between blade-pass partials
      a[k] = (k === 1 ? 0.22 : 0.07) / Math.sqrt(k);
    }
  }
  return a;
}

const PUNCH_RATE = 2.2; // normalised motor speed per second that counts as a punch
const STALL = 0.012;

export class MotorSound {
  private readonly voices: { osc: OscillatorNode; whine: OscillatorNode; gain: GainNode; whineGain: GainNode }[] = [];
  private readonly drivePre: GainNode;
  private readonly body: BiquadFilterNode;
  private readonly washFilter: BiquadFilterNode;
  private readonly washGain: GainNode;
  private readonly washLfo: OscillatorNode;
  private readonly washDepth: GainNode;
  private readonly mute: GainNode;
  private readonly fpvGain: GainNode;
  private readonly extGain: GainNode;
  private readonly air: BiquadFilterNode;
  private readonly panner: PannerNode;
  private readonly linkHp: BiquadFilterNode;
  private readonly linkLp: BiquadFilterNode;
  private readonly hiss: GainNode;
  private readonly fpvSend: GainNode;
  private readonly extSend: GainNode;
  private prevMean = 0;
  private punch = 0;
  private chirp = 0;
  private chirpMotor = 0;
  private doppler = 1;
  private link = 0;
  private fpv = true;
  /** last values for tests / diagnostics */
  readonly last = { bladePass: [0, 0, 0, 0], whine: [0, 0, 0, 0], gains: [0, 0, 0, 0], wash: 0, doppler: 1, distance: 0, punch: 0 };

  constructor(
    private readonly scope: Scope,
    out: AudioNode,
    reverb: AudioNode,
    noise: AudioBuffer,
    hrtf: boolean,
    private readonly random: () => number = Math.random,
  ) {
    const ctx = scope.ctx;
    const imag = propSpectrum();
    const wave = ctx.createPeriodicWave(new Float32Array(imag.length), imag, { disableNormalization: false });

    const tonal = scope.gain(1);
    const whineSum = scope.gain(1);
    for (let i = 0; i < 4; i++) {
      const osc = scope.wave(wave, 60);
      const gain = scope.gain(0);
      osc.connect(gain).connect(tonal);
      const whine = scope.osc('sine', 400);
      const whineGain = scope.gain(0);
      whine.connect(whineGain).connect(whineSum);
      osc.start();
      whine.start();
      this.voices.push({ osc, whine, gain, whineGain });
    }
    // load buzz: soft clip with a variable pre-gain, then the body low-pass that opens with thrust
    this.drivePre = scope.gain(1);
    const drive = scope.shaper(softClipCurve(2.2));
    const post = scope.gain(0.5);
    this.body = scope.filter('lowpass', 2500, 0.9);
    tonal.connect(this.drivePre).connect(drive).connect(post).connect(this.body);

    const whineHp = scope.filter('highpass', 1200, 0.7);
    whineSum.connect(whineHp);

    // prop wash: pink noise, band-passed by thrust, AM at the blade-pass rate
    const wash = scope.loop(noise);
    this.washFilter = scope.filter('bandpass', 900, 0.55);
    const washAm = scope.gain(1);
    this.washLfo = scope.osc('sine', 100);
    this.washDepth = scope.gain(0);
    this.washLfo.connect(this.washDepth).connect(washAm.gain);
    this.washLfo.start();
    this.washGain = scope.gain(0);
    wash.connect(this.washFilter).connect(washAm).connect(this.washGain);

    const mix = scope.gain(1);
    this.body.connect(mix);
    whineHp.connect(mix);
    this.washGain.connect(mix);
    this.mute = scope.gain(1);
    mix.connect(this.mute);

    // FPV path: close and dry, with the analog link colour (band-limit + hiss) when enabled
    this.fpvGain = scope.gain(1);
    const presence = scope.filter('peaking', 2600, 0.8, 2.5);
    this.linkHp = scope.filter('highpass', 20, 0.7);
    this.linkLp = scope.filter('lowpass', 20000, 0.7);
    this.mute.connect(this.fpvGain).connect(presence).connect(this.linkHp).connect(this.linkLp).connect(out);
    const hissSrc = scope.loop(noise);
    const hissHp = scope.filter('highpass', 3500, 0.7);
    this.hiss = scope.gain(0);
    hissSrc.connect(hissHp).connect(this.hiss).connect(this.linkLp);
    this.fpvSend = scope.gain(0.06);
    this.fpvGain.connect(this.fpvSend).connect(reverb);

    // external path: air absorption → panner (distance + direction)
    this.extGain = scope.gain(0);
    this.air = scope.filter('lowpass', 18000, 0.6);
    this.panner = scope.panner(hrtf ? 'HRTF' : 'equalpower', 8, 1, 3000);
    this.mute.connect(this.extGain).connect(this.air).connect(this.panner).connect(out);
    this.extSend = scope.gain(0.28);
    this.panner.connect(this.extSend).connect(reverb);
  }

  /** Analog video-link colour in FPV: 0 = clean, 1 = full (band-limited goggles audio with hiss). */
  setLink(amount: number): void {
    this.link = Math.min(1, Math.max(0, amount));
  }

  setMuted(muted: boolean): void {
    glide(this.mute.gain, muted ? 0 : 1, this.scope.ctx.currentTime, 0.08);
  }

  update(f: MotorFrame): void {
    const now = this.scope.ctx.currentTime;
    const tc = 0.025;
    let sum = 0;
    let bpSum = 0;
    for (let i = 0; i < 4; i++) sum += Math.min(1, Math.max(0, f.motors[i] ?? 0));
    const mean = sum / 4;

    // throttle punch: a fast rise in mean motor speed
    const rate = f.dt > 0 ? (mean - this.prevMean) / f.dt : 0;
    const decay = Math.exp(-f.dt / 0.18);
    this.punch = Math.max(this.punch * decay, Math.min(1, Math.max(0, (rate - PUNCH_RATE) / 6)));
    // desync chirp: now and then, a hard punch straight from idle trips one ESC for a few tens of ms
    if (this.chirp <= 0 && this.prevMean < 0.16 && rate > 7 && f.armed && this.random() < 0.35) {
      this.chirp = 0.06;
      this.chirpMotor = Math.floor(this.random() * 4) & 3;
    }
    this.chirp = Math.max(0, this.chirp - f.dt);
    this.prevMean = mean;

    // Doppler + distance for the external path
    const dx = f.lx - f.px;
    const dy = f.ly - f.py;
    const dz = f.lz - f.pz;
    const dist = Math.hypot(dx, dy, dz);
    let target = 1;
    if (!f.fpv && dist > 0.5) target = dopplerFactor((f.vx * dx + f.vy * dy + f.vz * dz) / dist);
    // smooth the factor (camera cuts must not glitch the pitch)
    this.doppler += (target - this.doppler) * Math.min(1, f.dt * 10);

    for (let i = 0; i < 4; i++) {
      const v = this.voices[i]!;
      const u = Math.min(1, Math.max(0, f.motors[i] ?? 0));
      const desync = this.chirp > 0 && i === this.chirpMotor ? 0.62 : 1;
      const rpm = motorRpm(u, i) * this.doppler * desync;
      const shaft = Math.max(1, shaftHz(rpm));
      glide(v.osc.frequency, shaft, now, tc);
      glide(v.whine.frequency, Math.max(20, escWhineHz(rpm)), now, tc);
      // a stopped prop is silent; idle (5.5 %) already sings
      const presence = u <= STALL ? 0 : Math.min(1, (u - STALL) / 0.04);
      const level = presence * (0.03 + 0.09 * Math.pow(u, 1.3));
      glide(v.gain.gain, level, now, f.armed || u > STALL ? tc : 0.2);
      const whine = presence * (0.004 + 0.012 * u + 0.02 * this.punch) * (f.armed ? 1 : 0.6);
      glide(v.whineGain.gain, whine, now, tc);
      bpSum += bladePassHz(rpm);
      this.last.bladePass[i] = bladePassHz(rpm);
      this.last.whine[i] = escWhineHz(rpm);
      this.last.gains[i] = level;
    }

    const load = Math.min(1, mean * mean * 0.8 + this.punch * 0.9);
    glide(this.drivePre.gain, 0.7 + 1.5 * load + (this.chirp > 0 ? 2 : 0), now, tc);
    glide(this.body.frequency, 1200 + 4200 * mean + 2500 * this.punch, now, tc);

    const bp = bpSum / 4;
    const wash = mean <= STALL ? 0 : 0.02 + 0.22 * Math.pow(mean, 1.5) + 0.15 * this.punch;
    glide(this.washGain.gain, wash, now, 0.04);
    glide(this.washFilter.frequency, 500 + 2600 * mean + 1500 * this.punch, now, 0.05);
    glide(this.washLfo.frequency, Math.max(20, bp), now, tc);
    glide(this.washDepth.gain, 0.35 * Math.min(1, mean * 2), now, 0.05);

    // path crossfade on camera changes
    if (f.fpv !== this.fpv) this.fpv = f.fpv;
    glide(this.fpvGain.gain, f.fpv ? 1 : 0, now, 0.05);
    glide(this.extGain.gain, f.fpv ? 0 : 1, now, 0.05);
    const link = f.fpv ? this.link : 0;
    glide(this.linkHp.frequency, 20 + 220 * link, now, 0.1);
    glide(this.linkLp.frequency, 20000 - 14000 * link, now, 0.1);
    glide(this.hiss.gain, 0.012 * link * (f.armed ? 1 : 0.4), now, 0.1);

    if (!f.fpv) {
      placePanner(this.panner, f.px, f.py, f.pz, now);
      glide(this.air.frequency, airCutoff(dist), now, 0.1);
    }
    this.last.wash = wash;
    this.last.doppler = this.doppler;
    this.last.distance = dist;
    this.last.punch = this.punch;
  }
}
