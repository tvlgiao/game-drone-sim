/**
 * Per-level camera look: tone mapper, exposure, colour grade, bloom, ambient occlusion and aerial haze.
 * The same numbers drive the post stack (medium+) and the renderer's own tone mapping (low tier, VR),
 * so a level reads the same on every tier apart from the effects a tier drops.
 */
import type { LevelDef, LevelId } from '../types';
import type { AerialSettings } from './effects/aerial';
import { NEUTRAL_GRADE, type Grade } from './effects/grade';

export type ToneMapper = 'agx' | 'aces' | 'neutral';

export interface LevelLook {
  toneMapping: ToneMapper;
  /** renderer.toneMappingExposure: scene-referred linear light × exposure before the tone curve */
  exposure: number;
  grade: Readonly<Grade>;
  bloom: { threshold: number; smoothing: number; intensity: number; radius: number };
  /** N8AO world-space radius (m) and strength */
  ao: { radius: number; intensity: number; falloff: number };
  vignette: { offset: number; darkness: number };
  /** grain opacity (overlay blend); 0 disables */
  grain: number;
  /** null: no height fog (rooms) */
  aerial: Readonly<AerialSettings> | null;
  /**
   * Hemisphere-light scale while the captured environment lights the level: the capture already
   * carries the sky's ambient, a full hemisphere light on top would count it twice and flatten shadows.
   */
  hemiWithIbl: number;
}

/** Night Loft: warm practicals against cool moonlight, deep but not crushed blacks, teal-orange split. */
const NIGHT: LevelLook = {
  toneMapping: 'agx',
  exposure: 1.35,
  grade: {
    lift: [0.012, 0.016, 0.03],
    gamma: [1.02, 1.0, 0.98],
    gain: [1.04, 1.0, 0.95],
    contrast: 1.16,
    saturation: 1.22,
    shadowTint: [-0.006, 0.004, 0.02],
    highlightTint: [0.02, 0.008, -0.012],
  },
  bloom: { threshold: 0.9, smoothing: 0.3, intensity: 0.9, radius: 0.68 },
  ao: { radius: 0.9, intensity: 2.2, falloff: 1.2 },
  vignette: { offset: 0.32, darkness: 0.5 },
  grain: 0.05,
  aerial: null,
  hemiWithIbl: 1,
};

/** Training Field: clear late-morning sun, crisp shadows, haze into the treeline. */
const DAY: LevelLook = {
  toneMapping: 'neutral',
  exposure: 1.0,
  grade: {
    lift: [0.0, 0.004, 0.012],
    gamma: [1.0, 1.0, 1.0],
    gain: [1.02, 1.01, 0.99],
    contrast: 1.06,
    saturation: 0.94,
    shadowTint: [-0.004, 0.0, 0.012],
    highlightTint: [0.012, 0.006, -0.006],
  },
  bloom: { threshold: 1.6, smoothing: 0.4, intensity: 0.6, radius: 0.7 },
  ao: { radius: 2.0, intensity: 2.0, falloff: 1.0 },
  vignette: { offset: 0.38, darkness: 0.38 },
  grain: 0.035,
  aerial: { color: 0xb9cfe0, sunColor: 0x806a4c, density: 0.0022, falloff: 0.06, base: 0, maxOpacity: 0.6 },
  hemiWithIbl: 0.5,
};

const LOOKS: Partial<Record<LevelId, LevelLook>> = {
  'night-loft': NIGHT,
  training: DAY,
};

/** Look for a level; levels without an authored look get the indoor or outdoor default. */
export function levelLook(def: Pick<LevelDef, 'id' | 'kind'>): Readonly<LevelLook> {
  return LOOKS[def.id] ?? (def.kind === 'indoor' ? NIGHT : DAY);
}

export { NEUTRAL_GRADE };
