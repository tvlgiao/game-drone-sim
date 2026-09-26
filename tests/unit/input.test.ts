import { describe, expect, it } from 'vitest';
import {
  EdgeDetector,
  RepeatTrigger,
  applyAxialDeadzone,
  applyRadialDeadzone,
  stickToThrottle,
  triggerToThrottle,
} from '../../src/input/stick';
import { InputManager } from '../../src/input/input-manager';
import { DEFAULT_SETTINGS } from '../../src/core/settings';

describe('applyRadialDeadzone', () => {
  it('zeroes inside the deadzone', () => {
    expect(applyRadialDeadzone(0.03, 0.03, 0.05)).toEqual({ x: 0, y: 0 });
  });
  it('rescales so output starts at 0 just outside and reaches 1 at full', () => {
    const a = applyRadialDeadzone(0.0501, 0, 0.05);
    expect(a.x).toBeGreaterThan(0);
    expect(a.x).toBeLessThan(0.001);
    expect(applyRadialDeadzone(1, 0, 0.05).x).toBeCloseTo(1);
    expect(applyRadialDeadzone(0.525, 0, 0.05).x).toBeCloseTo(0.5);
  });
  it('keeps direction and clamps diagonal magnitude to 1', () => {
    const v = applyRadialDeadzone(1, -1, 0.05);
    expect(Math.hypot(v.x, v.y)).toBeCloseTo(1);
    expect(v.x).toBeCloseTo(-v.y);
  });
  it('writes into the provided object', () => {
    const out = { x: 9, y: 9 };
    expect(applyRadialDeadzone(0.5, 0, 0.1, out)).toBe(out);
  });
});

describe('applyAxialDeadzone', () => {
  it('keeps sign and rescales', () => {
    expect(applyAxialDeadzone(0.04, 0.05)).toBe(0);
    expect(applyAxialDeadzone(-1, 0.05)).toBeCloseTo(-1);
    expect(applyAxialDeadzone(0.525, 0.05)).toBeCloseTo(0.5);
  });
});

describe('throttle mapping', () => {
  it('left stick: full range, down = 0, centre = 0.5, up = 1', () => {
    expect(stickToThrottle(1)).toBe(0);
    expect(stickToThrottle(0.97)).toBe(0); // low-end deadzone makes 0 reachable
    expect(stickToThrottle(0)).toBeCloseTo(0.5, 1);
    expect(stickToThrottle(-1)).toBe(1);
    expect(stickToThrottle(-0.99)).toBe(1);
  });
  it('left stick is monotonic', () => {
    let prev = -1;
    for (let y = 1; y >= -1; y -= 0.05) {
      const t = stickToThrottle(y);
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
  });
  it('right trigger: 0..1 with end deadzones', () => {
    expect(triggerToThrottle(0)).toBe(0);
    expect(triggerToThrottle(0.01)).toBe(0);
    expect(triggerToThrottle(0.5)).toBeCloseTo(0.5, 1);
    expect(triggerToThrottle(1)).toBe(1);
    expect(triggerToThrottle(1.2)).toBe(1);
  });
});

describe('EdgeDetector', () => {
  it('fires only on the rising edge', () => {
    const e = new EdgeDetector();
    expect([false, true, true, false, true].map((p) => e.update(p))).toEqual([false, true, false, false, true]);
  });
});

describe('RepeatTrigger', () => {
  it('fires on press, then after the delay at the repeat interval', () => {
    const r = new RepeatTrigger(0.4, 0.1);
    const fired: number[] = [];
    for (let i = 0; i < 70; i++) if (r.update(true, 0.01)) fired.push(i);
    expect(fired[0]).toBe(0);
    expect(fired[1]).toBeGreaterThanOrEqual(39);
    expect(fired[1]).toBeLessThanOrEqual(41);
    expect(fired.length).toBe(4);
    expect(r.update(false, 0.01)).toBe(false);
    expect(r.update(true, 0.01)).toBe(true);
  });
});

/** Minimal Window stand-in: event target + navigator.getGamepads. */
function fakeWindow(pads: (Gamepad | null)[]): Window {
  const t = new EventTarget();
  return Object.assign(t, { navigator: { getGamepads: () => pads } }) as unknown as Window;
}

function fakePad(axes: number[], pressed: number[] = [], rt = 0): Gamepad {
  const buttons = Array.from({ length: 17 }, (_, i) => ({
    pressed: pressed.includes(i),
    touched: false,
    value: i === 7 ? rt : pressed.includes(i) ? 1 : 0,
  }));
  return { id: 'Xbox Wireless Controller', index: 0, connected: true, mapping: 'standard', axes, buttons, timestamp: 0 } as unknown as Gamepad;
}

describe('InputManager (gamepad, Mode 2)', () => {
  it('maps sticks: LY throttle, LX yaw, RX roll, RY pitch (up = +)', () => {
    const pad = fakePad([0.5, -1, 0.5, -1]);
    const im = new InputManager(fakeWindow([pad]), { ...DEFAULT_SETTINGS });
    const f = im.poll(1 / 60);
    expect(f.source).toBe('gamepad');
    expect(f.control.throttle).toBe(1);
    expect(f.control.yaw).toBeGreaterThan(0.4);
    expect(f.control.roll).toBeGreaterThan(0.3);
    expect(f.control.pitch).toBeGreaterThan(0.8);
    im.dispose();
  });

  it('trigger throttle source', () => {
    const pad = fakePad([0, 0, 0, 0], [], 0.75);
    const im = new InputManager(fakeWindow([pad]), { ...DEFAULT_SETTINGS, throttleSource: 'trigger' });
    expect(im.poll(1 / 60).control.throttle).toBeCloseTo(0.75, 1);
  });

  it('buttons are edge-triggered; A = arm + confirm, B = reset + back', () => {
    const pads: (Gamepad | null)[] = [fakePad([0, 1, 0, 0], [0])];
    const im = new InputManager(fakeWindow(pads), { ...DEFAULT_SETTINGS });
    let f = im.poll(1 / 60);
    expect(f.buttons.arm && f.buttons.confirm).toBe(true);
    f = im.poll(1 / 60);
    expect(f.buttons.arm).toBe(false);
    pads[0] = fakePad([0, 1, 0, 0], [1, 3, 5, 9]);
    f = im.poll(1 / 60);
    expect(f.buttons).toMatchObject({ reset: true, toggleMode: true, cycleCamera: true, pause: true, arm: false });
    expect(f.nav.back).toBe(true);
  });

  it('d-pad produces nav events', () => {
    const pads: (Gamepad | null)[] = [fakePad([0, 0, 0, 0], [13])];
    const im = new InputManager(fakeWindow(pads), { ...DEFAULT_SETTINGS });
    expect(im.poll(1 / 60).nav.down).toBe(true);
    expect(im.poll(1 / 60).nav.down).toBe(false);
  });

  it('no devices → source none, zero control', () => {
    const im = new InputManager(fakeWindow([]), { ...DEFAULT_SETTINGS });
    const f = im.poll(1 / 60);
    expect(f.source).toBe('none');
    expect(f.control).toEqual({ throttle: 0, yaw: 0, pitch: 0, roll: 0 });
  });
});
