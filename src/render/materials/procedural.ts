/**
 * Procedural PBR texture sets, generated as plain pixel arrays (no canvas, no GPU): albedo (sRGB, alpha
 * for foliage), a tangent-space normal map (OpenGL / +Y) derived from a height field, and an ARM map
 * (R ambient occlusion, G roughness, B metalness) — the same layout as the CC0 sets, so a material can
 * swap one for the other. Deterministic for a given size; every set tiles except the foliage card (one
 * leaf cluster per card). Brick, slab, concrete, wood and gravel come from the field-based generators.ts.
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
  | 'grass'
  | 'asphalt'
  | 'foliage'
  | 'plaster'
  | 'bark'
  | 'rock'
  | 'needles';

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

const rock: Sampler = (u, v, t) => {
  // weathered granite: big cracked blocks, mineral speckle, lichen-free grey-buff
  const blocks = tileCells(u, v, 6, 181);
  const crack = 1 - smooth(0.0, 0.06, Math.abs(blocks.d - 0.5) * 0.5 + 0.02 * tileNoise(u * 40, v * 40, 40, 191));
  const big = tileFbm(u, v, 4, 5, 193);
  const speck = tileNoise(u * 256, v * 256, 256, 197);
  const g = 0.42 + 0.14 * (big - 0.5) + 0.08 * (blocks.id - 0.5) + 0.06 * (speck - 0.5) - 0.16 * crack;
  t.r = g * 1.02;
  t.g = g * 0.98;
  t.b = g * 0.93;
  t.h = 0.7 * big + 0.1 * speck - 0.5 * crack;
  t.ao = 1 - 0.45 * crack;
  t.rough = 0.78 + 0.12 * (1 - big) * 0.5;
};

/**
 * Leaf-cluster card: ~50 broad leaves fanning out from the centre, alpha-cut, nothing crossing the card
 * edge (cards are single sprites, not a tiling surface), lighter tips, darker towards the twig.
 */
function foliageSampler(): Sampler {
  const leaves: { x: number; y: number; c: number; s: number; len: number; w: number; tone: number }[] = [];
  for (let i = 0; i < 56; i++) {
    const r = Math.sqrt(hash2(i, 1, 606)) * 0.33;
    const th = hash2(i, 2, 606) * Math.PI * 2;
    const a = th + (hash2(i, 3, 606) - 0.5) * 0.8;
    leaves.push({ x: 0.5 + Math.cos(th) * r, y: 0.5 + Math.sin(th) * r, c: Math.cos(a), s: Math.sin(a), len: 0.075 + hash2(i, 4, 606) * 0.05, w: 0.028 + hash2(i, 5, 606) * 0.018, tone: hash2(i, 6, 606) });
  }
  return (u, v, t) => {
    t.a = 0;
    t.r = 0.2;
    t.g = 0.3;
    t.b = 0.12;
    t.rough = 0.6;
    let best = -1;
    for (const l of leaves) {
      const dx = u - l.x;
      const dy = v - l.y;
      const along = (dx * l.c + dy * l.s) / l.len;
      const across = (-dx * l.s + dy * l.c) / l.w;
      const d = along * along + across * across;
      if (d >= 1 || l.tone <= best) continue;
      best = l.tone;
      const vein = Math.abs(across) < 0.08 ? 0.1 : 0;
      const lum = (0.78 + l.tone * 0.32) * (0.8 + 0.2 * (1 - Math.abs(across))) - vein;
      t.r = 0.3 * lum;
      t.g = 0.46 * lum;
      t.b = 0.15 * lum;
      t.a = 1;
      t.h = (1 - d) * 0.6 + l.tone * 0.3 - vein;
      t.ao = 0.65 + 0.35 * l.tone;
      t.rough = 0.55;
    }
  };
}

/** Conifer spray card: a twig up the middle with paired needles angled forward, alpha-cut, nothing at the edges. */
function needleSampler(): Sampler {
  const needles: { x0: number; y0: number; dx: number; dy: number; len: number; tone: number }[] = [];
  for (let i = 0; i < 120; i++) {
    const s = 0.06 + (i / 120) * 0.84;
    const side = i % 2 === 0 ? 1 : -1;
    const a = (55 + hash2(i, 1, 909) * 20) * (Math.PI / 180);
    const len = (0.26 + hash2(i, 2, 909) * 0.1) * (1 - s * 0.4);
    needles.push({ x0: 0.5, y0: s, dx: Math.sin(a) * side, dy: Math.cos(a), len, tone: hash2(i, 3, 909) });
  }
  return (u, v, t) => {
    t.a = 0;
    t.r = 0.12;
    t.g = 0.22;
    t.b = 0.14;
    t.rough = 0.7;
    const twig = Math.abs(u - 0.5) < 0.008 && v > 0.04 && v < 0.94;
    if (twig) {
      t.r = 0.22;
      t.g = 0.16;
      t.b = 0.1;
      t.a = 1;
      t.h = 0.5;
      return;
    }
    for (const n of needles) {
      const px = u - n.x0;
      const py = v - n.y0;
      const along = px * n.dx + py * n.dy;
      if (along < 0 || along > n.len) continue;
      const across = Math.abs(-px * n.dy + py * n.dx);
      const w = 0.011 * (1 - (along / n.len) * 0.6);
      if (across > w) continue;
      const lum = 0.75 + n.tone * 0.35 + (along / n.len) * 0.15;
      t.r = 0.17 * lum;
      t.g = 0.34 * lum;
      t.b = 0.2 * lum;
      t.a = 1;
      t.h = 0.6 - across * 20;
      t.ao = 0.7 + 0.3 * (along / n.len);
      t.rough = 0.6;
      return;
    }
  };
}

const SAMPLERS: Record<ProceduralKind, () => { sample: Sampler; bump: number }> = {
  carbonFibre: () => ({ sample: carbonFibre, bump: 0.5 }),
  brushedMetal: () => ({ sample: brushedMetal, bump: 0.08 }),
  paintedMetal: () => ({ sample: paintedMetal, bump: 0.08 }),
  rubber: () => ({ sample: rubber, bump: 0.35 }),
  grass: () => ({ sample: grass, bump: 0.8 }),
  asphalt: () => ({ sample: asphalt, bump: 0.7 }),
  foliage: () => ({ sample: foliageSampler(), bump: 0.6 }),
  plaster: () => ({ sample: plaster, bump: 0.3 }),
  bark: () => ({ sample: bark, bump: 1.4 }),
  rock: () => ({ sample: rock, bump: 1.0 }),
  needles: () => ({ sample: needleSampler(), bump: 0.4 }),
};

export const PROCEDURAL_KINDS = Object.keys(SAMPLERS) as ProceduralKind[];

/** Generates the albedo / normal / ARM maps of `kind` at `size`² texels. */
export function generatePbr(kind: ProceduralKind, size: number): PbrPixels {
  const { sample, bump } = SAMPLERS[kind]();
  return bake(size, sample, bump);
}
