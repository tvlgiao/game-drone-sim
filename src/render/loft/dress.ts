/** Small geometry helpers shared by the loft builders: atlas decals, catenary cables, finish presets. */
import * as THREE from 'three';
import type { AddOptions } from '../batcher';
import { decalRect } from '../env-materials/loft-canvas';
import { FINISH } from '../env-materials/loft-materials';

/** Batcher options for a prop-material finish preset. */
export function finish(name: keyof typeof FINISH, castShadow = true): AddOptions {
  const f = FINISH[name];
  return { color: f.color, rm: f.rm, castShadow };
}

/** w × h plane facing +Z whose UVs cover one decal-atlas cell (optionally a sub-rect of it, 0..1 within the cell). */
export function decalPlane(cell: number, w: number, h: number, sub: readonly [number, number, number, number] = [0, 0, 1, 1]): THREE.PlaneGeometry {
  const g = new THREE.PlaneGeometry(w, h);
  const [u0, v0, u1, v1] = decalRect(cell);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    const su = sub[0] + (sub[2] - sub[0]) * uv.getX(i);
    const sv = sub[1] + (sub[3] - sub[1]) * uv.getY(i);
    uv.setXY(i, u0 + (u1 - u0) * su, v0 + (v1 - v0) * sv);
  }
  return g;
}

/** Sagging cable between two points (parabolic sag, metres) as a thin tube. */
export function cable(a: THREE.Vector3, b: THREE.Vector3, sag: number, radius = 0.004, segments = 14): THREE.BufferGeometry {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const p = a.clone().lerp(b, t);
    p.y -= sag * 4 * t * (1 - t);
    pts.push(p);
  }
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), segments, radius, 4, false);
}

/** Straight round bar between two points (conduit, rod). */
export function rod(a: THREE.Vector3, b: THREE.Vector3, radius: number, radial = 6): THREE.BufferGeometry {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(radius, radius, len, radial, 1, true);
  const dir = b.clone().sub(a).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  g.applyQuaternion(q);
  const mid = a.clone().add(b).multiplyScalar(0.5);
  g.translate(mid.x, mid.y, mid.z);
  return g;
}

export const IDENTITY = new THREE.Matrix4();
