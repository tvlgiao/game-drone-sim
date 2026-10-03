/**
 * Countryside ground geometry: a flat meadow under the course that rolls into gentle farmland past the
 * treeline (visual only: physics keeps the flat y = 0 plane, and nothing rises within FLAT_RADIUS),
 * patchwork fields in the distance, the mowed flying field, and the landing-pad markings. Surfaces come
 * from the material library (grass, gravel, asphalt); the palette rides on vertex colours.
 */
import * as THREE from 'three';
import { clamp01, mulberry32, smooth } from '../materials/texgen';

/** metres per grass detail tile */
export const GRASS_TILE = 2.5;
/** no terrain relief inside this radius: the course, the treeline and their colliders sit on y = 0 */
export const FLAT_RADIUS = 100;
const RELIEF_FULL = 330;
const STRIPE_A = 0x6fa446;
const STRIPE_B = 0x5d943d;

/** Seeded 2D value noise (smooth), in [0,1]. */
function valueNoise(seed: number): (x: number, z: number) => number {
  const hash = (ix: number, iz: number): number => {
    let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(seed, 2246822519)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  return (x, z) => {
    const ix = Math.floor(x);
    const iz = Math.floor(z);
    const fx = x - ix;
    const fz = z - iz;
    const sx = fx * fx * (3 - 2 * fx);
    const sz = fz * fz * (3 - 2 * fz);
    const a = hash(ix, iz);
    const b = hash(ix + 1, iz);
    const c = hash(ix, iz + 1);
    const d = hash(ix + 1, iz + 1);
    return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
  };
}

const n1 = valueNoise(11);
const n2 = valueNoise(23);
const n3 = valueNoise(37);

/** Visual terrain height (m): 0 inside FLAT_RADIUS, gentle rolling farmland beyond, rising towards the horizon. */
export function terrainHeight(x: number, z: number): number {
  const r = Math.hypot(x, z);
  if (r <= FLAT_RADIUS) return 0;
  const k = smooth(FLAT_RADIUS, RELIEF_FULL, r);
  const rolling = (n1(x / 160, z / 160) - 0.35) * 18 + (n2(x / 60, z / 60) - 0.5) * 5;
  const rise = smooth(450, 800, r) * 25;
  return Math.max(-1.5, k * rolling + rise);
}

/** Farm parcels: Voronoi-ish cells far from the course, each a crop colour. */
const PARCELS = [0x8a9d4a, 0xb9a65a, 0x6f8f3f, 0x7a6a48, 0xa7b25c, 0x5f8a3c] as const;
function parcelColor(x: number, z: number, out: THREE.Color): number {
  const cell = 70;
  const gx = Math.floor(x / cell);
  const gz = Math.floor(z / cell);
  let best = 1e9;
  let id = 0;
  for (let oz = -1; oz <= 1; oz++) for (let ox = -1; ox <= 1; ox++) {
    const cx = (gx + ox + n3(gx + ox, gz + oz) * 0.9) * cell;
    const cz = (gz + oz + n3(gz + oz + 17, gx + ox) * 0.9) * cell;
    const d = (x - cx) * (x - cx) + (z - cz) * (z - cz);
    if (d < best) {
      best = d;
      id = Math.floor(n3(gx + ox + 31, gz + oz + 7) * PARCELS.length);
    }
  }
  out.set(PARCELS[Math.min(PARCELS.length - 1, id)]!);
  return id;
}

const MEADOW = [0x58863a, 0x66903f, 0x7a9446, 0x527a37, 0x87a04e] as const;

/**
 * Ground mesh: a polar grid (rings dense near the course, sparse at the horizon) so relief and colour
 * patches have detail where they are seen, with world-metre UVs for the grass detail.
 */
export function meadowGeometry(radius: number, rings = 72, sectors = 120): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const pal = MEADOW.map((h) => new THREE.Color(h));
  const c = new THREE.Color();
  const p = new THREE.Color();
  // ring radii: fine steps near the field, geometric growth outwards
  const radii: number[] = [0];
  let r = 8;
  while (radii.length < rings && r < radius) {
    radii.push(r);
    r = r < 120 ? r + 8 : r * 1.06;
  }
  radii.push(radius);
  for (let i = 0; i < radii.length; i++) {
    const rr = radii[i]!;
    const n = i === 0 ? 1 : sectors;
    for (let s = 0; s < n; s++) {
      const a = (s / sectors) * Math.PI * 2;
      const x = Math.sin(a) * rr;
      const z = Math.cos(a) * rr;
      const y = terrainHeight(x, z);
      pos.push(x, y, z);
      uv.push(x / GRASS_TILE, z / GRASS_TILE);
      const v = n1(x / 40, z / 40) * 0.6 + n2(x / 13, z / 13) * 0.4;
      const k = Math.min(pal.length - 1.001, v * (pal.length - 1) * 1.15);
      c.copy(pal[Math.floor(k)]!).lerp(pal[Math.floor(k) + 1]!, k - Math.floor(k));
      // farmland beyond the treeline, hazier with distance (aerial perspective is done by fog)
      const farm = smooth(140, 260, rr);
      if (farm > 0) {
        parcelColor(x, z, p);
        c.lerp(p, farm * 0.85);
      }
      // dips stay greener, crests drier
      c.multiplyScalar(1 + clamp01(y / 12) * 0.08);
      col.push(c.r, c.g, c.b);
    }
  }
  const ringStart = (i: number) => (i === 0 ? 0 : 1 + (i - 1) * sectors);
  for (let i = 1; i < radii.length; i++) {
    for (let s = 0; s < sectors; s++) {
      const s1 = (s + 1) % sectors;
      if (i === 1) {
        idx.push(0, ringStart(1) + s, ringStart(1) + s1);
      } else {
        const a0 = ringStart(i - 1) + s;
        const a1 = ringStart(i - 1) + s1;
        const b0 = ringStart(i) + s;
        const b1 = ringStart(i) + s1;
        idx.push(a0, b0, b1, a0, b1, a1);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function canvas(w: number, h = w): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  return [c, ctx];
}

/**
 * Landing-pad markings as an RGBA overlay for the library's asphalt (`overlay` patch): worn white border,
 * orange target ring, teal H and tyre rubber; transparent where the blacktop shows. 1 texel ≈ 1 cm at 512.
 */
export function padTexture(size = 512): THREE.CanvasTexture {
  const [c, ctx] = canvas(size);
  const rnd = mulberry32(5);
  ctx.clearRect(0, 0, size, size);
  const s = size / 512;
  ctx.globalAlpha = 0.92;
  ctx.strokeStyle = '#ecebe4';
  ctx.lineWidth = 14 * s;
  ctx.strokeRect(16 * s, 16 * s, size - 32 * s, size - 32 * s);
  ctx.strokeStyle = '#ff6a1f';
  ctx.lineWidth = 22 * s;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, 170 * s, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = '#2fd0c8';
  const bar = 34 * s;
  const hh = 190 * s;
  const hw = 130 * s;
  ctx.fillRect(size / 2 - hw / 2, size / 2 - hh / 2, bar, hh);
  ctx.fillRect(size / 2 + hw / 2 - bar, size / 2 - hh / 2, bar, hh);
  ctx.fillRect(size / 2 - hw / 2, size / 2 - bar / 2, hw, bar);
  ctx.globalAlpha = 1;
  // wear: the asphalt grain shows through the paint
  ctx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 9000 * s * s; i++) {
    ctx.fillStyle = 'rgba(0,0,0,' + (0.35 + rnd() * 0.5).toFixed(3) + ')';
    ctx.fillRect(rnd() * size, rnd() * size, 1.5 * s, 1.5 * s);
  }
  ctx.globalCompositeOperation = 'source-over';
  // skid rubber across the centre
  ctx.strokeStyle = 'rgba(15,15,16,0.22)';
  ctx.lineCap = 'round';
  for (let i = 0; i < 7; i++) {
    ctx.lineWidth = (6 + rnd() * 10) * s;
    ctx.beginPath();
    const y0 = size * (0.3 + rnd() * 0.4);
    ctx.moveTo(size * 0.15, y0);
    ctx.quadraticCurveTo(size / 2, y0 + (rnd() - 0.5) * 80 * s, size * 0.85, y0 + (rnd() - 0.5) * 40 * s);
    ctx.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Mowed field: hard-edged alternating stripes along Z (one quad each) plus painted boundary lines. */
export function fieldGeometry(half: number, stripes: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const uv: number[] = [];
  const a = new THREE.Color(STRIPE_A);
  const b = new THREE.Color(STRIPE_B);
  const line = new THREE.Color(0xf4f1e8);
  const w = (half * 2) / stripes;
  const quad = (x0: number, z0: number, x1: number, z1: number, c: THREE.Color, y = 0): void => {
    const v = [
      [x0, z0],
      [x0, z1],
      [x1, z1],
      [x0, z0],
      [x1, z1],
      [x1, z0],
    ];
    for (const [x, z] of v) {
      pos.push(x!, y, z!);
      col.push(c.r, c.g, c.b);
      uv.push(x! / GRASS_TILE, z! / GRASS_TILE);
    }
  };
  for (let i = 0; i < stripes; i++) quad(-half + i * w, -half, -half + (i + 1) * w, half, i % 2 === 0 ? a : b);
  const lw = 0.12;
  const y = 0.002;
  quad(-half, -half, half, -half + lw, line, y);
  quad(-half, half - lw, half, half, line, y);
  quad(-half, -half, -half + lw, half, line, y);
  quad(half - lw, -half, half, half, line, y);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}
