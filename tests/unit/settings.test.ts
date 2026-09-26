import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, SETTINGS_KEY, loadSettings, saveSettings, validateSettings } from '../../src/core/settings';

function mem(initial: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(initial));
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
}

describe('settings', () => {
  it('defaults match the spec', () => {
    expect(DEFAULT_SETTINGS).toEqual({
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
  });

  it('missing storage / key → defaults (a fresh copy)', () => {
    const a = loadSettings(null);
    expect(a).toEqual(DEFAULT_SETTINGS);
    a.volume = 0;
    expect(DEFAULT_SETTINGS.volume).toBe(0.7);
    expect(loadSettings(mem())).toEqual(DEFAULT_SETTINGS);
  });

  it('bad JSON → defaults', () => {
    expect(loadSettings(mem({ [SETTINGS_KEY]: '{not json' }))).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(mem({ [SETTINGS_KEY]: 'null' }))).toEqual(DEFAULT_SETTINGS);
  });

  it('throwing storage → defaults, save does not throw', () => {
    const bad = mem();
    bad.getItem = () => {
      throw new Error('denied');
    };
    bad.setItem = () => {
      throw new Error('quota');
    };
    expect(loadSettings(bad)).toEqual(DEFAULT_SETTINGS);
    expect(() => saveSettings({ ...DEFAULT_SETTINGS }, bad)).not.toThrow();
  });

  it('validates each field: bad enums fall back, numbers clamp, wrong types fall back', () => {
    const s = validateSettings({
      throttleSource: 'mouse',
      flightMode: 'acro',
      ratePreset: 'insane',
      cameraTiltDeg: 90,
      fovDeg: 10,
      quality: 'low',
      volume: -3,
      showFps: 'yes',
      deadzone: Number.NaN,
    });
    expect(s).toEqual({
      throttleSource: 'left-stick',
      flightMode: 'acro',
      ratePreset: 'freestyle',
      cameraTiltDeg: 45,
      fovDeg: 80,
      quality: 'low',
      volume: 0,
      showFps: true,
      deadzone: 0.05,
    });
  });

  it('round-trips through storage', () => {
    const st = mem();
    const custom = { ...DEFAULT_SETTINGS, throttleSource: 'right-trigger' as const, fovDeg: 120, showFps: false };
    saveSettings(custom, st);
    expect(loadSettings(st)).toEqual(custom);
  });
});
