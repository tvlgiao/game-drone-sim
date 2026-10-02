import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { DEFAULT_SETTINGS, cloneSettings, type Settings } from '../../src/core/settings';
import { InputManager, KEY_BUTTON, holdsAltitude, type HintedInputFrame } from '../../src/input/input-manager';
import { MOUSE_HOLD_TRAVEL, MouseStick, mouseStickKind, releasePointerLock, type MouseStickOptions } from '../../src/input/mouse';
import { actionGlyphs, channelHints, glyphHtml, hintScheme, keyCluster, padFamily, type Glyph, type HintScheme } from '../../src/ui/input-glyphs';
import { Simulation } from '../../src/physics/simulation';
import { EMPTY_LEVEL } from './physics-helpers';

const labels = (gs: Glyph[]): string[] => gs.map((g) => g.label || g.name);
const settings = (extra: Partial<Settings> = {}): Settings => ({ ...cloneSettings(DEFAULT_SETTINGS), ...extra });

describe('controller family from the Gamepad id', () => {
  it.each([
    ['Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', 'xbox'],
    ['045e-02ea-Controller', 'xbox'],
    ['xinput', 'xbox'],
    ['DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)', 'playstation'],
    ['Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)', 'playstation'],
    ['054c-05c4-Wireless Controller', 'playstation'],
    ['8BitDo Pro 2 (STANDARD GAMEPAD Vendor: 2dc8 Product: 6006)', 'generic'],
    [null, 'generic'],
  ] as const)('%s → %s', (id, family) => {
    expect(padFamily(id)).toBe(family);
  });

  it('scheme follows the active source; no source yet = keyboard', () => {
    expect(hintScheme('gamepad', 'DualSense Wireless Controller')).toBe('playstation');
    expect(hintScheme('gamepad', 'Xbox 360 Controller')).toBe('xbox');
    expect(hintScheme('xr', null)).toBe('quest');
    expect(hintScheme('touch', null)).toBe('touch');
    expect(hintScheme('keyboard', 'Xbox 360 Controller')).toBe('keyboard');
    expect(hintScheme('none', null)).toBe('keyboard');
  });
});

describe('action glyphs', () => {
  const all = (scheme: HintScheme) =>
    Object.fromEntries((['arm', 'toggleMode', 'cycleCamera', 'reset', 'pause', 'headingArrow', 'recenter', 'legend', 'mouseCentre'] as const).map((a) => [a, labels(actionGlyphs(scheme, a))]));

  it('keyboard: the real key bindings', () => {
    expect(all('keyboard')).toEqual({
      arm: ['Space'],
      toggleMode: ['M'],
      cycleCamera: ['C'],
      reset: ['R'],
      pause: ['Esc'],
      headingArrow: [],
      recenter: [],
      legend: ['H'],
      mouseCentre: ['Z'],
    });
    // read from the input tables, not a copy of them
    expect(actionGlyphs('keyboard', 'arm')[0]!.label).toBe(KEY_BUTTON.arm[0]);
  });

  it('Xbox: coloured A/B/X/Y, RB, View / Menu', () => {
    expect(all('xbox')).toMatchObject({ arm: ['A'], toggleMode: ['Y'], cycleCamera: ['RB'], reset: ['B'], pause: ['☰'], legend: ['⧉'], headingArrow: [] });
    expect(actionGlyphs('xbox', 'arm')[0]).toMatchObject({ style: 'face', tone: 'green' });
    expect(actionGlyphs('xbox', 'toggleMode')[0]).toMatchObject({ tone: 'yellow' });
    expect(actionGlyphs('xbox', 'reset')[0]).toMatchObject({ tone: 'red' });
    expect(actionGlyphs('xbox', 'pause')[0]!.name).toBe('Menu');
  });

  it('PlayStation: ✕ ○ □ △ shapes, R1, Create / Options', () => {
    expect(all('playstation')).toMatchObject({ arm: ['Cross'], toggleMode: ['Triangle'], cycleCamera: ['R1'], reset: ['Circle'], pause: ['Options'], legend: ['Create'] });
    expect(actionGlyphs('playstation', 'arm')[0]).toMatchObject({ shape: 'cross', label: '' });
  });

  it('generic pads: neutral A/B/X/Y, Back / Start', () => {
    expect(all('generic')).toMatchObject({ arm: ['A'], pause: ['Start'], legend: ['Back'] });
    expect(actionGlyphs('generic', 'arm')[0]!.tone).toBeUndefined();
  });

  it('Quest: every flight action incl. recentre and heading arrow', () => {
    expect(all('quest')).toEqual({
      arm: ['A'],
      toggleMode: ['B'],
      cycleCamera: ['R'],
      reset: ['X'],
      pause: ['Y'],
      headingArrow: ['L trigger'],
      recenter: ['L'],
      legend: [],
      mouseCentre: [],
    });
    expect(actionGlyphs('quest', 'cycleCamera')[0]).toMatchObject({ style: 'stick', press: true, name: 'Right stick click' });
  });

  it('touch: nothing (the on-screen buttons label themselves)', () => {
    for (const v of Object.values(all('touch'))) expect(v).toEqual([]);
  });

  it('PS glyph markup carries an accessible name and a drawn shape', () => {
    const html = glyphHtml(actionGlyphs('playstation', 'arm')[0]!);
    expect(html).toContain('aria-label="Cross"');
    expect(html).toContain('<svg');
    expect(glyphHtml(actionGlyphs('keyboard', 'reset')[0]!)).toBe('<kbd class="ds-g ds-g--key">R</kbd>');
  });
});

describe('stick legend per stick mode and throttle source', () => {
  const kb = (mode: 1 | 2 | 3 | 4, mouse = false, extra: Partial<Settings> = {}) =>
    Object.fromEntries(channelHints('keyboard', settings({ stickMode: mode, ...extra }), mouse).map((c) => [c.channel, labels(c.glyphs)]));

  it.each([
    [1, { throttle: ['↑', '↓'], yaw: ['A', 'D'], pitch: ['W', 'S'], roll: ['←', '→'] }],
    [2, { throttle: ['W', 'S'], yaw: ['A', 'D'], pitch: ['↑', '↓'], roll: ['←', '→'] }],
    [3, { throttle: ['↑', '↓'], yaw: ['←', '→'], pitch: ['W', 'S'], roll: ['A', 'D'] }],
    [4, { throttle: ['W', 'S'], yaw: ['←', '→'], pitch: ['↑', '↓'], roll: ['A', 'D'] }],
  ] as const)('keyboard mode %i', (mode, want) => {
    expect(kb(mode)).toEqual(want);
  });

  it('keyboard throttle says centre = hover', () => {
    expect(channelHints('keyboard', settings()).find((c) => c.channel === 'throttle')!.note).toBe('centre = hover');
  });

  it('gamepad: stick per channel, or the RT / R2 trigger as throttle', () => {
    const pad = channelHints('xbox', settings({ stickMode: 1 }));
    expect(pad.find((c) => c.channel === 'throttle')!.glyphs[0]!.label).toBe('R');
    expect(pad.find((c) => c.channel === 'pitch')!.glyphs[0]!.label).toBe('L');
    const rt = channelHints('xbox', settings({ throttleSource: 'trigger' })).find((c) => c.channel === 'throttle')!;
    expect(labels(rt.glyphs)).toEqual(['RT']);
    expect(labels(channelHints('playstation', settings({ throttleSource: 'trigger' }))[0]!.glyphs)).toEqual(['R2']);
  });

  it('keyboard + mouse: mouse on pitch + roll; mouse X on yaw moves roll to the yaw keys', () => {
    expect(kb(2, true)).toMatchObject({ pitch: ['↕', '↑', '↓'], roll: ['↔', '←', '→'], yaw: ['A', 'D'] });
    expect(kb(2, true, { mouseXAxis: 'yaw' })).toMatchObject({ yaw: ['↔', '←', '→'], roll: ['A', 'D'] });
  });

  it('HUD key clusters follow the stick wells', () => {
    const l = keyCluster(settings(), 'l', false);
    expect(labels([l.up, l.left, l.down, l.right])).toEqual(['W', 'A', 'S', 'D']);
    const r = keyCluster(settings(), 'r', true);
    expect(labels([r.up, r.left, r.down, r.right])).toEqual(['↑', '←', '↓', '→']);
    expect(r).toMatchObject({ mouseV: true, mouseH: true });
    expect(keyCluster(settings(), 'l', true)).toMatchObject({ mouseV: false, mouseH: false });
    const yaw = keyCluster(settings({ mouseXAxis: 'yaw' }), 'l', true);
    expect(labels([yaw.left, yaw.right])).toEqual(['←', '→']);
    expect(yaw.mouseH).toBe(true);
  });
});

const MO: MouseStickOptions = { mouseSensitivity: 1, mouseInvertY: false, mouseExpo: 0, mouseDeadzone: 0 };

describe('MouseStick', () => {
  it("'hold': the stick stays where the mouse left it, clamped to its circle", () => {
    const m = new MouseStick();
    m.feed(MOUSE_HOLD_TRAVEL / 2, 0);
    m.update(1 / 60, 'hold', MO);
    expect(m.out.x).toBeCloseTo(0.5);
    for (let i = 0; i < 120; i++) m.update(1 / 60, 'hold', MO);
    expect(m.out.x).toBeCloseTo(0.5);
    m.feed(5 * MOUSE_HOLD_TRAVEL, -5 * MOUSE_HOLD_TRAVEL);
    m.update(1 / 60, 'hold', MO);
    expect(Math.hypot(m.out.x, m.out.y)).toBeCloseTo(1);
    expect(m.out.y).toBeGreaterThan(0); // pushed away = stick forward
  });

  it("'hold': pushing past the edge does not wind up: moving back comes off the edge at once", () => {
    const m = new MouseStick();
    m.feed(10 * MOUSE_HOLD_TRAVEL, 0);
    m.update(1 / 60, 'hold', MO);
    m.feed(-MOUSE_HOLD_TRAVEL / 2, 0);
    m.update(1 / 60, 'hold', MO);
    expect(m.out.x).toBeCloseTo(0.5);
  });

  it("'spring': deflects while moving, back at centre ~0.15 s after the mouse stops", () => {
    const m = new MouseStick();
    for (let i = 0; i < 10; i++) {
      m.feed(10, 0);
      m.update(1 / 100, 'spring', MO);
    }
    expect(m.out.x).toBeGreaterThan(0.5);
    for (let i = 0; i < 15; i++) m.update(1 / 100, 'spring', MO);
    expect(Math.abs(m.out.x)).toBeLessThan(0.06);
  });

  it('sensitivity scales, invert Y flips, deadzone swallows a nudge, expo softens the centre', () => {
    const at = (o: Partial<MouseStickOptions>, dx: number, dy: number) => {
      const m = new MouseStick();
      m.feed(dx, dy);
      m.update(1 / 60, 'hold', { ...MO, ...o });
      return m.out;
    };
    expect(at({ mouseSensitivity: 2 }, 30, 0).x).toBeCloseTo(0.2);
    expect(at({}, 0, -30).y).toBeCloseTo(0.1);
    expect(at({ mouseInvertY: true }, 0, -30).y).toBeCloseTo(-0.1);
    expect(at({ mouseDeadzone: 0.05 }, 6, 0).x).toBe(0);
    expect(at({ mouseExpo: 1 }, MOUSE_HOLD_TRAVEL / 2, 0).x).toBeCloseTo(0.125);
  });

  it("'auto' is hold in Angle and spring in Acro; switching kind re-centres", () => {
    expect(mouseStickKind('auto', 'angle')).toBe('hold');
    expect(mouseStickKind('auto', 'acro')).toBe('spring');
    expect(mouseStickKind('hold', 'acro')).toBe('hold');
    expect(mouseStickKind('spring', 'angle')).toBe('spring');
    const m = new MouseStick();
    m.feed(100, 0);
    m.update(1 / 60, 'hold', MO);
    m.update(1 / 60, 'spring', MO);
    expect(m.out.x).toBe(0);
  });
});

/** Window + document stand-in with keys, pointer lock and mouse motion. */
/** linear mouse (no expo / deadzone) so stick values read straight off the pixel counts */
const LINEAR: Partial<Settings> = { mouseExpo: 0, mouseDeadzone: 0 };

function env(s: Settings = settings(LINEAR)) {
  const doc = Object.assign(new EventTarget(), {
    pointerLockElement: null as unknown,
    exitPointerLock(): void {
      doc.pointerLockElement = null;
      doc.dispatchEvent(new Event('pointerlockchange'));
    },
  });
  const win = Object.assign(new EventTarget(), { navigator: { getGamepads: () => [] }, document: doc }) as unknown as Window;
  const im = new InputManager(win, s);
  const key = (type: 'keydown' | 'keyup', code: string): boolean => win.dispatchEvent(Object.assign(new Event(type), { code }));
  const tap = (code: string): void => {
    key('keydown', code);
    key('keyup', code);
  };
  const lock = (): void => {
    doc.pointerLockElement = {};
    doc.dispatchEvent(new Event('pointerlockchange'));
  };
  const loseLock = (): void => {
    doc.pointerLockElement = null;
    doc.dispatchEvent(new Event('pointerlockchange'));
  };
  const move = (x: number, y: number): boolean => doc.dispatchEvent(Object.assign(new Event('mousemove'), { movementX: x, movementY: y }));
  const polls = (n: number, dt = 1 / 60): HintedInputFrame => {
    let f = im.poll(dt);
    for (let i = 1; i < n; i++) f = im.poll(dt);
    return f;
  };
  return { doc: doc as unknown as Document, im, key, tap, lock, loseLock, move, polls };
}

describe('InputManager: keyboard + mouse', () => {
  it('pointer lock + motion makes it the keyboard + mouse scheme: mouse X rolls, mouse Y pitches (mode 2)', () => {
    const e = env();
    e.lock();
    e.move(60, -30);
    const f = e.polls(1);
    expect(f.source).toBe('keyboard');
    expect(f.mouse).toBe(true);
    expect(f.control.roll).toBeCloseTo(0.2, 2);
    expect(f.control.pitch).toBeCloseTo(0.1, 2);
    expect(f.mouseStick).toMatchObject({ kind: 'hold' });
  });

  it('mouse X on yaw: the mouse yaws and A/D roll', () => {
    const e = env(settings({ ...LINEAR, mouseXAxis: 'yaw' }));
    e.lock();
    e.move(60, 0);
    e.key('keydown', 'KeyD');
    const f = e.polls(30);
    expect(f.control.yaw).toBeCloseTo(0.2, 2);
    expect(f.control.roll).toBe(1);
  });

  it("'auto' follows the live flight mode: Angle holds the tilt, Acro springs back", () => {
    const s = settings(LINEAR);
    const e = env(s);
    e.lock();
    e.move(60, 0);
    expect(e.polls(60).control.roll).toBeCloseTo(0.2, 2);
    e.im.altitudeHold({ ...s, flightMode: 'acro' });
    e.move(60, 0);
    expect(e.polls(1).control.roll).toBeGreaterThan(0.3);
    expect(e.polls(20).control.roll).toBeCloseTo(0, 2);
  });

  it('Z snaps the held mouse stick back to centre', () => {
    const e = env();
    e.lock();
    e.move(90, 0);
    expect(e.polls(5).control.roll).toBeCloseTo(0.3, 2);
    e.tap('KeyZ');
    expect(e.polls(1).control.roll).toBe(0);
  });

  it('losing the lock unexpectedly (Esc, alt-tab) pauses once; the game releasing it does not', () => {
    const e = env();
    e.lock();
    e.polls(1);
    e.loseLock();
    expect(e.polls(1).buttons.pause).toBe(true);
    expect(e.polls(1).buttons.pause).toBe(false);
    e.lock();
    e.polls(1);
    releasePointerLock(e.doc);
    expect(e.polls(1).buttons.pause).toBe(false);
  });

  it('the Escape that broke the lock does not also resume the flight', () => {
    const e = env();
    e.lock();
    e.polls(1);
    e.loseLock();
    expect(e.polls(1).buttons.pause).toBe(true);
    e.tap('Escape');
    const f = e.polls(1);
    expect(f.buttons.pause).toBe(false);
    expect(f.nav.back).toBe(false);
  });

  it('an Escape tapped just before the unlock is the pause itself: one pause edge', () => {
    const e = env();
    e.lock();
    e.polls(1);
    e.tap('Escape');
    e.loseLock();
    expect(e.polls(1).buttons.pause).toBe(true);
    expect(e.polls(1).buttons.pause).toBe(false);
  });

  it('H toggles the Controls legend (rising edge)', () => {
    const e = env();
    e.key('keydown', 'KeyH');
    expect(e.polls(1).legend).toBe(true);
    expect(e.polls(1).legend).toBe(false);
  });
});

describe('keyboard flies with altitude hold (centre = hover)', () => {
  it('sources whose throttle centres hold altitude', () => {
    const s = settings();
    expect(holdsAltitude('keyboard', s)).toBe(true);
    expect(holdsAltitude('xr', s)).toBe(true);
    expect(holdsAltitude('touch', s)).toBe(true);
    expect(holdsAltitude('touch', { touchThrottleCentre: false })).toBe(false);
    expect(holdsAltitude('gamepad', s)).toBe(false);
    expect(holdsAltitude('none', s)).toBe(false);
  });

  it('Space arms after the throttle sprang back to hover; a held W still blocks it', () => {
    const e = env();
    e.key('keydown', 'KeyW');
    e.polls(30);
    e.key('keyup', 'KeyW');
    expect(e.polls(30).control.throttle).toBe(0.5);
    e.tap('Space');
    const f = e.polls(1);
    expect(f.buttons.arm).toBe(true);
    expect(f.control.throttle).toBe(0);
    expect(e.im.takeoffLatched).toBe(true);
    expect(f.latched).toBe(true);
    e.key('keydown', 'KeyW');
    e.polls(1);
    expect(e.im.takeoffLatched).toBe(false);
    e.polls(30);
    e.tap('Space');
    expect(e.polls(1).control.throttle).toBeGreaterThan(0.9);
  });

  it('closed loop: arm on the ground, hold W to climb, release holds altitude, hold S lands', () => {
    const s = settings();
    const e = env(s);
    const sim = new Simulation(EMPTY_LEVEL, undefined, 3);
    sim.reset(new Vector3(0, 0.1, 0), 0);
    const FRAME = 1 / 60;
    const fly = (seconds: number): void => {
      for (let t = 0; t < seconds; t += FRAME) {
        const f = e.im.poll(FRAME);
        sim.fc.altitudeHold = e.im.altitudeHold(s);
        if (f.buttons.arm) sim.setArmed(!sim.fc.armed, f.control);
        for (let i = 0; i < 16; i++) sim.step(FRAME / 16, f.control);
      }
    };
    const y = (): number => sim.world.state.position.y;
    fly(0.5);
    e.tap('Space');
    fly(1);
    expect(sim.fc.armed).toBe(true);
    expect(y()).toBeLessThan(0.3); // latched: idles on the ground
    e.key('keydown', 'KeyW');
    fly(1.2);
    e.key('keyup', 'KeyW');
    expect(y()).toBeGreaterThan(1.5);
    fly(1);
    const y0 = y();
    fly(3);
    expect(Math.abs(y() - y0)).toBeLessThan(0.15);
    e.key('keydown', 'KeyS');
    fly(4);
    expect(y()).toBeLessThan(0.3);
    e.key('keyup', 'KeyS');
    e.tap('Space');
    fly(0.2);
    expect(sim.fc.armed).toBe(false);
  });
});
