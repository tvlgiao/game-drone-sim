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

/** Linear rise / fall time (s) of a keyboard axis between centre and full deflection. */
export const KEY_AXIS_RISE_TIME = 0.12;

/** Moves `v` toward `target` by at most `maxStep`. */
export function slew(v: number, target: number, maxStep: number): number {
  const d = target - v;
  return Math.abs(d) <= maxStep ? target : v + Math.sign(d) * maxStep;
}

// ---------------------------------------------------------------- RC stick modes

export type Channel = 'throttle' | 'yaw' | 'pitch' | 'roll';
export type StickSlot = 'lx' | 'ly' | 'rx' | 'ry';
export type StickModeNum = 1 | 2 | 3 | 4;
export const STICK_SLOTS: readonly StickSlot[] = ['lx', 'ly', 'rx', 'ry'];

/** Which channel each physical stick axis drives, per RC transmitter mode. */
export const MODE_TABLE: Readonly<Record<StickModeNum, Readonly<Record<StickSlot, Channel>>>> = {
  1: { lx: 'yaw', ly: 'pitch', rx: 'roll', ry: 'throttle' },
  2: { lx: 'yaw', ly: 'throttle', rx: 'roll', ry: 'pitch' },
  3: { lx: 'roll', ly: 'pitch', rx: 'yaw', ry: 'throttle' },
  4: { lx: 'roll', ly: 'throttle', rx: 'yaw', ry: 'pitch' },
};

/** Stick axis slot carrying throttle in a mode ('ly' or 'ry'). */
export function throttleSlot(mode: StickModeNum): 'ly' | 'ry' {
  return MODE_TABLE[mode].ly === 'throttle' ? 'ly' : 'ry';
}

/** Physical stick axis slot that drives `ch` in `mode`. */
export function slotOf(mode: StickModeNum, ch: Channel): StickSlot {
  const t = MODE_TABLE[mode];
  return STICK_SLOTS.find((s) => t[s] === ch)!;
}

/**
 * Circle → square gate (inverse elliptical grid mapping): a round-gate gamepad stick pushed fully
 * diagonal (≈0.707, 0.707) reaches (1, 1) like a square-gate RC gimbal. On-axis values are unchanged.
 */
export function squareGate(x: number, y: number, out: Vec2 = { x: 0, y: 0 }): Vec2 {
  const x2 = x * x;
  const y2 = y * y;
  const k = 2 * Math.SQRT2;
  const tx = 2 + x2 - y2;
  const ty = 2 - x2 + y2;
  const sx = 0.5 * Math.sqrt(Math.max(0, tx + k * x)) - 0.5 * Math.sqrt(Math.max(0, tx - k * x));
  const sy = 0.5 * Math.sqrt(Math.max(0, ty + k * y)) - 0.5 * Math.sqrt(Math.max(0, ty - k * y));
  out.x = clamp(sx, -1, 1);
  out.y = clamp(sy, -1, 1);
  return out;
}

export interface StickMapOptions {
  stickMode: StickModeNum;
  throttleSource: 'stick' | 'trigger';
  squareGate: boolean;
  invert: Readonly<Record<Channel, boolean>>;
  deadzone: number;
}

export interface ChannelValues {
  throttle: number;
  yaw: number;
  pitch: number;
  roll: number;
}

const tmp: Vec2 = { x: 0, y: 0 };

function shapeStick(x: number, y: number, holdsThrottle: boolean, o: StickMapOptions, shaping: boolean, out: Vec2): Vec2 {
  if (!shaping) {
    out.x = clamp(x, -1, 1);
    out.y = clamp(y, -1, 1);
    return out;
  }
  if (holdsThrottle) {
    // Throttle axis stays raw (full range, non-centering); only the other axis gets a deadzone.
    out.x = applyAxialDeadzone(x, o.deadzone);
    out.y = clamp(y, -1, 1);
  } else {
    applyRadialDeadzone(x, y, o.deadzone, out);
  }
  if (o.squareGate) squareGate(out.x, out.y, out);
  return out;
}

/**
 * Physical stick positions (−1..1, Y +up) → RC channels for the selected mode.
 * `shaping` = deadzone + square gate (gamepad); off for keyboard virtual sticks.
 * Writes processed stick positions (for the visualiser) to `outSticks`, channels to `outCh`.
 */
export function mapSticks(
  raw: Readonly<Record<StickSlot, number>>,
  trigger: number,
  o: StickMapOptions,
  outSticks: Record<StickSlot, number>,
  outCh: ChannelValues,
  shaping = true,
): void {
  const thr = throttleSlot(o.stickMode);
  const useTrigger = o.throttleSource === 'trigger';
  const leftThr = thr === 'ly';
  shapeStick(raw.lx, useTrigger && leftThr ? 0 : raw.ly, leftThr, o, shaping, tmp);
  outSticks.lx = tmp.x;
  outSticks.ly = tmp.y;
  shapeStick(raw.rx, useTrigger && !leftThr ? 0 : raw.ry, !leftThr, o, shaping, tmp);
  outSticks.rx = tmp.x;
  outSticks.ry = tmp.y;

  let throttle: number;
  if (useTrigger) {
    throttle = triggerToThrottle(trigger);
    outSticks[thr] = throttle * 2 - 1;
  } else {
    const t = (outSticks[thr] + 1) / 2;
    throttle = shaping ? throttleEnds(t, THROTTLE_LOW_DEADZONE) : clamp(t, 0, 1);
  }
  const table = MODE_TABLE[o.stickMode];
  for (const s of STICK_SLOTS) {
    const ch = table[s];
    if (ch !== 'throttle') outCh[ch] = outSticks[s];
  }
  outCh.throttle = throttle;
  if (o.invert.throttle) outCh.throttle = 1 - outCh.throttle;
  if (o.invert.yaw) outCh.yaw = -outCh.yaw;
  if (o.invert.pitch) outCh.pitch = -outCh.pitch;
  if (o.invert.roll) outCh.roll = -outCh.roll;
}

/** Keyboard virtual sticks: WASD = left stick, arrows = right stick (true = key held). */
export interface VirtualKeys {
  lUp: boolean;
  lDown: boolean;
  lLeft: boolean;
  lRight: boolean;
  rUp: boolean;
  rDown: boolean;
  rLeft: boolean;
  rRight: boolean;
}

/**
 * Keys → stick positions (−1..1, Y +up). Every axis, throttle included, slews toward ±1 while its key is
 * held and springs back to centre on release (KEY_AXIS_RISE_TIME per unit), like a self-centring joystick:
 * the keyboard throttle is flown with altitude hold, so centre = hover.
 * Take-off latch: while `latched`, the throttle axis reads fully down (idle on the ground, the FC can arm)
 * until the throttle-up key is pressed; latchTakeoff() re-arms it.
 */
export class VirtualSticks {
  /** output positions (latch applied) */
  readonly pos: Record<StickSlot, number> = { lx: 0, ly: -1, rx: 0, ry: 0 };
  latched = true;
  private readonly raw: Record<StickSlot, number> = { lx: 0, ly: -1, rx: 0, ry: 0 };
  private hold: 'ly' | 'ry' = 'ly';

  constructor(public riseTime = KEY_AXIS_RISE_TIME) {}

  /** Throttle-axis value as throttle 0..1. */
  get throttle(): number {
    return (this.pos[this.hold] + 1) / 2;
  }

  latchTakeoff(): void {
    this.latched = true;
    this.raw[this.hold] = -1;
    this.pos[this.hold] = -1;
  }

  update(dt: number, k: VirtualKeys, hold: 'ly' | 'ry'): void {
    if (hold !== this.hold) {
      this.raw[this.hold] = 0;
      this.hold = hold;
      this.raw[hold] = this.latched ? -1 : 0;
    }
    const step = this.riseTime > 0 ? dt / this.riseTime : 1;
    const target: Record<StickSlot, number> = {
      lx: (k.lRight ? 1 : 0) - (k.lLeft ? 1 : 0),
      ly: (k.lUp ? 1 : 0) - (k.lDown ? 1 : 0),
      rx: (k.rRight ? 1 : 0) - (k.rLeft ? 1 : 0),
      ry: (k.rUp ? 1 : 0) - (k.rDown ? 1 : 0),
    };
    if (this.latched && target[hold] > 0) this.latched = false;
    for (const s of STICK_SLOTS) {
      if (s === hold && this.latched) this.raw[s] = -1;
      else this.raw[s] = slew(this.raw[s], target[s], step);
      this.pos[s] = this.raw[s];
    }
  }
}

/**
 * Remap helper: after start(), feed raw axes each frame; once `duration` has elapsed returns the index
 * of the axis with the largest deflection from its starting value (≥ minDelta), else keeps waiting
 * until `timeout` and then returns −1.
 */
export class AxisCapture {
  private base: number[] = [];
  private peak: number[] = [];
  private t = 0;
  active = false;

  constructor(
    public duration = 1,
    public minDelta = 0.4,
    public timeout = 6,
  ) {}

  start(axes: readonly number[]): void {
    this.base = Array.from(axes);
    this.peak = this.base.map(() => 0);
    this.t = 0;
    this.active = true;
  }

  cancel(): void {
    this.active = false;
  }

  /** Returns the captured axis index, −1 on timeout, or null while still capturing. */
  sample(axes: readonly number[], dt: number): number | null {
    if (!this.active) return null;
    this.t += dt;
    for (let i = 0; i < axes.length; i++) {
      if (i >= this.base.length) {
        this.base[i] = axes[i]!;
        this.peak[i] = 0;
      }
      const d = Math.abs(axes[i]! - this.base[i]!);
      if (d > this.peak[i]!) this.peak[i] = d;
    }
    if (this.t < this.duration) return null;
    let best = -1;
    let bestD = this.minDelta;
    this.peak.forEach((d, i) => {
      if (d >= bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best >= 0 || this.t >= this.timeout) {
      this.active = false;
      return best;
    }
    return null;
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
