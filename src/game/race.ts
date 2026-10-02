/** Race state machine: countdown, ordered ring passes, crash/respawn, timing and best-time persistence. DOM-free. */
import { Vector3 } from 'three';
import type { Contact, DroneState, GameEvent, RaceSnapshot, RaceStatus, RingDef, RoomLevelData, WorldBounds } from '../types';
import { isRuntime, type LevelRuntime } from '../levels/runtime';
import { createSurfaces, type SurfaceProvider } from './surfaces';

export const COUNTDOWN_SECONDS = 3;
export const CRASH_SPEED = 5;
export const COLLISION_SPEED = 0.8;
export const COLLISION_COOLDOWN = 0.15;
export const RESPAWN_DELAY = 1.5;
export const UPSIDE_DOWN_DOT = -0.5;
export const UPSIDE_DOWN_HEIGHT = 0.3;
export const UPSIDE_DOWN_TIME = 1;
export const RESPAWN_OFFSET = 1.2;
/** Seconds outside the level bounds (or above its ceiling) before the drone is respawned. */
export const OUT_OF_BOUNDS_RESPAWN = 5;
/** A step moving further than this is a teleport (respawn), never a ring pass. */
const MAX_STEP_TRAVEL = 1;

/** Storage keys of a level's best lap / splits: its LevelId (raw room data: its name). */
export const bestTimeKey = (levelKey: string): string => `drone-sim.best.${levelKey}`;
export const bestSplitsKey = (levelKey: string): string => `drone-sim.splits.${levelKey}`;
/** Builds before the level registry keyed the loft by its display name. */
const LEGACY_KEYS: readonly (readonly [string, string])[] = [['Night Loft', 'night-loft']];

/** A level as the race sees it: a LevelRuntime, or raw room data (tests, previews). */
export type RaceLevel = LevelRuntime | RoomLevelData;

/**
 * One-time move of best laps stored under a display name to the LevelId key. An existing id key wins
 * (it can only have been written later); the old keys are removed either way so the move never repeats.
 */
export function migrateBestTimes(storage: Storage | null): void {
  if (!storage) return;
  try {
    for (const [from, to] of LEGACY_KEYS) {
      for (const key of [bestTimeKey, bestSplitsKey]) {
        const old = storage.getItem(key(from));
        if (old === null) continue;
        if (storage.getItem(key(to)) === null) storage.setItem(key(to), old);
        storage.removeItem(key(from));
      }
    }
  } catch {
    /* quota / privacy mode: the old keys stay and the next boot retries */
  }
}

/** Stored best lap of a level (seconds); null when there is none or it is unreadable. */
export function readBestTime(storage: Storage | null, levelKey: string): number | null {
  let v: string | null = null;
  try {
    v = storage?.getItem(bestTimeKey(levelKey)) ?? null;
  } catch {
    return null;
  }
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Outside the bounds' footprint or above its ceiling; `ground` = ground height under the drone. */
export function outOfBounds(b: WorldBounds, x: number, y: number, z: number, ground = 0): boolean {
  if (b.kind === 'room') return false;
  if (y - ground > b.maxAgl) return true;
  if (b.kind !== 'rect' || !b.min || !b.max) return false;
  return x < b.min[0] || x > b.max[0] || z < b.min[1] || z > b.max[1];
}

interface RaceCourse {
  rings: readonly RingDef[];
  spawn: RoomLevelData['spawn'];
  /** persistence key */
  key: string;
  bounds: WorldBounds;
  surfaces: SurfaceProvider;
  ground: (x: number, z: number) => number;
}

const FLAT = (): number => 0;

function courseOf(level: RaceLevel): RaceCourse {
  if (!isRuntime(level)) {
    return { rings: level.rings, spawn: level.spawn, key: level.name, bounds: { kind: 'room', maxAgl: level.room.size[1] }, surfaces: createSurfaces(level.props), ground: FLAT };
  }
  const d = level.def;
  const t = level.terrain;
  return { rings: d.rings, spawn: d.spawn, key: d.id, bounds: d.bounds, surfaces: level.surfaces, ground: t ? (x, z) => t.heightAt(x, z) : FLAT };
}

type Mode = 'race' | 'freefly' | null;

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Where the segment prev→cur crosses the ring plane from the back (−dir) to the front (+dir) side
 * within `radius` of the centre. Returns the crossing point in `out`, or null.
 */
export function ringCrossing(
  prev: Vector3,
  cur: Vector3,
  center: readonly [number, number, number],
  dir: readonly [number, number, number],
  radius: number,
  out: Vector3,
): Vector3 | null {
  const a = dir[0] * (prev.x - center[0]) + dir[1] * (prev.y - center[1]) + dir[2] * (prev.z - center[2]);
  const b = dir[0] * (cur.x - center[0]) + dir[1] * (cur.y - center[1]) + dir[2] * (cur.z - center[2]);
  if (!(a < 0 && b >= 0)) return null;
  const t = a / (a - b);
  out.set(prev.x + (cur.x - prev.x) * t, prev.y + (cur.y - prev.y) * t, prev.z + (cur.z - prev.z) * t);
  const dx = out.x - center[0];
  const dy = out.y - center[1];
  const dz = out.z - center[2];
  return dx * dx + dy * dy + dz * dz <= radius * radius ? out : null;
}

/** World-up component of the body up axis (1 = level, −1 = inverted). */
export function bodyUpDot(q: { x: number; z: number }): number {
  return 1 - 2 * (q.x * q.x + q.z * q.z);
}

/** Yaw (rad) that faces from `from` towards `to`; yaw 0 faces −Z, positive yaw turns left. */
export function yawTowards(from: { x: number; z: number }, to: { x: number; z: number }): number {
  return Math.atan2(-(to.x - from.x), -(to.z - from.z));
}

export class RaceController {
  private status: RaceStatus = 'menu';
  private mode: Mode = null;
  private pausedFrom: RaceStatus | null = null;
  private time = 0;
  /** Latches at the first armed step after GO: the lap clock never counts time spent sitting disarmed. */
  private clockStarted = false;
  private countdownLeft = 0;
  private countdownShown = 0;
  private nextRing = 0;
  private lastPassed = -1;
  private lastSplit: number | null = null;
  private bestTime: number | null;
  private bestSplits: number[] | null;
  private splits: number[] = [];
  private crashTimer = 0;
  private upsideTimer = 0;
  private collisionCooldown = 0;
  private skipRingCheck = false;
  private readonly pending: GameEvent[] = [];
  private readonly events: GameEvent[] = [];
  private outTimer = 0;
  private outShown = 0;
  private readonly hit = new Vector3();
  private readonly storage: Storage | null;
  private level: RaceCourse;

  constructor(level: RaceLevel, storage: Storage | null = defaultStorage()) {
    this.storage = storage;
    this.level = courseOf(level);
    this.bestTime = this.readBest();
    this.bestSplits = this.readSplits();
  }

  /** Switches course: back to the menu state, with that level's best lap. */
  setLevel(level: RaceLevel): void {
    this.level = courseOf(level);
    this.bestTime = this.readBest();
    this.bestSplits = this.readSplits();
    this.toMenu();
  }

  snapshot(): RaceSnapshot {
    return {
      status: this.status,
      time: this.time,
      countdown: this.status === 'countdown' || this.pausedFrom === 'countdown' ? Math.ceil(this.countdownLeft) : 0,
      nextRing: this.mode === 'freefly' ? -1 : this.nextRing,
      totalRings: this.level.rings.length,
      bestTime: this.bestTime,
      lastSplit: this.lastSplit,
    };
  }

  /** Resets the course and starts the 3-2-1 countdown. Emits 'respawn' (drone to spawn) then 'countdown' 3. */
  startRace(): void {
    this.resetRun('race');
    this.status = 'countdown';
    this.countdownLeft = COUNTDOWN_SECONDS;
    this.countdownShown = COUNTDOWN_SECONDS;
    this.pending.push({ type: 'respawn' }, { type: 'countdown', value: COUNTDOWN_SECONDS });
  }

  /** Free flight: no timer, rings passable in any order. Emits 'respawn'. */
  startFreeFly(): void {
    this.resetRun('freefly');
    this.status = 'freefly';
    this.pending.push({ type: 'respawn' });
  }

  toMenu(): void {
    this.resetRun(null);
    this.status = 'menu';
  }

  pause(): void {
    if (this.status === 'paused' || this.status === 'menu' || this.status === 'finished') return;
    this.pausedFrom = this.status;
    this.status = 'paused';
  }

  resume(): void {
    if (this.status !== 'paused' || !this.pausedFrom) return;
    this.status = this.pausedFrom;
    this.pausedFrom = null;
  }

  /** Respawn at the checkpoint on the next step (reset button). */
  requestReset(): void {
    if (this.status === 'paused' || this.status === 'menu' || this.status === 'finished') return;
    this.respawn();
  }

  /**
   * Advance one physics step. The returned array is reused: consume it before the next call.
   * `prevPos` is the drone position at the start of this step.
   */
  step(dt: number, prevPos: Vector3, state: DroneState, contacts: readonly Contact[]): readonly GameEvent[] {
    const ev = this.events;
    ev.length = 0;
    for (const e of this.pending) ev.push(e);
    this.pending.length = 0;

    switch (this.status) {
      case 'countdown':
        this.stepCountdown(dt);
        break;
      case 'racing':
      case 'freefly':
        if (this.status === 'racing') {
          if (state.armed) this.clockStarted = true;
          if (this.clockStarted) this.time += dt;
        }
        this.checkRings(prevPos, state.position);
        if (this.status === 'racing' || this.status === 'freefly') this.checkCrash(dt, state, contacts);
        if (this.status === 'racing' || this.status === 'freefly') this.checkBounds(dt, state);
        break;
      case 'crashed':
        if (this.mode === 'race' && this.clockStarted) this.time += dt;
        this.crashTimer -= dt;
        if (this.crashTimer <= 0) this.respawn();
        for (const e of this.pending) ev.push(e);
        this.pending.length = 0;
        break;
      default:
        break;
    }
    this.collisionCooldown = Math.max(0, this.collisionCooldown - dt);
    return ev;
  }

  /**
   * Checkpoint: 1.2 m past the last passed ring along its direction, set down on the floor / prop top
   * below it (respawns are disarmed: left in mid-air the quad would fall, crash and respawn forever),
   * facing the next ring; else the level spawn.
   */
  respawnPoint(): { position: Vector3; yaw: number } {
    const rings = this.level.rings;
    if (this.mode !== 'race' || this.lastPassed < 0) {
      const s = this.level.spawn;
      return { position: new Vector3(s.position[0], s.position[1], s.position[2]), yaw: s.yaw };
    }
    const r = rings[this.lastPassed]!;
    const x = r.position[0] + r.direction[0] * RESPAWN_OFFSET;
    const z = r.position[2] + r.direction[2] * RESPAWN_OFFSET;
    const air = r.position[1] + r.direction[1] * RESPAWN_OFFSET;
    const pos = new Vector3(x, this.level.surfaces.topBelow(x, air, z) + this.level.spawn.position[1], z);
    const next = rings[this.lastPassed + 1];
    let yaw: number;
    if (next) {
      const dx = next.position[0] - pos.x;
      const dz = next.position[2] - pos.z;
      yaw = Math.hypot(dx, dz) > 1e-3 ? yawTowards(pos, { x: next.position[0], z: next.position[2] }) : 0;
    } else {
      const hx = r.direction[0];
      const hz = r.direction[2];
      yaw = Math.hypot(hx, hz) > 1e-3 ? Math.atan2(-hx, -hz) : 0;
    }
    return { position: pos, yaw };
  }

  private resetRun(mode: Mode): void {
    this.mode = mode;
    this.pausedFrom = null;
    this.time = 0;
    this.clockStarted = false;
    this.countdownLeft = 0;
    this.nextRing = 0;
    this.lastPassed = -1;
    this.lastSplit = null;
    this.splits = [];
    this.crashTimer = 0;
    this.upsideTimer = 0;
    this.collisionCooldown = 0;
    this.skipRingCheck = true;
    this.outTimer = 0;
    this.outShown = 0;
    this.pending.length = 0;
  }

  private stepCountdown(dt: number): void {
    this.countdownLeft -= dt;
    if (this.countdownLeft <= 0) {
      this.countdownLeft = 0;
      this.status = 'racing';
      this.events.push({ type: 'race-start' });
      return;
    }
    const shown = Math.ceil(this.countdownLeft);
    if (shown !== this.countdownShown) {
      this.countdownShown = shown;
      this.events.push({ type: 'countdown', value: shown });
    }
  }

  private checkRings(prev: Vector3, cur: Vector3): void {
    if (this.skipRingCheck) {
      this.skipRingCheck = false;
      return;
    }
    if (prev.distanceToSquared(cur) > MAX_STEP_TRAVEL * MAX_STEP_TRAVEL) return;
    const rings = this.level.rings;
    if (this.mode === 'race') {
      const r = rings[this.nextRing];
      if (!r || !ringCrossing(prev, cur, r.position, r.direction, r.radius, this.hit)) return;
      const index = this.nextRing;
      this.splits[index] = this.time;
      const ref = this.bestSplits?.[index];
      this.lastSplit = typeof ref === 'number' ? this.time - ref : null;
      this.lastPassed = index;
      this.nextRing++;
      this.events.push({ type: 'ring-passed', index, position: this.hit.clone() });
      if (this.nextRing >= rings.length) this.finish();
      return;
    }
    for (let i = 0; i < rings.length; i++) {
      const r = rings[i]!;
      if (ringCrossing(prev, cur, r.position, r.direction, r.radius, this.hit)) {
        this.lastPassed = i;
        this.events.push({ type: 'ring-passed', index: i, position: this.hit.clone() });
      }
    }
  }

  private finish(): void {
    this.status = 'finished';
    const newBest = this.bestTime === null || this.time < this.bestTime;
    if (newBest) {
      this.bestTime = this.time;
      this.bestSplits = this.splits.slice();
      this.write(bestTimeKey(this.level.key), String(this.time));
      this.write(bestSplitsKey(this.level.key), JSON.stringify(this.bestSplits));
    }
    this.events.push({ type: 'race-finish', time: this.time, best: newBest });
  }

  private checkCrash(dt: number, state: DroneState, contacts: readonly Contact[]): void {
    let worst: Contact | null = null;
    for (const c of contacts) if (!worst || c.impactSpeed > worst.impactSpeed) worst = c;
    if (worst && worst.impactSpeed > CRASH_SPEED) {
      this.crash(state, worst.impactSpeed);
      return;
    }
    if (worst && worst.impactSpeed > COLLISION_SPEED && this.collisionCooldown <= 0) {
      this.collisionCooldown = COLLISION_COOLDOWN;
      this.events.push({ type: 'collision', contact: worst });
    }
    const agl = state.position.y - this.level.ground(state.position.x, state.position.z);
    if (bodyUpDot(state.orientation) < UPSIDE_DOWN_DOT && agl < UPSIDE_DOWN_HEIGHT) {
      this.upsideTimer += dt;
      if (this.upsideTimer > UPSIDE_DOWN_TIME) this.crash(state, 0);
    } else {
      this.upsideTimer = 0;
    }
  }

  /** Soft bounds: a countdown while outside, then a respawn; flying back in cancels it. */
  private checkBounds(dt: number, state: DroneState): void {
    const p = state.position;
    if (!outOfBounds(this.level.bounds, p.x, p.y, p.z, this.level.ground(p.x, p.z))) {
      if (this.outTimer > 0) this.events.push({ type: 'in-bounds' });
      this.outTimer = 0;
      this.outShown = 0;
      return;
    }
    this.outTimer += dt;
    if (this.outTimer >= OUT_OF_BOUNDS_RESPAWN) {
      this.respawn();
      return;
    }
    const left = Math.ceil(OUT_OF_BOUNDS_RESPAWN - this.outTimer);
    if (left !== this.outShown) {
      this.outShown = left;
      this.events.push({ type: 'out-of-bounds', seconds: left });
    }
  }

  private crash(state: DroneState, speed: number): void {
    this.status = 'crashed';
    this.crashTimer = RESPAWN_DELAY;
    this.upsideTimer = 0;
    this.events.push({ type: 'crash', position: state.position.clone(), speed });
  }

  private respawn(): void {
    this.status = this.mode === 'race' ? (this.status === 'countdown' ? 'countdown' : 'racing') : 'freefly';
    this.crashTimer = 0;
    this.upsideTimer = 0;
    this.outTimer = 0;
    this.outShown = 0;
    this.skipRingCheck = true;
    this.pending.push({ type: 'respawn' });
  }

  private readBest(): number | null {
    return readBestTime(this.storage, this.level.key);
  }

  private readSplits(): number[] | null {
    const v = this.read(bestSplitsKey(this.level.key));
    if (!v) return null;
    try {
      const a: unknown = JSON.parse(v);
      return Array.isArray(a) && a.every((x) => typeof x === 'number') ? (a as number[]) : null;
    } catch {
      return null;
    }
  }

  private read(key: string): string | null {
    if (!this.storage) return null;
    try {
      return this.storage.getItem(key);
    } catch {
      return null;
    }
  }

  private write(key: string, value: string): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(key, value);
    } catch {
      /* quota / privacy mode */
    }
  }
}
