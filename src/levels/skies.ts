/**
 * Outdoor lighting presets (sRGB hex colours, sun direction towards the sun). The fog colour is always the
 * horizon colour, so far terrain dissolves into the sky (07 §1.6).
 */
import type { EnvDef, SkyDef } from '../types';
import { hash1, u01 } from '../world/rng';

export type TimeOfDay = 'dawn' | 'noon' | 'golden' | 'dusk';
/** authored levels may also use these */
export type SkyPreset = TimeOfDay | 'afternoon' | 'alpine';
export const TIMES_OF_DAY: readonly TimeOfDay[] = ['dawn', 'noon', 'golden', 'dusk'];

function unit(x: number, y: number, z: number): [number, number, number] {
  const l = Math.sqrt(x * x + y * y + z * z);
  return [x / l, y / l, z / l];
}

export const SKIES: Readonly<Record<SkyPreset, SkyDef>> = {
  // golden hour in thin mountain air: a cool haze, the warmth stays around the sun
  alpine: { top: 0x3a69b0, horizon: 0xc9d1d8, sunDir: unit(-0.82, 0.26, -0.34), sunColor: 0xffcd94, sunIntensity: 5.8, hemi: [0xafc2df, 0x4b4a3e] },
  afternoon: { top: 0x3274c6, horizon: 0xcfd9df, sunDir: unit(-0.72, 0.44, -0.36), sunColor: 0xffe0b8, sunIntensity: 6.2, hemi: [0xc3d6f2, 0x5e5a50] },
  dawn: { top: 0x4f7fbf, horizon: 0xf1cfb4, sunDir: unit(0.82, 0.16, -0.4), sunColor: 0xffcf9e, sunIntensity: 4.6, hemi: [0xb9c6e6, 0x4d4b3c] },
  noon: { top: 0x2f72cf, horizon: 0xc6dbea, sunDir: unit(-0.42, 0.74, 0.46), sunColor: 0xfff2df, sunIntensity: 5.2, hemi: [0xcfe0fb, 0x5b6a3c] },
  golden: { top: 0x3f6fb2, horizon: 0xe6cdac, sunDir: unit(-0.86, 0.22, -0.3), sunColor: 0xffc283, sunIntensity: 5.6, hemi: [0xb3c4e2, 0x56483a] },
  dusk: { top: 0x2b4174, horizon: 0xdc9670, sunDir: unit(-0.78, 0.11, 0.6), sunColor: 0xff9a5e, sunIntensity: 4, hemi: [0x8d9cc8, 0x3e3836] },
};

/** Environment for an outdoor level at `time`, fog reaching 1 % visibility at `viewDistance` metres. */
export function outdoorEnv(time: SkyPreset, viewDistance: number, wind = 0.5): EnvDef {
  const sky = SKIES[time];
  return { sky, fog: { color: sky.horizon, viewDistance }, ambience: { kind: 'wind', gain: wind }, shadows: 'sun-follow' };
}

/** The Infinite world's time of day, fixed per seed (07 §2.6). */
export function timeFromSeed(seed: number): TimeOfDay {
  return TIMES_OF_DAY[Math.floor(u01(hash1(seed >>> 0, 7, 0x7173)) * TIMES_OF_DAY.length)]!;
}

/** 0 in full daylight .. 1 at dusk: how many windows are lit (sun elevation below ~25°). */
export function duskAmount(sky: SkyDef): number {
  const e = sky.sunDir[1];
  return Math.min(1, Math.max(0, (0.42 - e) / 0.36));
}
