import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CameraRig } from '../../src/render/camera-rig';
import { LOFT_LEVEL } from '../../src/game/level-data';
import { createDroneState } from '../../src/physics/physics-world';
import type { CameraMode, DroneState } from '../../src/types';

const ROOM = LOFT_LEVEL.room.size;
const CEILING = ROOM[1];

function droneAt(x: number, y: number, z: number): DroneState {
  const d = createDroneState();
  d.position.set(x, y, z);
  d.armed = true;
  return d;
}

function settle(rig: CameraRig, drone: DroneState, mode: CameraMode, seconds = 2): THREE.PerspectiveCamera {
  for (let t = 0; t < seconds; t += 1 / 60) rig.update({ dt: 1 / 60, time: t, drone, mode, cameraTiltDeg: 25, fovDeg: 110, speed: 0 });
  return rig.camera;
}

/** NDC of `p` in `cam` (|x|, |y| < 1 and z < 1 ⇒ on screen). */
function ndc(cam: THREE.PerspectiveCamera, p: THREE.Vector3): THREE.Vector3 {
  cam.updateMatrixWorld();
  return p.clone().project(cam);
}

/** Degrees of view below the horizon at the bottom edge of the frame. */
function belowHorizonDeg(cam: THREE.PerspectiveCamera): number {
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
  const pitch = THREE.MathUtils.radToDeg(Math.asin(fwd.y));
  return cam.fov / 2 - pitch;
}

describe('chase camera near the ceiling', () => {
  it('stays below the ceiling, keeps its distance behind the quad and keeps it in frame', () => {
    const rig = new CameraRig(LOFT_LEVEL.pilot, ROOM);
    const drone = droneAt(-9, CEILING - 0.1, 2);
    const cam = settle(rig, drone, 'chase');
    expect(cam.position.y).toBeLessThan(CEILING - 0.1);
    const behind = Math.hypot(cam.position.x - drone.position.x, cam.position.z - drone.position.z);
    expect(behind).toBeGreaterThan(0.7);
    const p = ndc(cam, drone.position);
    expect(Math.abs(p.x)).toBeLessThan(0.8);
    expect(Math.abs(p.y)).toBeLessThan(0.8);
    expect(p.z).toBeLessThan(1);
  });

  it('mid-room the chase pose is unchanged: 1 m behind and above the quad', () => {
    const rig = new CameraRig(LOFT_LEVEL.pilot, ROOM);
    const drone = droneAt(-9, 3, 2);
    const cam = settle(rig, drone, 'chase');
    expect(cam.position.z - drone.position.z).toBeCloseTo(1, 1);
    expect(cam.position.y - drone.position.y).toBeCloseTo(0.35, 1);
  });
});

describe('FPV camera near the ceiling', () => {
  it('pressed to the ceiling the view still reaches well below the horizon and the lens stays under it', () => {
    const rig = new CameraRig(LOFT_LEVEL.pilot, ROOM);
    const cam = settle(rig, droneAt(-9, CEILING - 0.1, 2), 'fpv');
    expect(belowHorizonDeg(cam)).toBeGreaterThan(25);
    expect(cam.position.y).toBeLessThan(CEILING - 0.03);
  });

  it('away from the ceiling the camera keeps the pilot\'s uptilt', () => {
    const rig = new CameraRig(LOFT_LEVEL.pilot, ROOM);
    const cam = settle(rig, droneAt(-9, 2.5, 2), 'fpv');
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    expect(THREE.MathUtils.radToDeg(Math.asin(fwd.y))).toBeCloseTo(25, 0);
  });
});
