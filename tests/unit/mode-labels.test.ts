import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CameraRig } from '../../src/render/camera-rig';
import { LOFT_LEVEL } from '../../src/game/level-data';
import { createDroneState } from '../../src/physics/physics-world';
import { effectiveFovDeg } from '../../src/ui/mode-labels';

/** Horizontal FOV the rig's FPV camera actually renders at `aspect` for a settings FOV. */
function rigHorizontalFov(fovDeg: number, aspect: number): number {
  const rig = new CameraRig(LOFT_LEVEL.pilot, LOFT_LEVEL.room.size);
  rig.camera.aspect = aspect;
  const drone = createDroneState();
  drone.position.set(-9, 2.5, 2);
  for (let t = 0; t < 2; t += 1 / 60) rig.update({ dt: 1 / 60, time: t, drone, mode: 'fpv', cameraTiltDeg: 25, fovDeg, speed: 0 });
  const v = THREE.MathUtils.degToRad(rig.camera.fov);
  return THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(v / 2) * aspect));
}

describe('effective FPV field of view', () => {
  const cases: [number, number][] = [
    [110, 16 / 9],
    [130, 16 / 9],
    [125, 4 / 3],
    [130, 4 / 3],
    [130, 1024 / 768],
    [120, 0.75],
    [80, 32 / 9],
  ];
  for (const [fov, aspect] of cases) {
    it(`matches the camera rig for ${fov}° at aspect ${aspect.toFixed(2)}`, () => {
      expect(effectiveFovDeg(fov, aspect)).toBeCloseTo(rigHorizontalFov(fov, aspect), 3);
    });
  }

  it('is the setting itself unless the rig clamps it', () => {
    expect(effectiveFovDeg(110, 16 / 9)).toBe(110);
    expect(effectiveFovDeg(130, 4 / 3)).toBeLessThan(126);
  });
});
