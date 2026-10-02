/** FPV / Chase / LOS cameras with smooth mode transitions and shake. No per-frame allocations. */
import * as THREE from 'three';
import type { CameraMode, DroneState, LevelDef } from '../types';
import { FPV_FOV_V_RANGE } from '../core/camera-limits';
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
const OUTDOOR_GROUND_CLEARANCE = 0.15;

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

  /** Re-target the rig to a level (camera object kept: post FX and the XR dolly hold it). */
  setLevel(def: LevelDef): void {
    if (def.kind === 'indoor') {
      this.configure(def.pilot, def.room.size, null);
      return;
    }
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
    if (roomSize) {
      const m = 0.18;
      this.bounds.min.set(-roomSize[0] / 2 + m, 0.12, -roomSize[2] / 2 + m);
      this.bounds.max.set(roomSize[0] / 2 - m, roomSize[1] - m, roomSize[2] / 2 - m);
      this.ceiling = roomSize[1];
      // Resting gaze: centre of the room at chest height, so the whole course is in view.
      this.overview.set(0, roomSize[1] * 0.28, -roomSize[2] * 0.08);
      this.camera.far = INDOOR_FAR;
    } else {
      this.bounds.min.set(-Infinity, OUTDOOR_GROUND_CLEARANCE, -Infinity);
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

  /** Standing pilot's spot on the floor (y = 0) → `out`; returns the yaw facing the room overview. */
  losFloorAnchor(out: THREE.Vector3): number {
    out.set(this.pilot.x, 0, this.pilot.z);
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
      this.fovV = LOS_FOV_V;
    }
  }

  /**
   * Standing pilot's head: rests on the overview (outdoors: the focus ring) and only turns when the drone nears the
   * edge of the frame (dead-zone), with a critically damped spring like a human head.
   */
  private updateHead(f: RigInput, dt: number): void {
    const halfV = THREE.MathUtils.degToRad(LOS_FOV_V / 2);
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
   * Keeps the chase camera inside the room (outdoors: above the ground). The ceiling only lowers it (horizontal offset kept): pulling
   * it back along drone→camera would park it on the quad, looking up at its belly.
   */
  private pullInside(from: THREE.Vector3, cam: THREE.Vector3): void {
    if (cam.y > this.bounds.max.y) cam.y = this.bounds.max.y;
    pullInsideBox(this.bounds, from, cam);
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
