/**
 * Per-level camera look: tone mapper, exposure, colour grade, bloom, ambient occlusion and aerial haze.
 * The same numbers drive the post stack (medium+) and the renderer's own tone mapping (low tier, VR),
 * so a level reads the same on every tier apart from the effects a tier drops.
 */
import { SKIES } from '../levels/skies';
import type { EnvDef, LevelDef, LevelId, SkyDef } from '../types';
import type { AerialSettings } from './effects/aerial';
import { NEUTRAL_GRADE, type Grade } from './effects/grade';

export type ToneMapper = 'agx' | 'aces' | 'neutral';

export interface LevelLook {
  toneMapping: ToneMapper;
  /** renderer.toneMappingExposure: scene-referred linear light × exposure before the tone curve */
  exposure: number;
  grade: Readonly<Grade>;
  /** threshold is a floor: the level view's own bloomThreshold wins when higher */
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
  /** race-gate LED channel gain: gates must stay the brightest thing in the frame (daylight needs more) */
  ringGain: number;
}

/** Night Loft: warm practicals against cool moonlight, deep but not crushed blacks, teal-orange split. */
const NIGHT: LevelLook = {
  toneMapping: 'aces',
  exposure: 1.2,
  grade: {
    lift: [0.012, 0.016, 0.03],
    gamma: [1.02, 1.0, 0.98],
    gain: [1.04, 1.0, 0.95],
    contrast: 1.04,
    saturation: 1.0,
    shadowTint: [-0.006, 0.004, 0.02],
    highlightTint: [0.02, 0.008, -0.012],
  },
  bloom: { threshold: 0.9, smoothing: 0.3, intensity: 0.9, radius: 0.68 },
  ao: { radius: 0.9, intensity: 2.2, falloff: 1.2 },
  vignette: { offset: 0.32, darkness: 0.5 },
  grain: 0.05,
  aerial: null,
  // the captured room already carries the moonlit-window ambient the cool hemisphere stands in for
  hemiWithIbl: 0.55,
  ringGain: 1,
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
  // above the sun's Mie halo (~3 in scene units): only the disc, rings and sparks bloom, never a disk of sky
  bloom: { threshold: 4, smoothing: 1.5, intensity: 0.6, radius: 0.7 },
  ao: { radius: 2.0, intensity: 2.0, falloff: 1.0 },
  vignette: { offset: 0.38, darkness: 0.38 },
  grain: 0.035,
  aerial: { color: 0xb9cfe0, sunColor: 0x806a4c, density: 0.0022, falloff: 0.06, base: 0, maxOpacity: 0.6 },
  hemiWithIbl: 0.5,
  ringGain: 2.2,
};

const LOOKS: Partial<Record<LevelId, LevelLook>> = {
  'night-loft': NIGHT,
  training: DAY,
};

/** Sky presets of the generated levels (levels/skies.ts) a look is made for. */
export type WorldTime = NonNullable<EnvDef['time']>;

/**
 * Generated worlds (City, Alpine Valley, Infinite): one look per time of day. The haze colour is the sky's
 * horizon, the same colour the level fades its fog to, and its density is set for kilometre views (a valley
 * floor hazes, the peaks stay crisp); `exposure` and the grade carry the time of day.
 */
function worldLook(sky: SkyDef, o: { tone: ToneMapper; exposure: number; grade: Grade; bloom: number; ringGain: number; haze: number; sun: number; vignette: number }): LevelLook {
  return {
    toneMapping: o.tone,
    exposure: o.exposure,
    grade: o.grade,
    bloom: { threshold: o.bloom, smoothing: 1.2, intensity: 0.65, radius: 0.72 },
    ao: { radius: 2.5, intensity: 1.8, falloff: 1.0 },
    vignette: { offset: 0.36, darkness: o.vignette },
    grain: 0.03,
    aerial: { color: sky.haze ?? sky.horizon, sunColor: o.sun, density: o.haze, falloff: 0.0045, base: 0, maxOpacity: 0.55 },
    hemiWithIbl: 0.6,
    ringGain: o.ringGain,
  };
}

const WORLD_LOOKS: Readonly<Record<WorldTime, LevelLook>> = {
  // clear day: true greens, a blue-grey valley haze, crisp shadows
  afternoon: worldLook(SKIES.afternoon, {
    tone: 'neutral', exposure: 1.0, bloom: 4, ringGain: 2.2, haze: 0.00055, sun: 0x6a5840, vignette: 0.34,
    grade: { lift: [0.0, 0.004, 0.012], gamma: [1.0, 1.0, 1.0], gain: [1.02, 1.01, 0.99], contrast: 1.08, saturation: 0.84, shadowTint: [-0.004, 0.0, 0.014], highlightTint: [0.012, 0.006, -0.006] },
  }),
  noon: worldLook(SKIES.noon, {
    tone: 'neutral', exposure: 0.95, bloom: 4, ringGain: 2.3, haze: 0.0005, sun: 0x5a5040, vignette: 0.32,
    grade: { lift: [0.0, 0.004, 0.012], gamma: [1.0, 1.0, 1.0], gain: [1.01, 1.01, 1.0], contrast: 1.1, saturation: 0.9, shadowTint: [-0.004, 0.0, 0.012], highlightTint: [0.008, 0.004, -0.004] },
  }),
  // low warm sun: long shadows, amber highlights over cool blue shade
  golden: worldLook(SKIES.golden, {
    tone: 'aces', exposure: 1.15, bloom: 3.2, ringGain: 1.9, haze: 0.0006, sun: 0xa0703c, vignette: 0.38,
    grade: { lift: [0.006, 0.006, 0.02], gamma: [1.0, 1.0, 1.02], gain: [1.05, 1.0, 0.93], contrast: 1.06, saturation: 0.98, shadowTint: [-0.01, 0.0, 0.022], highlightTint: [0.03, 0.012, -0.02] },
  }),
  // Alpine golden hour in thin air: cooler haze, the warmth stays near the sun
  alpine: worldLook(SKIES.alpine, {
    tone: 'aces', exposure: 1.12, bloom: 3.2, ringGain: 1.9, haze: 0.0005, sun: 0x9a6c3e, vignette: 0.36,
    grade: { lift: [0.004, 0.006, 0.018], gamma: [1.0, 1.0, 1.01], gain: [1.04, 1.0, 0.95], contrast: 1.07, saturation: 0.96, shadowTint: [-0.01, 0.0, 0.02], highlightTint: [0.026, 0.01, -0.016] },
  }),
  dawn: worldLook(SKIES.dawn, {
    tone: 'aces', exposure: 1.2, bloom: 3, ringGain: 1.8, haze: 0.0008, sun: 0x9a6a58, vignette: 0.38,
    grade: { lift: [0.01, 0.008, 0.024], gamma: [1.0, 1.0, 1.02], gain: [1.03, 0.99, 0.97], contrast: 1.04, saturation: 0.94, shadowTint: [-0.006, 0.0, 0.024], highlightTint: [0.024, 0.006, 0.0] },
  }),
  // City at dusk: the sky still lit, streets in blue shade, warm windows and lamps that bloom
  dusk: worldLook(SKIES.dusk, {
    tone: 'aces', exposure: 1.1, bloom: 2.4, ringGain: 1.5, haze: 0.0006, sun: 0x8a4a2c, vignette: 0.42,
    grade: { lift: [0.01, 0.01, 0.03], gamma: [1.0, 1.0, 1.03], gain: [1.04, 0.99, 0.95], contrast: 1.06, saturation: 1.02, shadowTint: [-0.012, -0.002, 0.03], highlightTint: [0.03, 0.01, -0.02] },
  }),
};

/**
 * Look for a level; levels without an authored look get the indoor or outdoor default. Generated levels take
 * the look of the time of day they are drawn at (`time`, else their own).
 */
export function levelLook(def: Pick<LevelDef, 'id' | 'kind'> & { env?: Pick<EnvDef, 'time'> }, time?: WorldTime): Readonly<LevelLook> {
  const t = time ?? def.env?.time;
  if (t && !LOOKS[def.id]) return WORLD_LOOKS[t];
  return LOOKS[def.id] ?? (def.kind === 'indoor' ? NIGHT : DAY);
}

export { NEUTRAL_GRADE };
