/** Player settings: defaults, validation, migration and persistence (DOM-free, storage injected). */
import type { FlightMode, QualityTier } from '../types';

/** RC transmitter stick mode (which stick carries throttle / pitch / roll / yaw). */
export type StickMode = 1 | 2 | 3 | 4;
/** 'stick' = the throttle stick of the selected mode; 'trigger' = right trigger (RT). */
export type ThrottleSource = 'stick' | 'trigger';
export type RatePreset = 'beginner' | 'freestyle' | 'race';

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
  cameraTiltDeg: number;
  fovDeg: number;
  quality: QualityTier | 'auto';
  volume: number;
  showFps: boolean;
  deadzone: number;
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
  cameraTiltDeg: 25,
  fovDeg: 110,
  quality: 'auto',
  volume: 0.7,
  showFps: true,
  deadzone: 0.05,
});

/** Allowed values / numeric ranges, shared with the settings screens. */
export const SETTINGS_OPTIONS = {
  stickMode: [1, 2, 3, 4] as const,
  throttleSource: ['stick', 'trigger'] as const,
  flightMode: ['angle', 'acro'] as const,
  ratePreset: ['beginner', 'freestyle', 'race'] as const,
  quality: ['auto', 'ultra', 'high', 'medium', 'low'] as const,
  cameraTiltDeg: { min: 0, max: 45, step: 5 },
  fovDeg: { min: 80, max: 130, step: 5 },
  volume: { min: 0, max: 1, step: 0.1 },
  deadzone: { min: 0, max: 0.25, step: 0.01 },
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

/** Deep copy (nested objects are never shared between Settings values). */
export function cloneSettings(s: Readonly<Settings>): Settings {
  return { ...s, invert: { ...s.invert }, axisMap: { ...s.axisMap } };
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
    ratePreset: pick(r.ratePreset, o.ratePreset, d.ratePreset),
    cameraTiltDeg: num(r.cameraTiltDeg, o.cameraTiltDeg, d.cameraTiltDeg),
    fovDeg: num(r.fovDeg, o.fovDeg, d.fovDeg),
    quality: pick(r.quality, o.quality, d.quality),
    volume: num(r.volume, o.volume, d.volume),
    showFps: bool(r.showFps, d.showFps),
    deadzone: num(r.deadzone, o.deadzone, d.deadzone),
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

/** Loads persisted settings; bad JSON / missing storage yield defaults. `undefined` = localStorage. */
export function loadSettings(storage: Storage | null = defaultStorage()): Settings {
  if (!storage) return cloneSettings(DEFAULT_SETTINGS);
  try {
    const text = storage.getItem(SETTINGS_KEY);
    if (!text) return cloneSettings(DEFAULT_SETTINGS);
    return validateSettings(JSON.parse(text));
  } catch {
    return cloneSettings(DEFAULT_SETTINGS);
  }
}

/** Persists settings; storage errors (quota, privacy mode) are swallowed. */
export function saveSettings(s: Settings, storage: Storage | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(SETTINGS_KEY, JSON.stringify(validateSettings(s)));
  } catch {
    /* storage unavailable */
  }
}
