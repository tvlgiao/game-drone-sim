/** FPV / Chase / LOS cameras with smooth mode transitions and shake. No per-frame allocations. */
import * as THREE from 'three';
import type { CameraMode, DroneState } from '../types';
import { CAMERA_PIVOT, LENS_OFFSET } from './drone-model';

const CHASE_BACK = 0.62;
const CHASE_UP = 0.2;
const CHASE_OMEGA = 9;
const BLEND_TIME = 0.45;

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

export interface RigInput {
  dt: number;
  time: number;
  drone: DroneState;
  mode: CameraMode;
  cameraTiltDeg: number;
  fovDeg: number;
  speed: number;
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
  private chaseInit = false;
  private trauma = 0;
  private fovV = 70;
  private readonly pilot: THREE.Vector3;
  private readonly bounds: THREE.Box3;
  /** exposed for FX: FPV-ness 0..1 (1 while fully in FPV) */
  fpvWeight = 0;

  constructor(pilot: readonly [number, number, number], roomSize: readonly [number, number, number]) {
    this.camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.02, 90);
    this.pilot = new THREE.Vector3(pilot[0], pilot[1], pilot[2]);
    const m = 0.18;
    this.bounds = new THREE.Box3(
      new THREE.Vector3(-roomSize[0] / 2 + m, 0.12, -roomSize[2] / 2 + m),
      new THREE.Vector3(roomSize[0] / 2 - m, roomSize[1] - m, roomSize[2] / 2 - m),
    );
    this.camera.position.copy(this.pilot);
  }

  get currentMode(): CameraMode {
    return this.mode;
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
      this.blend = 0;
    }
    this.updateChase(f, dt);
    this.losLook.lerp(f.drone.position, 1 - Math.exp(-dt * 10));

    this.pose(f.mode, f, _pos, _q);
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

    // Shake: high-frequency vibration in FPV (motor driven) + trauma from impacts.
    let motors = 0;
    for (let i = 0; i < 4; i++) motors += f.drone.motors[i];
    motors *= 0.25;
    const vib = f.mode === 'fpv' && f.drone.armed ? 0.0012 + motors * 0.0035 : 0;
    const tr = this.trauma * this.trauma;
    const amp = vib + tr * (f.mode === 'fpv' ? 0.09 : 0.05);
    if (amp > 0) {
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
      const tilt = THREE.MathUtils.degToRad(f.cameraTiltDeg);
      _qt.setFromAxisAngle(_x, tilt);
      _v.set(0, 0, -LENS_OFFSET - 0.004).applyQuaternion(_qt).add(CAMERA_PIVOT);
      outPos.copy(_v).applyQuaternion(f.drone.orientation).add(f.drone.position);
      outQuat.copy(f.drone.orientation).multiply(_qt);
      // settings FOV is horizontal-ish (like a real FPV camera); convert to vertical for three.
      const h = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(f.fovDeg, 60, 150));
      this.fovV = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(h / 2) / aspect)), 35, 110);
    } else if (mode === 'chase') {
      outPos.copy(this.chasePos);
      lookQuat(outPos, this.chaseLook, outQuat);
      this.fovV = 68 + Math.min(14, f.speed * 0.9);
    } else {
      outPos.copy(this.pilot);
      lookQuat(outPos, this.losLook, outQuat);
      const dist = this.pilot.distanceTo(f.drone.position);
      // Fixed tripod at 55°, with a gentle zoom when the quad is far so it stays readable.
      this.fovV = dist > 7 ? Math.max(32, (55 * 7) / dist) : 55;
    }
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
    this.bounds.clampPoint(_v, _v);
    _v2.copy(d.position).addScaledVector(_fwd, 0.9).addScaledVector(d.velocity, 0.12);
    _v2.y += 0.02;
    if (!this.chaseInit) {
      this.chasePos.copy(_v);
      this.chaseVel.set(0, 0, 0);
      this.chaseLook.copy(_v2);
      this.losLook.copy(d.position);
      this.chaseInit = true;
      return;
    }
    // critically damped spring
    const w = CHASE_OMEGA;
    _pos.copy(_v).sub(this.chasePos).multiplyScalar(w * w).addScaledVector(this.chaseVel, -2 * w);
    this.chaseVel.addScaledVector(_pos, dt);
    this.chasePos.addScaledVector(this.chaseVel, dt);
    this.bounds.clampPoint(this.chasePos, this.chasePos);
    this.chaseLook.lerp(_v2, 1 - Math.exp(-dt * 12));
  }
}

function lookQuat(eye: THREE.Vector3, target: THREE.Vector3, out: THREE.Quaternion): void {
  if (eye.distanceToSquared(target) < 1e-8) return;
  _m.lookAt(eye, target, _up);
  out.setFromRotationMatrix(_m);
}
