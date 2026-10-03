/**
 * Vegetation and cloth that sways: bushes, hedgerows and flags merged into three meshes (bark, leaves,
 * cards), and the positions of the instanced trees (trees.ts). Every vertex carries `aSway`, the metres it
 * may move in the wind (0 at the roots); the library's wind patch moves it, so the static merge stays one
 * draw per material.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { PropDef } from '../../types';
import { treeInstance, type TreeInstance } from './trees';

const LEAF = [0x3f7a35, 0x4c8a3a, 0x5a9440, 0x3b6e34, 0x6a9a3e] as const;

/** cheap smooth 3D-ish noise for displacing crowns (deterministic per position) */
function bump(x: number, y: number, z: number): number {
  return Math.sin(x * 3.1 + y * 1.7) * 0.5 + Math.sin(z * 2.7 - x * 1.3 + y * 2.1) * 0.35 + Math.sin(y * 4.3 + z * 1.1) * 0.15;
}

type Part = THREE.BufferGeometry;

/**
 * Bend vertex normals towards "out of the crown": a canopy then shades as one soft volume instead of
 * faceted balls (the usual foliage trick). `k` = 1 replaces them outright.
 */
function crownNormals(g: THREE.BufferGeometry, center: THREE.Vector3, k: number): void {
  const pos = g.attributes.position;
  const nor = g.attributes.normal as THREE.BufferAttribute;
  const n = new THREE.Vector3();
  const d = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    d.fromBufferAttribute(pos, i).sub(center);
    const len = d.length();
    if (len < 1e-4) continue;
    d.multiplyScalar(1 / len);
    n.fromBufferAttribute(nor, i).lerp(d, k);
    if (n.lengthSq() < 1e-8) n.copy(d);
    n.normalize();
    nor.setXYZ(i, n.x, n.y, n.z);
  }
}

/** Paints colour + sway on a world-placed geometry; returns it non-indexed with position/normal/color/uv/aSway. */
function finishPart(g: THREE.BufferGeometry, color: (p: THREE.Vector3, n: THREE.Vector3, out: THREE.Color) => void, sway: (p: THREE.Vector3) => number): Part {
  const ng = g.index ? g.toNonIndexed() : g;
  if (ng !== g) g.dispose();
  if (!ng.attributes.normal) ng.computeVertexNormals();
  if (!ng.attributes.uv) ng.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(ng.attributes.position.count * 2), 2));
  const pos = ng.attributes.position;
  const nor = ng.attributes.normal;
  const n = pos.count;
  const col = new Float32Array(n * 3);
  const sw = new Float32Array(n);
  const p = new THREE.Vector3();
  const no = new THREE.Vector3();
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    p.fromBufferAttribute(pos, i);
    no.fromBufferAttribute(nor, i);
    color(p, no, c);
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
    sw[i] = sway(p);
  }
  ng.setAttribute('color', new THREE.BufferAttribute(col, 3));
  ng.setAttribute('aSway', new THREE.BufferAttribute(sw, 1));
  for (const name of Object.keys(ng.attributes)) if (!['position', 'normal', 'uv', 'color', 'aSway'].includes(name)) ng.deleteAttribute(name);
  ng.morphAttributes = {};
  return ng;
}

export class VegBuilder {
  readonly bark: Part[] = [];
  readonly leaves: Part[] = [];
  readonly cards: Part[] = [];
  /** tree instances recorded by tree() (built by `Forest`) */
  readonly trees: TreeInstance[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();

  constructor(private readonly ground: (x: number, z: number) => number) {}

  private place(g: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): THREE.BufferGeometry {
    this.e.set(rx, ry, rz, 'YXZ');
    this.q.setFromEuler(this.e);
    this.m.compose(new THREE.Vector3(x, y, z), this.q, new THREE.Vector3(sx, sy, sz));
    g.applyMatrix4(this.m);
    return g;
  }

  /** Trees are instanced (trees.ts): the builder only records where they stand. */
  tree(p: PropDef): void {
    this.trees.push(treeInstance(p, this.ground(p.position[0], p.position[2])));
  }

  /** A noisy leaf mass (icosphere) with ambient occlusion baked into the vertex colour. */
  private blob(cx: number, cy: number, cz: number, r: number, base: THREE.Color, crownC: THREE.Vector3, crownR: number, y0: number, h: number, swayTop: number, squash = 0.86, detail = 1): void {
    const g = new THREE.IcosahedronGeometry(r, detail);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const px = pos.getX(i);
      const py = pos.getY(i);
      const pz = pos.getZ(i);
      const k = 1 + bump(px / r + cx, py / r + cy, pz / r + cz) * 0.16;
      pos.setXYZ(i, px * k, py * k * squash, pz * k);
    }
    g.computeVertexNormals();
    this.place(g, cx, cy, cz);
    crownNormals(g, crownC, 0.6);
    const outward = new THREE.Vector3();
    this.leaves.push(
      finishPart(
        g,
        (p, n, c) => {
          outward.copy(p).sub(crownC);
          const depth = Math.min(1, outward.length() / crownR);
          const up = n.y * 0.5 + 0.5;
          const facing = n.dot(outward.normalize()) * 0.5 + 0.5;
          const ao = (0.35 + 0.65 * depth * facing) * (0.6 + 0.4 * up);
          c.copy(base).multiplyScalar(0.55 + 0.6 * ao);
        },
        (p) => Math.pow(Math.max(0, p.y - y0) / h, 1.5) * swayTop,
      ),
    );
  }

  /** Leaf cards scattered over a blob's surface (filled in only on tiers that draw cards). */
  private cardsOn(cx: number, cy: number, cz: number, r: number, base: THREE.Color, y0: number, h: number, swayTop: number, rnd: () => number, count: number): void {
    for (let i = 0; i < count; i++) {
      const th = rnd() * Math.PI * 2;
      const ph = Math.acos(rnd() * 1.6 - 0.6);
      const d = r * (0.45 + rnd() * 0.25);
      const px = cx + Math.sin(ph) * Math.cos(th) * d;
      const py = cy + Math.cos(ph) * d * 0.86;
      const pz = cz + Math.sin(ph) * Math.sin(th) * d;
      const s = r * (0.95 + rnd() * 0.45);
      const g = new THREE.PlaneGeometry(s, s);
      this.place(g, px, py, pz, (rnd() - 0.5) * 1.2, rnd() * Math.PI, (rnd() - 0.5) * 1.2);
      // cards shade like the leaf mass they sit on: normals point out of the blob
      crownNormals(g, new THREE.Vector3(cx, cy, cz), 1);
      const tint = 0.85 + rnd() * 0.35;
      // the card texture carries the green: the vertex colour only shifts the hue towards the bush's own
      this.cards.push(finishPart(g, (_p, _n, c) => c.setRGB(1, 1, 1).lerp(base, 0.35).multiplyScalar(tint * 1.1), (p) => Math.pow(Math.max(0, p.y - y0) / h, 1.5) * swayTop));
    }
  }

  /** Low shrub: 2–4 leaf masses hugging the ground; `far` ones are coarser and get no cards. */
  bush(x: number, z: number, size: number, rnd: () => number, far = false): void {
    const y0 = this.ground(x, z);
    const base = new THREE.Color(LEAF[Math.floor(rnd() * LEAF.length)]!).offsetHSL(0.01, -0.05, -0.03);
    const n = 2 + Math.floor(rnd() * 3);
    const c = new THREE.Vector3(x, y0 + size * 0.35, z);
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2;
      const br = size * (0.4 + rnd() * 0.25);
      const bx = x + Math.cos(a) * size * 0.35;
      const bz = z + Math.sin(a) * size * 0.35;
      // near bushes: a smaller, darker core under a coat of leaf cards (the cards carry the silhouette on
      // tiers that draw them; the core alone reads as the cheap bush elsewhere)
      this.blob(bx, y0 + br * 0.55, bz, far ? br : br * 0.86, far ? base : base.clone().multiplyScalar(0.8), c, size, y0, size, 0.05, 0.75, far ? 0 : 1);
      if (!far) this.cardsOn(bx, y0 + br * 0.55, bz, br, base, y0, size, 0.05, rnd, 9);
    }
  }

  /** Feather flag: a tall curved banner on a bent pole, cloth swaying. */
  flag(x: number, z: number, h: number, color: number, accent: number, yaw: number): void {
    const y0 = this.ground(x, z);
    const pole = new THREE.CylinderGeometry(0.02, 0.025, h, 6, 1, true);
    pole.translate(x, y0 + h / 2, z);
    this.bark.push(finishPart(pole, (_p, _n, c) => c.setRGB(0.55, 0.57, 0.6), () => 0));
    const w = 0.55;
    const bh = h * 0.78;
    const g = new THREE.PlaneGeometry(w, bh, 4, 8);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const u = (pos.getX(i) + w / 2) / w;
      const v = (pos.getY(i) + bh / 2) / bh;
      // feather shape: narrower at the bottom, rounded top
      const width = w * (0.55 + 0.45 * Math.sin(Math.min(1, v * 1.2) * Math.PI * 0.5)) * (v > 0.85 ? Math.cos(((v - 0.85) / 0.15) * Math.PI * 0.45) : 1);
      pos.setXYZ(i, u * width, v * bh + h * 0.2 - h / 2, Math.sin(u * Math.PI) * 0.05);
    }
    g.computeVertexNormals();
    this.place(g, x, y0 + h / 2, z, 0, yaw, 0);
    const top = new THREE.Color(color);
    const acc = new THREE.Color(accent);
    this.leaves.push(
      finishPart(
        g,
        (p, _n, c) => c.copy(p.y - y0 > h * 0.62 ? acc : top),
        (p) => {
          const dx = p.x - x;
          const dz = p.z - z;
          return Math.min(1, Math.hypot(dx, dz) / w) * 0.25;
        },
      ),
    );
  }

  build(parent: THREE.Object3D, mats: { bark: THREE.Material; leaves: THREE.Material; cards: THREE.Material }): { bark: THREE.Mesh | null; leaves: THREE.Mesh | null; cards: THREE.Mesh | null } {
    const make = (parts: Part[], mat: THREE.Material, name: string): THREE.Mesh | null => {
      if (parts.length === 0) return null;
      const g = mergeGeometries(parts, false);
      for (const p of parts) p.dispose();
      if (!g) throw new Error(`merge failed: ${name}`);
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, mat);
      m.name = name;
      m.matrixAutoUpdate = false;
      parent.add(m);
      return m;
    };
    const out = { bark: make(this.bark, mats.bark, 'veg:bark'), leaves: make(this.leaves, mats.leaves, 'veg:leaves'), cards: make(this.cards, mats.cards, 'veg:cards') };
    this.bark.length = 0;
    this.leaves.length = 0;
    this.cards.length = 0;
    return out;
  }
}
