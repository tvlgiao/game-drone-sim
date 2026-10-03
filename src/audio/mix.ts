/**
 * Pure audio math shared by the engine and its tests: volume curves, bus gains, ducking, motor RPM →
 * frequency, Doppler and air absorption. No WebAudio here.
 */

/** Mixer buses under the master. */
export type BusName = 'music' | 'sfx' | 'ambience' | 'ui' | 'voice';
export const BUSES: readonly BusName[] = ['music', 'sfx', 'ambience', 'ui', 'voice'];

/** Mix levels a bus sits at with every slider at 100 % (the static mix, before the player's sliders). */
export const BUS_TRIM: Readonly<Record<BusName, number>> = { music: 2.1, sfx: 1.4, ambience: 1.6, ui: 0.8, voice: 1.1 };

/** Player-facing mix settings (Settings › Sound). */
export interface MixSettings {
  /** 0..1 */
  master: number;
  music: number;
  musicOn: boolean;
  sfx: number;
  ambience: number;
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/**
 * Slider position 0..1 → linear gain on a perceptual curve: 40 dB of range, 50 % ≈ −12 dB (the square law
 * near the top, a fade to true silence at 0).
 */
export function sliderGain(v: number): number {
  const x = clamp01(v);
  return x <= 0 ? 0 : x * x;
}

export function toDb(gain: number): number {
  return gain <= 0 ? -Infinity : 20 * Math.log10(gain);
}

export function fromDb(db: number): number {
  return Math.pow(10, db / 20);
}

/** Linear gain of each bus fader (trim × slider), master excluded; music is 0 when switched off. */
export function busGains(s: MixSettings): Record<BusName, number> {
  return {
    music: s.musicOn ? BUS_TRIM.music * sliderGain(s.music) : 0,
    sfx: BUS_TRIM.sfx * sliderGain(s.sfx),
    ambience: BUS_TRIM.ambience * sliderGain(s.ambience),
    // menu clicks and callouts follow the effects slider: one "effects" control for the player
    ui: BUS_TRIM.ui * sliderGain(s.sfx),
    voice: BUS_TRIM.voice * sliderGain(s.sfx),
  };
}

export function masterGain(s: MixSettings): number {
  return sliderGain(s.master);
}

/** Effective linear gain from a source on `bus` to the output (before the limiter and any ducking). */
export function effectiveGain(s: MixSettings, bus: BusName): number {
  return masterGain(s) * busGains(s)[bus];
}

/** Music duck under a loud motor: 0 dB below 55 % mean RPM, −5 dB at full RPM (FPV keeps the props on top). */
export function motorDuckDb(meanRpmFraction: number, fpv: boolean): number {
  const k = clamp01((meanRpmFraction - 0.55) / 0.45);
  return -(fpv ? 5 : 3) * k * k;
}

/** Crash duck: −9 dB at the impact, released over `release` seconds (smoothstep). */
export function crashDuckDb(sinceCrash: number, release = 2.2): number {
  if (!(sinceCrash >= 0) || sinceCrash >= release) return 0;
  const x = sinceCrash / release;
  return -9 * (1 - x * x * (3 - 2 * x));
}

/** Sum of dB ducks floored at −18 dB. */
export function duckGain(...db: number[]): number {
  let sum = 0;
  for (const d of db) sum += d;
  return fromDb(Math.max(-18, sum));
}

// ---------------------------------------------------------------------------------------------------------
// Motors: a 3-inch 4S quad (1404 ~4600 KV, 3-blade props, 12N14P motors)

/** Full-throttle loaded RPM of the reference quad. */
export const MAX_RPM = 33000;
export const BLADES = 3;
/** 12N14P stator: 7 magnet pole pairs, so the electrical (whine) frequency is 7× the shaft rate */
export const POLE_PAIRS = 7;
/** Per-motor RPM trim: real motors never match, so the four tones beat against each other. */
export const MOTOR_DETUNE: readonly number[] = [1, 1.011, 0.993, 1.017];

/** Normalised motor speed 0..1 (DroneState.motors) → shaft RPM. */
export function motorRpm(u: number, motor = 0): number {
  return MAX_RPM * clamp01(u) * (MOTOR_DETUNE[motor] ?? 1);
}

/** Shaft rotation frequency (Hz). */
export function shaftHz(rpm: number): number {
  return rpm / 60;
}

/** Blade-pass frequency: what the ear hears as the prop's pitch (rpm / 60 × blades). */
export function bladePassHz(rpm: number, blades = BLADES): number {
  return (rpm / 60) * blades;
}

/** Motor electrical frequency: the high ESC / winding whine. */
export function escWhineHz(rpm: number, polePairs = POLE_PAIRS): number {
  return (rpm / 60) * polePairs;
}

/** Speed of sound (m/s). */
export const SOUND_SPEED = 343;

/**
 * Doppler pitch factor for a source moving with `vs` towards / away from a still listener. `radial` is the
 * source velocity along the source→listener unit vector (positive = approaching). Clamped to ±1 octave.
 */
export function dopplerFactor(radial: number, c = SOUND_SPEED): number {
  const v = Math.max(-0.6 * c, Math.min(0.6 * c, radial));
  return Math.min(2, Math.max(0.5, c / (c - v)));
}

/** Air absorption: low-pass cutoff (Hz) for a source `d` metres away (open field). */
export function airCutoff(d: number): number {
  const x = Math.max(0, d);
  return Math.max(1800, 20000 / (1 + x / 45));
}

/** Gain of the speed-driven wind rush (m/s): quadratic from 3 m/s, full at 30 m/s. */
export function windRush(speed: number): number {
  const s = clamp01((speed - 3) / 27);
  return s * s;
}
