/**
 * Procedural drone textures as DataTextures (no canvas, so they also build under node for tests):
 * a 2×2 twill carbon weave (albedo / tangent-space normal / roughness) and the hard-surface atlas —
 * a row of material swatches plus the battery label — with a packed clearcoat/roughness/metalness map.
 */
import * as THREE from 'three';
import { mulberry32 } from '../textures';

export const ATLAS_SIZE = 256;
/** swatch row height in texels (top of the atlas); the label fills the rest */
const SWATCH_ROWS = 32;
const SWATCH_W = 32;
const LABEL_V = (ATLAS_SIZE - SWATCH_ROWS) / ATLAS_SIZE;
/** image row where the label's edge strip starts (UV v = 0.25, see batteryUV) */
const STRIP_ROW = Math.round(ATLAS_SIZE * (1 - 0.25 * LABEL_V));

/** Surface response of one atlas swatch; the part's own tint comes from its vertex colour. */
interface SwatchDef {
  roughness: number;
  metalness: number;
  clearcoat: number;
}

export const SWATCH = {
  tpu: 0,
  gloss: 1,
  rubber: 2,
  pcb: 3,
  anodized: 4,
  steel: 5,
  enamel: 6,
  glass: 7,
} as const;
export type Swatch = (typeof SWATCH)[keyof typeof SWATCH];

const SWATCHES: readonly SwatchDef[] = [
  { roughness: 0.62, metalness: 0, clearcoat: 0.12 },
  { roughness: 0.3, metalness: 0, clearcoat: 0.7 },
  { roughness: 0.86, metalness: 0, clearcoat: 0 },
  { roughness: 0.42, metalness: 0, clearcoat: 0.6 },
  { roughness: 0.3, metalness: 1, clearcoat: 0.25 },
  { roughness: 0.2, metalness: 1, clearcoat: 0 },
  { roughness: 0.32, metalness: 1, clearcoat: 0.5 },
  { roughness: 0.03, metalness: 0, clearcoat: 1 },
];

/** UV centre of a swatch cell. */
export function swatchUV(s: Swatch): [number, number] {
  return [(s * SWATCH_W + SWATCH_W / 2) / ATLAS_SIZE, 1 - SWATCH_ROWS / 2 / ATLAS_SIZE];
}

/** Point every UV of `g` at one swatch (flat surface response for the whole part). */
export function setSwatch(g: THREE.BufferGeometry, s: Swatch): THREE.BufferGeometry {
  const [u, v] = swatchUV(s);
  const n = g.attributes.position.count;
  const uv = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    uv[i * 2] = u;
    uv[i * 2 + 1] = v;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

/** Squeeze the geometry's own 0..1 UVs into the label region of the atlas. */
export function toLabelUV(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setY(i, uv.getY(i) * LABEL_V);
  return g;
}

function dataTexture(data: Uint8Array, size: number, srgb: boolean): THREE.DataTexture {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

export interface CarbonMaps {
  map: THREE.DataTexture;
  normalMap: THREE.DataTexture;
  roughnessMap: THREE.DataTexture;
}

/**
 * 2×2 twill weave, `tows` tows per tile. Each tow is a rounded bundle with fibre striations along
 * its run; warp tows read slightly lighter and glossier than weft (the anisotropic sheen of real CF).
 */
export function carbonWeave(size = 256, tows = 8, seed = 17): CarbonMaps {
  const rnd = mulberry32(seed);
  const t = size / tows;
  const height = new Float32Array(size * size);
  const warp = new Uint8Array(size * size);
  const fibre = new Float32Array(size * 4);
  for (let i = 0; i < fibre.length; i++) fibre[i] = rnd();
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = Math.floor(x / t);
      const j = Math.floor(y / t);
      const over = (((i + j) % 4) + 4) % 4 < 2;
      const across = over ? (x % t) / t : (y % t) / t;
      const along = over ? (y % t) / t : (x % t) / t;
      const bundle = Math.sin(Math.PI * across);
      // the tow dips where it dives under the crossing tow at either end of its float
      const dip = 0.82 + 0.18 * Math.sin(Math.PI * along);
      const strand = over ? fibre[x % fibre.length] : fibre[(y + size) % fibre.length];
      height[y * size + x] = Math.pow(bundle, 0.6) * dip * (0.94 + 0.06 * strand);
      warp[y * size + x] = over ? 1 : 0;
    }
  }
  const albedo = new Uint8Array(size * size * 4);
  const normal = new Uint8Array(size * size * 4);
  const rough = new Uint8Array(size * size * 4);
  const strength = 2.2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const k = y * size + x;
      const h = height[k];
      const hx = height[y * size + ((x + 1) % size)] - height[y * size + ((x - 1 + size) % size)];
      const hy = height[((y + 1) % size) * size + x] - height[((y - 1 + size) % size) * size + x];
      let nx = -hx * strength;
      let ny = -hy * strength;
      let nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      nz /= len;
      normal[k * 4] = Math.round((nx * 0.5 + 0.5) * 255);
      normal[k * 4 + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      normal[k * 4 + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      normal[k * 4 + 3] = 255;
      const w = warp[k];
      const strand = w ? fibre[x % fibre.length] : fibre[(y + size) % fibre.length];
      const lum = (w ? 0.058 : 0.04) * (0.6 + 0.4 * h) * (0.88 + 0.24 * strand);
      const c = Math.round(Math.pow(lum, 1 / 2.2) * 255);
      albedo[k * 4] = c;
      albedo[k * 4 + 1] = c;
      albedo[k * 4 + 2] = Math.min(255, c + 3);
      albedo[k * 4 + 3] = 255;
      // resin pools between tows are glossier than the fibre tops
      const r = (w ? 0.34 : 0.48) + (1 - h) * -0.12 + strand * 0.06;
      rough[k * 4] = 0;
      rough[k * 4 + 1] = Math.round(THREE.MathUtils.clamp(r, 0.05, 1) * 255);
      rough[k * 4 + 2] = 0;
      rough[k * 4 + 3] = 255;
    }
  }
  return { map: dataTexture(albedo, size, true), normalMap: dataTexture(normal, size, false), roughnessMap: dataTexture(rough, size, false) };
}

// 5×7 bitmap glyphs for the battery label
const GLYPHS: Record<string, readonly string[]> = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

type Rgb = readonly [number, number, number];

/** Draw text into an RGBA buffer; (x, y) is the glyph box's top-left in image rows (row 0 = top). */
function drawText(buf: Uint8Array, size: number, text: string, x: number, y: number, scale: number, col: Rgb): void {
  let cx = x;
  for (const ch of text) {
    const g = GLYPHS[ch] ?? GLYPHS[' '];
    for (let gy = 0; gy < 7; gy++) {
      for (let gx = 0; gx < 5; gx++) {
        if (g[gy][gx] !== '1') continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const px = cx + gx * scale + sx;
            const row = y + gy * scale + sy;
            if (px < 0 || px >= size || row < 0 || row >= size) continue;
            const k = ((size - 1 - row) * size + px) * 4;
            buf[k] = col[0];
            buf[k + 1] = col[1];
            buf[k + 2] = col[2];
          }
        }
      }
    }
    cx += 6 * scale;
  }
}

export interface AtlasMaps {
  map: THREE.DataTexture;
  /** R clearcoat, G roughness, B metalness (three's channel conventions) */
  orm: THREE.DataTexture;
}

/** Swatch row (flat white albedo, per-swatch response) + battery label. */
export function hardSurfaceAtlas(): AtlasMaps {
  const S = ATLAS_SIZE;
  const albedo = new Uint8Array(S * S * 4);
  const orm = new Uint8Array(S * S * 4);
  const rnd = mulberry32(5);
  for (let row = 0; row < S; row++) {
    for (let x = 0; x < S; x++) {
      const k = ((S - 1 - row) * S + x) * 4;
      albedo[k + 3] = 255;
      orm[k + 3] = 255;
      if (row < SWATCH_ROWS) {
        const sw = SWATCHES[Math.min(SWATCHES.length - 1, Math.floor(x / SWATCH_W))];
        albedo[k] = albedo[k + 1] = albedo[k + 2] = 255;
        orm[k] = Math.round(sw.clearcoat * 255);
        orm[k + 1] = Math.round(sw.roughness * 255);
        orm[k + 2] = Math.round(sw.metalness * 255);
        continue;
      }
      // label: side art (rows above STRIP_ROW) and the top/bottom edge strip below it
      const ly = row - SWATCH_ROWS;
      let c: Rgb = [22, 23, 27];
      let rough = 0.3;
      if (row >= STRIP_ROW) {
        c = (x >> 4) % 2 === 0 ? [30, 31, 36] : [26, 27, 31];
        rough = 0.55;
      } else {
        const band = x * 0.62 - ly;
        if (band > 70 && band < 104) c = [255, 92, 22];
        else if (band > 108 && band < 113) c = [235, 236, 240];
        if (ly < 6 || ly > STRIP_ROW - SWATCH_ROWS - 7) c = [12, 12, 14];
      }
      const n = (rnd() - 0.5) * 6;
      albedo[k] = THREE.MathUtils.clamp(c[0] + n, 0, 255);
      albedo[k + 1] = THREE.MathUtils.clamp(c[1] + n, 0, 255);
      albedo[k + 2] = THREE.MathUtils.clamp(c[2] + n, 0, 255);
      orm[k] = 255;
      orm[k + 1] = Math.round(rough * 255);
      orm[k + 2] = 0;
    }
  }
  const white: Rgb = [240, 242, 246];
  drawText(albedo, S, '4S', 18, SWATCH_ROWS + 44, 7, white);
  drawText(albedo, S, '850MAH', 140, SWATCH_ROWS + 34, 3, white);
  drawText(albedo, S, '120C', 140, SWATCH_ROWS + 64, 4, [255, 140, 70]);
  drawText(albedo, S, 'LIPO', 140, SWATCH_ROWS + 108, 3, [160, 162, 170]);
  drawText(albedo, S, 'LIPO 4S 850MAH', 20, STRIP_ROW + 22, 2, [120, 122, 130]);
  return { map: dataTexture(albedo, S, true), orm: dataTexture(orm, S, false) };
}
