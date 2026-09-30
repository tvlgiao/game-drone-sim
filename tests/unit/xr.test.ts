import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/core/settings';
import { isQuestBrowser } from '../../src/core/xr';
import { InputManager } from '../../src/input/input-manager';
import { XR_BTN, XrControllers, type XrSourceLike } from '../../src/input/xr-controllers';
import { xrHudContent, type XrHudState } from '../../src/ui/xr-hud';
import type { RaceSnapshot } from '../../src/types';

/** Quest Touch controller: xr-standard, thumbstick on axes 2/3 (Y +down). */
function touch(hand: 'left' | 'right', stickX = 0, stickY = 0, pressed: number[] = []): XrSourceLike {
  return {
    handedness: hand,
    gamepad: {
      axes: [0, 0, stickX, stickY],
      buttons: Array.from({ length: 7 }, (_, i) => ({ pressed: pressed.includes(i), value: pressed.includes(i) ? 1 : 0 })),
    },
  };
}

function fakeWindow(): Window {
  const t = new EventTarget();
  return Object.assign(t, { navigator: { getGamepads: () => [] } }) as unknown as Window;
}

describe('XrControllers', () => {
  it('reads left/right thumbsticks with Y flipped to +up', () => {
    const xr = new XrControllers();
    xr.latched = false;
    xr.setSources(() => [touch('left', 0.2, -0.5), touch('right', -0.3, 0.4)]);
    xr.poll(0);
    expect(xr.connected).toBe(true);
    expect(xr.pos).toEqual({ lx: 0.2, ly: 0.5, rx: -0.3, ry: -0.4 });
  });

  it('maps A/B to the right hand and X/Y to the left, as rising edges', () => {
    const xr = new XrControllers();
    xr.setSources(() => [touch('left', 0, 0, [XR_BTN.LOWER]), touch('right', 0, 0, [XR_BTN.UPPER])]);
    xr.poll(0);
    expect(xr.pressed).toMatchObject({ x: true, b: true, a: false, y: false });
    xr.poll(16);
    expect(xr.pressed).toMatchObject({ x: false, b: false });
    expect(xr.held).toMatchObject({ x: true, b: true });
  });

  it('holds the throttle stick at the bottom until pushed above centre (take-off latch)', () => {
    const xr = new XrControllers();
    xr.setThrottleSlot('ly');
    xr.setSources(() => [touch('left', 0, 0), touch('right')]);
    xr.poll(0);
    expect(xr.pos.ly).toBe(-1);
    // pulling down keeps the latch; a push above centre releases it
    xr.setSources(() => [touch('left', 0, 0.8), touch('right')]);
    xr.poll(16);
    expect(xr.latched).toBe(true);
    xr.setSources(() => [touch('left', 0, -0.5), touch('right')]);
    xr.poll(32);
    expect(xr.latched).toBe(false);
    expect(xr.pos.ly).toBe(0.5);
    xr.setSources(() => [touch('left', 0, 0), touch('right')]);
    xr.poll(48);
    expect(xr.pos.ly).toBe(0);
  });

  it('re-reads the sources every poll (controllers appear after the session starts)', () => {
    const xr = new XrControllers();
    let current: XrSourceLike[] = [];
    xr.setSources(() => current);
    xr.poll(0);
    expect(xr.connected).toBe(false);
    current = [touch('left'), touch('right', 0, 0, [XR_BTN.LOWER])];
    xr.poll(16);
    expect(xr.connected).toBe(true);
    expect(xr.pressed.a).toBe(true);
  });

  it('is not connected with one controller and clears on session end', () => {
    const xr = new XrControllers();
    xr.setSources(() => [touch('right', 0.9, 0)]);
    xr.poll(0);
    expect(xr.connected).toBe(false);
    xr.setSources(null);
    expect(xr.active).toBe(false);
    expect(xr.pos.rx).toBe(0);
  });
});

describe('InputManager with XR controllers', () => {
  it('switches to the xr source while a session runs and maps Mode 2 with a centred hover throttle', () => {
    const im = new InputManager(fakeWindow(), { ...DEFAULT_SETTINGS, stickMode: 2 });
    im.xr.setSources(() => [touch('left', 0, 0), touch('right', 0.5, -0.5)]);
    im.xr.latched = false;
    const f = im.poll(1 / 72);
    expect(f.source).toBe('xr');
    expect(f.xr).not.toBeNull();
    expect(f.control.throttle).toBeCloseTo(0.5, 1);
    expect(f.control.roll).toBeGreaterThan(0);
    expect(f.control.pitch).toBeGreaterThan(0);
  });

  it('A arms, B toggles mode, X resets, Y pauses, right stick click cycles the camera', () => {
    const im = new InputManager(fakeWindow(), { ...DEFAULT_SETTINGS });
    im.xr.setSources(() => [touch('left', 0, 0, [XR_BTN.LOWER, XR_BTN.UPPER]), touch('right', 0, 0, [XR_BTN.LOWER, XR_BTN.UPPER, XR_BTN.STICK])]);
    const b = im.poll(1 / 72).buttons;
    expect(b).toMatchObject({ arm: true, confirm: true, toggleMode: true, reset: true, pause: true, cycleCamera: true });
  });

  it('latches the throttle at zero so the drone can arm with a centred thumbstick', () => {
    const im = new InputManager(fakeWindow(), { ...DEFAULT_SETTINGS });
    im.xr.setSources(() => [touch('left'), touch('right')]);
    im.latchTakeoff();
    const f = im.poll(1 / 72);
    expect(f.control.throttle).toBe(0);
    expect(im.takeoffLatched).toBe(true);
  });

  it('leaves the xr source when the session ends', () => {
    const im = new InputManager(fakeWindow(), { ...DEFAULT_SETTINGS });
    im.xr.setSources(() => [touch('left'), touch('right')]);
    expect(im.poll(1 / 72).source).toBe('xr');
    im.xr.setSources(null);
    const f = im.poll(1 / 72);
    expect(f.source).not.toBe('xr');
    expect(f.xr).toBeNull();
  });
});

describe('xrHudContent', () => {
  const race = (p: Partial<RaceSnapshot>): RaceSnapshot => ({ status: 'menu', time: 0, countdown: 0, nextRing: 0, totalRings: 10, bestTime: null, lastSplit: null, ...p });
  const state = (p: Partial<XrHudState>): XrHudState => ({ race: race({}), armed: false, latched: false, mode: 'angle', camera: 'los', altitude: 1.23, speed: 0, toast: '', ...p });

  it('menu screens sit at eye level with Quest button hints', () => {
    const c = xrHudContent(state({}));
    expect(c.layout).toBe('menu');
    expect(c.hint).toContain('A Race');
    expect(xrHudContent(state({ race: race({ status: 'paused' }) })).hint).toContain('A Resume');
    expect(xrHudContent(state({ race: race({ status: 'finished', time: 12.5 }) })).title).toBe('FINISH 00:12.50');
  });

  it('flight HUD shows timer, ring, flight line and the take-off hint while latched', () => {
    const c = xrHudContent(state({ race: race({ status: 'racing', time: 3.2, nextRing: 2 }), armed: true, latched: true }));
    expect(c.layout).toBe('hud');
    expect(c.title).toBe('00:03.20 · Ring 3/10');
    expect(c.sub).toBe('ARMED · ANGLE · LOS · 1.2 m');
    expect(c.hint).toBe('Push throttle up to take off');
  });

  it('a toast replaces the hint line', () => {
    expect(xrHudContent(state({ race: race({ status: 'freefly' }), toast: 'ACRO mode' })).hint).toBe('ACRO mode');
  });
});

describe('isQuestBrowser', () => {
  it('detects Quest Browser user agents only', () => {
    expect(isQuestBrowser('Mozilla/5.0 (X11; Linux x86_64; Quest 2) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/35.0 Chrome/128.0 VR Safari/537.36')).toBe(true);
    expect(isQuestBrowser('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128.0 Safari/537.36')).toBe(false);
  });
});
