import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { createSphereHit, sphereVsPlane, sphereVsShape } from '../../src/physics/collision';
import type { ColliderShape } from '../../src/types';

const hit = createSphereHit();
const v = (x: number, y: number, z: number) => new Vector3(x, y, z);
const close = (a: Vector3, x: number, y: number, z: number) => {
  expect(a.x).toBeCloseTo(x, 6);
  expect(a.y).toBeCloseTo(y, 6);
  expect(a.z).toBeCloseTo(z, 6);
};

describe('sphereVsShape: box', () => {
  const box: ColliderShape = { kind: 'box', center: [0, 1, 0], half: [1, 1, 1] };

  it('face contact: normal is the face normal, depth = r − gap, point on the face', () => {
    expect(sphereVsShape(v(1.05, 1.2, 0.3), 0.1, box, hit)).toBe(true);
    close(hit.normal, 1, 0, 0);
    expect(hit.depth).toBeCloseTo(0.05, 9);
    close(hit.point, 1, 1.2, 0.3);
  });

  it('edge and corner contacts point diagonally out of the box', () => {
    expect(sphereVsShape(v(1.05, 2.05, 0), 0.1, box, hit)).toBe(true);
    close(hit.normal, Math.SQRT1_2, Math.SQRT1_2, 0);
    expect(hit.depth).toBeCloseTo(0.1 - Math.hypot(0.05, 0.05), 9);
    expect(sphereVsShape(v(1.03, 2.03, -1.03), 0.1, box, hit)).toBe(true);
    const k = 1 / Math.sqrt(3);
    close(hit.normal, k, k, -k);
  });

  it('miss when the gap exceeds the radius (incl. corner region)', () => {
    expect(sphereVsShape(v(1.2, 1, 0), 0.1, box, hit)).toBe(false);
    expect(sphereVsShape(v(1.08, 2.08, 1.08), 0.1, box, hit)).toBe(false);
  });

  it('centre inside pushes out through the nearest face', () => {
    expect(sphereVsShape(v(0.9, 1.1, 0.2), 0.1, box, hit)).toBe(true);
    close(hit.normal, 1, 0, 0);
    expect(hit.depth).toBeCloseTo(0.2, 9);
  });

  it('yaw rotates the box about +Y (Object3D.rotation.y convention)', () => {
    // long thin box along local X, yawed 90°: local +X → world −Z
    const b: ColliderShape = { kind: 'box', center: [0, 0, 0], half: [2, 0.1, 0.1], yaw: Math.PI / 2 };
    expect(sphereVsShape(v(0, 0, -1.5), 0.05, b, hit)).toBe(true);
    expect(sphereVsShape(v(1.5, 0, 0), 0.05, b, hit)).toBe(false);
    expect(sphereVsShape(v(0.15, 0, -1.5), 0.1, b, hit)).toBe(true);
    close(hit.normal, 1, 0, 0);
    expect(hit.depth).toBeCloseTo(0.05, 6);
  });
});

describe('sphereVsShape: cylinder (vertical, capped)', () => {
  const cyl: ColliderShape = { kind: 'cylinder', center: [2, 3, 0], radius: 0.25, halfHeight: 3 };

  it('side contact has a horizontal radial normal', () => {
    expect(sphereVsShape(v(2, 1, 0.3), 0.1, cyl, hit)).toBe(true);
    close(hit.normal, 0, 0, 1);
    expect(hit.depth).toBeCloseTo(0.05, 9);
    close(hit.point, 2, 1, 0.25);
  });

  it('cap contact has a vertical normal', () => {
    expect(sphereVsShape(v(2.1, 6.05, 0), 0.1, cyl, hit)).toBe(true);
    close(hit.normal, 0, 1, 0);
    expect(hit.depth).toBeCloseTo(0.05, 9);
  });

  it('rim (cap edge) contact is diagonal; misses beyond reach', () => {
    expect(sphereVsShape(v(2.3, 6.05, 0), 0.1, cyl, hit)).toBe(true);
    close(hit.normal, Math.SQRT1_2, Math.SQRT1_2, 0);
    expect(sphereVsShape(v(2.4, 3, 0), 0.1, cyl, hit)).toBe(false);
    expect(sphereVsShape(v(2, 6.2, 0), 0.1, cyl, hit)).toBe(false);
  });

  it('inside the cylinder pushes out radially when the side is nearest', () => {
    expect(sphereVsShape(v(2.2, 3, 0), 0.1, cyl, hit)).toBe(true);
    close(hit.normal, 1, 0, 0);
    expect(hit.depth).toBeCloseTo(0.15, 9);
  });
});

describe('sphereVsShape: torus (ring rim)', () => {
  const ring: ColliderShape = { kind: 'torus', center: [0, 2, 0], normal: [0, 0, 1], majorRadius: 0.82, tubeRadius: 0.07 };

  it('flying through the middle of the gate does not touch it', () => {
    expect(sphereVsShape(v(0, 2, 0), 0.075, ring, hit)).toBe(false);
    expect(sphereVsShape(v(0.5, 2.2, 0.01), 0.075, ring, hit)).toBe(false);
  });

  it('clipping the rim from inside pushes towards the centre', () => {
    expect(sphereVsShape(v(0.7, 2, 0), 0.075, ring, hit)).toBe(true);
    close(hit.normal, -1, 0, 0);
    expect(hit.depth).toBeCloseTo(0.075 + 0.07 - 0.12, 9);
    close(hit.point, 0.75, 2, 0);
  });

  it('hitting the face of the rim head-on gives a normal along the ring axis', () => {
    expect(sphereVsShape(v(0, 2.82, -0.1), 0.075, ring, hit)).toBe(true);
    close(hit.normal, 0, 0, -1);
    expect(hit.depth).toBeCloseTo(0.045, 9);
  });

  it('works for an arbitrary (tilted) ring normal', () => {
    const n = new Vector3(1, 1, 0).normalize();
    const t: ColliderShape = { kind: 'torus', center: [0, 0, 0], normal: [n.x, n.y, n.z], majorRadius: 1, tubeRadius: 0.1 };
    // rim point along in-plane direction (−1,1,0)/√2
    const rim = new Vector3(-1, 1, 0).normalize();
    const c = rim.clone().multiplyScalar(1).addScaledVector(n, 0.15);
    expect(sphereVsShape(c, 0.1, t, hit)).toBe(true);
    expect(hit.normal.dot(n)).toBeCloseTo(1, 6);
    expect(hit.depth).toBeCloseTo(0.05, 9);
  });
});

describe('sphereVsPlane', () => {
  it('floor plane y=0', () => {
    expect(sphereVsPlane(v(3, 0.07, -2), 0.075, 0, 1, 0, 0, hit)).toBe(true);
    close(hit.normal, 0, 1, 0);
    expect(hit.depth).toBeCloseTo(0.005, 9);
    close(hit.point, 3, 0, -2);
    expect(sphereVsPlane(v(3, 0.08, -2), 0.075, 0, 1, 0, 0, hit)).toBe(false);
  });

  it('ceiling plane (normal −Y at y=H)', () => {
    expect(sphereVsPlane(v(0, 5.95, 0), 0.075, 0, -1, 0, -6, hit)).toBe(true);
    close(hit.normal, 0, -1, 0);
    expect(hit.depth).toBeCloseTo(0.025, 9);
  });
});
