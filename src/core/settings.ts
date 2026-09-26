/** Player settings: defaults, validation and persistence (DOM-free, storage injected). */
import type { FlightMode, QualityTier } from '../types';

export type ThrottleSource = 'left-stick' | 'right-trigger';
export type RatePreset = 'beginner' | 'freestyle' | 'race';

export interface Settings {
  throttleSource: ThrottleSource;
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

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  throttleSource: 'left-stick',
  flightMode: 'angle',
  ratePreset: 'freestyle',
  cameraTiltDeg: 25,
  fovDeg: 110,
  quality: 'auto',
  volume: 0.7,
  showFps: true,
  deadzone: 0.05,
});

/** Allowed values / numeric ranges, shared with the settings screen. */
export const SETTINGS_OPTIONS = {
  throttleSource: ['left-stick', 'right-trigger'] as const,
  flightMode: ['angle', 'acro'] as const,
  ratePreset: ['beginner', 'freestyle', 'race'] as const,
  quality: ['auto', 'ultra', 'high', 'medium', 'low'] as const,
  cameraTiltDeg: { min: 0, max: 45, step: 5 },
  fovDeg: { min: 80, max: 130, step: 5 },
  volume: { min: 0, max: 1, step: 0.1 },
  deadzone: { min: 0, max: 0.25, step: 0.01 },
};

function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function num(v: unknown, range: { min: number; max: number }, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(range.max, Math.max(range.min, v));
}

/** Coerces arbitrary data into valid Settings: unknown enum values fall back, numbers are clamped. */
export function validateSettings(raw: unknown): Settings {
  const r = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_SETTINGS;
  const o = SETTINGS_OPTIONS;
  return {
    throttleSource: pick(r.throttleSource, o.throttleSource, d.throttleSource),
    flightMode: pick(r.flightMode, o.flightMode, d.flightMode),
    ratePreset: pick(r.ratePreset, o.ratePreset, d.ratePreset),
    cameraTiltDeg: num(r.cameraTiltDeg, o.cameraTiltDeg, d.cameraTiltDeg),
    fovDeg: num(r.fovDeg, o.fovDeg, d.fovDeg),
    quality: pick(r.quality, o.quality, d.quality),
    volume: num(r.volume, o.volume, d.volume),
    showFps: typeof r.showFps === 'boolean' ? r.showFps : d.showFps,
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
  if (!storage) return { ...DEFAULT_SETTINGS };
  try {
    const text = storage.getItem(SETTINGS_KEY);
    if (!text) return { ...DEFAULT_SETTINGS };
    return validateSettings(JSON.parse(text));
  } catch {
    return { ...DEFAULT_SETTINGS };
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
