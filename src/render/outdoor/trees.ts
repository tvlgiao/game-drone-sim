/**
 * Instanced trees. A handful of archetypes (two broadleaf, one conifer) are grown once, procedurally, at a
 * nominal 10 m height and 2.5 m crown radius, and every tree of a level is an instance of one of them,
 * scaled to its prop (height on y, crown radius on x / z) and turned by its yaw:
 *
 * - detailed (ultra / high): a tapered, flared trunk with primary and secondary branches (library `bark`,
 *   CC0 where loaded) and clustered leaf cards (library `foliage`, alpha-tested) gathered at the branch
 *   tips plus a fill shell, normals bent out of the crown so it shades as one soft volume;
 * - cheap (medium / low / VR): one opaque mesh per archetype — a six-sided trunk and a few displaced leaf
 *   masses (or stacked cones), vertex-coloured.
 *
 * Every vertex carries `aSway` (metres at the top, 0 at the roots); the library's wind patch moves it in
 * world space, phase-shifted per instance. Archetype geometry stays inside the unit crown cylinder
 * (|xz| ≤ CROWN_R above 24 % of the height, y ≤ HEIGHT), so every instance stays inside its prop's canopy
 * collider; the trunk stays inside the trunk collider's 25 cm radius.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { PropDef } from '../../types';
import { mulberry32, smooth } from '../materials/texgen';

/** archetype height / crown radius (m): instances scale from these */
export const ARCH_HEIGHT = 10;
export const ARCH_CROWN = 2.5;
/** crown geometry keeps this share of the collider radius free (rounding of the scale, card edges) */
const CROWN_FILL = 0.96;
/** canopy collider starts at this share of the height; below it only the trunk may be */
const CANOPY_LOW = 0.24;
/** archetype trunk radius limit below the canopy (× the widest instance scale ≈ the trunk collider's 0.25 m) */
const TRUNK_MAX = 0.16;

export type TreeKind = 'oak' | 'birch' | 'pine';
const KINDS: readonly TreeKind[] = ['oak', 'birch', 'pine'];

export interface TreeInstance {
  kind: TreeKind;
  x: number;
  y: number;
  z: number;
  yaw: number;
  height: number;
  /** canopy radius (m) */
  crown: number;
  /** per-tree brightness / hue jitter */
  tint: THREE.Color;
}

interface Archetype {
  bark: THREE.BufferGeometry;
  cards: THREE.BufferGeometry;
  lod: THREE.BufferGeometry;
}

const LEAF = { oak: [0x3d7a32, 0x4a8636, 0x55913c], birch: [0x6a9e3c, 0x78a842, 0x5f9638], pine: [0x2a5a38, 0x2f6240, 0x26523a] } as const;
const BARK_TINT = { oak: 0xd2c2b2, birch: 0xf2ede4, pine: 0xb89c88 } as const;

function hashId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Writes colour + sway, strips to position / normal / uv / color / aSway, non-indexed. */
function finish(g: THREE.BufferGeometry, color: (p: THREE.Vector3, n: THREE.Vector3, out: THREE.Color) => void, sway: (p: THREE.Vector3) => number): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  if (ng !== g) g.dispose();
  if (!ng.attributes.normal) ng.computeVertexNormals();
  if (!ng.attributes.uv) ng.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(ng.attributes.position.count * 2), 2));
  const pos = ng.attributes.position;
  const nor = ng.attributes.normal;
  const col = new Float32Array(pos.count * 3);
  const sw = new Float32Array(pos.count);
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    n.fromBufferAttribute(nor, i);
    color(p, n, c);
    col.set([c.r, c.g, c.b], i * 3);
    sw[i] = sway(p);
  }
  ng.setAttribute('color', new THREE.BufferAttribute(col, 3));
  ng.setAttribute('aSway', new THREE.BufferAttribute(sw, 1));
  for (const name of Object.keys(ng.attributes)) if (!['position', 'normal', 'uv', 'color', 'aSway'].includes(name)) ng.deleteAttribute(name);
  return ng;
}

/** Bend normals towards "out of the crown" (k = 1 replaces them): the canopy shades as one soft volume. */
function crownNormals(g: THREE.BufferGeometry, center: THREE.Vector3, k: number, squashY = 1): void {
  const pos = g.attributes.position;
  const nor = g.attributes.normal as THREE.BufferAttribute;
  const n = new THREE.Vector3();
  const d = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    d.fromBufferAttribute(pos, i).sub(center);
    d.y *= squashY;
    const len = d.length();
    if (len < 1e-4) continue;
    d.multiplyScalar(1 / len);
    n.fromBufferAttribute(nor, i).lerp(d, k);
    if (n.lengthSq() < 1e-8) n.copy(d);
    n.normalize();
    nor.setXYZ(i, n.x, n.y, n.z);
  }
}

/** Tapered tube along a polyline: `radius(t)` per ring, UVs in metres (u around, v along). */
function limb(path: readonly THREE.Vector3[], radius: (t: number) => number, sides: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const tan = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const bin = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  let along = 0;
  for (let i = 0; i < path.length; i++) {
    const p = path[i]!;
    const a = path[Math.max(0, i - 1)]!;
    const b = path[Math.min(path.length - 1, i + 1)]!;
    tan.subVectors(b, a).normalize();
    nrm.crossVectors(tan, Math.abs(tan.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : up).normalize();
    bin.crossVectors(tan, nrm).normalize();
    if (i > 0) along += p.distanceTo(path[i - 1]!);
    const r = radius(i / (path.length - 1));
    for (let s = 0; s <= sides; s++) {
      const th = (s / sides) * Math.PI * 2;
      const cx = Math.cos(th);
      const sy = Math.sin(th);
      pos.push(p.x + (nrm.x * cx + bin.x * sy) * r, p.y + (nrm.y * cx + bin.y * sy) * r, p.z + (nrm.z * cx + bin.z * sy) * r);
      uv.push((s / sides) * Math.max(0.3, r * Math.PI * 2), along);
    }
  }
  for (let i = 0; i < path.length - 1; i++) {
    for (let s = 0; s < sides; s++) {
      const a = i * (sides + 1) + s;
      const b = a + sides + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Keeps every vertex of `g` inside the crown cylinder (above the canopy floor) and under the top. */
function containCrown(g: THREE.BufferGeometry): void {
  const pos = g.attributes.position;
  const maxR = ARCH_CROWN * CROWN_FILL;
  const top = ARCH_HEIGHT * 0.985;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const r = Math.hypot(x, z);
    // below the canopy only the trunk collider (25 cm) exists: the widest tree scales x by ~1.5
    const lim = y > ARCH_HEIGHT * CANOPY_LOW ? maxR : TRUNK_MAX;
    const k = r > lim ? lim / r : 1;
    pos.setXYZ(i, x * k, Math.min(y, top), z * k);
  }
  pos.needsUpdate = true;
}

/** A leaf card of edge `s` centred on `c`, turned (rx, ry, rz); its normals point out of the crown. */
function card(c: THREE.Vector3, s: number, rx: number, ry: number, rz: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(s, s);
  g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')));
  g.translate(c.x, c.y, c.z);
  return g;
}

function swayOf(top: number, pow = 1.5): (p: THREE.Vector3) => number {
  return (p) => Math.pow(Math.max(0, p.y) / ARCH_HEIGHT, pow) * top * (0.6 + 0.4 * Math.min(1, Math.hypot(p.x, p.z) / ARCH_CROWN));
}

/** Broadleaf (oak: broad, dense, low crown; birch: narrow, airy, higher crown, pale bark). */
function growBroadleaf(kind: 'oak' | 'birch', seed: number): Archetype {
  const rnd = mulberry32(seed);
  const H = ARCH_HEIGHT;
  const R = ARCH_CROWN;
  const birch = kind === 'birch';
  const crownLo = H * (birch ? 0.4 : 0.32);
  const crownC = new THREE.Vector3(0, (crownLo + H) / 2, 0);
  const ry = (H - crownLo) / 2;
  const swayTop = 0.24;
  const leafBase = LEAF[kind];
  const barkParts: THREE.BufferGeometry[] = [];
  const cardParts: THREE.BufferGeometry[] = [];
  const tips: THREE.Vector3[] = [];

  // trunk: gentle S-curve, flared root, forks at ~70 % of the crown height
  const trunkTop = crownLo + ry * (birch ? 1.1 : 0.7);
  const lean = new THREE.Vector2((rnd() - 0.5) * 0.25, (rnd() - 0.5) * 0.25);
  const trunkPath: THREE.Vector3[] = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    trunkPath.push(new THREE.Vector3(lean.x * t * t + Math.sin(t * 3 + seed) * 0.04, t * trunkTop, lean.y * t * t + Math.cos(t * 2.6 + seed) * 0.04));
  }
  const r0 = birch ? 0.1 : 0.13;
  barkParts.push(limb(trunkPath, (t) => (r0 * (1 - t * 0.72) + 0.02) * (1 + Math.pow(1 - t, 8) * 0.4), 9));

  // primary branches up and out from the upper trunk, secondaries off their outer half
  const nPrim = birch ? 9 : 7 + Math.floor(rnd() * 2);
  const at = (t: number) => trunkPath[Math.min(10, Math.round(t * 10))]!;
  for (let b = 0; b < nPrim; b++) {
    const t0 = 0.42 + (b / nPrim) * 0.5 + rnd() * 0.05;
    const start = at(t0);
    if (start.y < H * CANOPY_LOW + 0.3) continue;
    const az = b * 2.39996 + rnd() * 0.5;
    const elev = THREE.MathUtils.degToRad(birch ? 55 + rnd() * 20 : 32 + rnd() * 22);
    const dir = new THREE.Vector3(Math.cos(az) * Math.cos(elev), Math.sin(elev), Math.sin(az) * Math.cos(elev));
    const len = (birch ? 1.7 : 2.0) + rnd() * 0.6;
    const end = start.clone().addScaledVector(dir, len);
    const mid = start.clone().lerp(end, 0.5).add(new THREE.Vector3(0, 0.15 + rnd() * 0.15, 0));
    const path = [start, start.clone().lerp(mid, 0.5), mid, mid.clone().lerp(end, 0.5), end];
    barkParts.push(limb(path, (t) => (birch ? 0.05 : 0.075) * (1 - t * 0.7), 5));
    tips.push(end.clone());
    for (let k = 0; k < (birch ? 2 : 3); k++) {
      const s = path[2 + Math.min(2, k)]!.clone();
      const az2 = az + (rnd() - 0.5) * 2.2;
      const d2 = new THREE.Vector3(Math.cos(az2), 0.5 + rnd() * 0.5, Math.sin(az2)).normalize();
      const e2 = s.clone().addScaledVector(d2, 0.7 + rnd() * 0.6);
      barkParts.push(limb([s, s.clone().lerp(e2, 0.5).add(new THREE.Vector3(0, 0.06, 0)), e2], (t) => 0.026 * (1 - t * 0.6), 4));
      tips.push(e2);
    }
  }
  tips.push(at(1).clone().add(new THREE.Vector3(0, 0.5, 0)));

  // leaf clusters: cards around every tip, plus a fill shell so the crown has no holes
  const cardSize = birch ? 1.15 : 1.5;
  const cluster = (c: THREE.Vector3, n: number, spread: number) => {
    for (let k = 0; k < n; k++) {
      const p = c.clone().add(new THREE.Vector3((rnd() - 0.5) * spread, (rnd() - 0.4) * spread * 0.8, (rnd() - 0.5) * spread));
      cardParts.push(card(p, cardSize * (0.8 + rnd() * 0.5), (rnd() - 0.5) * 1.4, rnd() * Math.PI, (rnd() - 0.5) * 1.4));
    }
  };
  for (const t of tips) cluster(t, birch ? 6 : 7, birch ? 1.0 : 1.2);
  const fill = birch ? 60 : 95;
  for (let k = 0; k < fill; k++) {
    const th = rnd() * Math.PI * 2;
    const ph = Math.acos(rnd() * 1.7 - 0.7);
    const d = 0.35 + Math.sqrt(rnd()) * 0.55;
    const p = new THREE.Vector3(Math.sin(ph) * Math.cos(th) * R * d, crownC.y + Math.cos(ph) * ry * d, Math.sin(ph) * Math.sin(th) * R * d);
    cardParts.push(card(p, cardSize * (0.9 + rnd() * 0.5), (rnd() - 0.5) * 1.2, rnd() * Math.PI, (rnd() - 0.5) * 1.2));
  }

  const bark = mergeGeometries(barkParts.map((g) => g.toNonIndexed()))!;
  for (const g of barkParts) g.dispose();
  containCrown(bark);
  const barkC = new THREE.Color(BARK_TINT[kind]);
  const barkOut = finish(bark, (p, _n, c) => c.copy(barkC).multiplyScalar(0.75 + 0.25 * smooth(0, 1.5, p.y)), swayOf(swayTop, 2));

  const cards = mergeGeometries(cardParts.map((g) => g.toNonIndexed()))!;
  for (const g of cardParts) g.dispose();
  containCrown(cards);
  crownNormals(cards, crownC, 0.75, R / ry);
  const leaf = leafBase.map((h) => new THREE.Color(h));
  const out = new THREE.Vector3();
  const cardsOut = finish(
    cards,
    (p, n, c) => {
      out.copy(p).sub(crownC);
      out.y *= R / ry;
      const depth = Math.min(1, out.length() / R);
      const up = n.y * 0.5 + 0.5;
      // the card texture carries the green; vertex colour adds a little hue spread and crown AO
      const pick = leaf[Math.abs(Math.floor((p.x * 3.1 + p.z * 1.7) * 10)) % leaf.length]!;
      c.setRGB(1, 1, 1).lerp(pick, 0.3).multiplyScalar((0.5 + 0.7 * depth) * (0.8 + 0.3 * up) * 1.25);
    },
    swayOf(swayTop),
  );

  return { bark: barkOut, cards: cardsOut, lod: lodBroadleaf(kind, crownC, ry, rnd) };
}

/** Cheap broadleaf: six-sided trunk + four displaced leaf masses (one on top, three around), one opaque vertex-coloured mesh. */
function lodBroadleaf(kind: 'oak' | 'birch', crownC: THREE.Vector3, ry: number, rnd: () => number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const trunk = new THREE.CylinderGeometry(0.07, 0.17, crownC.y + ry * 0.3, 6, 1, true);
  trunk.translate(0, (crownC.y + ry * 0.3) / 2, 0);
  const barkC = new THREE.Color(BARK_TINT[kind]).multiplyScalar(kind === 'birch' ? 0.6 : 0.3);
  parts.push(finish(trunk, (_p, _n, c) => c.copy(barkC), swayOf(0.24, 2)));
  const leaf = new THREE.Color(LEAF[kind][1]);
  const R = ARCH_CROWN;
  const blobs: [number, number, number, number][] = [[0, 0.2, 0, 0.66]];
  for (let k = 0; k < 3; k++) {
    const a = k * 2.09 + rnd() * 0.4;
    blobs.push([Math.cos(a) * R * 0.4, -0.3 - rnd() * 0.25, Math.sin(a) * R * 0.4, 0.54]);
  }
  for (const [bx, by, bz, br] of blobs) {
    const g = new THREE.IcosahedronGeometry(R * br, 1);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const k = 1 + Math.sin(pos.getX(i) * 3.1 + pos.getY(i) * 1.7 + bx) * 0.08;
      pos.setXYZ(i, pos.getX(i) * k, pos.getY(i) * k * (ry / R) * 0.95, pos.getZ(i) * k);
    }
    g.translate(bx, crownC.y + by * ry, bz);
    g.computeVertexNormals();
    containCrown(g);
    crownNormals(g, crownC, 0.6);
    const o = new THREE.Vector3();
    parts.push(
      finish(
        g,
        (p, n, c) => {
          o.copy(p).sub(crownC);
          const depth = Math.min(1, o.length() / R);
          c.copy(leaf).multiplyScalar((0.5 + 0.6 * depth) * (0.75 + 0.35 * (n.y * 0.5 + 0.5)));
        },
        swayOf(0.24),
      ),
    );
  }
  const g = mergeGeometries(parts)!;
  for (const p of parts) p.dispose();
  return g;
}

/** Conifer: straight trunk, whorls of drooping branches carrying needle sprays (cards), narrowing upwards. */
function growConifer(seed: number): Archetype {
  const rnd = mulberry32(seed);
  const H = ARCH_HEIGHT;
  const R = ARCH_CROWN;
  const swayTop = 0.2;
  const start = H * 0.22;
  const radiusAt = (y: number) => R * 0.97 * Math.pow(Math.max(0, 1 - (y - start) / (H - start)), 0.85);
  const barkParts: THREE.BufferGeometry[] = [];
  const cardParts: THREE.BufferGeometry[] = [];
  const trunkPath: THREE.Vector3[] = [];
  for (let i = 0; i <= 8; i++) trunkPath.push(new THREE.Vector3(Math.sin(i + seed) * 0.02, (i / 8) * H * 0.97, Math.cos(i * 1.3 + seed) * 0.02));
  barkParts.push(limb(trunkPath, (t) => 0.17 * (1 - t * 0.85) * (1 + Math.pow(1 - t, 10) * 0.6) + 0.012, 8));
  const whorls = 11;
  for (let w = 0; w < whorls; w++) {
    const t = w / (whorls - 1);
    const y = start + t * (H - start) * 0.9;
    const reach = radiusAt(y);
    const n = 6 - Math.floor(t * 2);
    for (let b = 0; b < n; b++) {
      const az = (b / n) * Math.PI * 2 + w * 0.7 + rnd() * 0.3;
      const droop = THREE.MathUtils.degToRad(12 + rnd() * 14);
      const dir = new THREE.Vector3(Math.cos(az) * Math.cos(droop), -Math.sin(droop), Math.sin(az) * Math.cos(droop));
      const s = new THREE.Vector3(0, y, 0);
      const e = s.clone().addScaledVector(dir, reach * 0.92);
      e.y += reach * 0.12;
      barkParts.push(limb([s, s.clone().lerp(e, 0.5).add(new THREE.Vector3(0, 0.08, 0)), e], (u) => 0.03 * (1 - u * 0.7), 4));
      // needle sprays along the branch, lying roughly flat and drooping at the tips
      const sprays = Math.max(3, Math.round(reach / 0.32));
      for (let k = 0; k < sprays; k++) {
        const u = (k + 0.6) / sprays;
        const p = s.clone().lerp(e, u);
        p.y += 0.05;
        const sz = (0.95 + 0.4 * (1 - u)) * Math.min(1.5, 0.55 + reach * 0.5);
        // the spray card's twig runs up its v axis: lay it along the branch, needles fanning sideways
        cardParts.push(card(p, sz, -Math.PI / 2 + (rnd() - 0.5) * 0.5 + u * 0.3, -az + Math.PI / 2 + (rnd() - 0.5) * 0.5, (rnd() - 0.5) * 0.4));
        cardParts.push(card(p, sz * 0.85, -Math.PI / 2 + 0.5 + (rnd() - 0.5) * 0.4, -az + Math.PI / 2 + (rnd() - 0.5) * 0.7, Math.PI / 2 + (rnd() - 0.5) * 0.4));
      }
    }
  }
  // leader spray at the top
  cardParts.push(card(new THREE.Vector3(0, H * 0.94, 0), 0.7, 0, 0, 0), card(new THREE.Vector3(0, H * 0.94, 0), 0.7, 0, Math.PI / 2, 0));

  const bark = mergeGeometries(barkParts.map((g) => g.toNonIndexed()))!;
  for (const g of barkParts) g.dispose();
  containCrown(bark);
  const barkC = new THREE.Color(BARK_TINT.pine);
  const barkOut = finish(bark, (p, _n, c) => c.copy(barkC).multiplyScalar(0.7 + 0.3 * smooth(0, 1.5, p.y)), swayOf(swayTop, 2));
  const cards = mergeGeometries(cardParts.map((g) => g.toNonIndexed()))!;
  for (const g of cardParts) g.dispose();
  containCrown(cards);
  // needles shade off the trunk axis and upwards
  const nor = cards.attributes.normal as THREE.BufferAttribute;
  const pos = cards.attributes.position;
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    n.set(pos.getX(i), 0.9, pos.getZ(i)).normalize().lerp(n.fromBufferAttribute(nor, i), 0.25).normalize();
    nor.setXYZ(i, n.x, n.y, n.z);
  }
  const leaf = LEAF.pine.map((h) => new THREE.Color(h));
  const cardsOut = finish(
    cards,
    (p, _n, c) => {
      const outer = Math.min(1, Math.hypot(p.x, p.z) / Math.max(0.3, radiusAt(p.y)));
      const pick = leaf[Math.abs(Math.floor((p.x * 2.3 + p.y * 1.1) * 10)) % leaf.length]!;
      c.setRGB(1, 1, 1).lerp(pick, 0.3).multiplyScalar((0.55 + 0.6 * outer) * (0.85 + 0.3 * (p.y / H)) * 1.25);
    },
    swayOf(swayTop),
  );
  return { bark: barkOut, cards: cardsOut, lod: lodConifer(radiusAt, start) };
}

/** Cheap conifer: six-sided trunk + five stacked cones with a ragged hem. */
function lodConifer(radiusAt: (y: number) => number, start: number): THREE.BufferGeometry {
  const H = ARCH_HEIGHT;
  const parts: THREE.BufferGeometry[] = [];
  const trunk = new THREE.CylinderGeometry(0.04, 0.15, H * 0.95, 6, 1, true);
  trunk.translate(0, H * 0.475, 0);
  const barkC = new THREE.Color(BARK_TINT.pine).multiplyScalar(0.3);
  parts.push(finish(trunk, (_p, _n, c) => c.copy(barkC), swayOf(0.2, 2)));
  const leaf = new THREE.Color(LEAF.pine[1]);
  const tiers = 5;
  for (let k = 0; k < tiers; k++) {
    const t = k / tiers;
    const y0 = start + t * (H - start) * 0.92;
    const th = (H - start) * 0.32;
    const g = new THREE.ConeGeometry(radiusAt(y0), th, 9, 1, true);
    g.translate(0, y0 + th / 2 - th * 0.15, 0);
    g.computeVertexNormals();
    containCrown(g);
    parts.push(finish(g, (p, n, c) => c.copy(leaf).multiplyScalar((0.55 + 0.45 * smooth(y0, y0 + th, p.y)) * (0.8 + 0.25 * (n.y * 0.5 + 0.5))), swayOf(0.2)));
  }
  const g = mergeGeometries(parts)!;
  for (const p of parts) p.dispose();
  return g;
}

let cache: Map<TreeKind, Archetype> | null = null;

/** The archetypes (grown once per page, shared by every level view; do not dispose). */
export function treeArchetypes(): ReadonlyMap<TreeKind, Archetype> {
  if (!cache) {
    cache = new Map<TreeKind, Archetype>([
      ['oak', growBroadleaf('oak', 41)],
      ['birch', growBroadleaf('birch', 77)],
      ['pine', growConifer(13)],
    ]);
  }
  return cache;
}

/** Instance placement for a tree prop: kind by its id hash, scale to its canopy, ground height given. */
export function treeInstance(p: PropDef, groundY: number): TreeInstance {
  const rnd = mulberry32(hashId(p.id));
  const roll = rnd();
  const kind: TreeKind = roll < 0.4 ? 'pine' : roll < 0.75 ? 'oak' : 'birch';
  const tint = new THREE.Color(1, 1, 1).multiplyScalar(0.88 + rnd() * 0.24);
  tint.g *= 0.97 + rnd() * 0.06;
  return { kind, x: p.position[0], y: groundY, z: p.position[2], yaw: p.yaw ?? 0, height: p.size[1], crown: p.size[0] / 2, tint };
}

export interface ForestMaterials {
  bark: THREE.Material;
  /** broadleaf leaf-cluster cards (library `foliage`) */
  cards: THREE.Material;
  /** conifer needle sprays (library `needles`) */
  needles: THREE.Material;
  lod: THREE.Material;
}

/** Instanced meshes for a level's trees: per archetype a detailed pair (bark + cards) and a cheap mesh. */
export class Forest {
  readonly detailed: THREE.InstancedMesh[] = [];
  readonly cheap: THREE.InstancedMesh[] = [];

  constructor(trees: readonly TreeInstance[], mats: ForestMaterials, parent: THREE.Object3D) {
    const arch = treeArchetypes();
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    for (const kind of KINDS) {
      const list = trees.filter((t) => t.kind === kind);
      if (list.length === 0) continue;
      const a = arch.get(kind)!;
      const make = (geo: THREE.BufferGeometry, mat: THREE.Material, name: string): THREE.InstancedMesh => {
        const mesh = new THREE.InstancedMesh(geo, mat, list.length);
        mesh.name = `tree:${kind}:${name}`;
        list.forEach((t, i) => {
          q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, t.yaw);
          // x / z to the canopy radius, y to the height: the archetype's crown cylinder maps onto the collider
          mesh.setMatrixAt(i, m.compose(pos.set(t.x, t.y, t.z), q, scl.set(t.crown / ARCH_CROWN, t.height / ARCH_HEIGHT, t.crown / ARCH_CROWN)));
          mesh.setColorAt(i, t.tint);
        });
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.computeBoundingSphere();
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        parent.add(mesh);
        return mesh;
      };
      this.detailed.push(make(a.bark, mats.bark, 'bark'), make(a.cards, kind === 'pine' ? mats.needles : mats.cards, 'cards'));
      this.cheap.push(make(a.lod, mats.lod, 'lod'));
    }
  }

  /** ultra / high: branches and leaf cards; medium / low (and VR): the cheap opaque masses. */
  setDetailed(on: boolean): void {
    for (const m of this.detailed) m.visible = on;
    for (const m of this.cheap) m.visible = !on;
  }

  dispose(): void {
    // archetype geometry is shared (treeArchetypes); instance buffers go with the meshes
    for (const m of [...this.detailed, ...this.cheap]) {
      m.removeFromParent();
      m.dispose();
    }
  }
}
