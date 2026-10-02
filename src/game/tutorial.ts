/**
 * Tutorial state machine (docs/07-levels-design.md §4): twelve steps, each completed by a predicate on a
 * per-frame `TutorialCtx`. DOM-free and three-free like `RaceController`; it never touches the flight
 * controller — the integrator applies `requiredFlightMode()` / `lockedButtons()` and respawns on `crash()`.
 */
import type { Channel } from '../input/stick';
import type { CameraMode, FlightMode, InputSource } from '../types';

export interface TutorialVec3 {
  x: number;
  y: number;
  z: number;
}

export interface TutorialQuat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** The part of `DroneState` the steps read (a `DroneState` is assignable). */
export interface TutorialDrone {
  velocity: TutorialVec3;
  orientation: TutorialQuat;
}

export interface TutorialCtx {
  /** frame seconds (not physics sub-steps) */
  dt: number;
  drone: TutorialDrone;
  /** height above the ground under the drone, m */
  agl: number;
  armed: boolean;
  flightMode: FlightMode;
  cameraMode: CameraMode;
  source: InputSource;
  /** rings passed so far in the level (any baseline: the ring step counts from its own start) */
  ringsPassed: number;
  /** confirm edge this frame (Enter / A / the card's Continue button) */
  confirm: boolean;
  /** skip button held this frame (gamepad B, Quest B): hold-to-skip */
  skipHeld?: boolean;
}

export type TutorialStepId =
  | 'welcome'
  | 'arm'
  | 'throttle'
  | 'hover'
  | 'yaw'
  | 'pitch-roll'
  | 'land'
  | 'disarm'
  | 'modes'
  | 'cameras'
  | 'ring'
  | 'done';

export type TutorialButton = 'arm' | 'toggleMode' | 'cycleCamera' | 'confirm';

/** What a hint highlights: sticks by channel (mapped to a side through the stick mode) and / or a button. */
export interface TutorialFocus {
  channels: readonly Channel[];
  button: TutorialButton | null;
}

/** One sub-goal bar (yaw left / right, four travel directions, three cameras…). */
export interface TutorialPart {
  id: string;
  value: number;
}

export interface TutorialStepDef {
  id: TutorialStepId;
  title: string;
  /** progress 0..1 for this frame; 1 completes the step */
  update(ctx: TutorialCtx, m: TutorialMachine): number;
  enter?(m: TutorialMachine): void;
  parts?(m: TutorialMachine): TutorialPart[];
  hintAfter: number;
  focus: TutorialFocus;
  /** angle mode is forced while this step runs */
  forceAngle: boolean;
  /** the step needs an armed, flying drone; the card says so when it is disarmed */
  needsArmed: boolean;
}

export type TutorialPhase = 'idle' | 'running' | 'done' | 'skipped';

export type TutorialEvent =
  | { type: 'step'; index: number; id: TutorialStepId }
  | { type: 'hint'; id: TutorialStepId }
  | { type: 'repeat'; id: TutorialStepId }
  | { type: 'done' }
  | { type: 'skipped' };

export interface TutorialRecord {
  done: boolean;
  skipped: boolean;
  /** 1-based number of the last step reached */
  step: number;
  /** ms since epoch of the last write */
  at: number;
}

export const TUTORIAL_KEY = 'drone-sim.tutorial.v1';
export const HINT_AFTER = 20;
export const TAKEOFF_AGL = 1.5;
export const HOVER_MIN_AGL = 1;
export const HOVER_MAX_AGL = 3;
export const HOVER_MAX_VY = 0.4;
export const HOVER_HOLD = 3;
export const YAW_TARGET = Math.PI;
/** slower heading changes (drift, wobble) do not count towards the yaw step */
export const YAW_MIN_RATE = (15 * Math.PI) / 180;
export const TRAVEL_TARGET = 4;
/** slower horizontal speed along an axis (drift) does not count towards the travel step */
export const TRAVEL_MIN_SPEED = 0.3;
/** below this the drone is on the ground: sliding does not count as flying a direction */
export const TRAVEL_MIN_AGL = 0.3;
export const LAND_AGL = 0.15;
export const LAND_MAX_SPEED = 0.3;
export const LAND_HOLD = 1;
export const SKIP_HOLD = 1;
export const SKIP_HOLD_XR = 1.5;
/** below this horizontal length of the nose vector the heading is undefined (nose straight up / down) */
const HEADING_MIN_HORIZONTAL = 0.2;
const CAMERAS: readonly CameraMode[] = ['los', 'fpv', 'chase'];

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const NO_FOCUS: TutorialFocus = { channels: [], button: null };

/** Heading in radians, + = turned right (clockwise seen from above) from facing −Z; null when the nose is vertical. */
export function headingOf(q: TutorialQuat): number | null {
  // nose = q · (0, 0, −1)
  const fx = -2 * (q.w * q.y + q.z * q.x);
  const fz = -1 + 2 * (q.x * q.x + q.y * q.y);
  if (Math.hypot(fx, fz) < HEADING_MIN_HORIZONTAL) return null;
  return Math.atan2(fx, -fz);
}

/** Signed shortest angle from a to b, in (−π, π]. */
export function angleDelta(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

function speedOf(v: TutorialVec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

/** The twelve steps of §4, in order. */
export const TUTORIAL_STEPS: readonly TutorialStepDef[] = [
  {
    id: 'welcome',
    title: 'Welcome, pilot',
    update: (c) => (c.confirm ? 1 : 0),
    hintAfter: HINT_AFTER,
    focus: { channels: [], button: 'confirm' },
    forceAngle: false,
    needsArmed: false,
  },
  {
    id: 'arm',
    title: 'Arm the motors',
    update: (c) => (c.armed ? 1 : 0),
    hintAfter: HINT_AFTER,
    focus: { channels: ['throttle'], button: 'arm' },
    forceAngle: true,
    needsArmed: false,
  },
  {
    id: 'throttle',
    title: 'Take off',
    update: (c) => (c.armed ? clamp01(c.agl / TAKEOFF_AGL) : 0),
    hintAfter: HINT_AFTER,
    focus: { channels: ['throttle'], button: null },
    forceAngle: true,
    needsArmed: true,
  },
  {
    id: 'hover',
    title: 'Hover',
    update: (c, m) => {
      const steady = c.armed && c.agl >= HOVER_MIN_AGL && c.agl <= HOVER_MAX_AGL && Math.abs(c.drone.velocity.y) < HOVER_MAX_VY;
      m.scratch.hold = steady ? (m.scratch.hold ?? 0) + c.dt : 0;
      return clamp01(m.scratch.hold / HOVER_HOLD);
    },
    hintAfter: HINT_AFTER,
    focus: { channels: ['throttle'], button: null },
    forceAngle: true,
    needsArmed: true,
  },
  {
    id: 'yaw',
    title: 'Yaw: turn on the spot',
    update: (c, m) => {
      const s = m.scratch;
      const h = headingOf(c.drone.orientation);
      if (h !== null && s.heading !== undefined && c.dt > 0) {
        const d = angleDelta(s.heading, h);
        if (Math.abs(d) / c.dt >= YAW_MIN_RATE) {
          if (d > 0) s.right = Math.min(YAW_TARGET, (s.right ?? 0) + d);
          else s.left = Math.min(YAW_TARGET, (s.left ?? 0) - d);
        }
      }
      if (h !== null) s.heading = h;
      return ((s.right ?? 0) + (s.left ?? 0)) / (2 * YAW_TARGET);
    },
    parts: (m) => [
      { id: 'right', value: (m.scratch.right ?? 0) / YAW_TARGET },
      { id: 'left', value: (m.scratch.left ?? 0) / YAW_TARGET },
    ],
    hintAfter: HINT_AFTER,
    focus: { channels: ['yaw'], button: null },
    forceAngle: true,
    needsArmed: true,
  },
  {
    id: 'pitch-roll',
    title: 'Pitch & roll',
    update: (c, m) => {
      const s = m.scratch;
      const h = headingOf(c.drone.orientation);
      if (h !== null && c.armed && c.agl >= TRAVEL_MIN_AGL) {
        const v = c.drone.velocity;
        const sin = Math.sin(h);
        const cos = Math.cos(h);
        const vf = v.x * sin - v.z * cos;
        const vr = v.x * cos + v.z * sin;
        const add = (k: string, speed: number): void => {
          if (speed >= TRAVEL_MIN_SPEED) s[k] = Math.min(TRAVEL_TARGET, (s[k] ?? 0) + speed * c.dt);
        };
        add('forward', vf);
        add('back', -vf);
        add('right', vr);
        add('left', -vr);
      }
      return ((s.forward ?? 0) + (s.back ?? 0) + (s.right ?? 0) + (s.left ?? 0)) / (4 * TRAVEL_TARGET);
    },
    parts: (m) =>
      ['forward', 'back', 'left', 'right'].map((id) => ({ id, value: (m.scratch[id] ?? 0) / TRAVEL_TARGET })),
    hintAfter: HINT_AFTER,
    focus: { channels: ['pitch', 'roll'], button: null },
    forceAngle: true,
    needsArmed: true,
  },
  {
    id: 'land',
    title: 'Land',
    update: (c, m) => {
      const s = m.scratch;
      if (s.from === undefined) s.from = Math.max(1, c.agl);
      const settled = c.armed && c.agl < LAND_AGL && speedOf(c.drone.velocity) < LAND_MAX_SPEED;
      s.hold = settled ? (s.hold ?? 0) + c.dt : 0;
      if (s.hold >= LAND_HOLD) return 1;
      // descent fills most of the bar, the settle second the rest; never 1 before it settled
      const descent = clamp01(1 - c.agl / s.from);
      return Math.min(0.99, 0.8 * descent + 0.2 * (s.hold / LAND_HOLD));
    },
    hintAfter: HINT_AFTER,
    focus: { channels: ['throttle'], button: null },
    forceAngle: true,
    needsArmed: true,
  },
  {
    id: 'disarm',
    title: 'Disarm',
    update: (c) => (c.armed ? 0 : 1),
    hintAfter: HINT_AFTER,
    focus: { channels: [], button: 'arm' },
    forceAngle: true,
    needsArmed: false,
  },
  {
    id: 'modes',
    title: 'Angle vs acro',
    update: (c, m) => {
      const s = m.scratch;
      if (c.flightMode === 'acro') s.acro = 1;
      else if (s.acro) s.angle = 1;
      return ((s.acro ?? 0) + (s.angle ?? 0)) / 2;
    },
    parts: (m) => [
      { id: 'acro', value: m.scratch.acro ?? 0 },
      { id: 'angle', value: m.scratch.angle ?? 0 },
    ],
    hintAfter: HINT_AFTER,
    focus: { channels: [], button: 'toggleMode' },
    forceAngle: false,
    needsArmed: false,
  },
  {
    id: 'cameras',
    title: 'Cameras',
    update: (c, m) => {
      m.scratch[c.cameraMode] = 1;
      return CAMERAS.reduce((n, k) => n + (m.scratch[k] ?? 0), 0) / CAMERAS.length;
    },
    parts: (m) => CAMERAS.map((id) => ({ id, value: m.scratch[id] ?? 0 })),
    hintAfter: HINT_AFTER,
    focus: { channels: [], button: 'cycleCamera' },
    forceAngle: false,
    needsArmed: false,
  },
  {
    id: 'ring',
    title: 'Your first ring',
    update: (c, m) => {
      const s = m.scratch;
      if (s.base === undefined || c.ringsPassed < s.base) s.base = c.ringsPassed;
      return c.ringsPassed > s.base ? 1 : 0;
    },
    hintAfter: HINT_AFTER,
    focus: { channels: ['pitch', 'roll'], button: null },
    forceAngle: false,
    needsArmed: true,
  },
  {
    id: 'done',
    title: 'Tutorial complete',
    update: () => 0,
    hintAfter: Infinity,
    focus: NO_FOCUS,
    forceAngle: false,
    needsArmed: false,
  },
];

export const TUTORIAL_STEP_COUNT = TUTORIAL_STEPS.length;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Stored progress, or null when there is none or it is unreadable (never throws). */
export function loadTutorialRecord(storage: Storage | null): TutorialRecord | null {
  if (!storage) return null;
  try {
    const text = storage.getItem(TUTORIAL_KEY);
    if (!text) return null;
    const r: unknown = JSON.parse(text);
    if (!isRecord(r)) return null;
    const step = typeof r.step === 'number' && Number.isInteger(r.step) ? Math.min(TUTORIAL_STEP_COUNT, Math.max(1, r.step)) : 1;
    return {
      done: r.done === true,
      skipped: r.skipped === true,
      step,
      at: typeof r.at === 'number' && Number.isFinite(r.at) ? r.at : 0,
    };
  } catch {
    return null;
  }
}

/** Persists progress; storage errors (quota, privacy mode) are swallowed. */
export function saveTutorialRecord(storage: Storage | null, r: TutorialRecord): void {
  if (!storage) return;
  try {
    storage.setItem(TUTORIAL_KEY, JSON.stringify(r));
  } catch {
    /* storage unavailable */
  }
}

/** First-run prompt: offered until the pilot finished or skipped the tutorial once. */
export function shouldOfferTutorial(r: TutorialRecord | null): boolean {
  return !r || (!r.done && !r.skipped);
}

export interface TutorialMachineOptions {
  storage?: Storage | null;
  /** clock for the record's `at` (ms since epoch) */
  now?: () => number;
}

export class TutorialMachine {
  readonly steps: readonly TutorialStepDef[] = TUTORIAL_STEPS;
  /** per-step working values, cleared when a step (re)starts */
  scratch: Record<string, number> = {};
  private _phase: TutorialPhase = 'idle';
  private _index = 0;
  private _progress = 0;
  private best = 0;
  private stall = 0;
  private _hint = false;
  private skipHold = 0;
  private skipHoldMax = SKIP_HOLD;
  private _playerFlightMode: FlightMode | null = null;
  private readonly storage: Storage | null;
  private readonly now: () => number;

  constructor(opts: TutorialMachineOptions = {}) {
    this.storage = opts.storage ?? null;
    this.now = opts.now ?? Date.now;
  }

  get phase(): TutorialPhase {
    return this._phase;
  }

  /** 0-based index of the current step */
  get index(): number {
    return this._index;
  }

  get step(): TutorialStepDef {
    return this.steps[this._index]!;
  }

  /** progress of the current step, 0..1 */
  get progress(): number {
    return this._progress;
  }

  /** whole tutorial, 0..1 (the done step counts as complete) */
  get overall(): number {
    if (this._phase === 'done') return 1;
    return Math.min(1, (this._index + this._progress) / (this.steps.length - 1));
  }

  get hint(): boolean {
    return this._hint;
  }

  /** hold-to-skip fill, 0..1 */
  get skipHoldProgress(): number {
    return clamp01(this.skipHold / this.skipHoldMax);
  }

  /** the pilot's flight mode when the tutorial started; restore it when the tutorial ends */
  get playerFlightMode(): FlightMode | null {
    return this._playerFlightMode;
  }

  get record(): TutorialRecord | null {
    return loadTutorialRecord(this.storage);
  }

  get active(): boolean {
    return this._phase === 'running';
  }

  /** Starts (or replays) from step 1, or from `fromStep` (1-based) to resume. */
  start(playerFlightMode: FlightMode, fromStep = 1): TutorialEvent[] {
    this._playerFlightMode = playerFlightMode;
    this._phase = 'running';
    const i = Math.min(this.steps.length - 2, Math.max(0, Math.floor(fromStep) - 1));
    return this.enter(Number.isFinite(i) ? i : 0);
  }

  update(ctx: TutorialCtx): TutorialEvent[] {
    if (this._phase !== 'running') return [];
    const dt = Number.isFinite(ctx.dt) && ctx.dt > 0 ? ctx.dt : 0;
    this.skipHoldMax = ctx.source === 'xr' ? SKIP_HOLD_XR : SKIP_HOLD;
    if (ctx.skipHeld) {
      this.skipHold += dt;
      if (this.skipHold >= this.skipHoldMax) return this.skip();
    } else {
      this.skipHold = 0;
    }
    const step = this.step;
    const p = clamp01(step.update(dt === ctx.dt ? ctx : { ...ctx, dt }, this));
    this._progress = p;
    if (p >= 1) return this.enter(this._index + 1);
    const out: TutorialEvent[] = [];
    if (p > this.best + 1e-6) {
      this.best = p;
      this.stall = 0;
      this._hint = false;
    } else {
      this.stall += dt;
      if (!this._hint && this.stall >= step.hintAfter) {
        this._hint = true;
        out.push({ type: 'hint', id: step.id });
      }
    }
    return out;
  }

  /**
   * A crash (or reset) while the tutorial runs: the current step starts over. Returns true when the
   * integrator should respawn the drone on the pad.
   */
  crash(): boolean {
    if (this._phase !== 'running') return false;
    this.restartStep();
    return true;
  }

  /** Ends the tutorial without finishing it; the record remembers the skip so the first-run prompt never returns. */
  skip(): TutorialEvent[] {
    if (this._phase === 'skipped') return [];
    const prev = this.record;
    this._phase = 'skipped';
    this._hint = false;
    this.skipHold = 0;
    saveTutorialRecord(this.storage, { done: prev?.done ?? false, skipped: true, step: this._index + 1, at: this.now() });
    return [{ type: 'skipped' }];
  }

  /** Angle mode while steps 2–8 run, else null (the pilot's own mode). */
  requiredFlightMode(): FlightMode | null {
    return this._phase === 'running' && this.step.forceAngle ? 'angle' : null;
  }

  /**
   * Flight buttons the integrator must drop this frame: arm on the welcome card (A / confirm share a button on
   * pad and Quest), the mode toggle while angle is forced.
   */
  lockedButtons(): readonly ('arm' | 'toggleMode')[] {
    if (this._phase !== 'running') return [];
    if (this.step.id === 'welcome') return ['arm'];
    return this.step.forceAngle ? ['toggleMode'] : [];
  }

  parts(): TutorialPart[] {
    const f = this.step.parts;
    return f ? f(this).map((p) => ({ id: p.id, value: clamp01(p.value) })) : [];
  }

  private restartStep(): void {
    this.scratch = {};
    this._progress = 0;
    this.best = 0;
    this.stall = 0;
    this._hint = false;
    this.step.enter?.(this);
  }

  private enter(i: number): TutorialEvent[] {
    this._index = i;
    this.restartStep();
    const step = this.step;
    const out: TutorialEvent[] = [{ type: 'step', index: i, id: step.id }];
    const prev = this.record;
    const done = step.id === 'done';
    if (done) {
      this._phase = 'done';
      this._progress = 1;
      out.push({ type: 'done' });
    }
    saveTutorialRecord(this.storage, { done: done || (prev?.done ?? false), skipped: prev?.skipped ?? false, step: i + 1, at: this.now() });
    return out;
  }
}
