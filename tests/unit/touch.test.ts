import { describe, expect, it } from 'vitest';
import { TouchInput, TouchSticks, stickRadius, throttleSideOf } from '../../src/input/touch';
import { InputManager } from '../../src/input/input-manager';
import { mapSticks, throttleSlot, type ChannelValues, type StickMapOptions, type StickModeNum, type StickSlot } from '../../src/input/stick';
import { DEFAULT_SETTINGS, cloneSettings, type Settings } from '../../src/core/settings';
import type { ButtonEvents } from '../../src/types';

const R = 60;
function sticks(side: 'l' | 'r' = 'l', centre = false, fixed = false): TouchSticks {
  const s = new TouchSticks();
  s.configure(side, centre, fixed, R);
  s.setAnchors(100, 300, 700, 300);
  return s;
}

describe('TouchSticks (pure stick math)', () => {
  it('floating: base spawns under the thumb, knob follows, values clamp per axis (square gate)', () => {
    const s = sticks('l');
    expect(s.down('r', 1, 600, 200)).toBe(true);
    expect([s.r.cx, s.r.cy]).toEqual([600, 200]);
    expect(s.pos.rx).toBe(0);
    expect(s.pos.ry).toBe(0);
    s.move(1, 630, 170); // right half-radius, up half-radius
    expect(s.pos.rx).toBeCloseTo(0.5);
    expect(s.pos.ry).toBeCloseTo(0.5);
    s.move(1, 800, 0); // far diagonal → both axes saturate to the square corner
    expect(s.pos.rx).toBe(1);
    expect(s.pos.ry).toBe(1);
  });

  it('non-throttle stick springs back to centre and to its anchor on release', () => {
    const s = sticks('l');
    s.down('r', 3, 600, 200);
    s.move(3, 660, 140);
    s.up(3);
    expect(s.pos.rx).toBe(0);
    expect(s.pos.ry).toBe(0);
    expect([s.r.cx, s.r.cy]).toEqual([700, 300]);
    expect(s.r.active).toBe(false);
  });

  it('throttle holds where released (non-centering) and re-grabbing does not jump', () => {
    const s = sticks('l');
    expect(s.pos.ly).toBe(-1); // starts at the bottom
    s.down('l', 7, 120, 350);
    expect(s.pos.ly).toBe(-1); // grab keeps the value
    expect(s.l.cy).toBe(350 - R); // base placed so the knob sits under the thumb
    s.move(7, 120, 350 - R * 1.5); // push up 1.5 R → +0.5
    expect(s.pos.ly).toBeCloseTo(0.5);
    s.move(7, 150, 350 - R * 1.5);
    expect(s.pos.lx).toBeCloseTo(0.5);
    s.up(7);
    expect(s.pos.ly).toBeCloseTo(0.5); // held
    expect(s.pos.lx).toBe(0); // yaw re-centres
    s.down('l', 8, 90, 250); // new grab somewhere else: still 0.5
    expect(s.pos.ly).toBeCloseTo(0.5);
    s.move(8, 90, 250 + R * 0.5);
    expect(s.pos.ly).toBeCloseTo(0);
  });

  it('auto-centre throttle springs to centre (hover) on release', () => {
    const s = sticks('l', true);
    expect(s.pos.ly).toBe(0);
    s.down('l', 1, 100, 300);
    s.move(1, 100, 300 + R);
    expect(s.pos.ly).toBe(-1);
    s.up(1);
    expect(s.pos.ly).toBe(0);
  });

  it('fixed placement: base stays at the anchor, X is absolute, throttle grabbed relatively', () => {
    const s = sticks('l', false, true);
    s.down('r', 2, 730, 330);
    expect([s.r.cx, s.r.cy]).toEqual([700, 300]);
    expect(s.pos.rx).toBeCloseTo(0.5);
    expect(s.pos.ry).toBeCloseTo(-0.5);
    s.down('l', 4, 40, 200);
    expect(s.l.cx).toBe(100);
    expect(s.pos.ly).toBe(-1);
    expect(s.pos.lx).toBe(-1);
  });

  it('multi-touch: each stick keeps its own pointerId; a second finger on a held stick is ignored', () => {
    const s = sticks('l');
    expect(s.down('l', 1, 100, 300)).toBe(true);
    expect(s.down('r', 2, 700, 300)).toBe(true);
    expect(s.down('l', 3, 120, 280)).toBe(false);
    s.move(2, 760, 300);
    s.move(3, 0, 0); // unknown pointer: no effect
    expect(s.pos.rx).toBe(1);
    expect(s.pos.lx).toBe(0);
    s.releaseAll();
    expect(s.l.active || s.r.active).toBe(false);
  });

  it('throttle side follows the stick mode (modes 1/3 right, 2/4 left) and resets old side', () => {
    const s = sticks('l');
    s.setThrottle(0.75);
    expect(s.pos.ly).toBeCloseTo(0.5);
    s.configure('r', false, false, R);
    expect(s.pos.ly).toBe(0);
    expect(s.pos.ry).toBe(-1);
    for (const m of [1, 2, 3, 4] as StickModeNum[]) expect(throttleSideOf(throttleSlot(m))).toBe(m % 2 === 0 ? 'l' : 'r');
  });

  it('mode-aware mapping through mapSticks: touch positions → channels', () => {
    const s = sticks('r'); // mode 1: throttle on the right stick
    s.down('r', 1, 700, 300);
    s.move(1, 700, 300 - 2 * R); // full up
    s.down('l', 2, 100, 300);
    s.move(2, 100, 300 - R); // left Y up = pitch in mode 1
    const o: StickMapOptions = { stickMode: 1, throttleSource: 'stick', squareGate: false, invert: { throttle: false, yaw: false, pitch: false, roll: false }, deadzone: 0.05 };
    const out: Record<StickSlot, number> = { lx: 0, ly: 0, rx: 0, ry: 0 };
    const ch: ChannelValues = { throttle: 0, yaw: 0, pitch: 0, roll: 0 };
    mapSticks(s.pos, 0, o, out, ch, true);
    expect(ch.throttle).toBe(1);
    expect(ch.pitch).toBe(1);
    expect(ch.roll).toBe(0);
  });

  it('stick radius: 60 pt phone, 72 pt tablet', () => {
    expect(stickRadius(true)).toBe(60);
    expect(stickRadius(false)).toBe(72);
  });
});

// ---------------------------------------------------------------- DOM adapter + InputManager

function fakeWindow(): Window {
  const t = new EventTarget();
  return Object.assign(t, { navigator: { getGamepads: () => [] } }) as unknown as Window;
}
const ptr = (target: EventTarget, type: string, pointerId: number, clientX: number, clientY: number, pointerType = 'touch', el?: unknown): void => {
  const e = Object.assign(new Event(type, { bubbles: true, cancelable: true }), { pointerId, clientX, clientY, pointerType });
  if (el) Object.defineProperty(e, 'target', { value: el });
  target.dispatchEvent(e);
};
function settings(extra: Partial<Settings> = {}): Settings {
  return { ...cloneSettings(DEFAULT_SETTINGS), ...extra };
}

describe('TouchInput + InputManager', () => {
  function setup(extra: Partial<Settings> = {}) {
    const win = fakeWindow();
    const im = new InputManager(win, settings(extra), true);
    const layer = new EventTarget() as unknown as HTMLElement;
    im.touch.attach(layer);
    im.touch.layout(0, 0, 800, { lx: 100, ly: 300, rx: 700, ry: 300 }, R);
    // Events dispatched on the layer do not bubble to the fake window, so forward like the DOM would.
    const down = (id: number, x: number, y: number, type = 'touch'): void => {
      ptr(win, 'pointerdown', id, x, y, type);
      ptr(layer, 'pointerdown', id, x, y, type);
    };
    return { win, im, down };
  }

  it('touch device defaults to the touch source; mode 2 left stick = throttle, starts at zero', () => {
    const { im } = setup();
    const f = im.poll(1 / 60);
    expect(f.source).toBe('touch');
    expect(f.control.throttle).toBe(0);
    im.dispose();
  });

  it('two thumbs: left pushes throttle, right pitches forward (deadzone applied, square gate off)', () => {
    const { win, im, down } = setup();
    down(1, 100, 300); // grab throttle at bottom (value -1): base centre 60 px above
    ptr(win, 'pointermove', 1, 100, 240); // centre → throttle 0.5
    down(2, 600, 200);
    ptr(win, 'pointermove', 2, 600, 200 - R); // right stick full up = pitch 1
    const f = im.poll(1 / 60);
    expect(f.source).toBe('touch');
    expect(f.control.throttle).toBeCloseTo(0.5, 1);
    expect(f.control.pitch).toBe(1);
    expect(f.sticks.ry).toBe(1);
    ptr(win, 'pointerup', 2, 0, 0);
    ptr(win, 'pointerup', 1, 0, 0);
    const g = im.poll(1 / 60);
    expect(g.control.pitch).toBe(0);
    expect(g.control.throttle).toBeCloseTo(0.5, 1); // held
    im.dispose();
  });

  it('mouse pointers never drive the sticks', () => {
    const { win, im, down } = setup();
    down(1, 100, 300, 'mouse');
    ptr(win, 'pointermove', 1, 100, 100, 'mouse');
    expect(im.poll(1 / 60).control.throttle).toBe(0);
    im.dispose();
  });

  it('on-screen buttons are edge events, merged with the other devices', () => {
    const { im } = setup();
    im.touch.press('arm');
    im.touch.press('pause');
    const f = im.poll(1 / 60);
    expect(f.buttons.arm).toBe(true);
    expect(f.buttons.pause).toBe(true);
    expect(im.poll(1 / 60).buttons.arm).toBe(false);
    const b: ButtonEvents = { arm: false, toggleMode: false, cycleCamera: false, reset: false, pause: false, confirm: false };
    im.touch.press('cycleCamera');
    im.touch.drainButtons(b);
    expect(b.cycleCamera).toBe(true);
    im.dispose();
  });

  it('keyboard takes over from touch, and touch takes back over', () => {
    const { win, im, down } = setup();
    down(1, 100, 300);
    expect(im.poll(1 / 60).source).toBe('touch');
    win.dispatchEvent(Object.assign(new Event('keydown'), { code: 'KeyW' }));
    expect(im.poll(1 / 60).source).toBe('keyboard');
    win.dispatchEvent(Object.assign(new Event('keyup'), { code: 'KeyW' }));
    ptr(win, 'pointerup', 1, 0, 0);
    down(2, 600, 300);
    expect(im.poll(1 / 60).source).toBe('touch');
    im.dispose();
  });

  it('non-touch device without input stays on "none"', () => {
    const im = new InputManager(fakeWindow(), settings(), false);
    expect(im.poll(1 / 60).source).toBe('none');
    im.dispose();
  });

  it('settings: stick mode moves the throttle to the right stick; auto-centre throttle rests at 50 %', () => {
    const { im } = setup({ stickMode: 1, touchThrottleCentre: true });
    const f = im.poll(1 / 60);
    expect(im.touch.sticks.r.holdsThrottle).toBe(true);
    expect(f.control.throttle).toBeCloseTo(0.5, 1);
    im.dispose();
  });

  it('pointer handlers do not allocate stick state (same objects every event)', () => {
    const t = new TouchInput();
    const pos = t.sticks.pos;
    t.sticks.down('l', 1, 10, 10);
    t.sticks.move(1, 20, 20);
    expect(t.sticks.pos).toBe(pos);
  });
});
