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

/** Lumpy crown blob: a displaced icosphere scaled to (rx, ry, rz) at (x, y, z). */
function blob(rx: number, ry: number, rz: number, x: number, y: number, z: number, hex: number, y0: number, h: number, amount = 0.3, detail = 1): Geo {
  const g = displace(new THREE.IcosahedronGeometry(1, detail), amount);
  g.scale(rx, ry, rz);
  g.translate(x, y, z);
  return colorize(g, (_x, yy, _z, nx, ny, nz) => {
    const facing = 0.5 + 0.5 * (nx * 0.4 + ny * 0.8 + nz * 0.2);
    return shadeHex(hex, (0.58 + 0.46 * ((yy - y0) / h)) * (0.8 + 0.32 * facing));
  });
}

/** Broadleaf LOD0: trunk with a fork and a crown of three overlapping lumps (≈ 260 triangles). */
export function broadleafLod0(): Geo {
  const d = TREE_DIMENSIONS[1]!;
  const H = d.height;
  const R = d.crownRadius;
  const y0 = H * d.crownBase;
  const crownH = H - y0;
  return mergeParts([
    trunk(y0 + 1.6, d.trunkRadius, 5),
    blob(R * 0.85, crownH * 0.38, R * 0.8, -R * 0.25, y0 + crownH * 0.4, 0.15 * R, BROADLEAF, y0, crownH),
    blob(R * 0.75, crownH * 0.36, R * 0.78, R * 0.3, y0 + crownH * 0.5, -0.2 * R, BROADLEAF, y0, crownH, 0.34, 0),
    blob(R * 0.62, crownH * 0.32, R * 0.6, 0, y0 + crownH * 0.72, 0, BROADLEAF, y0, crownH, 0.28, 0),
  ]);
}

const BIRCH = 0x7f9a46;

/** Birch LOD0: a slender white trunk under a narrow, airy crown of two lumps (≈ 110 triangles). */
export function birchLod0(): Geo {
  const d = TREE_DIMENSIONS[3]!;
  const H = d.height;
  const R = d.crownRadius;
  const y0 = H * d.crownBase;
  const crownH = H - y0;
  const bark = new THREE.CylinderGeometry(d.trunkRadius * 0.55, d.trunkRadius, y0 + crownH * 0.6, 5, 1, true);
  bark.translate(0, (y0 + crownH * 0.6) / 2, 0);
  return mergeParts([
    colorize(bark, (_x, y) => (Math.floor(y * 2.3) % 3 === 0 ? 0x3a3632 : 0xd8d4c8)),
    blob(R * 0.9, crownH * 0.3, R * 0.85, 0.2, y0 + crownH * 0.35, 0, BIRCH, y0, crownH, 0.4),
    blob(R * 0.7, crownH * 0.28, R * 0.7, -0.15, y0 + crownH * 0.68, 0.1, BIRCH, y0, crownH, 0.4, 0),
  ]);
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

/** Billboard atlas columns, in TREE_SPECIES order (conifer, broadleaf, scrub, birch). */
export const BILLBOARD_SPECIES = 4;
const ATLAS_W = 64;
const ATLAS_H = 128;

/**
 * Far-tree impostors: one RGBA atlas, a column per species (64 × 128 px), drawn procedurally: lit crown
 * silhouettes with noisy edges and a trunk. Alpha-tested; DataTexture, so it also builds in Node.
 */
export function treeBillboardAtlas(): THREE.DataTexture {
  const W = ATLAS_W * BILLBOARD_SPECIES;
  const data = new Uint8Array(W * ATLAS_H * 4);
  const crown: [number, number, number][] = [
    [0x2d, 0x4c, 0x2c],
    [0x46, 0x70, 0x2f],
    [0x6d, 0x7a, 0x3a],
    [0x7f, 0x9a, 0x46],
  ];
  const trunkC: [number, number, number][] = [
    [0x5a, 0x41, 0x30],
    [0x5a, 0x41, 0x30],
    [0x5a, 0x41, 0x30],
    [0xd8, 0xd4, 0xc8],
  ];
  for (let sp = 0; sp < BILLBOARD_SPECIES; sp++) {
    for (let py = 0; py < ATLAS_H; py++) {
      // v = 0 at the ground (texture rows bottom-up)
      const v = py / (ATLAS_H - 1);
      for (let px = 0; px < ATLAS_W; px++) {
        const u = px / (ATLAS_W - 1) - 0.5;
        const n = jitter(px * 3 + sp * 101, py * 3, 7) * 0.16;
        let inside = false;
        let shade = 1;
        if (sp === 0) {
          // conifer: a cone with three tier bulges from 0.18 up
          const t = (v - 0.18) / 0.82;
          const tier = 1 - 0.25 * ((t * 3) % 1);
          inside = t >= 0 && t <= 1 && Math.abs(u) < 0.46 * (1 - t) * tier + n * 0.5;
          shade = 0.65 + 0.45 * t;
        } else if (sp === 2) {
          const dy = (v - 0.45) / 0.45;
          inside = u * u / 0.22 + dy * dy < 1 + n;
          shade = 0.7 + 0.35 * v;
        } else {
          const cy = sp === 3 ? 0.66 : 0.62;
          const ry = sp === 3 ? 0.32 : 0.36;
          const rx = sp === 3 ? 0.36 : 0.47;
          const dy = (v - cy) / ry;
          const dx = u / rx;
          inside = dx * dx + dy * dy < 1 + n * 2.2;
          shade = 0.6 + 0.5 * ((v - (cy - ry)) / (2 * ry));
        }
        const trunkHere = !inside && sp !== 2 && Math.abs(u) < (sp === 3 ? 0.035 : 0.05) && v < (sp === 0 ? 0.3 : 0.5);
        const i = (py * W + sp * ATLAS_W + px) * 4;
        if (inside) {
          const c = crown[sp]!;
          const k = Math.min(1.25, Math.max(0.45, shade * (1 + n)));
          data[i] = Math.min(255, c[0] * k);
          data[i + 1] = Math.min(255, c[1] * k);
          data[i + 2] = Math.min(255, c[2] * k);
          data[i + 3] = 255;
        } else if (trunkHere) {
          const c = trunkC[sp]!;
          data[i] = c[0];
          data[i + 1] = c[1];
          data[i + 2] = c[2];
          data[i + 3] = 255;
        }
      }
    }
  }
  const t = new THREE.DataTexture(data, W, ATLAS_H, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

/**
 * Unit impostor: two crossed quads 1 m wide and 1 m tall (stretched per instance to the tree's crown width and
 * height), uv over one atlas column (the shader offsets it by species), normals straight up so both quads
 * light alike. 4 triangles.
 */
export function billboardModel(): Geo {
  const pos: number[] = [];
  const uv: number[] = [];
  const quad = (ax: number, az: number): void => {
    const v = [
      [-ax, 0, -az, 0, 0],
      [ax, 0, az, 1, 0],
      [ax, 1, az, 1, 1],
      [-ax, 0, -az, 0, 0],
      [ax, 1, az, 1, 1],
      [-ax, 1, -az, 0, 1],
    ];
    for (const [x, y, z, u, w] of v) {
      pos.push(x!, y!, z!);
      uv.push(u!, w!);
    }
  };
  quad(0.5, 0);
  quad(0, 0.5);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  const n = new Float32Array(pos.length);
  for (let i = 0; i < n.length; i += 3) n[i + 1] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(pos.length).fill(1), 3));
  return g;
}

/** Marker colour of a street light's lamp (the shader lights it at dusk). */
export const LAMP_HEX = 0xfff4d0;

/** Street light, 8 m pole with an arm reaching 2.2 m over the street along local +Z (20 triangles). */
export function streetLightModel(): Geo {
  const pole = new THREE.CylinderGeometry(0.07, 0.11, 8, 4, 1, true);
  pole.translate(0, 4, 0);
  const arm = box(0.08, 0.08, 2.3, 0, 7.9, 1.1, 0x4e5256);
  const lamp = box(0.3, 0.1, 0.6, 0, 7.82, 2.1, LAMP_HEX);
  // the arm's and lamp's bottom faces only: a light seen from below / the side
  return mergeParts([colorize(pole, () => 0x4e5256), arm, lamp]);
}

/** Parked car: body (instance colour, white here) and a glass cabin (24 triangles). */
export function carModel(): Geo {
  return mergeParts([box(1.86, 0.75, 4.3, 0, 0.45, 0, 0xffffff), box(1.6, 0.5, 2.2, 0, 1.07, -0.2, 0x1d2329)]);
}
