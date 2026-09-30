/**
 * WebXR controller reader (Meta Quest Touch, `xr-standard` mapping). Quest Browser does not list
 * Touch controllers in navigator.getGamepads(): they only exist as XRInputSource.gamepad.
 * Thumbsticks spring back to centre, so the throttle stick flies with altitude hold + take-off latch.
 */
import type { StickPositions, XrButtonEdges } from '../types';

/** `xr-standard` button indices. */
export const XR_BTN = {
  TRIGGER: 0,
  SQUEEZE: 1,
  STICK: 3,
  /** A on the right controller, X on the left */
  LOWER: 4,
  /** B on the right controller, Y on the left */
  UPPER: 5,
} as const;

/** Minimal shape of an XRInputSource this reader needs (keeps it testable without WebXR). */
export interface XrSourceLike {
  handedness: 'left' | 'right' | 'none';
  gamepad?: { axes: readonly number[]; buttons: readonly { pressed: boolean; value: number }[]; hapticActuators?: readonly unknown[] } | null;
}

/** Held (or, for `pressed`, rising-edge) state of the named Quest buttons. */
export type XrButtons = XrButtonEdges;

/** Throttle deflection above centre that releases the take-off latch (same as the touch sticks). */
export const XR_TAKEOFF_PUSH = 0.15;
const ACTIVITY_AXIS = 0.3;

const BUTTON_KEYS: readonly (keyof XrButtons)[] = ['a', 'b', 'x', 'y', 'rStick', 'lStick'];

export class XrControllers {
  /** Stick positions −1..1, Y +up (take-off latch applied to the throttle slot). */
  readonly pos: StickPositions = { lx: 0, ly: 0, rx: 0, ry: 0 };
  readonly held: XrButtons = { a: false, b: false, x: false, y: false, rStick: false, lStick: false };
  /** Rising edges of `held` for the last poll. */
  readonly pressed: XrButtons = { a: false, b: false, x: false, y: false, rStick: false, lStick: false };
  /** Both hands seen with a gamepad on the last poll. */
  connected = false;
  /** Timestamp (ms) of the last stick / button activity, −∞ if never. */
  lastActivity = -Infinity;
  /** While set, the throttle stick reads fully down until pushed above centre. */
  latched = true;

  private sources: (() => Iterable<XrSourceLike>) | null = null;
  private throttleSlot: 'ly' | 'ry' = 'ly';
  private readonly prev: XrButtons = { a: false, b: false, x: false, y: false, rStick: false, lStick: false };

  /**
   * Reader of the session's input sources, called every poll (null when no XR session is running).
   * A getter rather than the array: runtimes may only refresh `session.inputSources` on access.
   */
  setSources(sources: (() => Iterable<XrSourceLike>) | null): void {
    this.sources = sources;
    if (!sources) {
      this.connected = false;
      this.clear();
    }
  }

  get active(): boolean {
    return this.sources !== null;
  }

  setThrottleSlot(slot: 'ly' | 'ry'): void {
    this.throttleSlot = slot;
  }

  latchTakeoff(): void {
    this.latched = true;
  }

  poll(now: number): void {
    const p = this.pos;
    const h = this.held;
    this.clear();
    let left = false;
    let right = false;
    if (this.sources) {
      for (const src of this.sources()) {
        const gp = src.gamepad;
        if (!gp) continue;
        // xr-standard: axes 2/3 = thumbstick (Y +down); 0/1 = touchpad (absent on Touch controllers).
        const x = gp.axes.length >= 4 ? gp.axes[2]! : (gp.axes[0] ?? 0);
        const y = 0 - (gp.axes.length >= 4 ? gp.axes[3]! : (gp.axes[1] ?? 0));
        const btn = (i: number): boolean => gp.buttons[i]?.pressed ?? false;
        if (src.handedness === 'left') {
          left = true;
          p.lx = x;
          p.ly = y;
          h.x = btn(XR_BTN.LOWER);
          h.y = btn(XR_BTN.UPPER);
          h.lStick = btn(XR_BTN.STICK);
        } else if (src.handedness === 'right') {
          right = true;
          p.rx = x;
          p.ry = y;
          h.a = btn(XR_BTN.LOWER);
          h.b = btn(XR_BTN.UPPER);
          h.rStick = btn(XR_BTN.STICK);
        }
      }
    }
    this.connected = left && right;

    let any = false;
    for (const k of BUTTON_KEYS) {
      this.pressed[k] = h[k] && !this.prev[k];
      this.prev[k] = h[k];
      any ||= h[k];
    }
    if (any || Math.max(Math.abs(p.lx), Math.abs(p.ly), Math.abs(p.rx), Math.abs(p.ry)) > ACTIVITY_AXIS) this.lastActivity = now;

    const slot = this.throttleSlot;
    if (this.latched && p[slot] > XR_TAKEOFF_PUSH) this.latched = false;
    if (this.latched) p[slot] = -1;
  }

  /** Haptic pulse on every controller that has one (intensity 0..1). */
  pulse(intensity: number, ms: number): void {
    if (!this.sources) return;
    for (const src of this.sources()) {
      const act = src.gamepad?.hapticActuators?.[0] as { pulse?: (v: number, ms: number) => Promise<boolean> } | undefined;
      try {
        act?.pulse?.(Math.min(1, Math.max(0, intensity)), Math.max(0, ms))?.catch(() => undefined);
      } catch {
        /* haptics unsupported */
      }
    }
  }

  private clear(): void {
    const p = this.pos;
    p.lx = p.ly = p.rx = p.ry = 0;
    for (const k of BUTTON_KEYS) this.held[k] = false;
  }
}
