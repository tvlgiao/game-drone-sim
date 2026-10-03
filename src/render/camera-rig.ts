/** FPV / Chase / LOS cameras with smooth mode transitions and shake. No per-frame allocations. */
import * as THREE from 'three';
import type { CameraMode, DroneState, LevelDef, OutdoorLevel } from '../types';
import { FPV_FOV_V_RANGE } from '../core/camera-limits';
import { heightField, isRuntime, type LevelRuntime } from '../levels/runtime';
import { boxTopAt, type ColliderGrid, type GridCollider } from '../physics/collider-grid';
import type { ColliderShape } from '../types';
import { FLAT_GROUND, findDryGround, type HeightField } from '../physics/terrain';
import { CAMERA_PIVOT, LENS_OFFSET } from './drone-model';

const CHASE_BACK = 1.0;
const CHASE_UP = 0.35;
const CHASE_OMEGA = 9;
const BLEND_TIME = 0.45;
/** LOS: standing pilot's eye. Vertical FOV wide enough to take in the whole loft from the corner. */
const LOS_FOV_V = 62;
/** fraction of the half-FOV the drone may drift before the pilot turns their head */
const LOS_MARGIN_YAW = 0.62;
const LOS_MARGIN_PITCH = 0.55;
/** head turn spring (rad/s natural frequency) and relax-back-to-overview rate */
const LOS_HEAD_OMEGA = 4.5;
const LOS_RELAX = 0.35;
/**
 * Hard limit (fraction of the half-frame, in NDC) on the drone's offset from the head direction, applied after the
 * spring: a fast climb or dash next to the pilot outruns the spring, which would otherwise lose the drone.
 */
const LOS_HARD_FRAME = 0.62;
const LOS_MAX_PITCH = 1.45;
/**
 * FPV under the ceiling: within this clearance (m) the camera's uptilt eases off (to FPV_CEILING_TILT
 * of the setting at contact), otherwise a quad pressed to the unlit ceiling sees nothing but black.
 */
const FPV_CEILING_RELIEF = 0.6;
const FPV_CEILING_TILT = 0.3;
/** lens kept this far below the ceiling plane so the near plane never cuts into it */
const FPV_CEILING_GAP = 0.04;
/** far planes: the loft is 24 m across; outdoors the sky dome and backdrop hills sit a few hundred metres out */
const INDOOR_FAR = 90;
const OUTDOOR_FAR = 1200;
/** outdoors the chase camera keeps this far above the ground (the room box inset indoors is 0.12) */
export const CHASE_GROUND_CLEARANCE = 0.35;
/** the FPV lens sits a few cm above the ground when landed: only keep the near plane out of it */
export const FPV_GROUND_CLEARANCE = 0.03;
/** samples along drone → camera when looking for terrain / boxes in between */
const MARCH_STEPS = 8;
/** boxes are inflated by this much (m) so the near plane does not clip a wall the camera stops at */
const BOX_MARGIN = 0.08;
/** Large levels: the LOS FOV narrows with range, from 62° at ≤ 40 m to 28° at ≥ 200 m. */
export const LOS_FOV_NEAR = { range: 40, fov: LOS_FOV_V } as const;
export const LOS_FOV_FAR = { range: 200, fov: 28 } as const;
/** 1/s: how fast the LOS FOV follows its range target */
const LOS_FOV_RATE = 1.5;
/** an outdoor level is large (range-dependent LOS FOV) when unbounded or at least this wide */
export const LARGE_LEVEL_EXTENT = 200;
/** Pilot relocation (levels with `relocatePilot`, outside VR). */
export const RELOCATE_RANGE = 260;
export const RELOCATE_OCCLUDED_SECONDS = 1.5;
export const RELOCATE_FADE_SECONDS = 0.3;
export const RELOCATE_BEHIND = 35;
export const PILOT_EYE_HEIGHT = 1.7;
const OCCLUSION_SAMPLES = 16;
/** re-plant search: distances (m) from the drone, tried in order, and 30° turns off "behind" per distance */
const RELOCATE_RADII = [RELOCATE_BEHIND, 25, 50, 15, 70, 100] as const;
const RELOCATE_TURNS = [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6] as const;
/** a roof is a stand only up to this far above the drone (no pilots on top of a 200 m tower) */
const RELOCATE_ROOF_ABOVE = 12;
/** the pilot's body (feet → just over the eye) keeps this far (m) from every collider */
const PILOT_BODY_MARGIN = 0.4;
/** after a search that found no spot, wait this long (s) before trying again */
const RELOCATE_RETRY = 1;
/** sight line ends left out of the occlusion test (m): the eye itself, and a drone sitting on a roof */
const SIGHT_END_EYE = 0.2;
const SIGHT_END_DRONE = 0.3;

const _pos = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qt = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _e = new THREE.Euler();
const _up = new THREE.Vector3(0, 1, 0);
const _x = new THREE.Vector3(1, 0, 0);
const _right = new THREE.Vector3();
const _camUp = new THREE.Vector3();
const _mp = new THREE.Vector3();
const _dry = { x: 0, z: 0 };
const _eye = new THREE.Vector3();
const _best = new THREE.Vector3();

/** Target LOS vertical FOV (deg) at `range` metres on a large level. */
export function losFovForRange(range: number): number {
  const t = THREE.MathUtils.clamp((range - LOS_FOV_NEAR.range) / (LOS_FOV_FAR.range - LOS_FOV_NEAR.range), 0, 1);
  return LOS_FOV_NEAR.fov + (LOS_FOV_FAR.fov - LOS_FOV_NEAR.fov) * t;
}

export function isLargeLevel(def: OutdoorLevel): boolean {
  const b = def.bounds;
  if (b.kind === 'infinite') return true;
  if (b.kind !== 'rect' || !b.min || !b.max) return false;
  return Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1]) >= LARGE_LEVEL_EXTENT;
}

/** Segment a → b (parameter window t0..t1) against a yawed box (slab test in the box frame). */
export function segmentHitsBox(a: THREE.Vector3, b: THREE.Vector3, sh: Extract<ColliderShape, { kind: 'box' }>, t0: number, t1: number): boolean {
  const yaw = sh.yaw ?? 0;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const ax = a.x - sh.center[0];
  const az = a.z - sh.center[2];
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  // world → local = R_y(−yaw), as boxTopAt
  const o = [c * ax - s * az, a.y - sh.center[1], s * ax + c * az];
  const d = [c * dx - s * dz, b.y - a.y, s * dx + c * dz];
  let lo = t0;
  let hi = t1;
  for (let k = 0; k < 3; k++) {
    const h = sh.half[k]!;
    if (Math.abs(d[k]!) < 1e-9) {
      if (Math.abs(o[k]!) > h) return false;
      continue;
    }
    let ta = (-h - o[k]!) / d[k]!;
    let tb = (h - o[k]!) / d[k]!;
    if (ta > tb) [ta, tb] = [tb, ta];
    if (ta > lo) lo = ta;
    if (tb < hi) hi = tb;
    if (lo > hi) return false;
  }
  return true;
}

/** A shape comes within `m` of the vertical column (x, z) between y0 and y1 (tori by their bounding box). */
function shapeNearColumn(sh: ColliderShape, x: number, z: number, y0: number, y1: number, m: number): boolean {
  if (sh.kind === 'box') {
    const yaw = sh.yaw ?? 0;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const dx = x - sh.center[0];
    const dz = z - sh.center[2];
    return Math.abs(c * dx - s * dz) <= sh.half[0] + m && Math.abs(s * dx + c * dz) <= sh.half[2] + m && y1 >= sh.center[1] - sh.half[1] && y0 <= sh.center[1] + sh.half[1];
  }
  if (sh.kind === 'cylinder') {
    return Math.hypot(x - sh.center[0], z - sh.center[2]) <= sh.radius + m && y1 >= sh.center[1] - sh.halfHeight && y0 <= sh.center[1] + sh.halfHeight;
  }
  const r = sh.majorRadius + sh.tubeRadius;
  return Math.hypot(x - sh.center[0], z - sh.center[2]) <= r + m && y1 >= sh.center[1] - r && y0 <= sh.center[1] + r;
}

/**
 * Outdoor camera constraint: nothing (terrain, collider-grid boxes) may stand between the drone and
 * the camera, and the camera never goes below `clearance` over the ground.
 */
export class OutdoorConstraint {
  private readonly found: GridCollider[] = [];
  /** sight-line and pilot-spot queries (kept apart from `found`, which pullCamera fills) */
  private readonly sight: GridCollider[] = [];

  constructor(
    readonly field: HeightField,
    readonly grid: ColliderGrid | null,
  ) {}

  /**
   * Raises `cam` to `clearance` over the ground, then marches drone → camera in 8 steps and pulls the
   * camera back to the last clear sample; a final raise keeps the clearance (horizontal offset kept).
   */
  pullCamera(from: THREE.Vector3, cam: THREE.Vector3, clearance = CHASE_GROUND_CLEARANCE): void {
    this.raise(cam, clearance);
    let n = 0;
    if (this.grid) {
      const m = BOX_MARGIN;
      n = this.grid.query(
        Math.min(from.x, cam.x) - m,
        Math.min(from.y, cam.y) - m,
        Math.min(from.z, cam.z) - m,
        Math.max(from.x, cam.x) + m,
        Math.max(from.y, cam.y) + m,
        Math.max(from.z, cam.z) + m,
        this.found,
      );
    }
    let clear = 0;
    for (let k = 1; k <= MARCH_STEPS; k++) {
      const t = k / MARCH_STEPS;
      _mp.lerpVectors(from, cam, t);
      if (this.blocked(_mp, n)) break;
      clear = t;
    }
    if (clear < 1) cam.lerpVectors(from, cam, clear);
    this.raise(cam, clearance);
  }

  /** True when terrain rises above the segment a → b (excluding its ends), sampled `samples` times. */
  terrainBlocks(a: THREE.Vector3, b: THREE.Vector3, samples = OCCLUSION_SAMPLES): boolean {
    for (let k = 1; k < samples; k++) {
      _mp.lerpVectors(a, b, k / samples);
      if (_mp.y < this.field.heightAt(_mp.x, _mp.z)) return true;
    }
    return false;
  }

  /**
   * Line of sight a → b blocked by the terrain or by a collider-grid box (buildings, bridges, slabs; trees and
   * other cylinders do not hide the drone). The last SIGHT_END_DRONE m at b and the first SIGHT_END_EYE m at a are
   * left out, so a drone sitting on a roof is still in sight.
   */
  sightBlocked(a: THREE.Vector3, b: THREE.Vector3): boolean {
    if (this.terrainBlocks(a, b)) return true;
    if (!this.grid) return false;
    const len = a.distanceTo(b);
    if (len < SIGHT_END_EYE + SIGHT_END_DRONE) return false;
    const n = this.grid.query(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.min(a.z, b.z), Math.max(a.x, b.x), Math.max(a.y, b.y), Math.max(a.z, b.z), this.sight);
    const t0 = SIGHT_END_EYE / len;
    const t1 = 1 - SIGHT_END_DRONE / len;
    for (let i = 0; i < n; i++) {
      const sh = this.sight[i]!.shape;
      if (sh.kind === 'box' && segmentHitsBox(a, b, sh, t0, t1)) return true;
    }
    return false;
  }

  /**
   * Where a pilot at (x, z) would stand: the ground, or the highest box top under (x, z) that is at most `maxTop`;
   * NaN when (x, z) lies inside a box rising above `maxTop` (a tower wall, not a place to stand).
   */
  standHeight(x: number, z: number, maxTop: number): number {
    let stand = this.field.heightAt(x, z);
    if (!this.grid) return stand;
    const n = this.grid.query(x, -Infinity, z, x, Infinity, z, this.sight);
    for (let i = 0; i < n; i++) {
      const top = boxTopAt(this.sight[i]!.shape, x, z);
      if (top === -Infinity || top <= stand) continue;
      if (top > maxTop) return Number.NaN;
      stand = top;
    }
    return stand;
  }

  /** The pilot's body (a column from `feet` to just over the eye at (x, z)) is clear of every collider. */
  bodyClear(x: number, feet: number, z: number): boolean {
    if (!this.grid) return true;
    const m = PILOT_BODY_MARGIN;
    const y0 = feet + 0.05;
    const y1 = feet + PILOT_EYE_HEIGHT + 0.2;
    const n = this.grid.query(x - m, y0, z - m, x + m, y1, z + m, this.sight);
    for (let i = 0; i < n; i++) if (shapeNearColumn(this.sight[i]!.shape, x, z, y0, y1, m)) return false;
    return true;
  }

  private raise(cam: THREE.Vector3, clearance: number): void {
    const g = this.field.heightAt(cam.x, cam.z) + clearance;
    if (cam.y < g) cam.y = g;
  }

  private blocked(p: THREE.Vector3, n: number): boolean {
    if (p.y < this.field.heightAt(p.x, p.z)) return true;
    for (let i = 0; i < n; i++) {
      const s = this.found[i]!.shape;
      if (s.kind !== 'box') continue;
      const yaw = s.yaw ?? 0;
      const dx = p.x - s.center[0];
      const dz = p.z - s.center[2];
      const c = Math.cos(yaw);
      const sn = Math.sin(yaw);
      const m = BOX_MARGIN;
      if (Math.abs(c * dx - sn * dz) <= s.half[0] + m && Math.abs(p.y - s.center[1]) <= s.half[1] + m && Math.abs(sn * dx + c * dz) <= s.half[2] + m) return true;
    }
    return false;
  }
}

export interface RigInput {
  dt: number;
  time: number;
  drone: DroneState;
  mode: CameraMode;
  cameraTiltDeg: number;
  fovDeg: number;
  speed: number;
  /** jump straight to the mode's pose (no blend): still frames behind a menu */
  instant?: boolean;
}

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  private mode: CameraMode = 'chase';
  private blend = 1;
  private readonly fromPos = new THREE.Vector3();
  private readonly fromQuat = new THREE.Quaternion();
  private fromFov = 70;
  private readonly chasePos = new THREE.Vector3();
  private readonly chaseVel = new THREE.Vector3();
  private readonly chaseLook = new THREE.Vector3();
  private readonly losLook = new THREE.Vector3();
  private readonly overview: THREE.Vector3;
  private headYaw = 0;
  private headPitch = 0;
  private headYawV = 0;
  private headPitchV = 0;
  private headTargetYaw = 0;
  private headTargetPitch = 0;
  private headInit = false;
  /** exposed for FX: LOS-ness 0..1 */
  losWeight = 0;
  private chaseInit = false;
  private trauma = 0;
  private fovV = 70;
  private readonly pilot = new THREE.Vector3();
  /**
   * Space the chase camera must stay in: the inset room box indoors; outdoors only the ground plane
   * bounds it (an unbounded box with its floor just above the ground).
   */
  private readonly bounds = new THREE.Box3();
  /** FPV ceiling (Infinity under open sky) */
  private ceiling = Infinity;
  private outdoor = false;
  /** null indoors */
  private outdoorConstraint: OutdoorConstraint | null = null;
  private field: HeightField = FLAT_GROUND;
  /** range-dependent LOS FOV (large outdoor levels) */
  private largeLevel = false;
  private relocatable = false;
  private losFov = LOS_FOV_V;
  private occludedFor = 0;
  /** seconds before another re-plant search after one that found no safe spot */
  private relocRetry = 0;
  /** 0 idle, 1 fading out, 2 fading in */
  private relocPhase = 0;
  /** relocation needs a non-VR view: the headset teleports its own way */
  allowRelocate = true;
  /** 0..1 black fade over the view while the LOS pilot is re-planted */
  fade = 0;
  /** times the pilot has been re-planted on this level */
  relocations = 0;
  /** outdoor LOS: where the pilot's head rests (next ring), null = the static overview */
  private focus: THREE.Vector3 | null = null;
  private readonly focusPoint = new THREE.Vector3();
  /** exposed for FX: FPV-ness 0..1 (1 while fully in FPV) */
  fpvWeight = 0;
  /** camera shake / impact trauma; off in a headset, where shaking the view causes nausea */
  shake = true;
  /** this frame's pose for the current mode before the mode-change blend (XR teleports instead) */
  readonly targetPos = new THREE.Vector3();
  readonly targetQuat = new THREE.Quaternion();

  /** `roomSize` null = outdoor level (open sky over flat ground y = 0). */
  constructor(pilot: readonly [number, number, number], roomSize: readonly [number, number, number] | null) {
    this.camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.02, INDOOR_FAR);
    this.overview = new THREE.Vector3();
    this.configure(pilot, roomSize, null);
  }

  /**
   * Re-target the rig to a level (camera object kept: post FX and the XR dolly hold it). A bare
   * LevelDef is flat ground with no collider grid.
   */
  setLevel(level: LevelDef | LevelRuntime): void {
    const def = isRuntime(level) ? level.def : level;
    this.field = isRuntime(level) ? heightField(level) : FLAT_GROUND;
    this.largeLevel = false;
    this.relocatable = false;
    if (def.kind === 'indoor') {
      this.outdoorConstraint = null;
      this.configure(def.pilot, def.room.size, null);
      return;
    }
    this.outdoorConstraint = new OutdoorConstraint(this.field, isRuntime(level) ? level.grid : null);
    this.largeLevel = isLargeLevel(def);
    this.relocatable = def.relocatePilot === true;
    const c = new THREE.Vector3();
    for (const r of def.rings) c.add(_v.set(r.position[0], r.position[1], r.position[2]));
    if (def.rings.length > 0) c.divideScalar(def.rings.length);
    else c.set(def.spawn.position[0], def.pilot[1], def.spawn.position[2] - 20);
    this.configure(def.pilot, null, c);
  }

  private configure(pilot: readonly [number, number, number], roomSize: readonly [number, number, number] | null, overview: THREE.Vector3 | null): void {
    this.pilot.set(pilot[0], pilot[1], pilot[2]);
    this.outdoor = roomSize === null;
    this.focus = null;
    this.losFov = LOS_FOV_V;
    this.occludedFor = 0;
    this.relocRetry = 0;
    this.relocPhase = 0;
    this.fade = 0;
    this.relocations = 0;
    if (roomSize) {
      const m = 0.18;
      this.bounds.min.set(-roomSize[0] / 2 + m, 0.12, -roomSize[2] / 2 + m);
      this.bounds.max.set(roomSize[0] / 2 - m, roomSize[1] - m, roomSize[2] / 2 - m);
      this.ceiling = roomSize[1];
      // Resting gaze: centre of the room at chest height, so the whole course is in view.
      this.overview.set(0, roomSize[1] * 0.28, -roomSize[2] * 0.08);
      this.camera.far = INDOOR_FAR;
    } else {
      this.bounds.min.set(-Infinity, -Infinity, -Infinity);
      this.bounds.max.set(Infinity, Infinity, Infinity);
      this.ceiling = Infinity;
      this.overview.copy(overview ?? _v.set(this.pilot.x, this.pilot.y, this.pilot.z - 20));
      this.camera.far = OUTDOOR_FAR;
    }
    this.camera.position.copy(this.pilot);
    this.camera.updateProjectionMatrix();
    this.headInit = false;
    this.chaseInit = false;
  }

  /**
   * Outdoor LOS: rest the pilot's gaze on this point (the next ring) instead of the course overview;
   * null returns to the overview. Indoors the room overview always holds.
   */
  setFocus(p: THREE.Vector3 | null): void {
    if (!this.outdoor || !p) {
      this.focus = null;
      return;
    }
    this.focus = this.focusPoint.copy(p);
  }

  get currentMode(): CameraMode {
    return this.mode;
  }

  /** LOS pilot's eye (moves when the pilot is re-planted). */
  get pilotEye(): THREE.Vector3 {
    return this.pilot;
  }

  /** Current LOS vertical FOV target after smoothing (deg). */
  get losFovDeg(): number {
    return this.losFov;
  }

  /** Standing pilot's spot on the ground → `out`; returns the yaw facing the room overview. */
  losFloorAnchor(out: THREE.Vector3): number {
    out.set(this.pilot.x, this.field.heightAt(this.pilot.x, this.pilot.z), this.pilot.z);
    _v2.copy(this.overview).sub(this.pilot);
    return yawOf(_v2);
  }

  /** Add camera shake (0..1, accumulates, clamped). */
  addTrauma(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Snap chase spring to the drone (after respawn). */
  snap(): void {
    this.chaseInit = false;
  }

  update(f: RigInput): void {
    const dt = Math.min(f.dt, 0.05);
    if (f.mode !== this.mode) {
      this.fromPos.copy(this.camera.position);
      this.fromQuat.copy(this.camera.quaternion);
      this.fromFov = this.camera.fov;
      this.mode = f.mode;
      this.blend = f.instant ? 1 : 0;
    }
    this.updateLosFov(f, dt);
    this.updateRelocation(f, dt);
    this.updateChase(f, dt);
    this.updateHead(f, dt);

    this.pose(f.mode, f, _pos, _q);
    this.targetPos.copy(_pos);
    this.targetQuat.copy(_q);
    const targetFov = this.fovV;

    const cam = this.camera;
    if (this.blend < 1) {
      this.blend = Math.min(1, this.blend + dt / BLEND_TIME);
      const t = this.blend * this.blend * (3 - 2 * this.blend);
      cam.position.lerpVectors(this.fromPos, _pos, t);
      cam.quaternion.slerpQuaternions(this.fromQuat, _q, t);
      cam.fov = this.fromFov + (targetFov - this.fromFov) * t;
    } else {
      cam.position.copy(_pos);
      cam.quaternion.copy(_q);
      cam.fov = targetFov;
    }
    const fpvTarget = f.mode === 'fpv' ? 1 : 0;
    this.fpvWeight += (fpvTarget - this.fpvWeight) * Math.min(1, dt * 8);
    this.losWeight += ((f.mode === 'los' ? 1 : 0) - this.losWeight) * Math.min(1, dt * 8);

    // Shake: high-frequency vibration in FPV (motor driven) + trauma from impacts.
    let motors = 0;
    for (let i = 0; i < 4; i++) motors += f.drone.motors[i];
    motors *= 0.25;
    const vib = f.mode === 'fpv' && f.drone.armed ? 0.0012 + motors * 0.0035 : 0;
    const tr = this.trauma * this.trauma;
    const amp = vib + tr * (f.mode === 'fpv' ? 0.09 : 0.05);
    if (amp > 0 && this.shake) {
      const t = f.time;
      _e.set(
        amp * (Math.sin(t * 91.3) * 0.6 + Math.sin(t * 57.1 + 1.3) * 0.4),
        amp * (Math.sin(t * 73.7 + 2.1) * 0.6 + Math.sin(t * 43.9) * 0.4),
        amp * 0.7 * Math.sin(t * 67.3 + 0.7),
      );
      _qt.setFromEuler(_e);
      cam.quaternion.multiply(_qt);
      if (tr > 0) {
        cam.position.x += tr * 0.04 * Math.sin(t * 47.0);
        cam.position.y += tr * 0.04 * Math.sin(t * 53.0 + 1.0);
      }
    }
    this.trauma = Math.max(0, this.trauma - dt * 1.4);

    cam.near = f.mode === 'los' ? 0.05 : f.mode === 'fpv' ? 0.02 : 0.03;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }

  private pose(mode: CameraMode, f: RigInput, outPos: THREE.Vector3, outQuat: THREE.Quaternion): void {
    const aspect = this.camera.aspect;
    if (mode === 'fpv') {
      const setTilt = THREE.MathUtils.degToRad(f.cameraTiltDeg);
      this.fpvLens(f.drone, setTilt, outPos);
      const relief = 1 - THREE.MathUtils.clamp((this.ceiling - outPos.y) / FPV_CEILING_RELIEF, 0, 1);
      const tilt = setTilt * (1 - (1 - FPV_CEILING_TILT) * relief);
      if (relief > 0) this.fpvLens(f.drone, tilt, outPos);
      outPos.y = Math.min(outPos.y, this.ceiling - FPV_CEILING_GAP);
      this.outdoorConstraint?.pullCamera(f.drone.position, outPos, FPV_GROUND_CLEARANCE);
      outQuat.copy(f.drone.orientation).multiply(_qt.setFromAxisAngle(_x, tilt));
      // settings FOV is horizontal-ish (like a real FPV camera); convert to vertical for three.
      const h = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(f.fovDeg, 60, 150));
      this.fovV = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(h / 2) / aspect)), FPV_FOV_V_RANGE.min, FPV_FOV_V_RANGE.max);
    } else if (mode === 'chase') {
      outPos.copy(this.chasePos);
      lookQuat(outPos, this.chaseLook, outQuat);
      this.fovV = 68 + Math.min(14, f.speed * 0.9);
    } else {
      outPos.copy(this.pilot);
      dirFromAngles(this.headYaw, this.headPitch, _v);
      this.losLook.copy(this.pilot).add(_v);
      lookQuat(outPos, this.losLook, outQuat);
      this.fovV = this.losFov;
    }
  }

  /**
   * Standing pilot's head: rests on the overview (outdoors: the focus ring) and only turns when the drone nears the
   * edge of the frame (dead-zone), with a critically damped spring like a human head.
   */
  private updateHead(f: RigInput, dt: number): void {
    const halfV = THREE.MathUtils.degToRad(this.losFov / 2);
    const halfH = Math.atan(Math.tan(halfV) * this.camera.aspect);
    _v.copy(this.focus ?? this.overview).sub(this.pilot);
    const baseYaw = yawOf(_v);
    const basePitch = pitchOf(_v);
    _v.copy(f.drone.position).sub(this.pilot);
    const droneYaw = yawOf(_v);
    const dronePitch = pitchOf(_v);
    if (!this.headInit) {
      this.headYaw = this.headTargetYaw = baseYaw;
      this.headPitch = this.headTargetPitch = basePitch;
      this.headInit = true;
    }
    // drift back towards the overview, then keep the drone inside the dead-zone
    this.headTargetYaw += wrapAngle(baseYaw - this.headTargetYaw) * Math.min(1, dt * LOS_RELAX);
    this.headTargetPitch += (basePitch - this.headTargetPitch) * Math.min(1, dt * LOS_RELAX);
    const my = halfH * LOS_MARGIN_YAW;
    const mp = halfV * LOS_MARGIN_PITCH;
    const dy = wrapAngle(droneYaw - this.headTargetYaw);
    if (dy > my) this.headTargetYaw += dy - my;
    else if (dy < -my) this.headTargetYaw += dy + my;
    const dp = dronePitch - this.headTargetPitch;
    if (dp > mp) this.headTargetPitch += dp - mp;
    else if (dp < -mp) this.headTargetPitch += dp + mp;
    this.headTargetPitch = THREE.MathUtils.clamp(this.headTargetPitch, -1.2, 1.2);

    const w = LOS_HEAD_OMEGA;
    const ey = wrapAngle(this.headTargetYaw - this.headYaw);
    this.headYawV += (ey * w * w - 2 * w * this.headYawV) * dt;
    this.headYaw = wrapAngle(this.headYaw + this.headYawV * dt);
    const ep = this.headTargetPitch - this.headPitch;
    this.headPitchV += (ep * w * w - 2 * w * this.headPitchV) * dt;
    this.headPitch += this.headPitchV * dt;

    this.keepInFrame(f.drone.position, Math.tan(halfH) * LOS_HARD_FRAME, Math.tan(halfV) * LOS_HARD_FRAME, droneYaw, dronePitch);
    this.headPitch = THREE.MathUtils.clamp(this.headPitch, -LOS_MAX_PITCH, LOS_MAX_PITCH);
  }

  /**
   * Turns the head the least needed so `p` projects within ±`tx` / ±`ty` (tangent units of the view frame).
   * Works in the head's own frame: yaw/pitch differences alone misjudge the projection when looking up steeply.
   */
  private keepInFrame(p: THREE.Vector3, tx: number, ty: number, droneYaw: number, dronePitch: number): void {
    _v.copy(p).sub(this.pilot);
    for (let i = 0; i < 6; i++) {
      dirFromAngles(this.headYaw, this.headPitch, _fwd);
      _right.crossVectors(_fwd, _up).normalize();
      _camUp.crossVectors(_right, _fwd);
      const zf = _v.dot(_fwd);
      if (zf <= 1e-3) {
        this.headYaw = droneYaw;
        this.headPitch = dronePitch;
        this.headYawV = this.headPitchV = 0;
        continue;
      }
      const x = _v.dot(_right) / zf;
      const y = _v.dot(_camUp) / zf;
      const ex = Math.abs(x) > tx ? Math.atan(x) - Math.sign(x) * Math.atan(tx) : 0;
      const ey = Math.abs(y) > ty ? Math.atan(y) - Math.sign(y) * Math.atan(ty) : 0;
      if (ex === 0 && ey === 0) break;
      // +x (right) is a negative yaw; a yaw turn moves the view sideways by about cos(pitch) of its angle
      this.headYaw = wrapAngle(this.headYaw - (ex * 1.05) / Math.max(0.25, Math.cos(this.headPitch)));
      this.headPitch = THREE.MathUtils.clamp(this.headPitch + ey * 1.05, -LOS_MAX_PITCH, LOS_MAX_PITCH);
      if (this.headYawV * ex > 0) this.headYawV = 0;
      if (this.headPitchV * ey < 0) this.headPitchV = 0;
    }
  }

  /** FPV lens position in world space for an uptilt of `tilt` rad → `out`. */
  private fpvLens(d: DroneState, tilt: number, out: THREE.Vector3): void {
    _qt.setFromAxisAngle(_x, tilt);
    _v.set(0, 0, -LENS_OFFSET - 0.004).applyQuaternion(_qt).add(CAMERA_PIVOT);
    out.copy(_v).applyQuaternion(d.orientation).add(d.position);
  }

  /**
   * Keeps the chase camera inside the room (the ceiling only lowers it, horizontal offset kept: pulling it back
   * along drone→camera would park it on the quad, looking up at its belly); outdoors the OutdoorConstraint.
   */
  private pullInside(from: THREE.Vector3, cam: THREE.Vector3): void {
    if (this.outdoorConstraint) {
      this.outdoorConstraint.pullCamera(from, cam);
      return;
    }
    if (cam.y > this.bounds.max.y) cam.y = this.bounds.max.y;
    pullInsideBox(this.bounds, from, cam);
  }

  /** Large levels: the LOS FOV narrows with the pilot → drone range (smoothed); elsewhere fixed. */
  private updateLosFov(f: RigInput, dt: number): void {
    const target = this.largeLevel ? losFovForRange(this.pilot.distanceTo(f.drone.position)) : LOS_FOV_V;
    this.losFov = f.instant ? target : this.losFov + (target - this.losFov) * (1 - Math.exp(-dt * LOS_FOV_RATE));
  }

  /**
   * Re-plants the LOS pilot when the drone is out of range or hidden behind terrain or buildings for too long: in
   * LOS behind a fade (out, move, in), otherwise at once since the pilot is not on screen.
   */
  private updateRelocation(f: RigInput, dt: number): void {
    const oc = this.outdoorConstraint;
    if (!oc || !this.relocatable || !this.allowRelocate) {
      this.relocPhase = 0;
      this.fade = 0;
      this.occludedFor = 0;
      this.relocRetry = 0;
      return;
    }
    if (this.relocPhase === 0) {
      this.relocRetry = Math.max(0, this.relocRetry - dt);
      const d = f.drone.position;
      this.occludedFor = oc.sightBlocked(this.pilot, d) ? this.occludedFor + dt : 0;
      if (this.relocRetry > 0 || (this.pilot.distanceTo(d) <= RELOCATE_RANGE && this.occludedFor <= RELOCATE_OCCLUDED_SECONDS)) return;
      if (f.mode !== 'los' || f.instant) {
        this.replant(f.drone);
        return;
      }
      this.relocPhase = 1;
    }
    if (this.relocPhase === 1) {
      this.fade = Math.min(1, this.fade + dt / RELOCATE_FADE_SECONDS);
      if (this.fade >= 1) {
        this.replant(f.drone);
        this.relocPhase = 2;
      }
      return;
    }
    this.fade = Math.max(0, this.fade - dt / RELOCATE_FADE_SECONDS);
    if (this.fade <= 0) this.relocPhase = 0;
  }

  /**
   * Re-plants the pilot near the drone: 35 m behind it (against its horizontal velocity, else its heading) when
   * that spot works, else the next of RELOCATE_RADII × RELOCATE_TURNS. A spot is dry, the body there is clear of
   * every collider (never inside a building), the pilot stands on the ground or on a roof at most
   * RELOCATE_ROOF_ABOVE over the drone, and the eye sees the drone past terrain and buildings. With no clear view
   * anywhere the first safe spot is taken; with no safe spot the pilot stays and the search waits RELOCATE_RETRY.
   */
  private replant(d: DroneState): boolean {
    const oc = this.outdoorConstraint;
    this.occludedFor = 0;
    if (!oc) return false;
    _v.set(-d.velocity.x, 0, -d.velocity.z);
    if (_v.lengthSq() < 1) {
      _v.set(0, 0, -1).applyQuaternion(d.orientation).negate();
      _v.y = 0;
      if (_v.lengthSq() < 1e-6) _v.set(0, 0, 1);
    }
    const base = Math.atan2(_v.x, _v.z);
    const maxTop = d.position.y + RELOCATE_ROOF_ABOVE;
    let fallback = false;
    for (const r of RELOCATE_RADII) {
      for (const k of RELOCATE_TURNS) {
        const a = base + (k * Math.PI) / 6;
        if (!findDryGround(this.field, d.position.x + Math.sin(a) * r, d.position.z + Math.cos(a) * r, _dry)) continue;
        const stand = oc.standHeight(_dry.x, _dry.z, maxTop);
        if (Number.isNaN(stand) || !oc.bodyClear(_dry.x, stand, _dry.z)) continue;
        _eye.set(_dry.x, stand + PILOT_EYE_HEIGHT, _dry.z);
        if (!oc.sightBlocked(_eye, d.position)) return this.plantAt(_eye);
        if (!fallback) {
          fallback = true;
          _best.copy(_eye);
        }
      }
    }
    if (fallback) return this.plantAt(_best);
    this.relocRetry = RELOCATE_RETRY;
    return false;
  }

  private plantAt(eye: THREE.Vector3): boolean {
    this.pilot.copy(eye);
    this.occludedFor = 0;
    this.headInit = false;
    this.relocations++;
    return true;
  }

  private updateChase(f: RigInput, dt: number): void {
    const d = f.drone;
    // yaw-only forward vector
    _fwd.set(0, 0, -1).applyQuaternion(d.orientation);
    _fwd.y = 0;
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1);
    _fwd.normalize();
    _v.copy(d.position).addScaledVector(_fwd, -CHASE_BACK);
    _v.y += CHASE_UP;
    // feed-forward cancels the spring's steady-state lag (2v/ω) so the quad stays framed
    _v.addScaledVector(d.velocity, 2 / CHASE_OMEGA - 0.05);
    this.pullInside(d.position, _v);
    _v2.copy(d.position).addScaledVector(_fwd, 0.6).addScaledVector(d.velocity, 0.1);
    if (!this.chaseInit) {
      this.chasePos.copy(_v);
      this.chaseVel.set(0, 0, 0);
      this.chaseLook.copy(_v2);
      this.chaseInit = true;
      return;
    }
    // critically damped spring
    const w = CHASE_OMEGA;
    _pos.copy(_v).sub(this.chasePos).multiplyScalar(w * w).addScaledVector(this.chaseVel, -2 * w);
    this.chaseVel.addScaledVector(_pos, dt);
    this.chasePos.addScaledVector(this.chaseVel, dt);
    this.pullInside(d.position, this.chasePos);
    this.chaseLook.lerp(_v2, 1 - Math.exp(-dt * 12));
  }
}

/**
 * Room-shell "raycast": if the segment drone→camera leaves the (inset) room box, pull the camera
 * back along it to the exit point so walls/floor/ceiling never come between camera and drone.
 */
function pullInsideBox(box: THREE.Box3, from: THREE.Vector3, cam: THREE.Vector3): void {
  box.clampPoint(from, _pv);
  let t = 1;
  for (let a = 0; a < 3; a++) {
    const f = _pv.getComponent(a);
    const c = cam.getComponent(a);
    const d = c - f;
    if (Math.abs(d) < 1e-9) continue;
    const lim = d > 0 ? box.max.getComponent(a) : box.min.getComponent(a);
    const ta = (lim - f) / d;
    if (ta < t) t = Math.max(0, ta);
  }
  if (t < 1) cam.lerpVectors(_pv, cam, t);
}

const _pv = new THREE.Vector3();

function lookQuat(eye: THREE.Vector3, target: THREE.Vector3, out: THREE.Quaternion): void {
  if (eye.distanceToSquared(target) < 1e-8) return;
  _m.lookAt(eye, target, _up);
  out.setFromRotationMatrix(_m);
}

/** yaw 0 looks down -Z, positive turns left (rotation about +Y) */
function yawOf(v: THREE.Vector3): number {
  return Math.atan2(-v.x, -v.z);
}

function pitchOf(v: THREE.Vector3): number {
  return Math.atan2(v.y, Math.hypot(v.x, v.z));
}

function dirFromAngles(yaw: number, pitch: number, out: THREE.Vector3): THREE.Vector3 {
  const c = Math.cos(pitch);
  return out.set(-Math.sin(yaw) * c, Math.sin(pitch), -Math.cos(yaw) * c);
}

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
