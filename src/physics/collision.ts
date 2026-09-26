/** Narrow-phase sphere tests against level collider shapes and infinite planes. Allocation-free. */
import { Vector3 } from 'three';
import type { ColliderShape } from '../types';

export interface SphereHit {
  /** unit normal from the obstacle towards the sphere centre */
  normal: Vector3;
  /** penetration depth, metres (> 0 on hit) */
  depth: number;
  /** contact point on the obstacle surface (world) */
  point: Vector3;
}

export function createSphereHit(): SphereHit {
  return { normal: new Vector3(), depth: 0, point: new Vector3() };
}

const EPS = 1e-9;

/** Sphere vs box (optionally yawed about +Y, same convention as Object3D.rotation.y). */
function sphereVsBox(
  center: Vector3,
  radius: number,
  c: readonly number[],
  half: readonly number[],
  yaw: number,
  out: SphereHit,
): boolean {
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const dx = center.x - c[0];
  const dy = center.y - c[1];
  const dz = center.z - c[2];
  // world → local = R_y(-yaw)
  const lx = cos * dx - sin * dz;
  const ly = dy;
  const lz = sin * dx + cos * dz;
  const hx = half[0];
  const hy = half[1];
  const hz = half[2];
  const qx = lx < -hx ? -hx : lx > hx ? hx : lx;
  const qy = ly < -hy ? -hy : ly > hy ? hy : ly;
  const qz = lz < -hz ? -hz : lz > hz ? hz : lz;
  let nx: number;
  let ny: number;
  let nz: number;
  let px: number;
  let py: number;
  let pz: number;
  const ex = lx - qx;
  const ey = ly - qy;
  const ez = lz - qz;
  const d2 = ex * ex + ey * ey + ez * ez;
  if (d2 > EPS * EPS) {
    if (d2 >= radius * radius) return false;
    const d = Math.sqrt(d2);
    nx = ex / d;
    ny = ey / d;
    nz = ez / d;
    out.depth = radius - d;
    px = qx;
    py = qy;
    pz = qz;
  } else {
    // centre inside: push out through the nearest face
    const fx = hx - Math.abs(lx);
    const fy = hy - Math.abs(ly);
    const fz = hz - Math.abs(lz);
    px = lx;
    py = ly;
    pz = lz;
    nx = 0;
    ny = 0;
    nz = 0;
    if (fx <= fy && fx <= fz) {
      nx = lx >= 0 ? 1 : -1;
      px = nx * hx;
      out.depth = fx + radius;
    } else if (fy <= fz) {
      ny = ly >= 0 ? 1 : -1;
      py = ny * hy;
      out.depth = fy + radius;
    } else {
      nz = lz >= 0 ? 1 : -1;
      pz = nz * hz;
      out.depth = fz + radius;
    }
  }
  // local → world = R_y(yaw)
  out.normal.set(cos * nx + sin * nz, ny, -sin * nx + cos * nz);
  out.point.set(c[0] + cos * px + sin * pz, c[1] + py, c[2] - sin * px + cos * pz);
  return true;
}

/** Sphere vs capped vertical cylinder. */
function sphereVsCylinder(
  center: Vector3,
  radius: number,
  c: readonly number[],
  cr: number,
  hh: number,
  out: SphereHit,
): boolean {
  const dx = center.x - c[0];
  const dy = center.y - c[1];
  const dz = center.z - c[2];
  const rho = Math.sqrt(dx * dx + dz * dz);
  const ux = rho > EPS ? dx / rho : 1;
  const uz = rho > EPS ? dz / rho : 0;
  const qr = rho > cr ? cr : rho;
  const qy = dy < -hh ? -hh : dy > hh ? hh : dy;
  const er = rho - qr;
  const ey = dy - qy;
  const d2 = er * er + ey * ey;
  if (d2 > EPS * EPS) {
    if (d2 >= radius * radius) return false;
    const d = Math.sqrt(d2);
    const nr = er / d;
    const ny = ey / d;
    out.normal.set(ux * nr, ny, uz * nr);
    out.depth = radius - d;
    out.point.set(c[0] + ux * qr, c[1] + qy, c[2] + uz * qr);
    return true;
  }
  const side = cr - rho;
  const cap = hh - Math.abs(dy);
  if (side < cap) {
    out.normal.set(ux, 0, uz);
    out.depth = side + radius;
    out.point.set(c[0] + ux * cr, c[1] + dy, c[2] + uz * cr);
  } else {
    const s = dy >= 0 ? 1 : -1;
    out.normal.set(0, s, 0);
    out.depth = cap + radius;
    out.point.set(center.x, c[1] + s * hh, center.z);
  }
  return true;
}

/** Sphere vs torus with arbitrary axis (race-gate rim). */
function sphereVsTorus(
  center: Vector3,
  radius: number,
  c: readonly number[],
  n: readonly number[],
  major: number,
  tube: number,
  out: SphereHit,
): boolean {
  const dx = center.x - c[0];
  const dy = center.y - c[1];
  const dz = center.z - c[2];
  const h = dx * n[0] + dy * n[1] + dz * n[2];
  let px = dx - h * n[0];
  let py = dy - h * n[1];
  let pz = dz - h * n[2];
  let pl = Math.sqrt(px * px + py * py + pz * pz);
  if (pl < EPS) {
    // on the axis: every rim point is equidistant; pick any in-plane direction
    const ax = Math.abs(n[0]) < 0.9 ? 1 : 0;
    const ay = 1 - ax;
    px = ay * n[2];
    py = -ax * n[2];
    pz = ax * n[1] - ay * n[0];
    pl = Math.sqrt(px * px + py * py + pz * pz);
  }
  const qx = (px / pl) * major;
  const qy = (py / pl) * major;
  const qz = (pz / pl) * major;
  const ex = dx - qx;
  const ey = dy - qy;
  const ez = dz - qz;
  const dist = Math.sqrt(ex * ex + ey * ey + ez * ez);
  const reach = radius + tube;
  if (dist >= reach) return false;
  if (dist > EPS) out.normal.set(ex / dist, ey / dist, ez / dist);
  else out.normal.set(n[0], n[1], n[2]);
  out.depth = reach - dist;
  out.point.set(c[0] + qx + out.normal.x * tube, c[1] + qy + out.normal.y * tube, c[2] + qz + out.normal.z * tube);
  return true;
}

/** Sphere vs any ColliderShape. Writes the hit into `out` and returns true on overlap. */
export function sphereVsShape(center: Vector3, radius: number, shape: ColliderShape, out: SphereHit): boolean {
  switch (shape.kind) {
    case 'box':
      return sphereVsBox(center, radius, shape.center, shape.half, shape.yaw ?? 0, out);
    case 'cylinder':
      return sphereVsCylinder(center, radius, shape.center, shape.radius, shape.halfHeight, out);
    case 'torus':
      return sphereVsTorus(center, radius, shape.center, shape.normal, shape.majorRadius, shape.tubeRadius, out);
  }
}

/** Sphere vs half-space bounded by plane n·x = d (n unit, solid side is n·x < d). */
export function sphereVsPlane(
  center: Vector3,
  radius: number,
  nx: number,
  ny: number,
  nz: number,
  d: number,
  out: SphereHit,
): boolean {
  const dist = center.x * nx + center.y * ny + center.z * nz - d;
  if (dist >= radius) return false;
  out.normal.set(nx, ny, nz);
  out.depth = radius - dist;
  out.point.set(center.x - nx * dist, center.y - ny * dist, center.z - nz * dist);
  return true;
}

/** Radius of a sphere centred on the shape centre that encloses the whole shape. */
export function shapeBoundingRadius(shape: ColliderShape): number {
  switch (shape.kind) {
    case 'box':
      return Math.hypot(shape.half[0], shape.half[1], shape.half[2]);
    case 'cylinder':
      return Math.hypot(shape.radius, shape.halfHeight);
    case 'torus':
      return shape.majorRadius + shape.tubeRadius;
  }
}
