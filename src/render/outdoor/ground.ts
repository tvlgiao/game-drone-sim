/**
 * Countryside ground: a flat meadow under the course that rolls into gentle farmland past the treeline
 * (visual only: physics keeps the flat y = 0 plane, and nothing rises within FLAT_RADIUS), patchwork
 * fields in the distance, the mowed flying field with view-dependent stripes, an asphalt landing pad
 * and a gravel apron under the pilot. Textures are procedural DataTextures (DOM-free) except the pad art.
 */
import * as THREE from 'three';
import { blur, clamp01, dataTexture, fbm, field, mix, mulberry32, normalFromHeight, rgba, smooth, worley } from '../env-materials/texgen';

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

/** Near-white tileable grass detail (multiplied over vertex colours) with a matching normal map. */
export function grassDetail(size: number, anisotropy: number): { map: THREE.DataTexture; normalMap: THREE.DataTexture } {
  const base = fbm(size, size, 8, 4, 31, 0.55);
  const clover = worley(size, Math.round(size / 18), 32);
  const h = field(size);
  const tint = new Float32Array(size * size);
  const rnd = mulberry32(77);
  // blade strokes: short leaning lines, lighter tips, darker roots (wrapped)
  for (let i = 0; i < size * size * 0.09; i++) {
    const x0 = rnd() * size;
    const y0 = rnd() * size;
    const len = 3 + rnd() * 6;
    const lean = (rnd() - 0.5) * 1.2;
    const light = rnd();
    for (let k = 0; k < len; k++) {
      const x = Math.floor(x0 + lean * k + size) % size;
      const y = Math.floor(y0 + k) % size;
      const j = y * size + x;
      const t = k / len;
      h.d[j] = Math.max(h.d[j]!, 0.4 + t * 0.6);
      tint[j] = mix(-0.12, 0.12 * light, t);
    }
  }
  const hb = blur(h, 1);
  const map = rgba(size, size, (i, _x, _y, c) => {
    const cl = clover.dist.d[i]! < 0.32 && clover.id.d[i]! > 0.82 ? 0.06 : 0;
    const v = 0.8 + base.d[i]! * 0.26 + tint[i]! * 0.5;
    c[0] = Math.min(1, v * (0.93 - cl));
    c[1] = Math.min(1, v * (1 + cl * 0.5));
    c[2] = Math.min(1, v * (0.86 - cl));
  });
  return { map: dataTexture(map, size, size, { srgb: true, anisotropy }), normalMap: dataTexture(normalFromHeight(hb, size / 96), size, size, { anisotropy }) };
}

/** Rolled gravel: packed stones (Worley cells) in greys and buff, with a normal map. */
export function gravelSet(size: number, anisotropy: number): { map: THREE.DataTexture; normalMap: THREE.DataTexture } {
  const stones = worley(size, Math.round(size / 7), 91);
  const fine = fbm(size, size, 32, 3, 92, 0.6);
  const h = field(size);
  for (let i = 0; i < size * size; i++) h.d[i] = (1 - smooth(0.15, 0.62, stones.dist.d[i]!)) * 0.8 + fine.d[i]! * 0.2;
  const map = rgba(size, size, (i, _x, _y, c) => {
    const id = stones.id.d[i]!;
    const edge = smooth(0.45, 0.7, stones.dist.d[i]!);
    const v = (0.5 + id * 0.35) * (1 - edge * 0.55) * (0.9 + fine.d[i]! * 0.2);
    const warm = id > 0.6 ? 1.06 : 0.98;
    c[0] = v * warm;
    c[1] = v * 0.97;
    c[2] = v * (id > 0.6 ? 0.86 : 0.95);
  });
  return { map: dataTexture(map, size, size, { srgb: true, anisotropy }), normalMap: dataTexture(normalFromHeight(h, size / 64), size, size, { anisotropy }) };
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
 * Asphalt landing pad: aggregate-speckled blacktop, worn white border, orange target ring and a teal H,
 * a little tyre / skid rubber. 1 texel ≈ 1 cm at 512.
 */
export function padTexture(size = 512): THREE.CanvasTexture {
  const [c, ctx] = canvas(size);
  const n = fbm(128, 128, 16, 3, 9, 0.6);
  const img = ctx.createImageData(size, size);
  const rnd = mulberry32(5);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const v = 52 + n.d[((y >> 2) & 127) * 128 + ((x >> 2) & 127)]! * 22 + (rnd() < 0.08 ? (rnd() - 0.3) * 60 : 0);
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v * 1.03;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
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
  // wear: asphalt grain shows through the paint
  for (let i = 0; i < 9000 * s * s; i++) {
    const v = 40 + rnd() * 30;
    ctx.fillStyle = `rgba(${v},${v},${v},${0.35 + rnd() * 0.4})`;
    ctx.fillRect(rnd() * size, rnd() * size, 1.5 * s, 1.5 * s);
  }
  // skid rubber across the centre
  ctx.strokeStyle = 'rgba(15,15,16,0.18)';
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

/**
 * Mowing stripes read by the light: grass laid towards the viewer looks lighter, away darker. The stripe
 * parity comes from world x; the sheen from the horizontal view direction (guarded normalisation).
 */
export function patchStripes(mat: THREE.MeshStandardMaterial, half: number, stripes: number, strength = 0.16): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uStripeHalf = { value: half };
    shader.uniforms.uStripeW = { value: (half * 2) / stripes };
    shader.uniforms.uStripeK = { value: strength };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vStripeWorld;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvStripeWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vStripeWorld;\nuniform float uStripeHalf;\nuniform float uStripeW;\nuniform float uStripeK;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  vec2 toEye = cameraPosition.xz - vStripeWorld.xz;
  float len = length( toEye );
  float facing = len > 1e-3 ? toEye.y / len : 0.0;
  float parity = mod( floor( ( vStripeWorld.x + uStripeHalf ) / uStripeW ), 2.0 ) * 2.0 - 1.0;
  float inside = step( abs( vStripeWorld.x ), uStripeHalf ) * step( abs( vStripeWorld.z ), uStripeHalf );
  diffuseColor.rgb *= 1.0 + uStripeK * parity * facing * inside;
}`,
      );
  };
  mat.customProgramCacheKey = () => 'mow-stripes';
}

