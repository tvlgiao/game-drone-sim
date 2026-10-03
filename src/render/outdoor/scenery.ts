/**
 * Countryside set dressing around the Training Field, all visual only and outside the flying field:
 * a post-and-rail fence with hedges, the pilots' pop-up tent with flags, a timber shed, hay bales, a
 * farm road with power poles, a red barn with a silo and a farmhouse on the rolling land, and hedgerows
 * along the parcels. Hard pieces go to the flat-shaded low-poly bucket; greenery and flags to the
 * swaying vegetation.
 */
import * as THREE from 'three';
import { StaticBatcher, trs } from '../batcher';
import { mulberry32 } from '../materials/texgen';
import type { VegBuilder } from './foliage';
import { FLAT_RADIUS, terrainHeight } from './ground';

const WOOD = 0x8a6a4a;
const WOOD_DARK = 0x5e4632;
const FENCE_HALF = 52;

export interface SceneryOptions {
  /** trunks to keep clear of (x, z, clearance) */
  avoid: readonly [number, number, number][];
}

function clearOf(x: number, z: number, avoid: SceneryOptions['avoid']): boolean {
  for (const [ax, az, r] of avoid) if ((x - ax) * (x - ax) + (z - az) * (z - az) < r * r) return false;
  return true;
}

export function buildScenery(batch: StaticBatcher, mat: THREE.Material, veg: VegBuilder, o: SceneryOptions): void {
  const rnd = mulberry32(5150);
  const add = (g: THREE.BufferGeometry, x: number, y: number, z: number, color: number, yaw = 0, rx = 0, rz = 0) => batch.add('lowpoly', mat, g, trs(x, y, z, yaw, 1, 1, 1, rx, rz), { color });

  fence(add, o, rnd, veg);
  tent(add, veg);
  shed(add, -47.5, 24, Math.PI / 2);
  // hay bales on the near parcels, beyond the treeline
  for (let i = 0; i < 18; i++) {
    const a = rnd() * Math.PI * 2;
    const r = FLAT_RADIUS + 15 + rnd() * 70;
    const x = Math.sin(a) * r;
    const z = -Math.cos(a) * r;
    const y = terrainHeight(x, z);
    const wrapped = rnd() < 0.4;
    add(new THREE.CylinderGeometry(0.75, 0.75, 1.2, 14), x, y + 0.72, z, wrapped ? 0xe9ebe6 : 0xc9a85a, rnd() * Math.PI, 0, Math.PI / 2);
    if (rnd() < 0.5) add(new THREE.CylinderGeometry(0.75, 0.75, 1.2, 14), x + 1.7, y + 0.72, z + 0.4, wrapped ? 0xe4e7e1 : 0xc2a256, rnd() * Math.PI, 0, Math.PI / 2);
  }
  farm(add, 230, -300, -0.5);
  farmhouse(add, -330, -210, 0.6);
  road(add, rnd);
  hedgerows(veg, rnd);
}

type Add = (g: THREE.BufferGeometry, x: number, y: number, z: number, color: number, yaw?: number, rx?: number, rz?: number) => void;

/** Post-and-rail fence on a square around the field, with gaps at trunks and hedges in the corners. */
function fence(add: Add, o: SceneryOptions, rnd: () => number, veg: VegBuilder): void {
  const step = 3;
  for (let side = 0; side < 4; side++) {
    for (let s = -FENCE_HALF; s < FENCE_HALF; s += step) {
      const p0 = edge(side, s);
      const p1 = edge(side, s + step);
      if (!clearOf(p0[0], p0[1], o.avoid) || !clearOf(p1[0], p1[1], o.avoid)) continue;
      add(new THREE.BoxGeometry(0.12, 1.25, 0.12), p0[0], 0.62, p0[1], WOOD_DARK, rnd() * 0.1);
      const mx = (p0[0] + p1[0]) / 2;
      const mz = (p0[1] + p1[1]) / 2;
      const yaw = side % 2 === 0 ? 0 : Math.PI / 2;
      for (const y of [0.55, 1.0]) add(new THREE.BoxGeometry(step, 0.09, 0.04), mx, y, mz, WOOD, yaw);
    }
  }
  for (const [cx, cz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    for (let k = 0; k < 4; k++) {
      const x = cx * (FENCE_HALF + 1.5) + (rnd() - 0.5) * 3;
      const z = cz * (FENCE_HALF + 1.5) + (rnd() - 0.5) * 3;
      if (clearOf(x, z, o.avoid)) veg.bush(x, z, 1.3 + rnd() * 0.9, rnd);
    }
  }
  // a hedge along the south fence, behind the pilots' tent
  for (let x = -26; x < 26; x += 2.2) if (Math.abs(x) > 6) veg.bush(x, FENCE_HALF + 1.6 + rnd(), 1.1 + rnd() * 0.6, rnd);
}

function edge(side: number, s: number): [number, number] {
  switch (side) {
    case 0:
      return [s, -FENCE_HALF];
    case 1:
      return [FENCE_HALF, s];
    case 2:
      return [-s, FENCE_HALF];
    default:
      return [-FENCE_HALF, -s];
  }
}

/** The pilots' pop-up canopy south of the field, a folding table, cooler, chairs, two feather flags. */
function tent(add: Add, veg: VegBuilder): void {
  const cx = 0;
  const cz = 45;
  const s = 3;
  for (const [lx, lz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) add(new THREE.CylinderGeometry(0.03, 0.03, 2.3, 6), cx + lx * s / 2, 1.15, cz + lz * s / 2, 0xd9dde2);
  const roof = new THREE.ConeGeometry(s * 0.72, 0.7, 4, 1);
  add(roof, cx, 2.62, cz, 0xff6a1f, Math.PI / 4);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const valance = new THREE.BoxGeometry(s, 0.22, 0.02);
    add(valance, cx + Math.sin(a) * s / 2, 2.2, cz + Math.cos(a) * s / 2, i % 2 === 0 ? 0xff6a1f : 0xf4f1e8, a);
  }
  add(new THREE.BoxGeometry(1.6, 0.04, 0.7), cx, 0.74, cz - 0.3, 0xe6e6e2);
  for (const lx of [-0.7, 0.7]) add(new THREE.BoxGeometry(0.04, 0.72, 0.6), cx + lx, 0.36, cz - 0.3, 0x8d949c);
  add(new THREE.BoxGeometry(0.34, 0.02, 0.24), cx - 0.3, 0.77, cz - 0.35, 0x1d1f23, 0.2);
  add(new THREE.BoxGeometry(0.33, 0.22, 0.02), cx - 0.32, 0.88, cz - 0.46, 0x1d1f23, 0.2, -0.3);
  add(new THREE.BoxGeometry(0.6, 0.4, 0.4), cx + 1.0, 0.2, cz + 0.6, 0x2a6fd0);
  add(new THREE.BoxGeometry(0.62, 0.06, 0.42), cx + 1.0, 0.43, cz + 0.6, 0xf4f1e8);
  for (const lx of [-0.6, 0.4]) {
    add(new THREE.BoxGeometry(0.5, 0.05, 0.45), cx + lx, 0.45, cz + 0.55, 0x2b5d8a);
    add(new THREE.BoxGeometry(0.5, 0.5, 0.05), cx + lx, 0.72, cz + 0.8, 0x2b5d8a, 0, -0.15);
    for (const dx of [-0.22, 0.22]) add(new THREE.CylinderGeometry(0.012, 0.012, 0.9, 4), cx + lx + dx, 0.4, cz + 0.55, 0x8d949c, 0, 0.5);
  }
  veg.flag(cx - 2.6, cz - 0.6, 3.6, 0xff6a1f, 0xf4f1e8, 0.3);
  veg.flag(cx + 2.6, cz - 0.6, 3.6, 0x2fd0c8, 0x1d2a44, -0.3);
}

/** Timber shed with a corrugated, rust-red gable roof. */
function shed(add: Add, x: number, z: number, yaw: number): void {
  const w = 4;
  const d = 3;
  const h = 2.4;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const at = (lx: number, lz: number): [number, number] => [x + lx * c + lz * s, z - lx * s + lz * c];
  add(new THREE.BoxGeometry(w, h, d), x, h / 2, z, WOOD, yaw);
  // vertical boards: thin battens
  for (let i = -w / 2 + 0.25; i < w / 2; i += 0.5) {
    for (const side of [-1, 1]) {
      const [bx, bz] = at(i, side * (d / 2 + 0.01));
      add(new THREE.BoxGeometry(0.05, h, 0.02), bx, h / 2, bz, WOOD_DARK, yaw);
    }
  }
  const [dx, dz] = at(0.6, d / 2 + 0.02);
  add(new THREE.BoxGeometry(0.9, 1.9, 0.03), dx, 0.95, dz, 0x4a6b5a, yaw);
  const [wx, wz] = at(-1.1, d / 2 + 0.02);
  add(new THREE.BoxGeometry(0.7, 0.55, 0.03), wx, 1.6, wz, 0x24303a, yaw);
  for (const side of [-1, 1]) {
    const [rx, rz] = at(0, side * d * 0.27);
    add(new THREE.BoxGeometry(w + 0.4, 0.06, d * 0.62), rx, h + 0.42, rz, 0x8e3b2a, yaw, side * -0.5);
  }
  // gable ends
  const gable = new THREE.CylinderGeometry(0.01, d / 2 + 0.05, 0.85, 3, 1);
  gable.rotateX(Math.PI / 2);
  gable.rotateZ(Math.PI / 2);
  add(gable, x, h + 0.42, z, WOOD, yaw);
}

/** Red barn, grey silo and a lean-to on the rolling land north-east. */
function farm(add: Add, x: number, z: number, yaw: number): void {
  const y = terrainHeight(x, z);
  add(new THREE.BoxGeometry(18, 9, 12), x, y + 4.5 - 0.5, z, 0x9b2f22, yaw);
  const roof = new THREE.CylinderGeometry(0.01, 8.2, 18.6, 4, 1);
  roof.rotateZ(Math.PI / 2);
  roof.scale(1, 0.5, 1);
  add(roof, x, y + 8.5 + 1.8, z, 0x3c3f44, yaw, Math.PI / 4);
  add(new THREE.BoxGeometry(4, 5, 0.3), x + Math.sin(yaw) * 6.1, y + 2.5, z + Math.cos(yaw) * 6.1, 0xf2eee6, yaw);
  add(new THREE.CylinderGeometry(3, 3, 16, 14), x + 13 * Math.cos(yaw), y + 8 - 0.5, z - 13 * Math.sin(yaw), 0xb8bec4);
  add(new THREE.SphereGeometry(3, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2), x + 13 * Math.cos(yaw), y + 15.5, z - 13 * Math.sin(yaw), 0x9aa1a8);
}

function farmhouse(add: Add, x: number, z: number, yaw: number): void {
  const y = terrainHeight(x, z);
  add(new THREE.BoxGeometry(11, 6, 8), x, y + 3 - 0.4, z, 0xf0ece2, yaw);
  const roof = new THREE.CylinderGeometry(0.01, 5.8, 11.6, 4, 1);
  roof.rotateZ(Math.PI / 2);
  roof.scale(1, 0.55, 1);
  add(roof, x, y + 6.2 + 1.2, z, 0x5a3a2e, yaw, Math.PI / 4);
  add(new THREE.BoxGeometry(0.9, 2.6, 0.9), x + 3, y + 8.4, z, 0x7a4b3a, yaw);
}

/** Farm road across the north with timber power poles every 45 m. */
function road(add: Add, rnd: () => number): void {
  const zAt = (x: number) => -150 - Math.sin(x / 140) * 25;
  const step = 12;
  for (let x = -520; x < 520; x += step) {
    const z0 = zAt(x);
    const z1 = zAt(x + step);
    const mx = x + step / 2;
    const mz = (z0 + z1) / 2;
    const y = terrainHeight(mx, mz);
    const yaw = Math.atan2(z1 - z0, step);
    const tilt = Math.atan2(terrainHeight(x + step, z1) - terrainHeight(x, z0), Math.hypot(step, z1 - z0));
    add(new THREE.BoxGeometry(step + 0.6, 0.12, 4.2), mx, y + 0.04, mz, 0x4a4b4e, -yaw, 0, tilt);
    if (((x + 520) / step) % 4 === 0) {
      const px = mx;
      const pz = mz - 3.6;
      const py = terrainHeight(px, pz);
      add(new THREE.CylinderGeometry(0.13, 0.17, 9, 6), px, py + 4.5, pz, 0x5b4a3a, rnd() * 0.2);
      add(new THREE.BoxGeometry(2.2, 0.14, 0.14), px, py + 8.4, pz, 0x5b4a3a, -yaw);
    }
  }
}

/** Hedgerows and tree clumps along the parcel edges on the farmland. */
function hedgerows(veg: VegBuilder, rnd: () => number): void {
  for (let i = 0; i < 26; i++) {
    const a = rnd() * Math.PI * 2;
    const r = 150 + rnd() * 320;
    const x0 = Math.sin(a) * r;
    const z0 = -Math.cos(a) * r;
    const dir = rnd() * Math.PI;
    const n = 4 + Math.floor(rnd() * 8);
    for (let k = 0; k < n; k++) {
      const x = x0 + Math.cos(dir) * k * 5.5;
      const z = z0 + Math.sin(dir) * k * 5.5;
      veg.bush(x, z, 2.6 + rnd() * 2.2, rnd, true);
    }
  }
}
