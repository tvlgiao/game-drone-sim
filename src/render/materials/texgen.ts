/**
 * DOM-free field-based texture toolkit (whole-image passes; `noise.ts` is the per-texel one and owns the
 * shared scalar helpers): tileable noise fields, height → tangent-space normal maps, packed AO / roughness /
 * metalness maps, written straight into DataTextures (no canvas, so the generators run in unit tests).
 * Row 0 of every field is v = 0 (DataTexture does not flip).
 */
import * as THREE from 'three';
import { fbmField, mulberry32 } from '../textures';
import { clamp01, mix, smooth } from './noise';

export { clamp01, fbmField, mix, mulberry32, smooth };

/** A square-or-not scalar field, row-major, row 0 = v 0. */
export interface Field {
  w: number;
  h: number;
  d: Float32Array<ArrayBufferLike>;
}

export function field(w: number, h = w): Field {
  return { w, h, d: new Float32Array(w * h) };
}

/** Tileable fbm value noise resampled to w×h (fbmField is square). */
export function fbm(w: number, h: number, basePeriod: number, octaves: number, seed: number, gain = 0.5): Field {
  const s = Math.max(w, h);
  const src = fbmField(s, basePeriod, octaves, seed, gain);
  const f = field(w, h);
  for (let y = 0; y < h; y++) {
    const sy = Math.floor((y / h) * s) * s;
    for (let x = 0; x < w; x++) f.d[y * w + x] = src[sy + Math.floor((x / w) * s)]!;
  }
  return f;
}

/**
 * Tileable Worley F1 noise (distance to the nearest jittered cell point, in cell units, ~0..1)
 * plus the id of that cell's point (0..1) for per-cell variation.
 */
export function worley(size: number, cells: number, seed: number): { dist: Field; id: Field } {
  const rnd = mulberry32(seed);
  const px = new Float32Array(cells * cells);
  const py = new Float32Array(cells * cells);
  const pid = new Float32Array(cells * cells);
  for (let i = 0; i < cells * cells; i++) {
    px[i] = rnd();
    py[i] = rnd();
    pid[i] = rnd();
  }
  const dist = field(size);
  const id = field(size);
  const k = cells / size;
  for (let y = 0; y < size; y++) {
    const fy = y * k;
    const cy = Math.floor(fy);
    for (let x = 0; x < size; x++) {
      const fx = x * k;
      const cx = Math.floor(fx);
      let best = 9;
      let bid = 0;
      for (let oy = -1; oy <= 1; oy++) {
        const gy = cy + oy;
        const wy = ((gy % cells) + cells) % cells;
        for (let ox = -1; ox <= 1; ox++) {
          const gx = cx + ox;
          const wx = ((gx % cells) + cells) % cells;
          const j = wy * cells + wx;
          const dx = gx + px[j]! - fx;
          const dy = gy + py[j]! - fy;
          const dd = dx * dx + dy * dy;
          if (dd < best) {
            best = dd;
            bid = pid[j]!;
          }
        }
      }
      dist.d[y * size + x] = Math.sqrt(best);
      id.d[y * size + x] = bid;
    }
  }
  return { dist, id };
}

/** Wrapped 3×3 box blur, `passes` times (cheap soft falloff for AO / edge masks). */
export function blur(f: Field, passes = 1): Field {
  const { w, h } = f;
  let src: Float32Array = f.d;
  let dst: Float32Array = new Float32Array(w * h);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      const y0 = ((y - 1 + h) % h) * w;
      const y1 = y * w;
      const y2 = ((y + 1) % h) * w;
      for (let x = 0; x < w; x++) {
        const x0 = (x - 1 + w) % w;
        const x2 = (x + 1) % w;
        dst[y1 + x] = (src[y0 + x0]! + src[y0 + x]! + src[y0 + x2]! + src[y1 + x0]! + src[y1 + x]! + src[y1 + x2]! + src[y2 + x0]! + src[y2 + x]! + src[y2 + x2]!) / 9;
      }
    }
    [src, dst] = [dst, src];
  }
  return { w, h, d: src };
}

/**
 * Tangent-space normal map (OpenGL convention, +Y = +v) from a height field in [0,1].
 * `strength` = height range in texels: larger is bumpier.
 */
export function normalFromHeight(hf: Field, strength: number): Uint8Array {
  const { w, h, d } = hf;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const ym = ((y - 1 + h) % h) * w;
    const yp = ((y + 1) % h) * w;
    const yc = y * w;
    for (let x = 0; x < w; x++) {
      const xm = (x - 1 + w) % w;
      const xp = (x + 1) % w;
      const dx = (d[yc + xp]! - d[yc + xm]!) * 0.5 * strength;
      const dy = (d[yp + x]! - d[ym + x]!) * 0.5 * strength;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const i = (yc + x) * 4;
      out[i] = Math.round((-dx * inv * 0.5 + 0.5) * 255);
      out[i + 1] = Math.round((-dy * inv * 0.5 + 0.5) * 255);
      out[i + 2] = Math.round((inv * 0.5 + 0.5) * 255);
      out[i + 3] = 255;
    }
  }
  return out;
}

/** RGBA8 from per-pixel callback returning 0..1 channels (sRGB-encoded values for colour maps). */
export function rgba(w: number, h: number, fn: (i: number, x: number, y: number, out: number[]) => void): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  const c = [0, 0, 0, 1];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      c[3] = 1;
      fn(i, x, y, c);
      const o = i * 4;
      out[o] = clamp255(c[0]!);
      out[o + 1] = clamp255(c[1]!);
      out[o + 2] = clamp255(c[2]!);
      out[o + 3] = clamp255(c[3]!);
    }
  }
  return out;
}

function clamp255(v: number): number {
  return v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
}


export interface TexOptions {
  srgb?: boolean;
  repeat?: boolean;
  anisotropy?: number;
}

/** Mipmapped DataTexture with linear filtering (DataTexture defaults to nearest, no mips). */
export function dataTexture(data: Uint8Array, w: number, h: number, opts: TexOptions = {}): THREE.DataTexture {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = opts.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (opts.repeat !== false) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = opts.anisotropy ?? 4;
  t.needsUpdate = true;
  return t;
}

/** Largest power of two ≤ min(want, cap) (and ≥ 16). */
export function texSize(want: number, cap: number): number {
  let s = 16;
  while (s * 2 <= Math.min(want, cap)) s *= 2;
  return s;
}
