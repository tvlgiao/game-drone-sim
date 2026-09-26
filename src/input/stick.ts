/** Pure, DOM-free input helpers: deadzones, throttle mapping, keyboard ramps, edge detection. */

export interface Vec2 {
  x: number;
  y: number;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Radial deadzone with rescale: |v| ≤ dz → 0, otherwise magnitude remapped (dz..1) → (0..1). */
export function applyRadialDeadzone(x: number, y: number, deadzone: number, out: Vec2 = { x: 0, y: 0 }): Vec2 {
  const mag = Math.hypot(x, y);
  if (mag <= deadzone || mag === 0) {
    out.x = 0;
    out.y = 0;
    return out;
  }
  const scaled = Math.min(1, (mag - deadzone) / (1 - deadzone));
  out.x = (x / mag) * scaled;
  out.y = (y / mag) * scaled;
  return out;
}

/** Single-axis deadzone with rescale, keeps sign. */
export function applyAxialDeadzone(v: number, deadzone: number): number {
  const a = Math.abs(v);
  if (a <= deadzone) return 0;
  return Math.sign(v) * Math.min(1, (a - deadzone) / (1 - deadzone));
}

/** Low-end deadzone that guarantees 0 (and 1) are reachable on a worn gimbal/trigger. */
export const THROTTLE_LOW_DEADZONE = 0.02;
export const THROTTLE_HIGH_DEADZONE = 0.01;

function throttleEnds(t: number, low: number): number {
  const hi = 1 - THROTTLE_HIGH_DEADZONE;
  if (t <= low) return 0;
  if (t >= hi) return 1;
  return (t - low) / (hi - low);
}

/**
 * Gamepad stick Y (−1 = pushed up, +1 = pulled down, Standard mapping) → throttle 0..1,
 * full range like a non-centering radio gimbal: down = 0, centre = 0.5, up = 1.
 */
export function stickToThrottle(axisY: number, lowDeadzone = THROTTLE_LOW_DEADZONE): number {
  return throttleEnds(clamp((1 - axisY) / 2, 0, 1), lowDeadzone);
}

/** Analog trigger value 0..1 → throttle 0..1 with the same end deadzones. */
export function triggerToThrottle(value: number, lowDeadzone = THROTTLE_LOW_DEADZONE): number {
  return throttleEnds(clamp(value, 0, 1), lowDeadzone);
}

/** Keyboard state consumed by KeyboardAxes (true = key held). */
export interface KeyAxisState {
  throttleUp: boolean;
  throttleDown: boolean;
  yawLeft: boolean;
  yawRight: boolean;
  pitchForward: boolean;
  pitchBack: boolean;
  rollLeft: boolean;
  rollRight: boolean;
}

export const KEY_THROTTLE_RATE = 0.6;
export const KEY_AXIS_RISE_TIME = 0.12;

/** Moves `v` toward `target` by at most `maxStep`. */
export function slew(v: number, target: number, maxStep: number): number {
  const d = target - v;
  return Math.abs(d) <= maxStep ? target : v + Math.sign(d) * maxStep;
}

/**
 * Keys → analog axes. Throttle ramps at KEY_THROTTLE_RATE /s and stays where released (like a radio);
 * yaw/pitch/roll slew toward ±1 / 0 with a linear rise/fall time of KEY_AXIS_RISE_TIME.
 */
export class KeyboardAxes {
  throttle = 0;
  yaw = 0;
  pitch = 0;
  roll = 0;

  constructor(
    public throttleRate = KEY_THROTTLE_RATE,
    public riseTime = KEY_AXIS_RISE_TIME,
  ) {}

  update(dt: number, k: KeyAxisState): void {
    const t = (k.throttleUp ? 1 : 0) - (k.throttleDown ? 1 : 0);
    this.throttle = clamp(this.throttle + t * this.throttleRate * dt, 0, 1);
    const step = this.riseTime > 0 ? dt / this.riseTime : 1;
    this.yaw = slew(this.yaw, (k.yawRight ? 1 : 0) - (k.yawLeft ? 1 : 0), step);
    this.pitch = slew(this.pitch, (k.pitchForward ? 1 : 0) - (k.pitchBack ? 1 : 0), step);
    this.roll = slew(this.roll, (k.rollRight ? 1 : 0) - (k.rollLeft ? 1 : 0), step);
  }

  reset(): void {
    this.throttle = this.yaw = this.pitch = this.roll = 0;
  }
}

/** Rising-edge detector: true only on the update where `pressed` goes false → true. */
export class EdgeDetector {
  private prev = false;
  update(pressed: boolean): boolean {
    const edge = pressed && !this.prev;
    this.prev = pressed;
    return edge;
  }
  reset(pressed = false): void {
    this.prev = pressed;
  }
}

export const NAV_REPEAT_DELAY = 0.4;
export const NAV_REPEAT_INTERVAL = 0.12;

/** Menu auto-repeat: fires on press, then after `delay`, every `interval` while held. */
export class RepeatTrigger {
  private held = 0;
  private nextFire = 0;
  private active = false;

  constructor(
    public delay = NAV_REPEAT_DELAY,
    public interval = NAV_REPEAT_INTERVAL,
  ) {}

  update(pressed: boolean, dt: number): boolean {
    if (!pressed) {
      this.active = false;
      return false;
    }
    if (!this.active) {
      this.active = true;
      this.held = 0;
      this.nextFire = this.delay;
      return true;
    }
    this.held += dt;
    if (this.held >= this.nextFire) {
      this.nextFire += this.interval;
      return true;
    }
    return false;
  }

  reset(): void {
    this.active = false;
  }
}
