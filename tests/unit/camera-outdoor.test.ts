import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  CameraRig,
  CHASE_GROUND_CLEARANCE,
  FPV_GROUND_CLEARANCE,
  LOS_FOV_FAR,
  LOS_FOV_NEAR,
  PILOT_EYE_HEIGHT,
  RELOCATE_BEHIND,
  RELOCATE_FADE_SECONDS,
  RELOCATE_OCCLUDED_SECONDS,
  isLargeLevel,
  losFovForRange,
} from '../../src/render/camera-rig';
import { createDroneState } from '../../src/physics/physics-world';
import { TRAINING_LEVEL } from '../../src/levels/training';
import { buildLevel } from '../../src/levels/registry';
import type { HeightField } from '../../src/physics/terrain';
import type { CameraMode, Collider, DroneState } from '../../src/types';
import type { LevelRuntime } from '../../src/levels/runtime';
import { FLAT, HILLS, box, outdoor, raised } from './terrain-helpers';

const DT = 1 / 60;

function rigOn(rt: LevelRuntime): CameraRig {
  const rig = new CameraRig(rt.def.pilot, null);
  rig.setLevel(rt);
  return rig;
}

function droneAt(x: number, y: number, z: number, yaw = 0): DroneState {
  const d = createDroneState();
  d.position.set(x, y, z);
  d.orientation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  return d;
}

function frame(rig: CameraRig, d: DroneState, mode: CameraMode, t: number, instant = false): void {
  rig.update({ dt: DT, time: t, drone: d, mode, cameraTiltDeg: 25, fovDeg: 110, speed: d.velocity.length(), instant });
}

/** Deepest point (m, > 0 = below) of the drone → camera segment under the terrain, 64 samples. */
function segmentBelow(field: HeightField, a: THREE.Vector3, b: THREE.Vector3): number {
  let worst = -Infinity;
  const p = new THREE.Vector3();
  for (let k = 0; k <= 64; k++) {
    p.lerpVectors(a, b, k / 64);
    worst = Math.max(worst, field.heightAt(p.x, p.z) - p.y);
  }
  return worst;
}

function insideBox(c: Collider, p: THREE.Vector3): boolean {
  const s = c.shape;
  if (s.kind !== 'box') return false;
  const yaw = s.yaw ?? 0;
  const dx = p.x - s.center[0];
  const dz = p.z - s.center[2];
  const lx = Math.cos(yaw) * dx - Math.sin(yaw) * dz;
  const lz = Math.sin(yaw) * dx + Math.cos(yaw) * dz;
  return Math.abs(lx) <= s.half[0] && Math.abs(p.y - s.center[1]) <= s.half[1] && Math.abs(lz) <= s.half[2];
}

describe('outdoor chase / FPV camera vs terrain', () => {
  for (const mode of ['chase', 'fpv'] as const) {
    it(`${mode}: never below the hills (clearance ${mode === 'chase' ? CHASE_GROUND_CLEARANCE : FPV_GROUND_CLEARANCE} m) and nothing between drone and camera`, () => {
      const rig = rigOn(outdoor(HILLS));
      const clearance = mode === 'chase' ? CHASE_GROUND_CLEARANCE : FPV_GROUND_CLEARANCE;
      // skim 0.3 m over the hills heading +x at 15 m/s, diving and climbing with the ground
      const d = droneAt(-60, 0, 3, -Math.PI / 2);
      let lowest = Infinity;
      let worstSeg = -Infinity;
      for (let i = 0; i < 480; i++) {
        const t = i * DT;
        const x = -60 + 15 * t;
        const y = HILLS.heightAt(x, 3) + 0.3;
        d.velocity.set(15, (y - d.position.y) / DT, 0);
        if (i === 0) d.velocity.y = 0;
        d.position.set(x, y, 3);
        frame(rig, d, mode, t, i === 0);
        const c = rig.camera.position;
        lowest = Math.min(lowest, c.y - HILLS.heightAt(c.x, c.z));
        worstSeg = Math.max(worstSeg, segmentBelow(HILLS, d.position, c));
      }
      expect(lowest).toBeGreaterThanOrEqual(clearance - 1e-9);
      expect(worstSeg).toBeLessThan(0.02);
    });
  }

  it('a chase camera that would end up inside a hillside is pulled back towards the drone', () => {
    // drone faces −z with a steep hill rising behind it (+z)
    const hill: HeightField = { heightAt: (_x, z) => Math.max(0, (z - 1) * 2.5) };
    const rig = rigOn(outdoor(hill));
    const d = droneAt(0, 0.5, 0.8);
    for (let i = 0; i < 120; i++) frame(rig, d, 'chase', i * DT, i === 0);
    const c = rig.camera.position;
    expect(c.y - hill.heightAt(c.x, c.z)).toBeGreaterThanOrEqual(CHASE_GROUND_CLEARANCE - 1e-9);
    expect(segmentBelow(hill, d.position, c)).toBeLessThan(0.02);
  });

  it('a thin ridge between the drone and the chase camera pulls the camera in front of it', () => {
    // 2 m high, 0.3 m thick earth wall just behind the drone (it faces −z, the camera sits +z)
    const ridge: HeightField = { heightAt: (_x, z) => (Math.abs(z - 1.5) < 0.15 ? 2 : 0) };
    const rig = rigOn(outdoor(ridge));
    const d = droneAt(0, 1, 1);
    for (let i = 0; i < 120; i++) frame(rig, d, 'chase', i * DT, i === 0);
    const c = rig.camera.position;
    expect(c.z).toBeLessThan(1.35);
    expect(segmentBelow(ridge, d.position, c)).toBeLessThanOrEqual(0);
  });

  it('FPV lens of a drone pressed into an uphill slope (hard landing) stays above the ground', () => {
    const f: HeightField = { heightAt: (x) => x };
    const rig = rigOn(outdoor(f));
    // facing +x (uphill), centre 4 cm into the ground: the lens would sit under the slope ahead
    const d = droneAt(0, -0.04, 0, -Math.PI / 2);
    for (let i = 0; i < 30; i++) frame(rig, d, 'fpv', i * DT, i === 0);
    const c = rig.camera.position;
    expect(c.y - f.heightAt(c.x, c.z)).toBeGreaterThanOrEqual(FPV_GROUND_CLEARANCE - 1e-9);
  });

  it('Training keeps the chase over flat ground at the 0.35 m clearance', () => {
    const rig = rigOn(buildLevel('training'));
    const d = droneAt(0, 0.05, 0);
    d.velocity.set(0, -6, 0);
    for (let i = 0; i < 120; i++) frame(rig, d, 'chase', i * DT, i === 0);
    expect(rig.camera.position.y).toBeGreaterThanOrEqual(CHASE_GROUND_CLEARANCE - 1e-9);
  });
});

describe('outdoor chase / FPV camera vs buildings in the collider grid', () => {
  const cases: [string, Collider, number][] = [
    ['wall right behind the drone', box('wall', [0, 3, 1.9], [5, 3, 0.4]), 0],
    ['yawed building behind the drone', box('house', [0.3, 4, 2.2], [3, 4, 0.8], 0.5), 0],
    ['flying backwards into a wall', box('wall2', [0, 3, 2.4], [5, 3, 0.4]), 6],
  ];
  for (const [name, wall, speed] of cases) {
    it(`chase never sits inside or behind a box: ${name}`, () => {
      const rt = outdoor(FLAT);
      rt.grid!.insertOwned('chunk', [wall]);
      const rig = rigOn(rt);
      const d = droneAt(0, 2, 1, 0);
      d.velocity.set(0, 0, speed);
      const p = new THREE.Vector3();
      for (let i = 0; i < 120; i++) {
        frame(rig, d, 'chase', i * DT, i === 0);
        const c = rig.camera.position;
        expect(insideBox(wall, c)).toBe(false);
        for (let k = 0; k <= 32; k++) expect(insideBox(wall, p.lerpVectors(d.position, c, k / 32))).toBe(false);
      }
    });
  }

  it('without the wall the chase sits its normal 1 m behind (the pull-back is the wall’s doing)', () => {
    const rig = rigOn(outdoor(FLAT));
    const d = droneAt(0, 2, 1, 0);
    for (let i = 0; i < 120; i++) frame(rig, d, 'chase', i * DT, i === 0);
    expect(rig.camera.position.z - d.position.z).toBeCloseTo(1, 1);
  });
});

describe('LOS FOV with range (large levels)', () => {
  it('62° up to 40 m, 28° from 200 m, linear between', () => {
    expect(LOS_FOV_NEAR).toEqual({ range: 40, fov: 62 });
    expect(LOS_FOV_FAR).toEqual({ range: 200, fov: 28 });
    expect(losFovForRange(0)).toBe(62);
    expect(losFovForRange(40)).toBe(62);
    expect(losFovForRange(120)).toBeCloseTo(45, 9);
    expect(losFovForRange(200)).toBe(28);
    expect(losFovForRange(900)).toBe(28);
  });

  it('on a large level the LOS camera eases to the range FOV (smoothed, not a jump)', () => {
    const rt = outdoor(FLAT, { bounds: { kind: 'infinite', maxAgl: 120 } });
    expect(isLargeLevel(rt.def as never)).toBe(true);
    const rig = rigOn(rt);
    const d = droneAt(0, 10, -15);
    frame(rig, d, 'los', 0, true);
    expect(rig.camera.fov).toBeCloseTo(62, 6);
    d.position.set(0, 10, -145); // 150 m from the pilot
    frame(rig, d, 'los', DT);
    const target = losFovForRange(rig.pilotEye.distanceTo(d.position));
    expect(rig.camera.fov).toBeGreaterThan(60);
    for (let i = 2; i < 600; i++) frame(rig, d, 'los', i * DT);
    expect(rig.camera.fov).toBeCloseTo(target, 1);
    expect(target).toBeLessThan(40);
  });

  it('Training (80 m field) keeps the fixed 62° LOS FOV at any range', () => {
    expect(isLargeLevel(TRAINING_LEVEL)).toBe(false);
    const rig = rigOn(buildLevel('training'));
    const d = droneAt(30, 10, -38);
    for (let i = 0; i < 300; i++) frame(rig, d, 'los', i * DT, i === 0);
    expect(rig.camera.fov).toBe(62);
  });

  it('a 400 m wide rect level counts as large; Training does not', () => {
    const rt = outdoor(FLAT, { bounds: { kind: 'rect', min: [-200, -200], max: [200, 200], maxAgl: 120 } });
    expect(isLargeLevel(rt.def as never)).toBe(true);
  });
});

describe('LOS pilot relocation', () => {
  const ground = 3;
  const level = (relocatePilot: boolean | undefined, field: HeightField = raised(ground)): LevelRuntime =>
    outdoor(field, { relocatePilot, pilot: [0, field.heightAt(0, 5) + PILOT_EYE_HEIGHT, 5] });

  it('beyond 260 m: fades out, re-plants 35 m behind the drone (against its velocity) at ground + 1.7, fades back in', () => {
    const rig = rigOn(level(true));
    const d = droneAt(0, 13, -200);
    frame(rig, d, 'los', 0, true);
    const start = rig.pilotEye.clone();
    d.position.set(0, 13, -280);
    d.velocity.set(0, 0, -12);
    let t = DT;
    frame(rig, d, 'los', t);
    expect(rig.fade).toBeGreaterThan(0);
    expect(rig.pilotEye.equals(start)).toBe(true);
    // still mid-fade just before 0.3 s
    for (; t < RELOCATE_FADE_SECONDS - 2 * DT; t += DT) frame(rig, d, 'los', t + DT);
    expect(rig.relocations).toBe(0);
    for (let i = 0; i < 4; i++) frame(rig, d, 'los', (t += DT));
    expect(rig.relocations).toBe(1);
    expect(rig.pilotEye.x).toBeCloseTo(0, 9);
    expect(rig.pilotEye.z).toBeCloseTo(-280 + RELOCATE_BEHIND, 9);
    expect(rig.pilotEye.y).toBeCloseTo(ground + PILOT_EYE_HEIGHT, 9);
    for (let i = 0; i < 30; i++) frame(rig, d, 'los', (t += DT));
    expect(rig.fade).toBe(0);
    expect(rig.relocations).toBe(1);
    // the re-planted pilot sees the drone
    const p = d.position.clone().project(rig.camera);
    expect(Math.max(Math.abs(p.x), Math.abs(p.y))).toBeLessThan(1);
    const anchor = new THREE.Vector3();
    rig.losFloorAnchor(anchor);
    expect(anchor.y).toBe(ground);
  });

  it('hidden behind a ridge for more than 1.5 s triggers it; 1.4 s does not', () => {
    const ridge: HeightField = { heightAt: (_x, z) => 30 * Math.max(0, 1 - Math.abs(z + 50) / 10) };
    const rig = rigOn(level(true, ridge));
    const d = droneAt(0, 3, -100);
    let t = 0;
    frame(rig, d, 'los', t, true);
    while (t < RELOCATE_OCCLUDED_SECONDS - 0.1) frame(rig, d, 'los', (t += DT));
    expect(rig.fade).toBe(0);
    expect(rig.relocations).toBe(0);
    while (t < RELOCATE_OCCLUDED_SECONDS + RELOCATE_FADE_SECONDS + 0.2) frame(rig, d, 'los', (t += DT));
    expect(rig.relocations).toBe(1);
    // still drone, heading −z: re-planted behind it (+z), on the far side of the ridge
    expect(rig.pilotEye.z).toBeCloseTo(-100 + RELOCATE_BEHIND, 9);
    expect(rig.pilotEye.y).toBeCloseTo(ridge.heightAt(0, -65) + PILOT_EYE_HEIGHT, 9);
  });

  it('a drone that pops back into view within 1.5 s resets the occlusion timer', () => {
    const ridge: HeightField = { heightAt: (_x, z) => 30 * Math.max(0, 1 - Math.abs(z + 50) / 10) };
    const rig = rigOn(level(true, ridge));
    const d = droneAt(0, 3, -100);
    let t = 0;
    frame(rig, d, 'los', t, true);
    for (let k = 0; k < 3; k++) {
      d.position.y = 3;
      while (t < (k + 1) * 2 - 0.9) frame(rig, d, 'los', (t += DT));
      d.position.y = 60;
      while (t < (k + 1) * 2) frame(rig, d, 'los', (t += DT));
    }
    expect(rig.relocations).toBe(0);
  });

  it('in chase / FPV the pilot is re-planted at once (no fade: the pilot is not on screen)', () => {
    const rig = rigOn(level(true));
    const d = droneAt(0, 13, -300);
    frame(rig, d, 'chase', 0, true);
    frame(rig, d, 'chase', DT);
    expect(rig.relocations).toBe(1);
    expect(rig.fade).toBe(0);
  });

  it('never on levels without relocatePilot (Training) or in VR', () => {
    for (const rig of [rigOn(level(undefined)), rigOn(buildLevel('training'))]) {
      const d = droneAt(0, 13, -300);
      for (let i = 0; i < 200; i++) frame(rig, d, 'los', i * DT, i === 0);
      expect(rig.relocations).toBe(0);
      expect(rig.fade).toBe(0);
    }
    const vr = rigOn(level(true));
    vr.allowRelocate = false;
    const d = droneAt(0, 13, -300);
    for (let i = 0; i < 200; i++) frame(vr, d, 'los', i * DT, i === 0);
    expect(vr.relocations).toBe(0);
  });
});
