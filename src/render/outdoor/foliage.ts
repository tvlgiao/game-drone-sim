/**
 * Vegetation and cloth that sways: trees (bark, clustered leaf masses, optional alpha leaf cards),
 * bushes and flags, merged into three meshes (bark, leaves, cards). Every vertex carries `aSway`, the
 * metres it may move in the wind (0 at the roots); the vertex shader moves it, so the static merge
 * stays one draw per material. Crowns stay inside their prop's canopy collider.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { PropDef } from '../../types';
import { dataTexture, mulberry32, rgba, smooth } from '../env-materials/texgen';

export interface WindUniforms {
  uTime: THREE.IUniform<number>;
  uWind: THREE.IUniform<THREE.Vector2>;
}

const WIND_HEAD = /* glsl */ `
attribute float aSway;
uniform float uTime;
uniform vec2 uWind;
`;

const WIND_BODY = /* glsl */ `
{
  float ph = dot( transformed.xz, vec2( 0.11, 0.07 ) );
  float gust = sin( uTime * 1.25 + ph ) * 0.55 + sin( uTime * 2.3 + ph * 1.7 ) * 0.25 + 0.4;
  transformed.xz += uWind * gust * aSway;
  #ifdef WIND_FLUTTER
  transformed += vec3( sin( uTime * 8.0 + ph * 13.0 ), sin( uTime * 6.3 + ph * 11.0 ) * 0.6, cos( uTime * 7.1 + ph * 9.0 ) ) * 0.06 * aSway;
  #endif
}
`;

/** Wind sway on a vertex-coloured standard material whose geometry carries `aSway`. */
export function applyWind(mat: THREE.MeshStandardMaterial, wind: WindUniforms, flutter: boolean): THREE.MeshStandardMaterial {
  if (flutter) mat.defines = { ...(mat.defines ?? {}), WIND_FLUTTER: '' };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = wind.uTime;
    shader.uniforms.uWind = wind.uWind;
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${WIND_HEAD}`).replace('#include <begin_vertex>', `#include <begin_vertex>\n${WIND_BODY}`);
  };
  mat.customProgramCacheKey = () => (flutter ? 'wind-flutter' : 'wind');
  return mat;
}

/** Leaf-cluster card: ~50 leaves fanning out from the centre, alpha-cut. */
export function leafCardTexture(size: number): THREE.DataTexture {
  const rnd = mulberry32(606);
  const leaves: { x: number; y: number; a: number; l: number; w: number; t: number }[] = [];
  for (let i = 0; i < 56; i++) {
    const r = Math.sqrt(rnd()) * 0.36;
    const th = rnd() * Math.PI * 2;
    leaves.push({ x: 0.5 + Math.cos(th) * r, y: 0.5 + Math.sin(th) * r, a: th + (rnd() - 0.5) * 0.8, l: 0.07 + rnd() * 0.05, w: 0.028 + rnd() * 0.018, t: rnd() });
  }
  const data = rgba(size, size, (_i, px, py, c) => {
    const u = (px + 0.5) / size;
    const v = (py + 0.5) / size;
    let best = -1;
    let shade = 0;
    for (const lf of leaves) {
      const dx = u - lf.x;
      const dy = v - lf.y;
      const ca = Math.cos(lf.a);
      const sa = Math.sin(lf.a);
      const along = (dx * ca + dy * sa) / lf.l;
      const across = (-dx * sa + dy * ca) / lf.w;
      const d = along * along + across * across;
      if (d < 1 && lf.t > best) {
        best = lf.t;
        shade = 0.75 + 0.25 * (1 - Math.abs(across)) - (Math.abs(across) < 0.08 ? 0.12 : 0);
      }
    }
    if (best < 0) {
      c[0] = 0.25;
      c[1] = 0.35;
      c[2] = 0.15;
      c[3] = 0;
      return;
    }
    const k = (0.75 + best * 0.35) * shade;
    c[0] = 0.62 * k;
    c[1] = 0.8 * k;
    c[2] = 0.48 * k;
    c[3] = 1;
  });
  const t = dataTexture(data, size, size, { srgb: true, repeat: false });
  return t;
}

/** Vertical bark streaks (normal-mapped through the cylinder's own UVs). */
export function barkTexture(size: number): THREE.DataTexture {
  const rnd = mulberry32(707);
  const cols = new Float32Array(size);
  for (let i = 0; i < size; i++) cols[i] = rnd();
  const data = rgba(size, size, (_i, x, y, c) => {
    const ridge = Math.abs(Math.sin((x / size) * Math.PI * 18 + Math.sin(y * 0.05) * 0.8 + cols[(x * 3) % size]! * 0.6));
    const k = 0.6 + ridge * 0.4 + (cols[(x + y * 7) % size]! - 0.5) * 0.12;
    c[0] = 0.42 * k;
    c[1] = 0.34 * k;
    c[2] = 0.27 * k;
  });
  return dataTexture(data, size, size, { srgb: true });
}

const LEAF = [0x3f7a35, 0x4c8a3a, 0x5a9440, 0x3b6e34, 0x6a9a3e] as const;
const NEEDLE = [0x2c5a3a, 0x284f35, 0x355f3c] as const;

function hashId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
}

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

  /** Broadleaf or conifer by hash of the id, inside the prop's trunk + canopy colliders. */
  tree(p: PropDef): void {
    const [x, , z] = p.position;
    const [crown, h] = p.size;
    const rnd = mulberry32(hashId(p.id));
    const y0 = this.ground(x, z);
    if (rnd() < 0.42) this.conifer(x, y0, z, crown / 2, h, p.yaw ?? 0, rnd);
    else this.broadleaf(x, y0, z, crown / 2, h, p.yaw ?? 0, rnd);
  }

  private trunk(x: number, y0: number, z: number, r0: number, r1: number, len: number, lean: THREE.Vector2, h: number, swayTop: number): void {
    const g = new THREE.CylinderGeometry(r1, r0, len, 8, 4, true);
    g.translate(0, len / 2, 0);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const t = pos.getY(i) / len;
      const flare = 1 + Math.pow(1 - t, 6) * 0.45;
      pos.setXYZ(i, pos.getX(i) * flare + lean.x * t * t, pos.getY(i), pos.getZ(i) * flare + lean.y * t * t);
    }
    g.computeVertexNormals();
    this.place(g, x, y0, z);
    this.bark.push(
      finishPart(
        g,
        (p, _n, c) => c.setRGB(1, 1, 1).multiplyScalar(0.8 + 0.2 * smooth(0, 1.2, p.y - y0)),
        (p) => Math.pow(Math.max(0, p.y - y0) / h, 2) * swayTop,
      ),
    );
  }

  private branch(a: THREE.Vector3, b: THREE.Vector3, r: number, y0: number, h: number, swayTop: number): void {
    const len = a.distanceTo(b);
    const g = new THREE.CylinderGeometry(r * 0.5, r, len, 5, 1, true);
    g.translate(0, len / 2, 0);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize()));
    g.translate(a.x, a.y, a.z);
    this.bark.push(finishPart(g, (_p, _n, c) => c.setRGB(0.9, 0.9, 0.9), (p) => Math.pow(Math.max(0, p.y - y0) / h, 2) * swayTop));
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
      const d = r * (0.75 + rnd() * 0.25);
      const px = cx + Math.sin(ph) * Math.cos(th) * d;
      const py = cy + Math.cos(ph) * d * 0.86;
      const pz = cz + Math.sin(ph) * Math.sin(th) * d;
      const s = r * (0.95 + rnd() * 0.5);
      const g = new THREE.PlaneGeometry(s, s);
      this.place(g, px, py, pz, (rnd() - 0.5) * 1.2, rnd() * Math.PI, (rnd() - 0.5) * 1.2);
      // cards shade like the leaf mass they sit on: normals point out of the blob
      crownNormals(g, new THREE.Vector3(cx, cy, cz), 1);
      const tint = 0.85 + rnd() * 0.35;
      this.cards.push(finishPart(g, (_p, _n, c) => c.copy(base).multiplyScalar(tint * 1.35), (p) => Math.pow(Math.max(0, p.y - y0) / h, 1.5) * swayTop));
    }
  }

  private broadleaf(x: number, y0: number, z: number, r: number, h: number, yaw: number, rnd: () => number): void {
    const swayTop = 0.12 + h * 0.012;
    // the canopy collider spans 0.24 h .. h: fill an ellipsoid from ~0.34 h up, trunk forks inside it
    const crownLo = h * 0.34;
    const ry = (h - crownLo) / 2;
    const trunkH = crownLo + ry * 0.5;
    const lean = new THREE.Vector2((rnd() - 0.5) * 0.35, (rnd() - 0.5) * 0.35);
    this.trunk(x, y0, z, 0.22, 0.1, trunkH, lean, h, swayTop);
    const base = new THREE.Color(LEAF[Math.floor(rnd() * LEAF.length)]!);
    const crownC = new THREE.Vector3(x + lean.x, y0 + crownLo + ry, z + lean.y);
    const fork = new THREE.Vector3(x + lean.x, y0 + crownLo + ry * 0.3, z + lean.y);
    const n = 9 + Math.floor(rnd() * 4);
    for (let i = 0; i < n; i++) {
      const a = yaw + (i / n) * Math.PI * 2 * 1.618 + rnd() * 0.5;
      const t = (i + 0.5) / n;
      const elev = (t * 2 - 1) * 0.9;
      const br = r * (0.36 + rnd() * 0.14);
      const reach = Math.sqrt(Math.max(0, 1 - elev * elev)) * Math.max(0, r - br) * (0.7 + rnd() * 0.3);
      const cx = crownC.x + Math.cos(a) * reach;
      const cz = crownC.z + Math.sin(a) * reach;
      const cy = THREE.MathUtils.clamp(crownC.y + elev * (ry - br * 0.6), y0 + crownLo + br * 0.5, y0 + h - br * 0.86);
      const tint = base.clone().offsetHSL((rnd() - 0.5) * 0.03, (rnd() - 0.5) * 0.1, (rnd() - 0.5) * 0.06);
      this.blob(cx, cy, cz, br, tint, crownC, Math.max(r, ry), y0, h, swayTop);
      this.cardsOn(cx, cy, cz, br, tint, y0, h, swayTop, rnd, 6);
      if (i % 3 === 0) this.branch(fork, new THREE.Vector3(cx, cy - br * 0.2, cz), 0.06, y0, h, swayTop);
    }
    const tb = r * 0.5;
    this.blob(crownC.x, Math.min(y0 + h - tb * 0.86, crownC.y + ry * 0.45), crownC.z, tb, base.clone().offsetHSL(0, 0, 0.04), crownC, Math.max(r, ry), y0, h, swayTop);
  }

  private conifer(x: number, y0: number, z: number, r: number, h: number, yaw: number, rnd: () => number): void {
    const swayTop = 0.1 + h * 0.01;
    this.trunk(x, y0, z, 0.17, 0.04, h * 0.96, new THREE.Vector2(0, 0), h, swayTop);
    const base = new THREE.Color(NEEDLE[Math.floor(rnd() * NEEDLE.length)]!);
    const tiers = 6 + Math.floor(rnd() * 3);
    const start = h * 0.18;
    for (let k = 0; k < tiers; k++) {
      const t = k / (tiers - 1);
      const tr = r * (1 - t * 0.82) * (0.92 + rnd() * 0.1);
      const th = (h - start) * (0.34 - t * 0.12);
      const cy = start + t * (h - start - th * 0.9);
      const g = new THREE.ConeGeometry(tr, th, 11, 2, true);
      const pos = g.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const py = pos.getY(i);
        const px = pos.getX(i);
        const pz = pos.getZ(i);
        // ragged, drooping hem
        const hem = py < -th / 2 + 1e-3 ? (Math.sin(Math.atan2(pz, px) * 7 + k) * 0.5 + 0.5) * th * 0.18 : 0;
        const rad = 1 + (py < 0 ? bump(px * 2, py, pz * 2) * 0.1 : 0);
        pos.setXYZ(i, px * rad, py - hem, pz * rad);
      }
      g.computeVertexNormals();
      this.place(g, x, y0 + cy + th / 2, z, 0, yaw + k * 0.7, 0);
      const tierC = new THREE.Vector3(x, y0 + cy + th / 2, z);
      this.leaves.push(
        finishPart(
          g,
          (p, n, c) => {
            const below = smooth(tierC.y - th * 0.5, tierC.y + th * 0.3, p.y);
            const outer = Math.min(1, Math.hypot(p.x - x, p.z - z) / Math.max(0.2, tr));
            c.copy(base).multiplyScalar((0.45 + 0.55 * below * (0.5 + 0.5 * outer)) * (0.75 + 0.25 * (n.y * 0.5 + 0.5)) * (0.9 + t * 0.25));
          },
          (p) => Math.pow(Math.max(0, p.y - y0) / h, 1.5) * swayTop,
        ),
      );
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
      this.blob(bx, y0 + br * 0.55, bz, br, base, c, size, y0, size, 0.05, 0.75, far ? 0 : 1);
      if (!far) this.cardsOn(bx, y0 + br * 0.55, bz, br, base, y0, size, 0.05, rnd, 3);
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
