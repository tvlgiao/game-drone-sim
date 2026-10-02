/**
 * Standalone render preview (render-preview.html): GameView with a scripted drone flying a smooth
 * loop through the rings, so rendering/VFX can be judged without physics, input or UI.
 * Query params: ?tier=ultra|high|medium|low  &cam=fpv|chase|los  &t=<start seconds>  &pause  &level=training|night-loft
 */
import * as THREE from 'three';
import { DynamicResolution, pickTier, probeGpu } from '../core/quality';
import { buildLevel } from '../levels/registry';
import type { CameraMode, DroneState, GameEvent, QualityTier } from '../types';
import { GameView } from './game-view';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('c') as HTMLCanvasElement;
const statsEl = document.getElementById('stats') as HTMLDivElement;
const runtime = buildLevel(params.get('level') === 'training' ? 'training' : 'night-loft');
const level = runtime.def;

const gpu = probeGpu();
let tier: QualityTier = (params.get('tier') as QualityTier | null) ?? pickTier(gpu);
const view = new GameView(canvas, runtime, tier);

// ---- scripted path through the rings ------------------------------------------------------
const pts: THREE.Vector3[] = [];
const ringIdx: number[] = [];
level.rings.forEach((r, i) => {
  const p = new THREE.Vector3(...r.position);
  const d = new THREE.Vector3(...r.direction);
  pts.push(p.clone().addScaledVector(d, -1.1));
  ringIdx.push(pts.length);
  pts.push(p.clone());
  pts.push(p.clone().addScaledVector(d, 1.1));
  if (i === 5 && level.id === 'night-loft') pts.push(new THREE.Vector3(7.8, 0.32, 3.0)); // low pass for prop-wash
});
const curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal', 0.5);
const length = curve.getLength();
const ringU = ringIdx.map((k) => {
  // param of the control point on the arc-length parameterisation
  const target = pts[k];
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i <= 2000; i++) {
    const u = i / 2000;
    const dd = curve.getPointAt(u).distanceToSquared(target);
    if (dd < bestD) {
      bestD = dd;
      best = u;
    }
  }
  return best;
});

const state: DroneState = {
  position: new THREE.Vector3(),
  velocity: new THREE.Vector3(),
  orientation: new THREE.Quaternion(),
  angularVelocity: new THREE.Vector3(),
  motors: [0, 0, 0, 0],
  armed: true,
  batteryVoltage: 16.4,
};

const SPEED = 4.2;
let dist = (Number(params.get('t') ?? 0) * SPEED) % length;
let nextRing = 0;
let freeFly = params.has('free');
let paused = params.has('pause');
let camMode: CameraMode = (params.get('cam') as CameraMode | null) ?? 'chase';
let crashT = -1;
const hover = params.get('hover')?.split(',').map(Number) ?? null;
let simTime = Number(params.get('t') ?? 0);
const crashVel = new THREE.Vector3();
const crashSpin = new THREE.Vector3();

const _p0 = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _acc = new THREE.Vector3();
const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _x = new THREE.Vector3();
const _z = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const events: GameEvent[] = [];

function poseAt(d: number, dt: number): void {
  const h = 0.12;
  const u0 = (((d - SPEED * h) % length) + length) % length / length;
  const u1 = (((d) % length) + length) % length / length;
  const u2 = (((d + SPEED * h) % length) + length) % length / length;
  curve.getPointAt(u0, _p0);
  curve.getPointAt(u1, _p1);
  curve.getPointAt(u2, _p2);
  state.velocity.subVectors(_p2, _p0).multiplyScalar(1 / (2 * h));
  _acc.copy(_p2).add(_p0).addScaledVector(_p1, -2).multiplyScalar(1 / (h * h));
  // a real quad would not pull more than ~1.4 g laterally on this course; keeps tilt believable
  const lat = Math.hypot(_acc.x, _acc.z);
  if (lat > 13) {
    _acc.x *= 13 / lat;
    _acc.z *= 13 / lat;
  }
  _acc.y = Math.max(-6, Math.min(8, _acc.y));
  _up.copy(_acc).add(_z.set(0, 9.81, 0));
  const thrust = _up.length();
  _up.normalize();
  _fwd.copy(state.velocity).addScaledVector(_up, -state.velocity.dot(_up)).normalize();
  _z.copy(_fwd).negate();
  _x.crossVectors(_up, _z).normalize();
  _z.crossVectors(_x, _up);
  _m.makeBasis(_x, _up, _z);
  _q.setFromRotationMatrix(_m);
  if (dt > 0) state.orientation.slerp(_q, Math.min(1, dt * 14));
  else state.orientation.copy(_q);
  state.position.copy(_p1);
  const u = Math.sqrt(Math.min(1, (thrust * 0.26) / (4 * 2.9)));
  for (let i = 0; i < 4; i++) state.motors[i] = Math.min(1, Math.max(0.05, u + Math.sin(simTime * 9 + i * 1.7) * 0.03));
}

function emit(e: GameEvent): void {
  events.push(e);
}

function crash(): void {
  if (crashT >= 0) return;
  crashT = 0;
  crashVel.copy(state.velocity).multiplyScalar(0.3);
  crashVel.y = Math.max(crashVel.y, 0.5);
  crashSpin.set(Math.random() * 14 - 7, Math.random() * 8 - 4, Math.random() * 14 - 7);
  emit({ type: 'crash', position: state.position.clone(), speed: state.velocity.length() });
  state.armed = false;
}

function respawn(): void {
  crashT = -1;
  state.armed = true;
  poseAt(dist, 0);
  emit({ type: 'respawn' });
}

function bump(): void {
  const n = new THREE.Vector3(0, 1, 0);
  const contact = { normal: n, depth: 0, point: state.position.clone().setY(state.position.y - 0.05), impactSpeed: 3.2, colliderId: 'preview' };
  emit({ type: 'collision', contact });
}

// ---- controls -----------------------------------------------------------------------------
const modes: CameraMode[] = ['fpv', 'chase', 'los'];
const tiers: QualityTier[] = ['ultra', 'high', 'medium', 'low'];
function setTier(t: QualityTier): void {
  tier = t;
  view.setQuality(t);
}
window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === '1') camMode = 'fpv';
  else if (k === '2') camMode = 'chase';
  else if (k === '3') camMode = 'los';
  else if (k === 'c') camMode = modes[(modes.indexOf(camMode) + 1) % modes.length];
  else if (k === 'x') crash();
  else if (k === 'h') bump();
  else if (k === 'r') respawn();
  else if (k === 'f') freeFly = !freeFly;
  else if (k === 'p') paused = !paused;
  else if (k === 'q') setTier(tiers[(tiers.indexOf(tier) + 1) % tiers.length]);
});
document.querySelectorAll<HTMLButtonElement>('#hud button').forEach((b) => {
  b.addEventListener('click', () => {
    if (b.dataset.cam) camMode = b.dataset.cam as CameraMode;
    if (b.dataset.tier) setTier(b.dataset.tier as QualityTier);
    const a = b.dataset.act;
    if (a === 'crash') crash();
    else if (a === 'bump') bump();
    else if (a === 'respawn') respawn();
    else if (a === 'free') freeFly = !freeFly;
    else if (a === 'pause') paused = !paused;
  });
});
const onResize = () => view.resize(window.innerWidth, window.innerHeight);
window.addEventListener('resize', onResize);

// ---- loop ---------------------------------------------------------------------------------
const dyn = params.has('dynres') ? new DynamicResolution(Number(params.get('dynres')) || 60) : null;
const preview = {
  fps: 0,
  frameMs: 0,
  calls: 0,
  triangles: 0,
  tier,
  gpu,
  view,
  get camera() {
    return camMode;
  },
  setCamera(m: CameraMode) {
    camMode = m;
  },
  setTier,
  crash,
  bump,
  respawn,
  setPaused(p: boolean) {
    paused = p;
  },
  setFreeFly(f: boolean) {
    freeFly = f;
  },
  /** Render `frames` frames back-to-back (one GPU sync at the end) and return mean ms/frame, independent of vsync. */
  bench(frames = 120): number {
    const gl = view.renderer.getContext();
    const px = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) {
      simTime += 1 / 120;
      dist += SPEED / 120;
      poseAt(dist, 1 / 120);
      view.frame({ dt: 1 / 120, time: simTime, drone: state, fanAngle: simTime * 8.8, nextRing, cameraMode: camMode, cameraTiltDeg: 25, fovDeg: 110, speed: 4 });
    }
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return (performance.now() - t0) / frames;
  },
  /** jump the scripted flight to time t (seconds along the loop) */
  seek(t: number) {
    simTime = t;
    dist = (t * SPEED) % length;
    poseAt(dist, 0);
    syncNextRing();
  },
};
(window as unknown as { __preview: typeof preview }).__preview = preview;

function syncNextRing(): void {
  const u = (dist % length) / length;
  const k = ringU.findIndex((r) => r > u);
  nextRing = k < 0 ? 0 : k;
}
poseAt(dist, 0);
syncNextRing();
let last = performance.now();
let emaMs = 16;
let statsTimer = 0;
function tick(now: number): void {
  const frameMs = now - last;
  last = now;
  const dt = Math.min(0.1, frameMs / 1000);
  emaMs += (frameMs - emaMs) * 0.05;
  preview.fps = 1000 / emaMs;
  preview.frameMs = emaMs;

  if (!paused || hover) {
    if (!paused) simTime += dt;
    if (crashT >= 0) {
      crashT += dt;
      crashVel.y -= 9.81 * dt;
      state.position.addScaledVector(crashVel, dt);
      if (state.position.y < 0.06) {
        state.position.y = 0.06;
        crashVel.multiplyScalar(0.4);
        crashVel.y = Math.abs(crashVel.y) * 0.3;
        crashSpin.multiplyScalar(0.6);
      }
      _q.setFromEuler(new THREE.Euler(crashSpin.x * dt, crashSpin.y * dt, crashSpin.z * dt));
      state.orientation.multiply(_q);
      for (let i = 0; i < 4; i++) state.motors[i] *= 0.9;
      if (crashT > 1.6) respawn();
    } else if (hover && crashT < 0) {
      const yaw = simTime * 0.35;
      state.position.set(hover[0], hover[1] + Math.sin(simTime * 1.3) * 0.03, hover[2]);
      state.velocity.set(0, Math.cos(simTime * 1.3) * 0.04, 0);
      _q.setFromEuler(new THREE.Euler(0.08 * Math.sin(simTime * 0.9), yaw, 0.06 * Math.sin(simTime * 1.1), 'YXZ'));
      state.orientation.copy(_q);
      for (let i = 0; i < 4; i++) state.motors[i] = 0.46 + Math.sin(simTime * 9 + i * 1.7) * 0.03;
    } else {
      const before = dist;
      dist += SPEED * dt;
      poseAt(dist, dt);
      if (!freeFly) {
        const u0 = (before % length) / length;
        const u1 = (dist % length) / length;
        const target = ringU[nextRing];
        const crossed = u1 >= u0 ? target > u0 && target <= u1 : target > u0 || target <= u1;
        if (crossed) {
          emit({ type: 'ring-passed', index: nextRing, position: state.position.clone() });
          nextRing = (nextRing + 1) % level.rings.length;
        }
      }
    }
  }
  for (const e of events) view.handleEvent(e);
  events.length = 0;

  view.frame({
    dt: paused ? 0.016 : dt,
    time: simTime,
    drone: state,
    fanAngle: (simTime * 1.4 * Math.PI * 2) % (Math.PI * 2),
    nextRing: freeFly ? -1 : nextRing,
    cameraMode: camMode,
    cameraTiltDeg: 25,
    fovDeg: 110,
    speed: state.velocity.length(),
  });
  if (dyn) view.setRenderScale(dyn.update(frameMs));
  const s = view.stats();
  preview.calls = s.calls;
  preview.triangles = s.triangles;
  preview.tier = tier;
  statsTimer += frameMs;
  if (statsTimer > 250) {
    statsTimer = 0;
    statsEl.textContent = `${preview.fps.toFixed(0)} fps  ${emaMs.toFixed(2)} ms\ntier ${tier}  cam ${camMode}\ncalls ${s.calls}  tris ${(s.triangles / 1000).toFixed(0)}k\ngpu ${gpu.renderer.slice(0, 48)}`;
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
