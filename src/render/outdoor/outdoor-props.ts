/**
 * Low-poly outdoor set pieces by PropDef.kind: flat-shaded vertex colours, merged per material through
 * the StaticBatcher. Every builder stays inside its prop's collider (cylinders: diameter × height), so
 * what the pilot sees is what the drone can hit. The wind sock's fabric stays live (it sways).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { PropDef } from '../../types';
import { StaticBatcher, trs } from '../batcher';
import { mulberry32 } from '../textures';

export const PALETTE = {
  poleRed: 0xe2462f,
  poleWhite: 0xf3efe6,
  cone: 0xff6a1f,
  coneBand: 0xf7f4ee,
  coneBase: 0x2b2d31,
  steel: 0x8d949c,
  sockOrange: 0xff7a2a,
  sockWhite: 0xf5f1e8,
  trunk: 0x6b4a32,
  leaves: [0x3f7d3a, 0x4f8f3f, 0x5c9a45, 0x376d3b],
  conifer: [0x2f5f3d, 0x2b5537, 0x3a6d45],
  hill: 0x4f7f4c,
  hillHigh: 0x7c9f62,
  line: 0xf4f1e8,
  teal: 0x2fd0c8,
} as const;

export interface OutdoorProps {
  meshes: THREE.Mesh[];
  /** wind-sock fabric, pivoting at the top of its pole */
  sock: THREE.Group | null;
  disposables: { dispose(): void }[];
}

/** Flat-shaded vertex-colour material shared by all low-poly pieces of one level view. */
export function lowPolyMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.85, metalness: 0 });
}

export function buildOutdoorProps(props: readonly PropDef[], mat: THREE.MeshStandardMaterial, parent: THREE.Object3D): OutdoorProps {
  const batch = new StaticBatcher();
  const out: OutdoorProps = { meshes: [], sock: null, disposables: [] };
  const hills: THREE.BufferGeometry[] = [];
  for (const p of props) {
    const [x, , z] = p.position;
    const [w, h] = p.size;
    switch (p.kind) {
      case 'pole':
        pole(batch, mat, x, z, w / 2, h);
        break;
      case 'cone':
        cone(batch, mat, x, z, w / 2, h);
        break;
      case 'windsock':
        out.sock = windsock(batch, mat, x, z, h, out.disposables);
        parent.add(out.sock);
        break;
      case 'tree':
        tree(batch, mat, p);
        break;
      case 'hill':
        hills.push(hill(p));
        break;
      default:
        break;
    }
  }
  out.meshes = batch.build(parent);
  if (hills.length > 0) {
    const g = mergeGeometries(hills)!;
    for (const hg of hills) hg.dispose();
    const m = new THREE.Mesh(g, mat);
    m.name = 'hills';
    m.receiveShadow = false;
    parent.add(m);
    out.meshes.push(m);
  }
  for (const m of out.meshes) out.disposables.push(m.geometry);
  return out;
}

/** Striped field-corner pole (0.5 m bands) with a ball on top. */
function pole(batch: StaticBatcher, mat: THREE.Material, x: number, z: number, r: number, h: number): void {
  const bands = Math.round(h / 0.5);
  const bh = h / bands;
  for (let i = 0; i < bands; i++) {
    const top = i === bands - 1 ? 0.92 : 1;
    batch.add('lowpoly', mat, new THREE.CylinderGeometry(r * top, r, bh, 10), trs(x, bh * (i + 0.5), z), { color: i % 2 === 0 ? PALETTE.poleRed : PALETTE.poleWhite });
  }
  batch.add('lowpoly', mat, new THREE.IcosahedronGeometry(r * 1.05, 1), trs(x, h - r * 0.6, z), { color: PALETTE.poleRed });
}

/** Traffic cone: base plate, orange cone, white reflective band. */
function cone(batch: StaticBatcher, mat: THREE.Material, x: number, z: number, r: number, h: number): void {
  batch.add('lowpoly', mat, new THREE.BoxGeometry(r * 2, 0.04, r * 2), trs(x, 0.02, z), { color: PALETTE.coneBase });
  batch.add('lowpoly', mat, new THREE.CylinderGeometry(r * 0.12, r * 0.82, h - 0.04, 12), trs(x, 0.04 + (h - 0.04) / 2, z), { color: PALETTE.cone });
  batch.add('lowpoly', mat, new THREE.CylinderGeometry(r * 0.44, r * 0.56, h * 0.16, 12), trs(x, h * 0.52, z), { color: PALETTE.coneBand });
}

const SOCK_LEN = 1.4;
/** Pole + a striped fabric cone; the fabric is returned as a live group pivoting at the pole top. */
function windsock(batch: StaticBatcher, mat: THREE.MeshStandardMaterial, x: number, z: number, h: number, disposables: { dispose(): void }[]): THREE.Group {
  batch.add('lowpoly', mat, new THREE.CylinderGeometry(0.035, 0.05, h, 8), trs(x, h / 2, z), { color: PALETTE.steel });
  const parts: THREE.BufferGeometry[] = [];
  const segs = 5;
  for (let i = 0; i < segs; i++) {
    const r0 = 0.26 - (i / segs) * 0.13;
    const r1 = 0.26 - ((i + 1) / segs) * 0.13;
    const g = new THREE.CylinderGeometry(r1, r0, SOCK_LEN / segs, 12, 1, true).toNonIndexed();
    g.rotateZ(-Math.PI / 2);
    g.translate(0.3 + (i + 0.5) * (SOCK_LEN / segs), 0, 0);
    const c = new THREE.Color(i % 2 === 0 ? PALETTE.sockOrange : PALETTE.sockWhite);
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let k = 0; k < n; k++) col.set([c.r, c.g, c.b], k * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    parts.push(g);
  }
  const ring = new THREE.TorusGeometry(0.27, 0.015, 6, 16).toNonIndexed();
  ring.rotateY(Math.PI / 2);
  ring.translate(0.3, 0, 0);
  const steel = new THREE.Color(PALETTE.steel);
  const rc = new Float32Array(ring.attributes.position.count * 3);
  for (let k = 0; k < ring.attributes.position.count; k++) rc.set([steel.r, steel.g, steel.b], k * 3);
  ring.setAttribute('color', new THREE.BufferAttribute(rc, 3));
  ring.deleteAttribute('uv');
  for (const g of parts) g.deleteAttribute('uv');
  const geo = mergeGeometries([...parts, ring])!;
  for (const g of [...parts, ring]) g.dispose();
  const sockMat = mat.clone();
  sockMat.side = THREE.DoubleSide;
  const fabric = new THREE.Mesh(geo, sockMat);
  fabric.castShadow = false;
  const pivot = new THREE.Group();
  pivot.name = 'windsock';
  pivot.position.set(x, h - 0.15, z);
  pivot.add(fabric);
  disposables.push(geo, sockMat);
  return pivot;
}

/** Broadleaf (icosphere crown) or conifer (stacked cones) by hash of the id; trunk inside the collider. */
function tree(batch: StaticBatcher, mat: THREE.Material, p: PropDef): void {
  const [x, , z] = p.position;
  const [crown, h] = p.size;
  const rnd = mulberry32(hashId(p.id));
  const yaw = p.yaw ?? 0;
  const trunkH = h * 0.4;
  batch.add('lowpoly', mat, new THREE.CylinderGeometry(0.14, 0.22, trunkH, 6), trs(x, trunkH / 2, z, yaw), { color: PALETTE.trunk });
  const r = crown / 2;
  if (rnd() < 0.45) {
    const pick = PALETTE.conifer[Math.floor(rnd() * PALETTE.conifer.length)]!;
    const tiers = 3;
    const base = h * 0.25;
    const th = (h - base) * 0.5;
    for (let i = 0; i < tiers; i++) {
      const y = base + th / 2 + (i * (h - base - th)) / (tiers - 1);
      batch.add('lowpoly', mat, new THREE.ConeGeometry(r * (1 - i * 0.24), th, 7), trs(x, y, z, yaw + i), { color: pick });
    }
  } else {
    const pick = PALETTE.leaves[Math.floor(rnd() * PALETTE.leaves.length)]!;
    const cy = h - r * 0.95;
    batch.add('lowpoly', mat, new THREE.IcosahedronGeometry(r, 0), trs(x, cy, z, yaw, 1, 0.95, 1), { color: pick });
    batch.add('lowpoly', mat, new THREE.IcosahedronGeometry(r * 0.62, 0), trs(x + r * 0.35, cy - r * 0.35, z - r * 0.2, yaw + 1), { color: pick });
  }
}

/** Far backdrop mound: jittered low-poly dome, lighter towards the top (visual only, out of reach). */
function hill(p: PropDef): THREE.BufferGeometry {
  const [w, h, d] = p.size;
  const g = new THREE.SphereGeometry(1, 26, 8, 0, Math.PI * 2, 0, Math.PI / 2).toNonIndexed();
  const pos = g.attributes.position;
  const rnd = mulberry32(hashId(p.id));
  const jitter = new Map<string, number>();
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i).toFixed(3)}|${pos.getY(i).toFixed(3)}|${pos.getZ(i).toFixed(3)}`;
    let j = jitter.get(key);
    if (j === undefined) {
      j = pos.getY(i) > 0.01 ? 0.95 + rnd() * 0.1 : 1;
      jitter.set(key, j);
    }
    // bell profile (y^1.6 of a hemisphere): long gentle foothills instead of a dome
    pos.setXYZ(i, pos.getX(i) * j, Math.pow(Math.max(0, pos.getY(i)), 1.6) * j * j, pos.getZ(i) * j);
  }
  g.scale(w / 2, h, d / 2);
  g.rotateY(p.yaw ?? 0);
  g.translate(p.position[0], p.position[1] - h * 0.04, p.position[2]);
  const lo = new THREE.Color(PALETTE.hill);
  const hi = new THREE.Color(PALETTE.hillHigh);
  const c = new THREE.Color();
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i += 3) {
    const y = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3;
    c.copy(lo).lerp(hi, THREE.MathUtils.clamp(y / h, 0, 1) * 0.8 + rnd() * 0.12);
    for (let k = 0; k < 3; k++) col.set([c.r, c.g, c.b], (i + k) * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.deleteAttribute('uv');
  g.computeVertexNormals();
  return g;
}

function hashId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
}
