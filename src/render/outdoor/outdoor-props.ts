/**
 * Outdoor set pieces by PropDef.kind: field poles, cones and the wind sock as flat-shaded vertex colours
 * merged per material through the StaticBatcher; trees go to the swaying vegetation; backdrop hills come
 * back as smooth meadow-coloured geometry for the caller to merge with the ground. Every builder stays
 * inside its prop's collider (cylinders: diameter × height), so what the pilot sees is what the drone can
 * hit. The wind sock's fabric stays live (it sways).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { PropDef } from '../../types';
import { StaticBatcher, trs } from '../batcher';
import { mulberry32 } from '../textures';
import type { VegBuilder } from './foliage';

export const PALETTE = {
  poleRed: 0xe2462f,
  poleWhite: 0xf3efe6,
  cone: 0xff6a1f,
  coneBand: 0xf7f4ee,
  coneBase: 0x2b2d31,
  steel: 0x8d949c,
  sockOrange: 0xff7a2a,
  sockWhite: 0xf5f1e8,
  hill: 0x5a7f55,
  hillHigh: 0x86a070,
  line: 0xf4f1e8,
  teal: 0x2fd0c8,
} as const;

export interface OutdoorProps {
  /** smooth backdrop hills (position, normal, color, uv) for the ground material */
  hills: THREE.BufferGeometry | null;
  /** wind-sock fabric, pivoting at the top of its pole */
  sock: THREE.Group | null;
  disposables: { dispose(): void }[];
}

/** Flat-shaded vertex-colour material shared by all low-poly pieces of one level view. */
export function lowPolyMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.85, metalness: 0 });
}

export function buildOutdoorProps(props: readonly PropDef[], mat: THREE.MeshStandardMaterial, parent: THREE.Object3D, veg: VegBuilder, batch: StaticBatcher): OutdoorProps {
  const out: OutdoorProps = { hills: null, sock: null, disposables: [] };
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
        veg.tree(p);
        break;
      case 'hill':
        hills.push(hill(p));
        break;
      default:
        break;
    }
  }
  if (hills.length > 0) {
    out.hills = mergeGeometries(hills);
    for (const hg of hills) hg.dispose();
  }
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

/** Far backdrop mound: a smooth bell-profile dome in meadow greens, lighter on the crest (visual only, out of reach). */
function hill(p: PropDef): THREE.BufferGeometry {
  const [w, h, d] = p.size;
  const g = new THREE.SphereGeometry(1, 48, 12, 0, Math.PI * 2, 0, Math.PI / 2);
  const pos = g.attributes.position;
  const rnd = mulberry32(hashId(p.id));
  const phase = rnd() * 10;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const y = Math.max(0, pos.getY(i));
    const a = Math.atan2(z, x);
    const j = 1 + (Math.sin(a * 3 + phase) * 0.06 + Math.sin(a * 7 + phase * 2) * 0.03) * y;
    // bell profile (y^1.6 of a hemisphere): long gentle foothills instead of a dome
    pos.setXYZ(i, x * j, Math.pow(y, 1.6) * j, z * j);
  }
  g.scale(w / 2, h, d / 2);
  g.rotateY(p.yaw ?? 0);
  g.translate(p.position[0], p.position[1] - h * 0.04, p.position[2]);
  g.computeVertexNormals();
  const lo = new THREE.Color(PALETTE.hill);
  const hi = new THREE.Color(PALETTE.hillHigh);
  const c = new THREE.Color();
  const col = new Float32Array(pos.count * 3);
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) - p.position[1];
    c.copy(lo).lerp(hi, THREE.MathUtils.clamp(y / h, 0, 1) * 0.8);
    col.set([c.r, c.g, c.b], i * 3);
    uv[i * 2] = pos.getX(i) / 3;
    uv[i * 2 + 1] = pos.getZ(i) / 3;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

function hashId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
}
