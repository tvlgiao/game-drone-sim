/**
 * Low-poly models for instanced scenery, in metres at scale 1 and matching the collider sizes of the world
 * engine (TREE_DIMENSIONS, ROCK_HALF, house and bridge boxes). Non-indexed, with sRGB vertex colours (converted
 * to linear in the instanced shader). Unit models (houses, bridges) are stretched per instance.
 */
import * as THREE from 'three';
import { ROCK_HALF, TREE_DIMENSIONS } from '../../world/scatter';

type Geo = THREE.BufferGeometry;

/** Deterministic pseudo-noise of a position (vertex jitter: shared vertices move together). */
function jitter(x: number, y: number, z: number): number {
  const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  return s - Math.floor(s) - 0.5;
}

function colorize(g: Geo, fn: (x: number, y: number, z: number, nx: number, ny: number, nz: number) => number): Geo {
  const p = g.getAttribute('position');
  const n = g.getAttribute('normal');
  const c = new Float32Array(p.count * 3);
  const col = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    col.setHex(fn(p.getX(i), p.getY(i), p.getZ(i), n.getX(i), n.getY(i), n.getZ(i)), THREE.LinearSRGBColorSpace);
    c[i * 3] = col.r;
    c[i * 3 + 1] = col.g;
    c[i * 3 + 2] = col.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

function shadeHex(hex: number, k: number): number {
  const r = Math.min(255, Math.max(0, Math.round(((hex >> 16) & 255) * k)));
  const g = Math.min(255, Math.max(0, Math.round(((hex >> 8) & 255) * k)));
  const b = Math.min(255, Math.max(0, Math.round((hex & 255) * k)));
  return (r << 16) | (g << 8) | b;
}

/** Concatenates non-indexed copies (position, normal, color) of `parts`. */
export function mergeParts(parts: Geo[]): Geo {
  const flat = parts.map((p) => (p.index ? p.toNonIndexed() : p));
  let n = 0;
  for (const p of flat) n += p.getAttribute('position').count;
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  let o = 0;
  for (const p of flat) {
    const c = p.getAttribute('position').count;
    pos.set(p.getAttribute('position').array as Float32Array, o * 3);
    nor.set(p.getAttribute('normal').array as Float32Array, o * 3);
    col.set(p.getAttribute('color').array as Float32Array, o * 3);
    o += c;
  }
  for (const p of parts) p.dispose();
  for (const p of flat) p.dispose();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

function displace(g: Geo, amount: number): Geo {
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const l = Math.sqrt(x * x + y * y + z * z) || 1;
    const k = 1 + amount * jitter(Math.round(x * 100), Math.round(y * 100), Math.round(z * 100));
    p.setXYZ(i, (x / l) * l * k, (y / l) * l * k, (z / l) * l * k);
  }
  g.computeVertexNormals();
  return g;
}

const TRUNK = 0x5a4130;
const CONIFER = 0x2d4c2c;
const BROADLEAF = 0x46702f;
const SCRUB = 0x6d7a3a;

function trunk(height: number, r: number, sides: number): Geo {
  const g = new THREE.CylinderGeometry(r * 0.6, r, height, sides, 1, true);
  g.translate(0, height / 2, 0);
  return colorize(g, (_x, y) => shadeHex(TRUNK, 0.75 + 0.35 * (y / height)));
}

/** Conifer LOD0: trunk + three stacked jittered cones (≈ 70 triangles). */
export function coniferLod0(): Geo {
  const d = TREE_DIMENSIONS[0]!;
  const H = d.height;
  const R = d.crownRadius;
  const parts: Geo[] = [trunk(H * 0.34, d.trunkRadius, 5)];
  const tiers: [number, number, number][] = [
    [d.crownBase, 0.62, 1],
    [0.42, 0.82, 0.74],
    [0.62, 1, 0.48],
  ];
  for (const [y0, y1, rk] of tiers) {
    const h = (y1 - y0) * H;
    const g = new THREE.ConeGeometry(R * rk, h, 8, 1, false);
    g.translate(0, y0 * H + h / 2, 0);
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const z = p.getZ(i);
      if (Math.abs(x) + Math.abs(z) < 1e-3) continue;
      const k = 1 + 0.28 * jitter(Math.round(x * 10), Math.round(p.getY(i) * 10), Math.round(z * 10));
      p.setXYZ(i, x * k, p.getY(i) - 0.25 * Math.abs(jitter(Math.round(z * 10), 3, Math.round(x * 10))), z * k);
    }
    g.computeVertexNormals();
    parts.push(
      colorize(g, (_x, y, _z, _nx, ny) => {
        // darker under each tier, lighter tips towards the top of the tree
        const t = (y - y0 * H) / h;
        return shadeHex(CONIFER, (ny < -0.5 ? 0.55 : 0.78 + 0.32 * t) * (0.9 + 0.2 * (y / H)));
      }),
    );
  }
  return mergeParts(parts);
}

/** Conifer LOD1: a 4-sided pyramid down to the ground (4 triangles), trunk-coloured at the foot. */
export function coniferLod1(): Geo {
  const d = TREE_DIMENSIONS[0]!;
  const H = d.height;
  const g = new THREE.ConeGeometry(d.crownRadius * 0.92, H, 4, 1, true);
  g.translate(0, H / 2, 0);
  g.rotateY(Math.PI / 4);
  return mergeParts([colorize(g, (_x, y) => (y < 0.5 ? TRUNK : shadeHex(CONIFER, 0.7 + 0.35 * (y / H))))]);
}

/** Broadleaf LOD0: trunk + a lumpy icosphere crown (≈ 90 triangles). */
export function broadleafLod0(): Geo {
  const d = TREE_DIMENSIONS[1]!;
  const H = d.height;
  const R = d.crownRadius;
  const crownH = H * (1 - d.crownBase);
  const crown = displace(new THREE.IcosahedronGeometry(1, 1), 0.32);
  crown.scale(R, crownH / 2, R);
  crown.translate(0, H - crownH / 2, 0);
  const top = H;
  const crownC = colorize(crown, (_x, y, _z, nx, ny, nz) => {
    const facing = 0.5 + 0.5 * (nx * 0.4 + ny * 0.8 + nz * 0.2);
    return shadeHex(BROADLEAF, (0.62 + 0.42 * ((y - (H - crownH)) / crownH)) * (0.82 + 0.3 * facing) * (y > top ? 1 : 1));
  });
  return mergeParts([trunk(H * d.crownBase + 1.2, d.trunkRadius, 5), crownC]);
}

/** Broadleaf LOD1: a squat octahedron crown on a 3-sided trunk (14 triangles), the silhouette of LOD0. */
export function broadleafLod1(): Geo {
  const d = TREE_DIMENSIONS[1]!;
  const H = d.height;
  const crownH = H * (1 - d.crownBase);
  const crown = new THREE.OctahedronGeometry(1, 0);
  crown.rotateY(Math.PI / 4);
  crown.scale(d.crownRadius * 1.05, crownH / 2, d.crownRadius * 1.05);
  crown.translate(0, H - crownH / 2, 0);
  const crownC = colorize(crown, (_x, y, _z, _nx, ny) => shadeHex(BROADLEAF, (0.6 + 0.4 * ((y - (H - crownH)) / crownH)) * (ny < 0 ? 0.75 : 1)));
  return mergeParts([trunk(H * d.crownBase + 1, d.trunkRadius * 1.3, 3), crownC]);
}

/** Scrub: a low lumpy bush (LOD0 20 triangles, LOD1 8). */
export function scrubModel(lod: 0 | 1): Geo {
  const d = TREE_DIMENSIONS[2]!;
  const g = lod === 0 ? displace(new THREE.IcosahedronGeometry(1, 0), 0.35) : new THREE.OctahedronGeometry(1, 0);
  g.scale(d.crownRadius, d.height / 2, d.crownRadius);
  g.translate(0, d.height / 2 - 0.2, 0);
  return mergeParts([colorize(g, (_x, y) => shadeHex(SCRUB, 0.7 + 0.3 * (y / d.height)))]);
}

/** Rock: a jittered icosahedron sized like its collider box, sunk 40 % into the ground. */
export function rockModel(): Geo {
  const g = displace(new THREE.IcosahedronGeometry(1, 0), 0.45);
  g.scale(ROCK_HALF[0], ROCK_HALF[1], ROCK_HALF[2]);
  g.translate(0, ROCK_HALF[1] * 0.6, 0);
  return mergeParts([colorize(g, (_x, _y, _z, _nx, ny) => shadeHex(0x84807a, 0.8 + 0.25 * ny))]);
}

/** Vertex colour slots of house models: walls take the instance colour, the rest is per archetype. */
export const HOUSE_WALL = 0xffffff;

function box(w: number, h: number, d: number, x: number, y: number, z: number, hex: number): Geo {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return colorize(g, () => hex);
}

/** A gable roof prism over the unit footprint, ridge along Z, from y = 1 to y = 2 (stretched to the roof height). */
function gable(hex: number, overhang = 0.06): Geo {
  const o = overhang;
  const x0 = -0.5 - o;
  const x1 = 0.5 + o;
  const z0 = -0.5 - o;
  const z1 = 0.5 + o;
  // slopes (two quads) + gable ends (two triangles)
  const v = [
    [x0, 1, z1], [x0, 1, z0], [0, 2, z0], [x0, 1, z1], [0, 2, z0], [0, 2, z1],
    [x1, 1, z0], [x1, 1, z1], [0, 2, z1], [x1, 1, z0], [0, 2, z1], [0, 2, z0],
    [x0, 1, z1], [0, 2, z1], [x1, 1, z1],
    [x1, 1, z0], [0, 2, z0], [x0, 1, z0],
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v.flat(), 3));
  g.computeVertexNormals();
  return colorize(g, (_x, _y, _z, _nx, ny) => (ny > 0.1 ? hex : HOUSE_WALL));
}

/**
 * House archetypes (HOUSE_ARCHETYPES order: cottage, farmhouse, barn, tower) on a unit footprint: walls
 * y 0..1 (× wall height), roof y 1..2 (× roof height). A door and trim are part of the walls' colours.
 */
export function houseModel(archetype: number): Geo {
  const roof = [0x8e3b2c, 0x6b4a3a, 0x5c615f, 0x4f5358][archetype] ?? 0x8e3b2c;
  const parts: Geo[] = [box(1, 1, 1, 0, 0.5, 0, HOUSE_WALL), gable(roof)];
  // door on +Z, a darker plinth
  parts.push(box(archetype === 2 ? 0.42 : 0.16, archetype === 2 ? 0.7 : 0.55, 0.02, 0, archetype === 2 ? 0.35 : 0.275, 0.505, archetype === 2 ? 0x5a3a2a : 0x3f2a20));
  parts.push(box(1.01, 0.08, 1.01, 0, 0.04, 0, 0x6a655c));
  if (archetype === 0 || archetype === 1) parts.push(box(0.1, 0.5, 0.1, 0.28, 1.55, -0.2, 0x7a6658));
  return mergeParts(parts);
}

/** Bridge on a unit plan: x −0.5..0.5 (× width), z −0.5..0.5 (× length), y in metres (deck top at 0). */
export function bridgeModel(): Geo {
  const parts: Geo[] = [box(1, 0.6, 1, 0, -0.3, 0, 0x8a8478)];
  for (const s of [-1, 1]) {
    parts.push(box(0.03, 0.12, 1, s * 0.485, 0.95, 0, 0x5a5a5e));
    for (let k = -4; k <= 4; k++) parts.push(box(0.025, 0.95, 0.012, s * 0.485, 0.475, k * 0.12, 0x5a5a5e));
    parts.push(box(0.12, 6, 0.05, s * 0.3, -3.3, 0.22, 0x7c776d));
    parts.push(box(0.12, 6, 0.05, s * 0.3, -3.3, -0.22, 0x7c776d));
  }
  return mergeParts(parts);
}

/** Generic unit box with a flat colour (city roof props, cars). */
export function unitBox(hex: number): Geo {
  return mergeParts([box(1, 1, 1, 0, 0.5, 0, hex)]);
}

/** Unit cylinder (radius 0.5, height 1, base at 0) with a flat colour (water tanks). */
export function unitCylinder(hex: number, sides = 10): Geo {
  const g = new THREE.CylinderGeometry(0.5, 0.5, 1, sides, 1, false);
  g.translate(0, 0.5, 0);
  return mergeParts([colorize(g, (_x, _y, _z, _nx, ny) => shadeHex(hex, ny > 0.5 ? 1.05 : 0.9))]);
}
