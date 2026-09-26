# Drone Sim — Implementation Plan

Companion to `01-design.md`. Stack: Vite 8 + TypeScript 5.9 strict + three r186 (WebGL2) +
pmndrs `postprocessing` + Vitest 5 + Playwright 1.63. No other runtime deps.

Shared contracts already written (do not change without the integrator):
- `src/types.ts` — ControlInput, InputFrame, DroneState, Collider shapes, LevelDef, GameEvent …
- `src/game/level-data.ts` — `LOFT_LEVEL`, `levelColliders(level)`.

Rules for every work package
- TypeScript strict, no `any`, no new npm deps. `npm run typecheck` must pass for your files.
- Simulation code (physics/, control/, game/race.ts, core/settings.ts) must NOT import DOM or render.
- Avoid per-frame allocations in hot paths (reuse `Vector3`/`Quaternion` scratch objects).
- Own only the files listed for your package. Need a contract change? Stop and report it.
- Hot-path doc comments: one concise line per exported symbol; no ticket refs.

---

## WP-A · Physics + Flight Controller (agent A)

Files: `src/physics/*`, `src/control/*`, `tests/unit/physics*.test.ts`, `tests/unit/control*.test.ts`.

```ts
// src/physics/drone-params.ts
export interface MotorSpec { position: [number, number, number]; /** +1 prop spins CCW seen from above (angular vel +Y) */ spin: 1 | -1 }
export interface DroneParams {
  mass: number; inertia: [number, number, number]; armLength: number;
  maxThrustPerMotor: number; tauUp: number; tauDown: number; yawTorqueCoef: number;
  dragCdA: [number, number, number]; rotorDrag: number; propRadius: number;
  colliderRadius: number; propColliderRadius: number;
  battery: { full: number; empty: number; sagPerThrust: number; capacityS: number };
  idle: number;
}
export const DEFAULT_DRONE: DroneParams;           // values from design §4
export const MOTOR_LAYOUT: readonly MotorSpec[];   // index order FR, RL, FL, RR (body frame, -Z forward)
export function hoverThrottle(p?: DroneParams): number; // sqrt(mg / (4 Tmax))

// src/physics/collision.ts
export interface SphereHit { normal: Vector3; depth: number; point: Vector3 }
export function sphereVsShape(center: Vector3, radius: number, shape: ColliderShape, out: SphereHit): boolean;

// src/physics/physics-world.ts
export class PhysicsWorld {
  constructor(level: LevelDef, params?: DroneParams);
  readonly params: DroneParams;
  readonly state: DroneState;          // current
  readonly prevState: DroneState;      // previous step, for render interpolation
  fanAngle: number;                    // rad, fan spins at 1.4 rev/s
  time: number;
  reset(position: Vector3, yaw: number): void;
  /** One fixed step. motorCmd 0..1 per motor (after mixer). Returns contacts of this step (reused array). */
  step(dt: number, motorCmd: readonly number[]): readonly Contact[];
  interpolate(alpha: number, out: DroneState): DroneState;
}

// src/control/rates.ts  — Betaflight "Actual" rates, returns deg/s
export function actualRate(stick: number, r: RateProfile): number;
export const RATE_PRESETS: Record<'beginner' | 'freestyle' | 'race', RateProfile>;
// src/control/pid.ts, src/control/mixer.ts (quad-X, airmode, idle)
// src/control/flight-controller.ts
export class FlightController {
  constructor(params: DroneParams, seed?: number);
  mode: FlightMode; rates: RateProfile; readonly armed: boolean;
  /** Real FC rule: arming refused unless throttle < 0.05 and not upside down. Returns new armed state. */
  setArmed(armed: boolean, input: ControlInput, state: DroneState): boolean;
  reset(): void;
  /** Runs at physics rate; reads simulated gyro (noise+LPF) from state; returns motor commands 0..1. */
  update(dt: number, input: ControlInput, state: DroneState): readonly number[];
}

// src/physics/simulation.ts — convenience used by main loop and tests
export class Simulation {
  constructor(level: LevelDef, params?: DroneParams);
  readonly world: PhysicsWorld; readonly fc: FlightController;
  /** fc.update → world.step; keeps state.armed/motors in sync. */
  step(dt: number, input: ControlInput): readonly Contact[];
}
```
Physics truths to unit-test: hover throttle equilibrium (vertical accel ≈ 0 within 2 %),
free-fall g, analytical terminal velocity for quadratic drag, attitude stays level with no
input in angle mode, acro rate tracking (step 0→max rate settles < 80 ms, overshoot < 15 %),
yaw torque direction sign, collision: no penetration after 1 s resting on floor, restitution
bounce height ≈ e², no energy gain on any bounce, ground-effect > 1 near floor, determinism
(same seed ⇒ identical state after 10 s), arming refusal with throttle up.

## WP-B · Rendering + VFX + Quality (agent B)

Files: `src/render/**`, `src/core/quality.ts`.

```ts
// src/core/quality.ts
export interface QualityProfile { tier: QualityTier; shadows: boolean; shadowMapSize: number; post: boolean;
  bloom: boolean; smaa: boolean; maxDpr: number; particles: number; envMap: boolean; }
export const QUALITY_PROFILES: Record<QualityTier, QualityProfile>;
export interface GpuInfo { webgl2: boolean; software: boolean; renderer: string; }
export function probeGpu(): GpuInfo;                       // failIfMajorPerformanceCaveat + debug renderer info
export function pickTier(info: GpuInfo): QualityTier;
export class DynamicResolution { constructor(targetFps: number); /** returns render scale 0.5..1 */ update(frameMs: number): number; }

// src/render/game-view.ts  — the ONLY render entry used by main.ts
export interface ViewFrame {
  dt: number; time: number; drone: DroneState; fanAngle: number;
  nextRing: number;            // index of next ring, -1 none (free-fly shows all rings)
  cameraMode: CameraMode; cameraTiltDeg: number; fovDeg: number;
  speed: number;               // m/s, for FX intensity
}
export class GameView {
  constructor(canvas: HTMLCanvasElement, level: LevelDef, tier: QualityTier);
  readonly renderer: THREE.WebGLRenderer;
  frame(f: ViewFrame): void;           // update + render
  handleEvent(e: GameEvent): void;     // ring burst, crash sparks, respawn flash…
  setQuality(tier: QualityTier): void;
  setRenderScale(scale: number): void;
  resize(width: number, height: number): void;
  stats(): { calls: number; triangles: number };
  dispose(): void;
}
```
Internal modules (suggested): `materials.ts` (procedural carbon/concrete/brick/wood textures on
canvas → CanvasTexture, cached), `room.ts`, `props.ts` (per PropDef.kind builders, instancing
for bulbs/crates), `drone-model.ts` (uses `MOTOR_LAYOUT` from physics for motor placement and
spin direction; prop blur disc), `rings-view.ts`, `camera-rig.ts` (FPV/chase/LOS), `post.ts`,
`vfx/particles.ts` (GPU points: dust motes, bursts, sparks), `lights.ts`.
Everything procedural — no external asset downloads.

## WP-C · Input + Audio + UI + Race logic + Settings (agent C)

Files: `src/input/*`, `src/audio/*`, `src/ui/*` (incl. `src/ui/styles.css`), `src/game/race.ts`,
`src/core/settings.ts`, `tests/unit/input*.test.ts`, `tests/unit/race*.test.ts`, `tests/unit/settings*.test.ts`.

```ts
// src/core/settings.ts
export interface Settings { throttleSource: 'left-stick' | 'right-trigger'; flightMode: FlightMode;
  ratePreset: 'beginner' | 'freestyle' | 'race'; cameraTiltDeg: number; fovDeg: number;
  quality: QualityTier | 'auto'; volume: number; showFps: boolean; deadzone: number; }
export const DEFAULT_SETTINGS: Settings;
export function loadSettings(storage?: Storage | null): Settings;   // try/catch, validates fields
export function saveSettings(s: Settings, storage?: Storage | null): void;

// src/input/input-manager.ts
export class InputManager {
  constructor(win: Window, settings: Settings);
  updateSettings(s: Settings): void;
  poll(dt: number): InputFrame;   // gamepad preferred when any stick/button active, else keyboard
  rumble(strong: number, weak: number, ms: number): void;
  dispose(): void;
}
// pure helpers exported for tests: applyRadialDeadzone, stickToThrottle, KeyboardAxes (ramped keys)

// src/game/race.ts
export class RaceController {
  constructor(level: LevelDef, storage?: Storage | null);
  snapshot(): RaceSnapshot;
  startRace(): void; startFreeFly(): void; toMenu(): void; pause(): void; resume(): void;
  /** Call once per physics step. prev/current drone positions for ring plane crossing. */
  step(dt: number, prevPos: Vector3, state: DroneState, contacts: readonly Contact[]): readonly GameEvent[];
  /** Where to respawn after crash/reset (on/behind last passed ring, facing next ring). */
  respawnPoint(): { position: Vector3; yaw: number };
  requestReset(): void;
}

// src/audio/audio.ts
export class GameAudio { resume(): Promise<void>; setVolume(v: number): void;
  update(motors: readonly number[], armed: boolean, speed: number): void; handleEvent(e: GameEvent): void; }

// src/ui/hud.ts
export interface HudFrame { race: RaceSnapshot; drone: DroneState; input: InputFrame; fps: number; mode: FlightMode;
  camera: CameraMode; altitude: number; speed: number; tier: QualityTier; settings: Settings; }
export type UiAction = { type: 'race' } | { type: 'freefly' } | { type: 'resume' } | { type: 'menu' } | { type: 'retry' }
  | { type: 'settings'; settings: Settings };
export class Hud {
  constructor(root: HTMLElement, onAction: (a: UiAction) => void);
  update(f: HudFrame): void;        // DOM writes throttled, no layout thrash
  showScreen(s: 'main' | 'pause' | 'finish' | 'none', data?: { time?: number; best?: number | null; newBest?: boolean }): void;
  navigate(nav: NavEvents, confirm: boolean): void;   // gamepad menu navigation
  toast(msg: string): void;
  setError(msg: string): void;      // fatal (no WebGL)
}
```
Race rules from design §2 (crash threshold 5 m/s, upside-down on floor > 1 s, respawn 1.5 s).

## WP-D · Integration (integrator = lead)

Files: `index.html`, `src/main.ts`, `src/core/loop.ts`.
Fixed-step accumulator 1 ms, max 250 steps/frame, interpolation alpha, event fan-out
(race → audio/view/hud/rumble), screen state machine, dynamic resolution hook, FPS meter,
`window.__drone` debug/test hook (state, snapshot, fps, inject input) used by e2e.

## WP-E · Tests + QA

- Unit (Vitest): suites from WP-A/C + integration determinism test.
- E2E (Playwright, real GPU flags): boot w/o console errors, FPS sample ≥ 60 on dev machine,
  scripted input: arm → take off → hover ±0.3 m → fly through ring 0 → counter = 1, crash & respawn.
- Review agent pass (correctness + perf), fix findings.

## Order
A, B, C in parallel (disjoint files) → D integrate → E tests/review → handover doc `docs/03-handover.md`.
