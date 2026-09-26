/**
 * Touch transmitter: two MOBA-style virtual sticks driven by Pointer Events (one pointerId per stick)
 * plus edge-triggered on-screen buttons. `TouchSticks` is pure math (unit-tested); `TouchInput`
 * only adapts DOM pointer events to it. Nothing here allocates per event.
 */
import type { ButtonEvents } from '../types';
import type { StickSlot } from './stick';

export type TouchSide = 'l' | 'r';
export type TouchButton = 'arm' | 'toggleMode' | 'cycleCamera' | 'reset' | 'pause';
export const TOUCH_BUTTONS: readonly TouchButton[] = ['arm', 'toggleMode', 'cycleCamera', 'reset', 'pause'];

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** One virtual stick: base centre + value (−1..1 per axis, Y +up), square-clamped per axis. */
export class StickTrack {
  /** pointerId holding the stick, −1 when free */
  pointerId = -1;
  /** base centre (CSS px, layer coordinates) */
  cx = 0;
  cy = 0;
  /** rest centre when free (fixed placement / idle ghost) */
  ax = 0;
  ay = 0;
  x = 0;
  y = 0;
  /** true when this stick's Y axis carries throttle */
  holdsThrottle = false;

  get active(): boolean {
    return this.pointerId >= 0;
  }
}

export interface TouchStickOptions {
  /** base radius in CSS px (knob travel) */
  radius: number;
  /** false (default) = throttle holds where released like a real gimbal; true = springs to centre (hover) */
  centreThrottle: boolean;
  /** true = bases stay at their anchors; false = spawn under the thumb */
  fixed: boolean;
}

/**
 * Pure stick state machine. Pointer positions are CSS px in the touch layer (Y down).
 * On touch-down the throttle axis is grabbed relative to its current value (no jump), other axes
 * are absolute from the base centre. Release: non-throttle axes re-centre; the throttle axis holds
 * unless `centreThrottle`.
 */
export class TouchSticks {
  readonly l = new StickTrack();
  readonly r = new StickTrack();
  /** stick positions in InputFrame convention, fed to mapSticks */
  readonly pos: Record<StickSlot, number> = { lx: 0, ly: -1, rx: 0, ry: 0 };
  readonly opts: TouchStickOptions = { radius: 60, centreThrottle: false, fixed: false };
  private throttleSide: TouchSide = 'l';

  constructor() {
    this.l.holdsThrottle = true;
    this.l.y = -1;
  }

  /** Which side carries throttle ('l' = modes 2/4) and the throttle behaviour. */
  configure(throttleSide: TouchSide, centreThrottle: boolean, fixed: boolean, radius: number): void {
    const o = this.opts;
    o.fixed = fixed;
    o.radius = radius > 0 ? radius : 60;
    if (throttleSide !== this.throttleSide) {
      const old = this.track(this.throttleSide);
      old.holdsThrottle = false;
      if (!old.active) old.y = 0;
      this.throttleSide = throttleSide;
      const t = this.track(throttleSide);
      t.holdsThrottle = true;
      if (!t.active) t.y = centreThrottle ? 0 : -1;
    }
    if (centreThrottle !== o.centreThrottle) {
      o.centreThrottle = centreThrottle;
      const t = this.track(throttleSide);
      if (!t.active && centreThrottle) t.y = 0;
    }
    this.sync();
  }

  track(side: TouchSide): StickTrack {
    return side === 'l' ? this.l : this.r;
  }

  /** Rest positions (layer px) used by fixed placement and the idle ghost. */
  setAnchors(lx: number, ly: number, rx: number, ry: number): void {
    this.l.ax = lx;
    this.l.ay = ly;
    this.r.ax = rx;
    this.r.ay = ry;
    if (!this.l.active) {
      this.l.cx = lx;
      this.l.cy = ly;
    }
    if (!this.r.active) {
      this.r.cx = rx;
      this.r.cy = ry;
    }
  }

  /** Starts tracking `pointerId` on `side`. Returns false if that stick is already held. */
  down(side: TouchSide, pointerId: number, px: number, py: number): boolean {
    const t = this.track(side);
    if (t.active) return false;
    t.pointerId = pointerId;
    const R = this.opts.radius;
    if (this.opts.fixed) {
      t.cx = t.ax;
      // Throttle is grabbed relatively (value keeps continuity), other axes absolute from the anchor.
      t.cy = t.holdsThrottle ? py + t.y * R : t.ay;
    } else {
      t.cx = px;
      t.cy = t.holdsThrottle ? py + t.y * R : py;
    }
    this.apply(t, px, py);
    return true;
  }

  /** Returns true when `pointerId` belongs to a stick. */
  move(pointerId: number, px: number, py: number): boolean {
    const t = this.l.pointerId === pointerId ? this.l : this.r.pointerId === pointerId ? this.r : null;
    if (!t) return false;
    this.apply(t, px, py);
    return true;
  }

  up(pointerId: number): boolean {
    const t = this.l.pointerId === pointerId ? this.l : this.r.pointerId === pointerId ? this.r : null;
    if (!t) return false;
    this.release(t);
    return true;
  }

  releaseAll(): void {
    if (this.l.active) this.release(this.l);
    if (this.r.active) this.release(this.r);
  }

  /** Throttle 0..1 → throttle stick position (e.g. zero it for a new session). */
  setThrottle(v: number): void {
    const t = this.track(this.throttleSide);
    t.y = clamp(v, 0, 1) * 2 - 1;
    this.sync();
  }

  private release(t: StickTrack): void {
    t.pointerId = -1;
    t.x = 0;
    if (!t.holdsThrottle || this.opts.centreThrottle) t.y = 0;
    t.cx = t.ax;
    t.cy = t.ay;
    this.sync();
  }

  private apply(t: StickTrack, px: number, py: number): void {
    const R = this.opts.radius;
    t.x = clamp((px - t.cx) / R, -1, 1);
    t.y = clamp((t.cy - py) / R, -1, 1);
    this.sync();
  }

  private sync(): void {
    const p = this.pos;
    p.lx = this.l.x;
    p.ly = this.l.y;
    p.rx = this.r.x;
    p.ry = this.r.y;
  }
}

/** Throttle side for a stick mode's throttle slot. */
export function throttleSideOf(slot: 'ly' | 'ry'): TouchSide {
  return slot === 'ly' ? 'l' : 'r';
}

/** Stick base radius (CSS px ≈ pt): phones 60, tablets 72. */
export function stickRadius(phone: boolean): number {
  return phone ? 60 : 72;
}

/**
 * DOM adapter: pointerdown on the touch layer (not on a button) grabs the stick of that screen half;
 * move / up are followed on the window by pointerId (no pointer capture, so synthetic events work too).
 * Only `pointerType === 'touch' | 'pen'` drives sticks.
 */
export class TouchInput {
  readonly sticks = new TouchSticks();
  /** performance.now() of the last touch anywhere on the page */
  lastActivity = -Infinity;
  private readonly pending: Record<TouchButton, boolean> = { arm: false, toggleMode: false, cycleCamera: false, reset: false, pause: false };
  private layer: HTMLElement | null = null;
  private win: Window | null = null;
  private halfW = 0;
  /** layer origin in the viewport (updated on resize, never read in pointermove) */
  private ox = 0;
  private oy = 0;

  private readonly onAnyTouch = (e: PointerEvent): void => {
    if (e.pointerType === 'touch' || e.pointerType === 'pen') this.lastActivity = performance.now();
  };

  private readonly onDown = (e: PointerEvent): void => {
    if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
    const t = e.target as Element | null;
    if (t && typeof t.closest === 'function' && t.closest('[data-tbtn]')) return;
    const x = e.clientX - this.ox;
    const y = e.clientY - this.oy;
    if (this.sticks.down(x < this.halfW ? 'l' : 'r', e.pointerId, x, y)) {
      this.lastActivity = performance.now();
      if (e.cancelable) e.preventDefault();
    }
  };

  private readonly onMove = (e: PointerEvent): void => {
    if (this.sticks.move(e.pointerId, e.clientX - this.ox, e.clientY - this.oy)) this.lastActivity = performance.now();
  };

  private readonly onUp = (e: PointerEvent): void => {
    this.sticks.up(e.pointerId);
  };

  private readonly onBlur = (): void => this.sticks.releaseAll();

  /** Global listener that marks touch as the active source; the stick layer is attached later. */
  listen(win: Window): void {
    this.win = win;
    win.addEventListener('pointerdown', this.onAnyTouch, { capture: true, passive: true });
    win.addEventListener('pointermove', this.onMove, { passive: true });
    win.addEventListener('pointerup', this.onUp, { passive: true });
    win.addEventListener('pointercancel', this.onUp, { passive: true });
    win.addEventListener('blur', this.onBlur);
  }

  attach(layer: HTMLElement): void {
    this.layer = layer;
    layer.addEventListener('pointerdown', this.onDown);
  }

  /** Layer geometry changed (resize / orientation): origin, halves, stick anchors. */
  layout(originX: number, originY: number, width: number, anchors: { lx: number; ly: number; rx: number; ry: number }, radius: number): void {
    this.ox = originX;
    this.oy = originY;
    this.halfW = width / 2;
    const s = this.sticks;
    s.configure(s.l.holdsThrottle ? 'l' : 'r', s.opts.centreThrottle, s.opts.fixed, radius);
    s.setAnchors(anchors.lx, anchors.ly, anchors.rx, anchors.ry);
  }

  /** On-screen button pressed (edge; consumed by the next poll). */
  press(name: TouchButton): void {
    this.pending[name] = true;
    this.lastActivity = performance.now();
  }

  /** ORs pending button presses into `b` and clears them. */
  drainButtons(b: ButtonEvents): void {
    const p = this.pending;
    for (let i = 0; i < TOUCH_BUTTONS.length; i++) {
      const n = TOUCH_BUTTONS[i]!;
      if (p[n]) {
        b[n] = true;
        p[n] = false;
      }
    }
  }

  dispose(): void {
    const w = this.win;
    if (w) {
      w.removeEventListener('pointerdown', this.onAnyTouch, { capture: true });
      w.removeEventListener('pointermove', this.onMove);
      w.removeEventListener('pointerup', this.onUp);
      w.removeEventListener('pointercancel', this.onUp);
      w.removeEventListener('blur', this.onBlur);
    }
    this.layer?.removeEventListener('pointerdown', this.onDown);
    this.layer = null;
    this.win = null;
  }
}
