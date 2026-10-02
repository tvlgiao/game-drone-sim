import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CameraRig } from '../../src/render/camera-rig';
import { buildLevel } from '../../src/levels/registry';
import { createDroneState } from '../../src/physics/physics-world';
import type { DroneState } from '../../src/types';

const SAFE = 0.7;
const DT = 1 / 60;
const ASPECTS: readonly [string, number][] = [
  ['desktop 16:9', 16 / 9],
  ['phone landscape', 2.16],
  ['iPad 4:3', 4 / 3],
];

const level = buildLevel('training');
const def = level.def;
const v = (p: readonly number[]): THREE.Vector3 => new THREE.Vector3(p[0], p[1], p[2]);
const pad = v(def.spawn.position);
const pilot = v(def.pilot);

/** Flight path over the Training course: climbs off the pad, through each ring, high passes, corners, past the pilot. */
const WAYPOINTS: THREE.Vector3[] = [
  pad.clone(),
  pad.clone().setY(4.6),
  pad.clone().setY(15),
  pad.clone().setY(2),
  ...def.rings.flatMap((r) => [v(r.position).addScaledVector(v(r.direction), -3), v(r.position), v(r.position).addScaledVector(v(r.direction), 3)]),
  new THREE.Vector3(30, 8, -30),
  new THREE.Vector3(-30, 3, -30),
  new THREE.Vector3(-35, 12, 30),
  new THREE.Vector3(30, 2, 30),
  new THREE.Vector3(pilot.x + 3, 3, pilot.z - 2),
  new THREE.Vector3(pilot.x - 3, 6, pilot.z - 3),
  new THREE.Vector3(0, 15, 10),
  pad.clone().setY(0.06),
];

function drone(): DroneState {
  const d = createDroneState();
  d.position.copy(pad);
  d.armed = true;
  return d;
}

function rigFor(aspect: number): CameraRig {
  const rig = new CameraRig(def.pilot, null);
  rig.setLevel(def);
  rig.camera.aspect = aspect;
  rig.camera.updateProjectionMatrix();
  return rig;
}

/** Flies the waypoints at `speed` m/s; returns the worst |NDC| of the drone seen over the flight. */
function fly(rig: CameraRig, d: DroneState, speed: number, focus: THREE.Vector3 | null): { worst: number; at: string } {
  rig.setFocus(focus);
  let worst = 0;
  let at = '';
  let t = 0;
  // the first frame switches the rig into LOS without the mode-change blend
  const step = (): void => {
    rig.update({ dt: DT, time: t, drone: d, mode: 'los', cameraTiltDeg: 25, fovDeg: 110, speed, instant: t === 0 });
    t += DT;
    const p = d.position.clone().project(rig.camera);
    const m = p.z >= 1 ? Infinity : Math.max(Math.abs(p.x), Math.abs(p.y));
    if (m > worst) {
      worst = m;
      at = `(${d.position.toArray().map((n) => n.toFixed(1)).join(', ')}) ndc ${p.x.toFixed(2)}, ${p.y.toFixed(2)}`;
    }
  };
  step();
  for (let i = 1; i < WAYPOINTS.length; i++) {
    const a = WAYPOINTS[i - 1]!;
    const b = WAYPOINTS[i]!;
    const n = Math.max(1, Math.ceil(a.distanceTo(b) / speed / DT));
    d.velocity.copy(b).sub(a).divideScalar(n * DT);
    for (let k = 1; k <= n; k++) {
      d.position.lerpVectors(a, b, k / n);
      step();
    }
  }
  return { worst, at };
}

describe('Training LOS keeps the drone in frame', () => {
  const focuses: [string, THREE.Vector3 | null][] = [['overview', null], ...def.rings.map((r, i): [string, THREE.Vector3] => [`next ring ${i + 1}`, v(r.position)])];
  for (const [name, aspect] of ASPECTS) {
    for (const [fname, focus] of focuses) {
      for (const speed of [6, 14]) {
        it(`${name}, ${fname}, ${speed} m/s`, () => {
          const r = fly(rigFor(aspect), drone(), speed, focus);
          expect(r.worst, r.at).toBeLessThanOrEqual(SAFE);
        });
      }
    }
  }

  it('a teleport (respawn) out of view is framed on the very next frame', () => {
    const rig = rigFor(16 / 9);
    const d = drone();
    rig.setFocus(v(def.rings[0]!.position));
    for (let i = 0; i < 120; i++) rig.update({ dt: DT, time: i * DT, drone: d, mode: 'los', cameraTiltDeg: 25, fovDeg: 110, speed: 0, instant: i === 0 });
    d.position.set(-35, 12, 30);
    rig.update({ dt: DT, time: 2, drone: d, mode: 'los', cameraTiltDeg: 25, fovDeg: 110, speed: 0 });
    const p = d.position.clone().project(rig.camera);
    expect(p.z).toBeLessThan(1);
    expect(Math.max(Math.abs(p.x), Math.abs(p.y))).toBeLessThanOrEqual(SAFE);
  });
});
