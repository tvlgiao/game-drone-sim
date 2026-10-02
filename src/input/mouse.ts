/**
 * Mouse flight. Under Pointer Lock (or click-drag on the canvas where Pointer Lock is missing) mouse
 * motion drives a virtual stick:
 * - 'hold': absolute — motion moves the stick inside its circle and it stays there (Angle: tilt held);
 * - 'spring': relative — motion deflects it and it re-centres as soon as the mouse stops (Acro: rates).
 * `MouseStick` is pure math (unit-tested); `MouseInput` adapts DOM events to it.
 */
import type { FlightMode } from '../types';
import type { MouseStickMode, Settings } from '../core/settings';
import { applyRadialDeadzone, type Vec2 } from './stick';

/** 'spring' time constant (s): the stick is back at centre ~0.15 s after the mouse stops. */
export const MOUSE_DECAY = 0.05;
/** 'spring': stick units per pixel at sensitivity 1 (≈ 1000 px/s of motion holds full deflection). */
export const MOUSE_GAIN = 0.02;
/** 'hold': pixels of travel from centre to the edge of the stick circle at sensitivity 1. */
export const MOUSE_HOLD_TRAVEL = 300;

export type MouseStickKind = Exclude<MouseStickMode, 'auto'>;

/** 'auto' follows the flight mode: Angle flies the held tilt, Acro flies rates on a self-centring stick. */
export function mouseStickKind(mode: MouseStickMode, flight: FlightMode): MouseStickKind {
  if (mode !== 'auto') return mode;
  return flight === 'acro' ? 'spring' : 'hold';
}

export type MouseStickOptions = Pick<Settings, 'mouseSensitivity' | 'mouseInvertY' | 'mouseExpo' | 'mouseDeadzone'>;

const expo = (v: number, e: number): number => v * (1 - e) + v * v * v * e;

export class MouseStick {
  /** shaped output (deadzone + expo), −1..1, x +right, y +up (mouse pushed away) */
  readonly out: Vec2 = { x: 0, y: 0 };
  /** unshaped stick position inside the unit circle */
  readonly pos: Vec2 = { x: 0, y: 0 };
  kind: MouseStickKind = 'hold';
  private dx = 0;
  private dy = 0;

  /** Accumulates raw motion (px, screen convention: +y = down) until the next update. */
  feed(dx: number, dy: number): void {
    if (Number.isFinite(dx)) this.dx += dx;
    if (Number.isFinite(dy)) this.dy += dy;
  }

  update(dt: number, kind: MouseStickKind, o: MouseStickOptions): void {
    if (kind !== this.kind) {
      // a held tilt must not turn into a held rate (or back): start the new behaviour centred
      this.kind = kind;
      this.pos.x = this.pos.y = 0;
    }
    const p = this.pos;
    const hold = kind === 'hold';
    const keep = hold ? 1 : dt > 0 ? Math.exp(-dt / MOUSE_DECAY) : 1;
    const g = (hold ? 1 / MOUSE_HOLD_TRAVEL : MOUSE_GAIN) * o.mouseSensitivity;
    p.x = p.x * keep + this.dx * g;
    p.y = p.y * keep + (o.mouseInvertY ? this.dy : -this.dy) * g;
    this.dx = this.dy = 0;
    const r = Math.hypot(p.x, p.y);
    if (r > 1) {
      p.x /= r;
      p.y /= r;
    }
    applyRadialDeadzone(p.x, p.y, o.mouseDeadzone, this.out);
    this.out.x = expo(this.out.x, o.mouseExpo);
    this.out.y = expo(this.out.y, o.mouseExpo);
  }

  /** Back to centre (Z / middle button, mode change); pending motion is dropped. */
  reset(): void {
    this.pos.x = this.pos.y = this.out.x = this.out.y = this.dx = this.dy = 0;
  }
}

/** Unlocks the game asked for itself; any other unlock (Esc, focus loss) pauses the flight. */
const expected = new WeakSet<Document>();

type LockFn = (opts?: { unadjustedMovement?: boolean }) => Promise<void> | void;

/**
 * Captures the mouse for flight, with raw (unaccelerated) motion where the browser supports it.
 * Browsers refuse without a user gesture; failures are ignored.
 */
export function requestPointerLock(el: Element): void {
  const lock = (el as Element & { requestPointerLock?: LockFn }).requestPointerLock;
  if (typeof lock !== 'function') return;
  try {
    const p = lock.call(el, { unadjustedMovement: true });
    if (p && typeof p.catch === 'function') {
      p.catch(() => {
        try {
          const q = lock.call(el);
          if (q && typeof q.catch === 'function') q.catch(() => undefined);
        } catch {
          /* refused */
        }
      });
    }
  } catch {
    /* pointer lock refused */
  }
}

/** Releases the mouse without pausing the flight (the game is already leaving flight). */
export function releasePointerLock(doc: Document): void {
  if (!doc.pointerLockElement) return;
  expected.add(doc);
  doc.exitPointerLock?.();
}

export function pointerLockSupported(doc: Document | null): boolean {
  return !!doc && 'pointerLockElement' in doc && typeof doc.exitPointerLock === 'function';
}

const MIDDLE = 1;

/** The game view (DOM-free check, so the module also runs in unit tests). */
export function isCanvas(t: EventTarget | null): t is HTMLCanvasElement {
  return !!t && (t as Element).tagName === 'CANVAS';
}

export class MouseInput {
  readonly stick = new MouseStick();
  /** Timestamp (ms) of the last mouse flight motion, −∞ if never. */
  lastActivity = -Infinity;
  locked = false;
  /** click-drag fallback (no Pointer Lock): pointerId of the drag in progress */
  private dragId = -1;
  private dragged = false;
  private unlockPause = false;
  private readonly doc: Document | null;
  private readonly lockable: boolean;

  private readonly onMove = (e: MouseEvent): void => {
    if (!this.locked) return;
    this.motion(e.movementX, e.movementY);
  };

  private readonly onDown = (e: PointerEvent): void => {
    if (e.pointerType !== 'mouse' || !isCanvas(e.target)) return;
    if (e.button === MIDDLE) {
      e.preventDefault(); // no autoscroll
      this.stick.reset();
      return;
    }
    if (this.lockable || e.button !== 0) return;
    this.dragId = e.pointerId;
    e.target.setPointerCapture?.(e.pointerId);
  };

  private readonly onDragMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.dragId) return;
    this.dragged = true;
    this.motion(e.movementX, e.movementY);
  };

  private readonly onUp = (e: PointerEvent): void => {
    if (e.pointerId === this.dragId) this.dragId = -1;
  };

  private readonly onLockChange = (): void => {
    const doc = this.doc!;
    const locked = !!doc.pointerLockElement;
    if (locked === this.locked) return;
    this.locked = locked;
    this.stick.reset();
    if (locked) {
      this.lastActivity = performance.now();
      expected.delete(doc);
    } else if (expected.has(doc)) {
      expected.delete(doc);
    } else {
      this.unlockPause = true;
    }
  };

  constructor(doc: Document | null) {
    this.doc = doc;
    this.lockable = pointerLockSupported(doc);
    if (!doc) return;
    doc.addEventListener('mousemove', this.onMove);
    doc.addEventListener('pointerlockchange', this.onLockChange);
    doc.addEventListener('pointerdown', this.onDown);
    doc.addEventListener('pointermove', this.onDragMove);
    doc.addEventListener('pointerup', this.onUp);
    doc.addEventListener('pointercancel', this.onUp);
  }

  /** The mouse is flying: captured, or (no Pointer Lock) dragged on the canvas at least once. */
  get engaged(): boolean {
    return this.locked || this.dragged;
  }

  /** True once after the lock was lost without the game asking (Esc, alt-tab): the flight pauses. */
  takeUnlockPause(): boolean {
    const p = this.unlockPause;
    this.unlockPause = false;
    return p;
  }

  dispose(): void {
    const d = this.doc;
    if (!d) return;
    d.removeEventListener('mousemove', this.onMove);
    d.removeEventListener('pointerlockchange', this.onLockChange);
    d.removeEventListener('pointerdown', this.onDown);
    d.removeEventListener('pointermove', this.onDragMove);
    d.removeEventListener('pointerup', this.onUp);
    d.removeEventListener('pointercancel', this.onUp);
  }

  private motion(dx: number, dy: number): void {
    this.stick.feed(dx, dy);
    if (dx || dy) this.lastActivity = performance.now();
  }
}
