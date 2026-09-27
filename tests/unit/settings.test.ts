import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  applyRatePreset,
  cloneSettings,
  loadSettings,
  saveSettings,
  setRateValue,
  validateSettings,
} from '../../src/core/settings';
import { RATE_PRESETS } from '../../src/control/rates';

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
      rates: { roll: { center: 200, max: 670, expo: 0.54 }, pitch: { center: 200, max: 670, expo: 0.54 }, yaw: { center: 200, max: 670, expo: 0.54 } },
      linkRollPitch: true,
      throttleMid: null,
      throttleExpo: 0.3,
      throttleLimit: 1,
      angleMaxTiltDeg: 55,
      cameraTiltDeg: 25,
      fovDeg: 110,
      quality: 'auto',
      volume: 0.7,
      showFps: true,
      deadzone: 0.05,
      touchThrottleCentre: true,
      touchSticksFixed: false,
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
      touchThrottleCentre: 'on',
      touchSticksFixed: true,
    });
    expect(s).toEqual({
      stickMode: 2,
      throttleSource: 'stick',
      squareGate: true,
      invert: { throttle: false, yaw: false, pitch: false, roll: false },
      axisMap: { lx: 0, ly: 1, rx: 2, ry: 3 },
      flightMode: 'acro',
      ratePreset: 'freestyle',
      rates: { roll: { center: 200, max: 670, expo: 0.54 }, pitch: { center: 200, max: 670, expo: 0.54 }, yaw: { center: 200, max: 670, expo: 0.54 } },
      linkRollPitch: true,
      throttleMid: null,
      throttleExpo: 0.3,
      throttleLimit: 1,
      angleMaxTiltDeg: 55,
      cameraTiltDeg: 45,
      fovDeg: 80,
      quality: 'low',
      volume: 0,
      showFps: true,
      deadzone: 0.05,
      touchThrottleCentre: true,
      touchSticksFixed: true,
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

  it('migrates old saves: rates come from the stored preset', () => {
    const s = loadSettings(mem({ [SETTINGS_KEY]: JSON.stringify({ ratePreset: 'race' }) }));
    expect(s.ratePreset).toBe('race');
    for (const a of ['roll', 'pitch', 'yaw'] as const) expect(s.rates[a]).toEqual(RATE_PRESETS.race);
    expect(s).toMatchObject({ throttleMid: null, throttleExpo: 0.3, throttleLimit: 1, angleMaxTiltDeg: 55 });
  });

  it('clamps rates and enforces max ≥ center; clamps throttle / angle fields', () => {
    const s = validateSettings({
      ratePreset: 'custom',
      rates: { roll: { center: 5, max: 5000, expo: 2 }, pitch: { center: 500, max: 200, expo: -1 }, yaw: 'bad' },
      throttleMid: 0.9,
      throttleExpo: 7,
      throttleLimit: 0.1,
      angleMaxTiltDeg: 100,
    });
    expect(s.rates.roll).toEqual({ center: 20, max: 1800, expo: 1 });
    expect(s.rates.pitch).toEqual({ center: 500, max: 500, expo: 0 });
    expect(s.rates.yaw).toEqual(RATE_PRESETS.freestyle);
    expect(s).toMatchObject({ throttleMid: 0.75, throttleExpo: 1, throttleLimit: 0.25, angleMaxTiltDeg: 80 });
    expect(validateSettings({ throttleMid: 0.1 }).throttleMid).toBe(0.25);
    expect(validateSettings({ throttleMid: 'auto' }).throttleMid).toBeNull();
    expect(validateSettings({ throttleMid: null }).throttleMid).toBeNull();
  });

  it('choosing a preset copies it to all axes; editing a value switches to custom', () => {
    const s = cloneSettings(DEFAULT_SETTINGS);
    applyRatePreset(s, 'beginner');
    expect(s.ratePreset).toBe('beginner');
    for (const a of ['roll', 'pitch', 'yaw'] as const) expect(s.rates[a]).toEqual(RATE_PRESETS.beginner);
    s.rates.roll.center = 111; // presets are copies
    expect(RATE_PRESETS.beginner.center).toBe(150);
    setRateValue(s, 'yaw', 'max', 500);
    expect(s.ratePreset).toBe('custom');
    expect(s.rates.yaw.max).toBe(500);
    applyRatePreset(s, 'custom');
    expect(s.rates.yaw.max).toBe(500); // custom keeps values
    expect(DEFAULT_SETTINGS.rates.roll).toEqual(RATE_PRESETS.freestyle);
  });

  it('link roll & pitch mirrors edits; yaw is never linked', () => {
    const s = cloneSettings(DEFAULT_SETTINGS);
    setRateValue(s, 'roll', 'center', 300);
    expect(s.rates.pitch.center).toBe(300);
    setRateValue(s, 'pitch', 'expo', 0.2);
    expect(s.rates.roll.expo).toBe(0.2);
    expect(s.rates.yaw).toEqual(RATE_PRESETS.freestyle);
    s.linkRollPitch = false;
    setRateValue(s, 'roll', 'max', 900);
    expect(s.rates.roll.max).toBe(900);
    expect(s.rates.pitch.max).toBe(670);
  });

  it('setRateValue clamps and keeps max ≥ center', () => {
    const s = cloneSettings(DEFAULT_SETTINGS);
    s.linkRollPitch = false;
    setRateValue(s, 'roll', 'center', 800); // above max: max follows
    expect(s.rates.roll).toMatchObject({ center: 600, max: 670 });
    setRateValue(s, 'roll', 'center', 590);
    setRateValue(s, 'roll', 'max', 300); // below center: held at center
    expect(s.rates.roll.max).toBe(590);
    setRateValue(s, 'roll', 'expo', 3);
    expect(s.rates.roll.expo).toBe(1);
    setRateValue(s, 'yaw', 'center', 700);
    expect(s.rates.yaw).toMatchObject({ center: 600, max: 670 });
    setRateValue(s, 'yaw', 'center', 5);
    expect(s.rates.yaw.center).toBe(20);
  });
});

describe('settings v2 migration', () => {
  it('touch throttle auto-centres by default and overrides an old stored hold default once', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } as unknown as Storage;
    expect(DEFAULT_SETTINGS.touchThrottleCentre).toBe(true);
    store.set('drone-sim.settings', JSON.stringify({ ...DEFAULT_SETTINGS, touchThrottleCentre: false }));
    expect(loadSettings(storage).touchThrottleCentre).toBe(true);
    saveSettings({ ...loadSettings(storage), touchThrottleCentre: false }, storage);
    expect(loadSettings(storage).touchThrottleCentre).toBe(false);
  });
});
