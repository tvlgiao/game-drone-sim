/** Player settings: defaults, validation, migration and persistence (DOM-free, storage injected). */
import { RATE_PRESETS, axisRatesFrom } from '../control/rates';
import type { AxisRates, FlightMode, QualityTier, RateProfile } from '../types';

/** RC transmitter stick mode (which stick carries throttle / pitch / roll / yaw). */
export type StickMode = 1 | 2 | 3 | 4;
/** 'stick' = the throttle stick of the selected mode; 'trigger' = right trigger (RT). */
export type ThrottleSource = 'stick' | 'trigger';
/** What mouse X flies (mouse Y is always pitch); 'yaw' moves roll onto the yaw keys. */
export type MouseXAxis = 'roll' | 'yaw';
/**
 * Mouse stick under pointer lock. 'hold' = absolute: the stick stays where the mouse left it (tilt held);
 * 'spring' = relative: motion deflects it and it re-centres as soon as the mouse stops (rates, attitude kept);
 * 'auto' = hold in Angle mode, spring in Acro.
 */
export type MouseStickMode = 'auto' | 'hold' | 'spring';
export type RatePreset = 'beginner' | 'freestyle' | 'race' | 'custom';
export type RateAxis = keyof AxisRates;
export type RateField = keyof RateProfile;

export interface ChannelFlags {
  throttle: boolean;
  yaw: boolean;
  pitch: boolean;
  roll: boolean;
}

/** Gamepad axis index feeding each physical stick axis slot. */
export interface AxisMap {
  lx: number;
  ly: number;
  rx: number;
  ry: number;
}

export interface Settings {
  stickMode: StickMode;
  throttleSource: ThrottleSource;
  squareGate: boolean;
  invert: ChannelFlags;
  axisMap: AxisMap;
  flightMode: FlightMode;
  ratePreset: RatePreset;
  /** per-axis Betaflight Actual rates (source of truth; presets just fill these) */
  rates: AxisRates;
  /** the pilot's own rates, restored when cycling back to 'custom' (null = never edited) */
  customRates: AxisRates | null;
  /** editing roll also sets pitch (UI convenience, persisted) */
  linkRollPitch: boolean;
  /** throttle stick centre → motor command; null = auto (hover throttle) */
  throttleMid: number | null;
  throttleExpo: number;
  throttleLimit: number;
  angleMaxTiltDeg: number;
  cameraTiltDeg: number;
  fovDeg: number;
  quality: QualityTier | 'auto';
  volume: number;
  showFps: boolean;
  /** arrow on the floor under the quad pointing where its nose faces (LOS / chase orientation aid) */
  headingArrow: boolean;
  /** analog FPV video look in FPV (scanlines, noise, sync roll); tiers without post never show it */
  analogVideo: boolean;
  /** strength of the analog look, 0.1..1 */
  analogStrength: number;
  deadzone: number;
  /** touch sticks: throttle springs back to centre (hover) instead of holding like a real gimbal */
  touchThrottleCentre: boolean;
  /** touch sticks stay at fixed positions instead of spawning under the thumb */
  touchSticksFixed: boolean;
  /** mouse flight: multiplier on the stick deflection per pixel of motion (1 = 100 %) */
  mouseSensitivity: number;
  /** false: pushing the mouse away tilts the nose down, like pushing a stick forward */
  mouseInvertY: boolean;
  mouseXAxis: MouseXAxis;
  mouseStick: MouseStickMode;
  /** cubic expo on the mouse stick (0 = linear) */
  mouseExpo: number;
  /** radius around centre that reads as centred */
  mouseDeadzone: number;
}

export const SETTINGS_KEY = 'drone-sim.settings';
export const MAX_AXIS_INDEX = 15;

export const DEFAULT_AXIS_MAP: Readonly<AxisMap> = Object.freeze({ lx: 0, ly: 1, rx: 2, ry: 3 });
const NO_INVERT: Readonly<ChannelFlags> = Object.freeze({ throttle: false, yaw: false, pitch: false, roll: false });

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  stickMode: 2,
  throttleSource: 'stick',
  squareGate: true,
  invert: NO_INVERT,
  axisMap: DEFAULT_AXIS_MAP,
  flightMode: 'angle',
  ratePreset: 'freestyle',
  rates: Object.freeze(axisRatesFrom(RATE_PRESETS.freestyle)) as AxisRates,
  customRates: null,
  linkRollPitch: true,
  throttleMid: null,
  throttleExpo: 0.3,
  throttleLimit: 1,
  angleMaxTiltDeg: 55,
  cameraTiltDeg: 25,
  fovDeg: 110,
  quality: 'auto',
  volume: 0.7,
  showFps: false,
  headingArrow: true,
  analogVideo: true,
  analogStrength: 0.35,
  deadzone: 0.05,
  touchThrottleCentre: true,
  touchSticksFixed: false,
  mouseSensitivity: 1,
  mouseInvertY: false,
  mouseXAxis: 'roll',
  mouseStick: 'auto',
  mouseExpo: 0.2,
  mouseDeadzone: 0.03,
});

/** Allowed values / numeric ranges, shared with the settings screens. */
export const SETTINGS_OPTIONS = {
  stickMode: [1, 2, 3, 4] as const,
  throttleSource: ['stick', 'trigger'] as const,
  flightMode: ['angle', 'acro'] as const,
  ratePreset: ['beginner', 'freestyle', 'race', 'custom'] as const,
  rateCenter: { min: 20, max: 600, step: 5 },
  rateMax: { min: 100, max: 1800, step: 10 },
  rateExpo: { min: 0, max: 1, step: 0.01 },
  throttleMid: { min: 0.25, max: 0.75, step: 0.01 },
  throttleExpo: { min: 0, max: 1, step: 0.01 },
  /** below ~0.5 a drained pack could no longer climb at full stick (the limit only scales above mid) */
  throttleLimit: { min: 0.5, max: 1, step: 0.01 },
  angleMaxTiltDeg: { min: 20, max: 80, step: 1 },
  quality: ['auto', 'ultra', 'high', 'medium', 'low'] as const,
  cameraTiltDeg: { min: 0, max: 45, step: 5 },
  fovDeg: { min: 80, max: 130, step: 5 },
  volume: { min: 0, max: 1, step: 0.1 },
  analogStrength: { min: 0.1, max: 1, step: 0.05 },
  deadzone: { min: 0, max: 0.25, step: 0.01 },
  mouseSensitivity: { min: 0.5, max: 3, step: 0.1 },
  mouseXAxis: ['roll', 'yaw'] as const,
  mouseStick: ['auto', 'hold', 'spring'] as const,
  mouseExpo: { min: 0, max: 1, step: 0.05 },
  mouseDeadzone: { min: 0, max: 0.2, step: 0.01 },
};

/** Old stored values → current ones. */
const THROTTLE_SOURCE_MIGRATION: Record<string, ThrottleSource> = { 'left-stick': 'stick', 'right-trigger': 'trigger' };

function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function num(v: unknown, range: { min: number; max: number }, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(range.max, Math.max(range.min, v));
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function axisIndex(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_AXIS_INDEX ? v : fallback;
}

export const RATE_AXES: readonly RateAxis[] = ['roll', 'pitch', 'yaw'];
const RATE_FIELD_RANGE = {
  center: SETTINGS_OPTIONS.rateCenter,
  max: SETTINGS_OPTIONS.rateMax,
  expo: SETTINGS_OPTIONS.rateExpo,
} as const;

/** Allowed range of one rate field. */
export function rateRange(field: RateField): { min: number; max: number; step: number } {
  return RATE_FIELD_RANGE[field];
}

/** Clamps a rate profile to its ranges and enforces max ≥ center. */
export function clampRate(raw: unknown, fallback: Readonly<RateProfile>): RateProfile {
  const r = obj(raw);
  const center = num(r.center, rateRange('center'), fallback.center);
  const max = num(r.max, rateRange('max'), fallback.max);
  return { center, max: Math.max(max, center), expo: num(r.expo, rateRange('expo'), fallback.expo) };
}

const copyRates = (r: Readonly<AxisRates>): AxisRates => ({ roll: { ...r.roll }, pitch: { ...r.pitch }, yaw: { ...r.yaw } });

/** Deep copy (nested objects are never shared between Settings values). */
export function cloneSettings(s: Readonly<Settings>): Settings {
  return {
    ...s,
    invert: { ...s.invert },
    axisMap: { ...s.axisMap },
    rates: copyRates(s.rates),
    customRates: s.customRates ? copyRates(s.customRates) : null,
  };
}

/** Selects a rate preset: a named preset copies its values into all three axes; 'custom' restores the pilot's own rates. */
export function applyRatePreset(s: Settings, preset: RatePreset): void {
  if (s.ratePreset === 'custom') s.customRates = copyRates(s.rates);
  s.ratePreset = preset;
  if (preset !== 'custom') s.rates = axisRatesFrom(RATE_PRESETS[preset]);
  else if (s.customRates) s.rates = copyRates(s.customRates);
}

/**
 * True when a rate edit would overwrite the saved Custom rates: there is a saved set, but a named preset is active,
 * so the edit starts from that preset's values (one Custom slot only). The Rates screen warns about it.
 */
export function rateEditReplacesCustom(s: Readonly<Settings>): boolean {
  return s.ratePreset !== 'custom' && s.customRates !== null;
}

/**
 * Edits one rate value (clamped). Center above max pushes max up; max below center is held at center.
 * With `linkRollPitch`, roll and pitch edits mirror each other. Any edit switches the preset to 'custom' and the
 * edited rates become `customRates` — on a named preset that replaces the saved set (see `rateEditReplacesCustom`).
 */
export function setRateValue(s: Settings, axis: RateAxis, field: RateField, value: number): void {
  const range = rateRange(field);
  const v = Math.min(range.max, Math.max(range.min, value));
  const targets: RateAxis[] = s.linkRollPitch && axis !== 'yaw' ? ['roll', 'pitch'] : [axis];
  for (const a of targets) {
    const r = { ...s.rates[a] };
    if (field === 'center') {
      r.center = v;
      if (r.max < v) r.max = Math.min(rateRange('max').max, v);
    } else if (field === 'max') {
      r.max = Math.max(v, r.center);
    } else {
      r.expo = v;
    }
    s.rates = { ...s.rates, [a]: r };
  }
  s.ratePreset = 'custom';
  s.customRates = copyRates(s.rates);
}

/** Coerces arbitrary data into valid Settings: unknown enum values fall back, numbers clamp, old values migrate. */
export function validateSettings(raw: unknown): Settings {
  const r = obj(raw);
  const d = DEFAULT_SETTINGS;
  const o = SETTINGS_OPTIONS;
  const ts = typeof r.throttleSource === 'string' ? (THROTTLE_SOURCE_MIGRATION[r.throttleSource] ?? r.throttleSource) : undefined;
  const inv = obj(r.invert);
  const am = obj(r.axisMap);
  const mode = r.stickMode;
  const preset = pick(r.ratePreset, o.ratePreset, d.ratePreset);
  // Old saves have only a preset name: its values become the per-axis rates.
  const base = axisRatesFrom(RATE_PRESETS[preset === 'custom' ? 'freestyle' : preset]);
  const rr = obj(r.rates);
  const rates: AxisRates = { roll: clampRate(rr.roll, base.roll), pitch: clampRate(rr.pitch, base.pitch), yaw: clampRate(rr.yaw, base.yaw) };
  const cr = r.customRates !== null && typeof r.customRates === 'object' && !Array.isArray(r.customRates) ? obj(r.customRates) : null;
  return {
    stickMode: mode === 1 || mode === 2 || mode === 3 || mode === 4 ? mode : d.stickMode,
    throttleSource: pick(ts, o.throttleSource, d.throttleSource),
    squareGate: bool(r.squareGate, d.squareGate),
    invert: {
      throttle: bool(inv.throttle, false),
      yaw: bool(inv.yaw, false),
      pitch: bool(inv.pitch, false),
      roll: bool(inv.roll, false),
    },
    axisMap: {
      lx: axisIndex(am.lx, DEFAULT_AXIS_MAP.lx),
      ly: axisIndex(am.ly, DEFAULT_AXIS_MAP.ly),
      rx: axisIndex(am.rx, DEFAULT_AXIS_MAP.rx),
      ry: axisIndex(am.ry, DEFAULT_AXIS_MAP.ry),
    },
    flightMode: pick(r.flightMode, o.flightMode, d.flightMode),
    ratePreset: preset,
    rates,
    // Saves from before customRates: a custom preset's values are the pilot's own.
    customRates: cr
      ? { roll: clampRate(cr.roll, rates.roll), pitch: clampRate(cr.pitch, rates.pitch), yaw: clampRate(cr.yaw, rates.yaw) }
      : preset === 'custom'
        ? copyRates(rates)
        : null,
    linkRollPitch: bool(r.linkRollPitch, d.linkRollPitch),
    throttleMid: typeof r.throttleMid === 'number' && Number.isFinite(r.throttleMid) ? num(r.throttleMid, o.throttleMid, 0.5) : null,
    throttleExpo: num(r.throttleExpo, o.throttleExpo, d.throttleExpo),
    throttleLimit: num(r.throttleLimit, o.throttleLimit, d.throttleLimit),
    angleMaxTiltDeg: num(r.angleMaxTiltDeg, o.angleMaxTiltDeg, d.angleMaxTiltDeg),
    cameraTiltDeg: num(r.cameraTiltDeg, o.cameraTiltDeg, d.cameraTiltDeg),
    fovDeg: num(r.fovDeg, o.fovDeg, d.fovDeg),
    quality: pick(r.quality, o.quality, d.quality),
    volume: num(r.volume, o.volume, d.volume),
    showFps: bool(r.showFps, d.showFps),
    headingArrow: bool(r.headingArrow, d.headingArrow),
    analogVideo: bool(r.analogVideo, d.analogVideo),
    analogStrength: num(r.analogStrength, o.analogStrength, d.analogStrength),
    deadzone: num(r.deadzone, o.deadzone, d.deadzone),
    touchThrottleCentre: bool(r.touchThrottleCentre, d.touchThrottleCentre),
    touchSticksFixed: bool(r.touchSticksFixed, d.touchSticksFixed),
    mouseSensitivity: num(r.mouseSensitivity, o.mouseSensitivity, d.mouseSensitivity),
    mouseInvertY: bool(r.mouseInvertY, d.mouseInvertY),
    mouseXAxis: pick(r.mouseXAxis, o.mouseXAxis, d.mouseXAxis),
    mouseStick: pick(r.mouseStick, o.mouseStick, d.mouseStick),
    mouseExpo: num(r.mouseExpo, o.mouseExpo, d.mouseExpo),
    mouseDeadzone: num(r.mouseDeadzone, o.mouseDeadzone, d.mouseDeadzone),
  };
}

/** localStorage when available (browser), otherwise null. Never throws. */
export function defaultStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** Bumped when a default changes in a way stored settings must not override. */
const SETTINGS_VERSION = 3;

/** Loads persisted settings; bad JSON / missing storage yield defaults. `undefined` = localStorage. */
export function loadSettings(storage: Storage | null = defaultStorage()): Settings {
  if (!storage) return cloneSettings(DEFAULT_SETTINGS);
  try {
    const text = storage.getItem(SETTINGS_KEY);
    if (!text) return cloneSettings(DEFAULT_SETTINGS);
    const raw = JSON.parse(text) as Record<string, unknown>;
    const v = raw && typeof raw.v === 'number' ? raw.v : 1;
    // v2: touch throttle auto-centres by default (MOBA-style); drop the old stored default.
    if (raw && v < 2) delete raw.touchThrottleCentre;
    // v3: the FPS chip is off by default; every older save stored the old `true` default.
    if (raw && v < 3) delete raw.showFps;
    return validateSettings(raw);
  } catch {
    return cloneSettings(DEFAULT_SETTINGS);
  }
}

/** Persists settings; storage errors (quota, privacy mode) are swallowed. */
export function saveSettings(s: Settings, storage: Storage | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(SETTINGS_KEY, JSON.stringify({ ...validateSettings(s), v: SETTINGS_VERSION }));
  } catch {
    /* storage unavailable */
  }
}
