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
      stickMode: 2,
      throttleSource: 'stick',
      squareGate: true,
      invert: { throttle: false, yaw: false, pitch: false, roll: false },
      axisMap: { lx: 0, ly: 1, rx: 2, ry: 3 },
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
    a.invert.pitch = true;
    a.axisMap.ly = 5;
    expect(DEFAULT_SETTINGS.volume).toBe(0.7);
    expect(DEFAULT_SETTINGS.invert.pitch).toBe(false);
    expect(DEFAULT_SETTINGS.axisMap.ly).toBe(1);
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
      stickMode: 2,
      throttleSource: 'stick',
      squareGate: true,
      invert: { throttle: false, yaw: false, pitch: false, roll: false },
      axisMap: { lx: 0, ly: 1, rx: 2, ry: 3 },
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
    const custom = {
      ...DEFAULT_SETTINGS,
      stickMode: 1 as const,
      throttleSource: 'trigger' as const,
      squareGate: false,
      invert: { throttle: false, yaw: true, pitch: false, roll: true },
      axisMap: { lx: 0, ly: 1, rx: 3, ry: 4 },
      fovDeg: 120,
      showFps: false,
    };
    saveSettings(custom, st);
    expect(loadSettings(st)).toEqual(custom);
  });

  it('migrates old throttleSource values and keeps other old fields', () => {
    const old = (ts: string) => loadSettings(mem({ [SETTINGS_KEY]: JSON.stringify({ throttleSource: ts, fovDeg: 120, flightMode: 'acro' }) }));
    expect(old('left-stick')).toMatchObject({ throttleSource: 'stick', stickMode: 2, squareGate: true, fovDeg: 120, flightMode: 'acro' });
    expect(old('right-trigger').throttleSource).toBe('trigger');
  });

  it('validates stick mode, square gate, invert flags and axis map', () => {
    const s = validateSettings({
      stickMode: 5,
      squareGate: 'yes',
      invert: { throttle: true, yaw: 1, pitch: null },
      axisMap: { lx: 7, ly: -1, rx: 2.5, ry: 99 },
    });
    expect(s.stickMode).toBe(2);
    expect(s.squareGate).toBe(true);
    expect(s.invert).toEqual({ throttle: true, yaw: false, pitch: false, roll: false });
    expect(s.axisMap).toEqual({ lx: 7, ly: 1, rx: 2, ry: 3 });
    for (const m of [1, 3, 4] as const) expect(validateSettings({ stickMode: m }).stickMode).toBe(m);
    expect(validateSettings({ stickMode: '1' }).stickMode).toBe(2);
    expect(validateSettings({ invert: [true], axisMap: 'x' }).invert.throttle).toBe(false);
  });
});
