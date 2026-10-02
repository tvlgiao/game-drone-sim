import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/core/settings';
import * as THREE from 'three';
import { XR_TARGET_FPS, isQuestBrowser, tuneXrSession, xrSessionObscured } from '../../src/core/xr';
import { XR_CAP_RATIO, XR_CARD_H, XR_CARD_PX, XR_CARD_TEXT_W, XR_CARD_W, XR_HUD_DOWN, XR_MENU_HINT_PX, layoutCard, wrapHint, xrPanelPose } from '../../src/render/xr-panel';
import { InputManager } from '../../src/input/input-manager';
import { XR_BTN, XR_YAW_SCALE, XrControllers, shapeXrControl, xrExpo, type XrSourceLike } from '../../src/input/xr-controllers';
import { actualRate, RATE_PRESETS } from '../../src/control/rates';
import { loadSettings } from '../../src/core/settings';
import { XR_APP_EXIT_HINT, xrHudContent, type XrHudState } from '../../src/ui/xr-hud';
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

const race = (p: Partial<RaceSnapshot>): RaceSnapshot => ({ status: 'menu', time: 0, countdown: 0, nextRing: 0, totalRings: 10, bestTime: null, lastSplit: null, ...p });
const state = (p: Partial<XrHudState>): XrHudState => ({ race: race({}), armed: false, latched: false, mode: 'angle', camera: 'los', altitude: 1.23, speed: 0, toast: '', ...p });

describe('xrHudContent', () => {

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

  it('armed and disarmed flight cards list every flight button: B mode, X reset, stick-click camera, Y pause', () => {
    for (const armed of [true, false]) {
      const hint = xrHudContent(state({ race: race({ status: 'freefly' }), armed })).hint;
      for (const part of [armed ? 'A disarm' : 'A arm', 'B mode', 'X reset', 'R-stick click cam', 'Y pause']) expect(hint, `armed=${armed}`).toContain(part);
    }
  });

  it('pause card spells out the left trigger; free fly shows speed in km/h like the flat HUD', () => {
    expect(xrHudContent(state({ race: race({ status: 'paused' }) })).sub).toContain('L-trigger heading arrow');
    expect(xrHudContent(state({ race: race({ status: 'freefly' }), speed: 5 })).title).toBe('FREE FLY · 18 km/h');
  });

  it('menus offer B Exit VR in the browser and B 2D menu in the installed Quest app', () => {
    for (const status of ['menu', 'paused', 'finished'] as const) {
      expect(xrHudContent(state({ race: race({ status }) })).hint).toContain('B Exit VR');
      const app = xrHudContent(state({ race: race({ status }), exitHint: XR_APP_EXIT_HINT })).hint;
      expect(app).toContain('B 2D menu');
      expect(app).not.toContain('Exit VR');
    }
  });
});

describe('VR card layout', () => {
  const head = new THREE.Vector3(0, 1.6, 0);
  const normalTowardsEye = (layout: 'menu' | 'hud'): { pos: THREE.Vector3; dot: number } => {
    const pos = new THREE.Vector3();
    const rot = new THREE.Euler();
    xrPanelPose(layout, head, pos, rot);
    const n = new THREE.Vector3(0, 0, 1).applyEuler(rot);
    return { pos, dot: n.dot(head.clone().sub(pos).normalize()) };
  };

  it('the flight card sits low and left of the line of sight and faces the eye squarely', () => {
    const { pos, dot } = normalTowardsEye('hud');
    expect(head.y - pos.y).toBeCloseTo(XR_HUD_DOWN, 5);
    expect(XR_HUD_DOWN).toBeGreaterThan(0.45);
    expect(pos.x).toBeLessThan(head.x);
    expect(dot).toBeGreaterThan(0.999);
  });

  it('menu cards sit at eye level facing the eye', () => {
    const { pos, dot } = normalTowardsEye('menu');
    expect(head.y - pos.y).toBeLessThan(0.1);
    expect(dot).toBeGreaterThan(0.999);
  });

  it('a hint wider than the card wraps at a separator into two balanced lines', () => {
    const measure = (t: string) => t.length * 10;
    expect(wrapHint('A Race · X Free fly', measure, 400)).toEqual(['A Race · X Free fly']);
    const lines = wrapHint('A disarm · B mode · X reset · R-stick click cam · Y pause', measure, 400);
    expect(lines).toHaveLength(2);
    expect(lines.join(' · ')).toBe('A disarm · B mode · X reset · R-stick click cam · Y pause');
    for (const l of lines) expect(measure(l)).toBeLessThanOrEqual(400);
  });

  it('text without a separator wraps at a space', () => {
    expect(wrapHint('Armed — push the throttle stick up to take off', (t) => t.length * 10, 300)).toEqual(['Armed — push the throttle', 'stick up to take off']);
  });

  it('the flight card spans at most ~25° of view and its smallest text clears 1.1° of cap height', () => {
    const pos = new THREE.Vector3();
    const width = xrPanelPose('hud', head, pos, new THREE.Euler());
    const dist = pos.distanceTo(head);
    const deg = (m: number): number => THREE.MathUtils.radToDeg(2 * Math.atan(m / 2 / dist));
    expect(deg(width)).toBeLessThanOrEqual(25);
    const cap = (Math.min(XR_CARD_PX.sub, XR_CARD_PX.hint) * XR_CAP_RATIO * width) / XR_CARD_W;
    expect(deg(cap)).toBeGreaterThanOrEqual(1.1);
  });

  // ~SF / Roboto (measured: 600 64px "A disarm · B mode · X reset" = 750 px), a touch wider
  const measure = (t: string, weight: number, px: number): number => t.length * px * (0.42 + weight / 10_000);
  const statuses: RaceSnapshot['status'][] = ['menu', 'paused', 'finished', 'countdown', 'crashed', 'freefly', 'racing'];
  const cards = statuses.flatMap((status) =>
    [false, true].map((armed) => xrHudContent(state({ race: race({ status, time: 3599.99, nextRing: 11, totalRings: 12 }), armed, camera: 'chase', altitude: 123.4, speed: 99 }))),
  );

  it('every card line fits the text width at its own font size (never squeezed horizontally)', () => {
    for (const c of cards) {
      const lines = layoutCard(c, measure);
      for (const l of lines) {
        expect(l.width, `${c.title}: ${l.text}`).toBeLessThanOrEqual(XR_CARD_TEXT_W);
        expect(l.width).toBeCloseTo(measure(l.text, l.weight, l.px), 6);
        expect(l.y - (l.px * 1.12) / 2).toBeGreaterThanOrEqual(0);
        expect(l.y + (l.px * 1.12) / 2).toBeLessThanOrEqual(XR_CARD_H);
      }
      const flat = (t: string): string => t.replaceAll(' · ', ' ');
      expect(flat(lines.map((l) => l.text).join(' '))).toContain(flat(c.title));
    }
  });

  it('the pause help wraps onto two full-size lines instead of being squeezed', () => {
    const paused = layoutCard(xrHudContent(state({ race: race({ status: 'paused' }) })), measure);
    const sub = paused.filter((l) => l.px === XR_CARD_PX.sub && l.weight === 500);
    expect(sub.map((l) => l.text)).toEqual(['L-stick click recentre', 'L-trigger heading arrow']);
  });

  it('the pause card action line follows the help lines at line rhythm (no extra block gap)', () => {
    const paused = layoutCard(xrHudContent(state({ race: race({ status: 'paused' }) })), measure);
    const sub = paused.filter((l) => l.weight === 500);
    const hint = paused[paused.length - 1]!;
    const subBottom = sub[sub.length - 1]!.y + (sub[sub.length - 1]!.px * 1.12) / 2;
    const hintTop = hint.y - (hint.px * 1.12) / 2;
    expect(hintTop - subBottom).toBeLessThanOrEqual(4);
    // without a sub line the hint keeps a full gap under the title
    const [title, solo] = layoutCard({ layout: 'menu', title: 'FINISH 01:00.00', sub: '', hint: 'A Retry · X Menu' }, measure);
    expect(solo!.y - (solo!.px * 1.12) / 2 - (title!.y + (title!.px * 1.12) / 2)).toBeGreaterThanOrEqual(12);
  });

  it('menu card hints are smaller and dimmer than the title; flight card hints keep their legible size', () => {
    const menu = layoutCard(xrHudContent(state({ race: race({ status: 'menu' }) })), measure);
    const [title] = menu;
    const hint = menu[menu.length - 1]!;
    expect(hint.px).toBeLessThan(title!.px * 0.7);
    expect(hint.colour).not.toBe(title!.colour);
    const lum = (hex: string): number => [1, 3, 5].reduce((s, i) => s + parseInt(hex.slice(i, i + 2), 16), 0);
    expect(lum(hint.colour)).toBeLessThan(lum('#7fe3ff'));
    const flight = layoutCard(xrHudContent(state({ race: race({ status: 'racing' }) })), measure);
    expect(flight[flight.length - 1]!.px).toBeGreaterThan(XR_MENU_HINT_PX);
  });

  it('a single word too wide for the card shrinks uniformly rather than squeezing', () => {
    const [l] = layoutCard({ layout: 'hud', title: 'W'.repeat(40), sub: '', hint: '' }, measure);
    expect(l.px).toBeLessThan(XR_CARD_PX.title);
    expect(l.width).toBeLessThanOrEqual(XR_CARD_TEXT_W);
  });

  it('button hints use one style: "A arm", never "A: arm"', () => {
    for (const c of cards) for (const t of [c.sub, c.hint]) expect(t).not.toMatch(/(\b[ABXY]|trigger|click):/);
  });
});

describe('XR session tuning (Quest frame rate + foveation)', () => {
  const fov = () => {
    const calls: number[] = [];
    return { calls, xr: { setFoveation: (v: number) => void calls.push(v) } };
  };

  it('asks for 72 Hz when the runtime lists it, and maximum fixed foveation', async () => {
    const asked: number[] = [];
    const f = fov();
    await tuneXrSession({ supportedFrameRates: new Float32Array([72, 80, 90, 120]), updateTargetFrameRate: async (r) => void asked.push(r) }, f.xr);
    expect(asked).toEqual([XR_TARGET_FPS]);
    expect(XR_TARGET_FPS).toBe(72);
    expect(f.calls).toEqual([1]);
  });

  it('leaves runtimes without the API or without 72 Hz alone, and swallows a refusal', async () => {
    const asked: number[] = [];
    await expect(tuneXrSession({}, fov().xr)).resolves.toBeUndefined();
    await tuneXrSession({ supportedFrameRates: new Float32Array([90, 120]), updateTargetFrameRate: async (r) => void asked.push(r) }, fov().xr);
    expect(asked).toEqual([]);
    const refuse = { supportedFrameRates: [72], updateTargetFrameRate: () => Promise.reject(new DOMException('no', 'InvalidStateError')) };
    await expect(tuneXrSession(refuse, { setFoveation: () => { throw new Error('no layer'); } })).resolves.toBeUndefined();
  });
});

describe('XR visibility (Quest system menu, headset off)', () => {
  it('blurred and hidden sessions count as obscured; visible does not', () => {
    expect(xrSessionObscured('visible-blurred')).toBe(true);
    expect(xrSessionObscured('hidden')).toBe(true);
    expect(xrSessionObscured('visible')).toBe(false);
    expect(xrSessionObscured(undefined)).toBe(false);
  });
});

describe('isQuestBrowser', () => {
  it('detects Quest Browser user agents only', () => {
    expect(isQuestBrowser('Mozilla/5.0 (X11; Linux x86_64; Quest 2) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/35.0 Chrome/128.0 VR Safari/537.36')).toBe(true);
    expect(isQuestBrowser('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128.0 Safari/537.36')).toBe(false);
  });
});

describe('XR stick shaping (softer thumbsticks)', () => {
  it('expo keeps the ends and softens the centre', () => {
    expect(xrExpo(1)).toBe(1);
    expect(xrExpo(-1)).toBe(-1);
    expect(xrExpo(0.5)).toBeCloseTo(0.275, 3);
  });

  it('full yaw stick turns ≈ 130°/s on the freestyle rates instead of 670°/s', () => {
    const c = { yaw: 1, pitch: 0, roll: 0 };
    shapeXrControl(c);
    expect(c.yaw).toBe(XR_YAW_SCALE);
    const rate = actualRate(c.yaw, RATE_PRESETS.freestyle);
    expect(rate).toBeGreaterThan(100);
    expect(rate).toBeLessThan(160);
    expect(actualRate(1, RATE_PRESETS.freestyle)).toBe(670);
  });

  it('the input manager applies the shaping on the xr source only', () => {
    const im = new InputManager(fakeWindow(), { ...DEFAULT_SETTINGS });
    im.xr.setSources(() => [touch('left', 1, 0), touch('right', 0.5, 0)]);
    im.xr.latched = false;
    const f = im.poll(1 / 72);
    expect(f.control.yaw).toBeCloseTo(XR_YAW_SCALE, 3);
    expect(f.control.roll).toBeLessThan(0.35);
  });
});

describe('left trigger (heading arrow toggle)', () => {
  it('fires once when the analog trigger passes 0.6', () => {
    const xr = new XrControllers();
    const trig = (v: number): XrSourceLike => {
      const src = touch('left');
      (src.gamepad!.buttons as { pressed: boolean; value: number }[])[XR_BTN.TRIGGER] = { pressed: v > 0.1, value: v };
      return src;
    };
    let v = 0.3;
    xr.setSources(() => [trig(v), touch('right')]);
    xr.poll(0);
    expect(xr.pressed.lTrigger).toBe(false);
    v = 0.9;
    xr.poll(16);
    expect(xr.pressed.lTrigger).toBe(true);
    xr.poll(32);
    expect(xr.pressed.lTrigger).toBe(false);
  });

  it('heading arrow defaults on and survives a settings round-trip', () => {
    expect(DEFAULT_SETTINGS.headingArrow).toBe(true);
    const store = new Map<string, string>([['drone-sim.settings', JSON.stringify({ headingArrow: false })]]);
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: () => undefined } as unknown as Storage;
    expect(loadSettings(storage).headingArrow).toBe(false);
  });
});

describe('XR source while a controller loses tracking', () => {
  it('stays on xr (no flicker to none/gamepad) and the lost hand reads centred', () => {
    const im = new InputManager(fakeWindow(), { ...DEFAULT_SETTINGS });
    let srcs: XrSourceLike[] = [touch('left'), touch('right')];
    im.xr.setSources(() => srcs);
    im.xr.latched = false;
    expect(im.poll(1 / 72).source).toBe('xr');
    srcs = [touch('right', 0.4, 0)];
    for (let i = 0; i < 3; i++) {
      const f = im.poll(1 / 72);
      expect(f.source).toBe('xr');
      expect(f.sticks.lx).toBe(0);
    }
    srcs = [touch('left'), touch('right')];
    expect(im.poll(1 / 72).source).toBe('xr');
  });
});
