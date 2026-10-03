/**
 * Procedural PBR texture sets, generated as plain pixel arrays (no canvas, no GPU): albedo (sRGB, alpha
 * for foliage), a tangent-space normal map (OpenGL / +Y) derived from a height field, and an ARM map
 * (R ambient occlusion, G roughness, B metalness) — the same layout as the CC0 sets, so a material can
 * swap one for the other. Every generator tiles seamlessly and is deterministic for a given size.
 */
import { clamp01, hash2, mix, smooth, tileCells, tileFbm, tileNoise } from './noise';

export interface PixelMap {
  width: number;
  height: number;
  /** RGBA8, row 0 = v 0 */
  data: Uint8Array;
}

export interface PbrPixels {
  albedo: PixelMap;
  normal: PixelMap;
  arm: PixelMap;
}

/** One texel: albedo in sRGB 0..1, height 0..1, AO / roughness / metalness 0..1. */
interface Texel {
  r: number;
  g: number;
  b: number;
  a: number;
  h: number;
  ao: number;
  rough: number;
  metal: number;
}

type Sampler = (u: number, v: number, t: Texel) => void;

export type ProceduralKind =
  | 'carbonFibre'
  | 'brushedMetal'
  | 'paintedMetal'
  | 'rubber'
  | 'concrete'
  | 'brick'
  | 'wood'
  | 'grass'
  | 'asphalt'
  | 'foliage'
  | 'plaster'
  | 'bark';

const to8 = (x: number): number => Math.round(clamp01(x) * 255);

/** Bakes a sampler into the three maps; `bump` scales the height gradient into the normal map. */
export function bake(size: number, sample: Sampler, bump: number): PbrPixels {
  const n = size * size;
  const albedo = new Uint8Array(n * 4);
  const arm = new Uint8Array(n * 4);
  const height = new Float32Array(n);
  const t: Texel = { r: 0, g: 0, b: 0, a: 1, h: 0, ao: 1, rough: 1, metal: 0 };
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      t.r = t.g = t.b = 0;
      t.a = 1;
      t.h = 0;
      t.ao = 1;
      t.rough = 1;
      t.metal = 0;
      sample(u, v, t);
      const i = y * size + x;
      const o = i * 4;
      albedo[o] = to8(t.r);
      albedo[o + 1] = to8(t.g);
      albedo[o + 2] = to8(t.b);
      albedo[o + 3] = to8(t.a);
      arm[o] = to8(t.ao);
      arm[o + 1] = to8(t.rough);
      arm[o + 2] = to8(t.metal);
      arm[o + 3] = 255;
      height[i] = t.h;
    }
  }
  return {
    albedo: { width: size, height: size, data: albedo },
    normal: { width: size, height: size, data: heightToNormal(height, size, bump) },
    arm: { width: size, height: size, data: arm },
  };
}

/** Central-difference normals from a wrapping height field (strength in texels of height per unit). */
export function heightToNormal(h: Float32Array, size: number, strength: number): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const k = strength * size * 0.5;
  for (let y = 0; y < size; y++) {
    const yu = ((y + 1) % size) * size;
    const yd = ((y - 1 + size) % size) * size;
    for (let x = 0; x < size; x++) {
      const xr = (x + 1) % size;
      const xl = (x - 1 + size) % size;
      const dx = (h[y * size + xr]! - h[y * size + xl]!) * k;
      const dy = (h[yu + x]! - h[yd + x]!) * k;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const o = (y * size + x) * 4;
      out[o] = to8(-dx * inv * 0.5 + 0.5);
      out[o + 1] = to8(-dy * inv * 0.5 + 0.5);
      out[o + 2] = to8(inv * 0.5 + 0.5);
      out[o + 3] = 255;
    }
  }
  return out;
}

const carbonFibre: Sampler = (u, v, t) => {
  // 2×2 twill: 12 tows per tile, each over-two-under-two, shifted one per row
  const N = 12;
  const x = u * N;
  const y = v * N;
  const i = Math.floor(x);
  const j = Math.floor(y);
  const horizontal = ((i + j) & 3) < 2;
  const across = horizontal ? y - j : x - i;
  const along = horizontal ? x : y;
  const crown = Math.sin(Math.PI * across);
  const fibres = 0.5 + 0.5 * Math.sin((across * 34 + tileNoise(along * 6, across * 3, N * 6, 31) * 1.5) * Math.PI);
  const lum = 0.035 + 0.05 * crown * crown + 0.02 * fibres * (horizontal ? 1 : 0.6);
  t.r = lum;
  t.g = lum * 1.02;
  t.b = lum * 1.08;
  t.h = 0.6 * crown + 0.08 * fibres;
  t.ao = 0.75 + 0.25 * crown;
  t.rough = 0.38 + 0.12 * (1 - crown) - 0.06 * fibres;
};

const brushedMetal: Sampler = (u, v, t) => {
  // streaks run along u: fine noise stretched 1:64
  const streak = tileNoise(u * 4, v * 256, 256, 41) * 0.6 + tileNoise(u * 16, v * 512, 512, 43) * 0.4;
  const blot = tileFbm(u, v, 4, 3, 47);
  const g = 0.62 + 0.08 * (streak - 0.5) + 0.05 * (blot - 0.5);
  t.r = g;
  t.g = g;
  t.b = g * 1.01;
  t.h = streak * 0.25;
  t.rough = 0.3 + 0.16 * streak + 0.06 * blot;
  t.metal = 1;
};

const paintedMetal: Sampler = (u, v, t) => {
  const wear = tileFbm(u, v, 6, 5, 53);
  const chip = smooth(0.73, 0.76, wear);
  const orange = tileNoise(u * 96, v * 96, 96, 57);
  const paint = 0.82 + 0.06 * (tileFbm(u, v, 3, 3, 59) - 0.5);
  t.r = mix(paint, 0.55, chip);
  t.g = mix(paint, 0.56, chip);
  t.b = mix(paint, 0.58, chip);
  t.h = (1 - chip) * 0.4 + orange * 0.04;
  t.ao = 1 - 0.25 * smooth(0.68, 0.74, wear) * (1 - chip);
  t.rough = mix(0.42 + 0.08 * orange, 0.32, chip);
  t.metal = chip;
};

const rubber: Sampler = (u, v, t) => {
  const grain = tileNoise(u * 192, v * 192, 192, 61);
  const blot = tileFbm(u, v, 4, 3, 67);
  const g = 0.075 + 0.02 * (blot - 0.5);
  t.r = g;
  t.g = g;
  t.b = g * 1.05;
  t.h = grain * 0.5 + blot * 0.3;
  t.rough = 0.78 + 0.12 * grain;
};

const concrete: Sampler = (u, v, t) => {
  const big = tileFbm(u, v, 3, 4, 71);
  const fine = tileFbm(u, v, 48, 3, 73);
  const cell = tileCells(u, v, 40, 79);
  const pore = 1 - smooth(0.0, 0.09, cell.d - 0.05 * cell.id);
  const g = 0.56 + 0.16 * (big - 0.5) + 0.08 * (fine - 0.5) - 0.18 * pore;
  t.r = g * 1.0;
  t.g = g * 0.985;
  t.b = g * 0.96;
  t.h = 0.5 * fine + 0.2 * big - 0.6 * pore;
  t.ao = 1 - 0.4 * pore;
  t.rough = 0.82 + 0.12 * (fine - 0.5) - 0.12 * (big - 0.5);
};

const brick: Sampler = (u, v, t) => {
  // running bond: 8 courses × 4 bricks per tile (bricks 2:1 when the tile is mapped 1:1)
  const rows = 8;
  const cols = 4;
  const ry = v * rows;
  const row = Math.floor(ry);
  const rx = u * cols + (row & 1) * 0.5;
  const col = Math.floor(rx);
  const fx = rx - col;
  const fy = ry - row;
  const mortar = 0.07;
  const ex = Math.min(fx, 1 - fx) * 2; // aspect: bricks are twice as wide as tall
  const ey = Math.min(fy, 1 - fy);
  const edge = Math.min(ex, ey);
  const inBrick = smooth(mortar * 0.6, mortar, edge + 0.02 * (tileNoise(u * 64, v * 64, 64, 83) - 0.5));
  const id = hash2(((col % cols) + cols) % cols, row, 89);
  const surface = tileFbm(u, v, 24, 3, 97);
  const burn = tileFbm(u, v, 5, 3, 101);
  const br = 0.5 + 0.12 * (id - 0.5) + 0.08 * (surface - 0.5) - 0.1 * smooth(0.6, 0.9, burn);
  const mortarG = 0.62 + 0.06 * (surface - 0.5);
  t.r = mix(mortarG, br * 1.0, inBrick);
  t.g = mix(mortarG * 0.97, br * 0.48, inBrick);
  t.b = mix(mortarG * 0.92, br * 0.36, inBrick);
  t.h = inBrick * (0.7 + 0.15 * surface) + (1 - inBrick) * 0.1 * surface;
  t.ao = mix(0.62, 1, inBrick);
  t.rough = mix(0.95, 0.82 + 0.1 * (surface - 0.5), inBrick);
};

const wood: Sampler = (u, v, t) => {
  // flat-sawn grain along u: rings warped by low-frequency noise
  const warp = tileFbm(u, v, 3, 3, 103);
  const rings = (v * 14 + warp * 3.2) % 1;
  const ring = smooth(0.0, 0.18, rings) * (1 - smooth(0.55, 1.0, rings));
  const fibre = tileNoise(u * 8, v * 220, 220, 107);
  const tone = 0.42 + 0.14 * ring + 0.05 * (fibre - 0.5) + 0.06 * (warp - 0.5);
  t.r = tone * 1.0;
  t.g = tone * 0.7;
  t.b = tone * 0.45;
  t.h = 0.3 * ring + 0.25 * fibre;
  t.rough = 0.55 + 0.1 * (1 - ring) + 0.05 * fibre;
};

const grass: Sampler = (u, v, t) => {
  const blades = tileNoise(u * 160, v * 40, 160, 109) * 0.6 + tileNoise(u * 320, v * 80, 320, 113) * 0.4;
  const patch = tileFbm(u, v, 4, 4, 127);
  const dry = smooth(0.62, 0.8, tileFbm(u, v, 6, 3, 131));
  const lum = 0.32 + 0.16 * blades + 0.08 * (patch - 0.5);
  t.r = mix(lum * 0.55, lum * 0.95, dry);
  t.g = mix(lum * 1.0, lum * 0.88, dry);
  t.b = mix(lum * 0.28, lum * 0.42, dry);
  t.h = blades;
  t.ao = 0.7 + 0.3 * blades;
  t.rough = 0.9 + 0.08 * (1 - blades);
};

const asphalt: Sampler = (u, v, t) => {
  const stones = tileCells(u, v, 90, 137);
  const stone = 1 - smooth(0.25, 0.45, stones.d);
  const tar = tileFbm(u, v, 6, 4, 139);
  const g = 0.16 + 0.05 * (tar - 0.5) + stone * (0.06 + 0.12 * stones.id);
  t.r = g;
  t.g = g;
  t.b = g * 1.02;
  t.h = stone * 0.6 + tar * 0.2;
  t.ao = 0.8 + 0.2 * stone;
  t.rough = 0.92 - 0.2 * stone * stones.id;
};

const plaster: Sampler = (u, v, t) => {
  const trowel = tileFbm(u, v, 5, 4, 157);
  const fine = tileNoise(u * 128, v * 128, 128, 163);
  const g = 0.82 + 0.06 * (trowel - 0.5) + 0.02 * (fine - 0.5);
  t.r = g;
  t.g = g * 0.98;
  t.b = g * 0.95;
  t.h = 0.6 * trowel + 0.15 * fine;
  t.rough = 0.88 - 0.08 * smooth(0.55, 0.75, trowel);
};

const bark: Sampler = (u, v, t) => {
  // vertical ridges (along v) split by deep fissures
  const warp = tileFbm(u, v, 4, 3, 167);
  const ridge = Math.abs(Math.sin((u * 9 + warp * 0.8) * Math.PI));
  const plates = tileNoise(u * 18, v * 5, 18, 173);
  const fissure = 1 - smooth(0.0, 0.25, ridge);
  const g = 0.3 + 0.1 * plates - 0.18 * fissure;
  t.r = g * 1.0;
  t.g = g * 0.78;
  t.b = g * 0.6;
  t.h = 1 - fissure + 0.2 * plates;
  t.ao = 1 - 0.5 * fissure;
  t.rough = 0.92;
};

/** Leaf cards: 26 leaves per tile, alpha-cut, darker towards the stem. */
function foliageSampler(): Sampler {
  const leaves: { x: number; y: number; c: number; s: number; len: number; tone: number }[] = [];
  for (let i = 0; i < 26; i++) {
    const a = hash2(i, 1, 151) * Math.PI * 2;
    leaves.push({ x: hash2(i, 2, 151), y: hash2(i, 3, 151), c: Math.cos(a), s: Math.sin(a), len: 0.2 + 0.12 * hash2(i, 4, 151), tone: hash2(i, 5, 151) });
  }
  return (u, v, t) => {
    t.a = 0;
    t.rough = 0.6;
    for (const l of leaves) {
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const dx = u - l.x + ox;
          const dy = v - l.y + oy;
          if (dx * dx + dy * dy > l.len * l.len) continue;
          const along = (dx * l.c + dy * l.s) / l.len;
          const across = (-dx * l.s + dy * l.c) / (l.len * 0.42);
          if (along < 0 || along > 1) continue;
          const width = Math.sin(Math.PI * Math.pow(along, 0.8));
          const r = Math.abs(across) / Math.max(1e-3, width);
          if (r > 1) continue;
          const vein = 1 - smooth(0.0, 0.08, Math.abs(across));
          const lum = 0.3 + 0.12 * l.tone + 0.08 * along;
          t.r = lum * 0.42 + vein * 0.05;
          t.g = lum * 0.95 + vein * 0.06;
          t.b = lum * 0.3;
          t.a = 1;
          t.h = (1 - r * r) * 0.6 - vein * 0.15;
          t.ao = 0.7 + 0.3 * along;
          t.rough = 0.55;
        }
      }
    }
  };
}

const SAMPLERS: Record<ProceduralKind, () => { sample: Sampler; bump: number }> = {
  carbonFibre: () => ({ sample: carbonFibre, bump: 0.5 }),
  brushedMetal: () => ({ sample: brushedMetal, bump: 0.08 }),
  paintedMetal: () => ({ sample: paintedMetal, bump: 0.08 }),
  rubber: () => ({ sample: rubber, bump: 0.35 }),
  concrete: () => ({ sample: concrete, bump: 0.6 }),
  brick: () => ({ sample: brick, bump: 1.2 }),
  wood: () => ({ sample: wood, bump: 0.2 }),
  grass: () => ({ sample: grass, bump: 0.8 }),
  asphalt: () => ({ sample: asphalt, bump: 0.7 }),
  foliage: () => ({ sample: foliageSampler(), bump: 0.6 }),
  plaster: () => ({ sample: plaster, bump: 0.3 }),
  bark: () => ({ sample: bark, bump: 1.4 }),
};

export const PROCEDURAL_KINDS = Object.keys(SAMPLERS) as ProceduralKind[];

/** Generates the albedo / normal / ARM maps of `kind` at `size`² texels. */
export function generatePbr(kind: ProceduralKind, size: number): PbrPixels {
  const { sample, bump } = SAMPLERS[kind]();
  return bake(size, sample, bump);
}
