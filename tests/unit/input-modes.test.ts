import { describe, expect, it } from 'vitest';
import {
  AxisCapture,
  MODE_TABLE,
  STICK_SLOTS,
  VirtualSticks,
  mapSticks,
  squareGate,
  throttleSlot,
  type Channel,
  type ChannelValues,
  type StickMapOptions,
  type StickModeNum,
  type StickSlot,
  type VirtualKeys,
} from '../../src/input/stick';
import { InputManager } from '../../src/input/input-manager';
import { DEFAULT_SETTINGS, cloneSettings, type Settings } from '../../src/core/settings';

const MODES: StickModeNum[] = [1, 2, 3, 4];
const NO_INV = { throttle: false, yaw: false, pitch: false, roll: false };
const opts = (mode: StickModeNum, extra: Partial<StickMapOptions> = {}): StickMapOptions => ({
  stickMode: mode,
  throttleSource: 'stick',
  squareGate: false,
  invert: NO_INV,
  deadzone: 0,
  ...extra,
});

function run(raw: Partial<Record<StickSlot, number>>, o: StickMapOptions, trigger = 0) {
  const sticks = { lx: 0, ly: 0, rx: 0, ry: 0 };
  const ch: ChannelValues = { throttle: 0, yaw: 0, pitch: 0, roll: 0 };
  mapSticks({ lx: 0, ly: 0, rx: 0, ry: 0, ...raw }, trigger, o, sticks, ch);
  return { sticks, ch };
}

describe('RC stick mode table', () => {
  it('matches the RC convention for all four modes', () => {
    expect(MODE_TABLE[1]).toEqual({ lx: 'yaw', ly: 'pitch', rx: 'roll', ry: 'throttle' });
    expect(MODE_TABLE[2]).toEqual({ lx: 'yaw', ly: 'throttle', rx: 'roll', ry: 'pitch' });
    expect(MODE_TABLE[3]).toEqual({ lx: 'roll', ly: 'pitch', rx: 'yaw', ry: 'throttle' });
    expect(MODE_TABLE[4]).toEqual({ lx: 'roll', ly: 'throttle', rx: 'yaw', ry: 'pitch' });
  });

  for (const mode of MODES) {
    it(`mode ${mode}: every physical axis drives its channel with + = right / up`, () => {
      const thr = throttleSlot(mode);
      for (const slot of STICK_SLOTS) {
        if (slot === thr) continue;
        const ch = MODE_TABLE[mode][slot] as Exclude<Channel, 'throttle'>;
        const { ch: out } = run({ [thr]: -1, [slot]: 0.8 }, opts(mode));
        expect(out[ch]).toBeCloseTo(0.8);
        for (const other of ['yaw', 'pitch', 'roll'] as const) if (other !== ch) expect(out[other]).toBeCloseTo(0);
        expect(out.throttle).toBe(0);
        expect(run({ [thr]: -1, [slot]: -0.5 }, opts(mode)).ch[ch]).toBeCloseTo(-0.5);
      }
    });

    it(`mode ${mode}: throttle is full range on the ${throttleSlot(mode) === 'ly' ? 'left' : 'right'} stick only`, () => {
      const thr = throttleSlot(mode);
      const otherY: StickSlot = thr === 'ly' ? 'ry' : 'ly';
      expect(run({ [thr]: -1 }, opts(mode)).ch.throttle).toBe(0);
      expect(run({ [thr]: 1 }, opts(mode)).ch.throttle).toBe(1);
      expect(run({ [thr]: 0 }, opts(mode)).ch.throttle).toBeCloseTo(0.5, 1);
      expect(run({ [thr]: -0.97 }, opts(mode)).ch.throttle).toBe(0); // low-end deadzone reaches 0
      expect(run({ [thr]: -1, [otherY]: 1 }, opts(mode)).ch.throttle).toBe(0);
      // Throttle axis gets no centre deadzone; the centering stick does.
      expect(run({ [thr]: 0.03 }, opts(mode, { deadzone: 0.1 })).ch.throttle).toBeGreaterThan(0.5);
      expect(run({ [thr]: -1, [otherY]: 0.05 }, opts(mode, { deadzone: 0.1 })).sticks[otherY]).toBe(0);
    });

    it(`mode ${mode}: trigger source overrides the throttle stick`, () => {
      const thr = throttleSlot(mode);
      const r = run({ [thr]: 1 }, opts(mode, { throttleSource: 'trigger' }), 0.25);
      expect(r.ch.throttle).toBeCloseTo(0.25, 1);
      expect(r.sticks[thr]).toBeCloseTo(2 * r.ch.throttle - 1);
      expect(run({ [thr]: -1 }, opts(mode, { throttleSource: 'trigger' }), 1).ch.throttle).toBe(1);
    });
  }
});

describe('squareGate', () => {
  it('maps the round-gate diagonal to the square corner', () => {
    const v = squareGate(Math.SQRT1_2, Math.SQRT1_2);
    expect(v.x).toBeCloseTo(1, 3);
    expect(v.y).toBeCloseTo(1, 3);
    const w = squareGate(-Math.SQRT1_2, Math.SQRT1_2);
    expect(w.x).toBeCloseTo(-1, 3);
    expect(w.y).toBeCloseTo(1, 3);
  });
  it('leaves on-axis values unchanged', () => {
    for (const a of [-1, -0.6, -0.2, 0, 0.3, 0.75, 1]) {
      expect(squareGate(a, 0).x).toBeCloseTo(a, 6);
      expect(squareGate(0, a).y).toBeCloseTo(a, 6);
      expect(squareGate(a, 0).y).toBeCloseTo(0, 6);
    }
  });
  it('is monotonic along the diagonal and clamps to ±1', () => {
    let prev = -Infinity;
    for (let m = 0; m <= 1.2; m += 0.02) {
      const v = squareGate(m * Math.SQRT1_2, m * Math.SQRT1_2);
      expect(v.x).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(Math.abs(v.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(v.y)).toBeLessThanOrEqual(1);
      prev = v.x;
    }
    expect(squareGate(1, 1)).toEqual({ x: 1, y: 1 });
    expect(squareGate(1.3, 0).x).toBe(1);
  });
  it('lets a diagonal throttle stick reach full throttle and full yaw (mode 2)', () => {
    const r = run({ lx: -Math.SQRT1_2, ly: Math.SQRT1_2 }, opts(2, { squareGate: true }));
    expect(r.ch.throttle).toBeCloseTo(1, 2);
    expect(r.ch.yaw).toBeCloseTo(-1, 2);
    const off = run({ lx: -Math.SQRT1_2, ly: Math.SQRT1_2 }, opts(2));
    expect(off.ch.throttle).toBeLessThan(0.9);
  });
});

describe('channel inversion', () => {
  it('reverses each channel independently after mapping', () => {
    const raw = { lx: 0.5, ly: -1, rx: 0.4, ry: 0.3 };
    const base = run(raw, opts(2)).ch;
    const inv = run(raw, opts(2, { invert: { throttle: true, yaw: true, pitch: true, roll: true } })).ch;
    expect(inv.throttle).toBeCloseTo(1 - base.throttle);
    expect(inv.yaw).toBeCloseTo(-base.yaw);
    expect(inv.pitch).toBeCloseTo(-base.pitch);
    expect(inv.roll).toBeCloseTo(-base.roll);
    const onlyYaw = run(raw, opts(2, { invert: { ...NO_INV, yaw: true } })).ch;
    expect(onlyYaw.pitch).toBeCloseTo(base.pitch);
    expect(onlyYaw.yaw).toBeCloseTo(-base.yaw);
  });
});

describe('VirtualSticks (keyboard)', () => {
  const K: VirtualKeys = { lUp: false, lDown: false, lLeft: false, lRight: false, rUp: false, rDown: false, rLeft: false, rRight: false };
  it('mode 2: every axis, throttle included, springs back to centre within 0.15 s of release', () => {
    const v = new VirtualSticks();
    for (let i = 0; i < 50; i++) v.update(0.01, { ...K, lUp: true, lRight: true, rUp: true }, 'ly');
    expect(v.throttle).toBe(1);
    expect(v.pos.lx).toBe(1);
    expect(v.pos.ry).toBe(1);
    for (let i = 0; i < 6; i++) v.update(0.01, K, 'ly');
    expect(v.throttle).toBeGreaterThan(0.6); // smooth, not a snap
    for (let i = 0; i < 9; i++) v.update(0.01, K, 'ly');
    expect(v.throttle).toBe(0.5); // centre = hover under altitude hold
    expect(v.pos.lx).toBe(0);
    expect(v.pos.ry).toBe(0);
    for (let i = 0; i < 50; i++) v.update(0.01, { ...K, lDown: true }, 'ly');
    expect(v.throttle).toBe(0);
    for (let i = 0; i < 15; i++) v.update(0.01, K, 'ly');
    expect(v.throttle).toBe(0.5);
  });
  it('take-off latch: throttle reads zero until the throttle-up key, the down key keeps it latched', () => {
    const v = new VirtualSticks();
    expect(v.latched).toBe(true);
    for (let i = 0; i < 30; i++) v.update(0.01, i < 10 ? { ...K, lDown: true } : K, 'ly');
    expect(v.throttle).toBe(0);
    expect(v.latched).toBe(true);
    v.update(0.01, { ...K, lUp: true }, 'ly');
    expect(v.latched).toBe(false);
    for (let i = 0; i < 30; i++) v.update(0.01, K, 'ly');
    expect(v.throttle).toBe(0.5);
    v.latchTakeoff();
    expect(v.throttle).toBe(0);
    v.update(0.01, K, 'ly');
    expect(v.throttle).toBe(0);
  });
  it('mode 1: arrow ↑/↓ is the throttle, W/S self-centres (pitch)', () => {
    const v = new VirtualSticks();
    v.update(0.01, K, 'ry');
    expect(v.pos.ry).toBe(-1);
    expect(v.pos.ly).toBe(0);
    for (let i = 0; i < 100; i++) v.update(0.01, { ...K, rUp: true, lUp: true }, 'ry');
    expect(v.throttle).toBe(1);
    expect(v.pos.ly).toBe(1);
    for (let i = 0; i < 30; i++) v.update(0.01, K, 'ry');
    expect(v.throttle).toBe(0.5);
    expect(v.pos.ly).toBe(0);
  });
  it('axis rise is smoothed over ~0.12 s', () => {
    const v = new VirtualSticks();
    v.update(0.06, { ...K, rLeft: true }, 'ly');
    expect(v.pos.rx).toBeCloseTo(-0.5);
  });
});

describe('AxisCapture', () => {
  it('picks the axis with the largest deflection after the window', () => {
    const c = new AxisCapture(1, 0.4, 5);
    c.start([0, 0, -1, 0]);
    expect(c.sample([0.1, 0, -1, 0.3], 0.5)).toBeNull();
    expect(c.sample([0.1, 0, 0.2, 0.9], 0.6)).toBe(2); // axis 2 moved 1.2 from its rest value
    expect(c.active).toBe(false);
  });
  it('keeps waiting for movement, then times out with −1', () => {
    const c = new AxisCapture(1, 0.4, 3);
    c.start([0, 0]);
    expect(c.sample([0.05, 0], 1.5)).toBeNull();
    expect(c.sample([0.05, 0], 2)).toBe(-1);
  });
});

/** Minimal Window stand-in: event target + navigator.getGamepads. */
function fakeWindow(pads: (Gamepad | null)[]): Window {
  const t = new EventTarget();
  return Object.assign(t, { navigator: { getGamepads: () => pads } }) as unknown as Window;
}

function pad(axes: number[], rt = 0, mapping = 'standard'): Gamepad {
  const buttons = Array.from({ length: 17 }, (_, i) => ({ pressed: false, touched: false, value: i === 7 ? rt : 0 }));
  return { id: 'Test pad', index: 0, connected: true, mapping, axes, buttons, timestamp: 0 } as unknown as Gamepad;
}

function settings(extra: Partial<Settings>): Settings {
  return { ...cloneSettings(DEFAULT_SETTINGS), squareGate: false, ...extra };
}

describe('InputManager stick modes + remap', () => {
  it('mode 1 on a gamepad: right stick Y is throttle, left stick Y is pitch', () => {
    const im = new InputManager(fakeWindow([pad([0, -1, 0, 1])]), settings({ stickMode: 1 }));
    const f = im.poll(1 / 60);
    expect(f.control.throttle).toBe(0);
    expect(f.control.pitch).toBeCloseTo(1);
    expect(f.sticks.ly).toBeCloseTo(1);
    expect(f.sticks.ry).toBe(-1);
  });

  it('axisMap reads sticks from remapped axes and exposes raw pad values', () => {
    const axes = [0, 0, -1, 0.8, -0.6, -1];
    const im = new InputManager(fakeWindow([pad(axes, 0, '')]), settings({ axisMap: { lx: 0, ly: 1, rx: 3, ry: 4 } }));
    const f = im.poll(1 / 60);
    // Radial deadzone 0.05 on (0.8, 0.6): magnitude 1 stays 1, direction kept.
    expect(f.control.roll).toBeCloseTo(0.8, 2);
    expect(f.control.pitch).toBeCloseTo(0.6, 2);
    expect(f.pad?.mapping).toBe('');
    expect(f.pad?.axes).toEqual(axes);
    const axesRef = f.pad!.axes;
    expect(im.poll(1 / 60).pad!.axes).toBe(axesRef); // reused, no per-frame allocation
  });

  it('keyboard is mode-aware: mode 1 ↑ is throttle, W is pitch', () => {
    const win = fakeWindow([]);
    const im = new InputManager(win, settings({ stickMode: 1 }));
    const key = (type: string, code: string) => win.dispatchEvent(Object.assign(new Event(type), { code }));
    key('keydown', 'ArrowUp');
    key('keydown', 'KeyW');
    let f = im.poll(0.01);
    for (let i = 0; i < 49; i++) f = im.poll(0.01);
    expect(f.source).toBe('keyboard');
    expect(f.control.throttle).toBe(1);
    expect(f.control.pitch).toBe(1);
    key('keyup', 'ArrowUp');
    key('keyup', 'KeyW');
    for (let i = 0; i < 30; i++) f = im.poll(0.01);
    expect(f.control.throttle).toBe(0.5);
    expect(f.control.pitch).toBe(0);
    im.dispose();
  });
});
