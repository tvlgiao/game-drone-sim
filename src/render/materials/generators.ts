/**
 * Field-based surface generators (texgen.ts): albedo, tangent-space normal and packed ORM (R ambient
 * occlusion, G roughness, B metalness — the CC0 ARM layout) per surface. The library uses the brick, slab,
 * concrete, wood and gravel sets as the procedural stage of its presets (`library.ts`); the rest are
 * single-purpose maps the loft art asks the library to cache (`library.custom`). Deterministic, DOM-free.
 */
import type * as THREE from 'three';
import { blur, clamp01, dataTexture, fbm, field, mix, mulberry32, normalFromHeight, rgba, smooth, worley, type Field } from './texgen';

export interface PbrSet {
  map: THREE.DataTexture;
  normalMap: THREE.DataTexture;
  /** R = AO, G = roughness, B = metalness */
  orm: THREE.DataTexture;
}

/** Brick: 16 courses × 5 stretchers per tile (one tile ≈ 1.2 m), so a stretcher is ~24 × 7.5 cm with mortar. */
export const BRICK_TILE_M = 1.2;
const BRICK_ROWS = 16;
const BRICK_COLS = 5;

interface BrickFields {
  height: Field;
  /** signed distance to the brick edge in px (negative = mortar) */
  edge: Field;
  brickRand: Float32Array;
  brickId: Int32Array;
  lo: Field;
  mid: Field;
  hi: Field;
}

function brickFields(size: number, seed: number): BrickFields {
  const rnd = mulberry32(seed);
  const bh = size / BRICK_ROWS;
  const bw = size / BRICK_COLS;
  const mortarHalf = bh * 0.07;
  const count = BRICK_ROWS * BRICK_COLS;
  // per brick: tint, roughness, proud offset, soot, chip seed
  const brickRand = new Float32Array(count * 5);
  for (let i = 0; i < brickRand.length; i++) brickRand[i] = rnd();
  const lo = fbm(size, size, 4, 5, seed + 1, 0.55);
  const mid = fbm(size, size, 16, 4, seed + 2, 0.5);
  const hi = fbm(size, size, 64, 3, seed + 3, 0.6);
  const pits = worley(size, Math.round(size / 10), seed + 4);
  const height = field(size);
  const edge = field(size);
  const brickId = new Int32Array(size * size);
  const bevel = Math.max(2, bh * 0.08);
  for (let y = 0; y < size; y++) {
    const row = Math.floor(y / bh);
    const ly = y - row * bh;
    const off = (row % 2) * (bw / 2) + (row % 4 === 1 ? bw * 0.04 : 0);
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const xx = (x + off) % size;
      const col = Math.floor(xx / bw);
      const lx = xx - col * bw;
      const id = row * BRICK_COLS + col;
      brickId[i] = id;
      const r = brickRand[id * 5 + 4]!;
      // ragged edges: noise eats into the arris, more on some bricks (chips)
      const e = Math.min(lx, bw - lx, ly, bh - ly) - mortarHalf - (hi.d[i]! - 0.5) * bh * 0.09 - Math.max(0, mid.d[i]! - 0.62 + r * 0.1) * bh * 0.5;
      edge.d[i] = e;
      const proud = (brickRand[id * 5 + 2]! - 0.5) * 0.08;
      const face = 0.62 + proud + 0.24 * smooth(0, bevel, e) + (mid.d[i]! - 0.5) * 0.06 + (hi.d[i]! - 0.5) * 0.05 - (pits.dist.d[i]! < 0.16 ? (0.16 - pits.dist.d[i]!) * 0.9 : 0);
      const mortar = 0.24 + (hi.d[i]! - 0.5) * 0.12;
      height.d[i] = mix(mortar, face, smooth(-1.2, 1.2, e));
    }
  }
  return { height, edge, brickRand, brickId, lo, mid, hi };
}

/** Reclaimed red brick (painted walls are the same courses under the library's `paint` patch). */
export function brickSet(size: number, anisotropy: number, seed = 3): PbrSet {
  const f = brickFields(size, seed);
  const normal = normalFromHeight(f.height, size / 128);
  const ao = blur({ w: size, h: size, d: Float32Array.from(f.edge.d, (e) => smooth(-6, 5, e)) }, 2);
  const redAlbedo = rgba(size, size, (i, _x, _y, c) => {
    const id = f.brickId[i]!;
    const t = f.brickRand[id * 5]!;
    const soot = f.brickRand[id * 5 + 3]!;
    const e = f.edge.d[i]!;
    let r: number;
    let g: number;
    let b: number;
    if (t < 0.1) {
      r = 0.3; g = 0.15; b = 0.11; // clinker / burnt
    } else if (t > 0.9) {
      r = 0.66; g = 0.4; b = 0.27; // pale orange
    } else {
      const k = (t - 0.1) / 0.8;
      r = mix(0.45, 0.6, k); g = mix(0.19, 0.27, k); b = mix(0.13, 0.17, k);
    }
    const v = (0.82 + f.lo.d[i]! * 0.3) * (0.9 + (f.hi.d[i]! - 0.5) * 0.35) * (soot > 0.8 ? 0.72 + f.mid.d[i]! * 0.2 : 1);
    const brick = smooth(-1, 1, e);
    const m = 0.5 + f.hi.d[i]! * 0.12;
    c[0] = mix(m * 1.02, r * v, brick);
    c[1] = mix(m * 0.98, g * v, brick);
    c[2] = mix(m * 0.9, b * v, brick);
  });
  const redOrm = rgba(size, size, (i, _x, _y, c) => {
    const id = f.brickId[i]!;
    const brick = smooth(-1, 1, f.edge.d[i]!);
    c[0] = 0.45 + 0.55 * ao.d[i]!;
    c[1] = mix(0.97, 0.78 + f.brickRand[id * 5 + 1]! * 0.14 + (f.hi.d[i]! - 0.5) * 0.1, brick);
    c[2] = 0;
  });
  const opts = { anisotropy };
  return { map: dataTexture(redAlbedo, size, size, { ...opts, srgb: true }), normalMap: dataTexture(normal, size, size, opts), orm: dataTexture(redOrm, size, size, opts) };
}

/** Polished concrete slab detail tile (4 m): aggregate flecks, mottling, pits, saw-cut joint on the tile border. */
export const FLOOR_TILE_M = 4;

export function concreteSet(size: number, anisotropy: number, opts: { seed?: number; joints?: boolean; rough?: number } = {}): PbrSet {
  const seed = opts.seed ?? 7;
  const lo = fbm(size, size, 4, 6, seed, 0.55);
  const mid = fbm(size, size, 16, 4, seed + 1, 0.5);
  const hi = fbm(size, size, 64, 3, seed + 2, 0.6);
  const agg = worley(size, Math.round(size / 6), seed + 3);
  const pits = worley(size, Math.round(size / 14), seed + 4);
  const jointW = Math.max(1.5, size / 340);
  const height = field(size);
  const joint = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const dj = opts.joints === false ? 1e9 : Math.min(x, size - x, y, size - y);
      const j = 1 - smooth(jointW * 0.5, jointW * 1.6, dj);
      joint[i] = j;
      const pit = pits.dist.d[i]! < 0.07 && pits.id.d[i]! > 0.85 ? (0.07 - pits.dist.d[i]!) * 3 : 0;
      height.d[i] = 0.55 + (hi.d[i]! - 0.5) * 0.06 + (mid.d[i]! - 0.5) * 0.05 - pit - j * 0.35;
    }
  }
  const normal = normalFromHeight(height, size / 256);
  const baseRough = opts.rough ?? 0.42;
  const map = rgba(size, size, (i, _x, _y, c) => {
    const fleck = agg.dist.d[i]! < 0.2 ? (agg.id.d[i]! > 0.5 ? 1.18 : 0.78) : 1;
    const v = (0.43 + (lo.d[i]! - 0.5) * 0.16 + (mid.d[i]! - 0.5) * 0.05) * fleck * (1 - joint[i]! * 0.5);
    c[0] = v * 1.03;
    c[1] = v;
    c[2] = v * 0.95;
  });
  const orm = rgba(size, size, (i, _x, _y, c) => {
    c[0] = 1 - joint[i]! * 0.6;
    c[1] = clamp01(baseRough + (lo.d[i]! - 0.5) * 0.28 + (hi.d[i]! - 0.5) * 0.1 + joint[i]! * 0.5);
    c[2] = 0;
  });
  return {
    map: dataTexture(map, size, size, { anisotropy, srgb: true }),
    normalMap: dataTexture(normal, size, size, { anisotropy }),
    orm: dataTexture(orm, size, size, { anisotropy }),
  };
}

/**
 * Unique (non-tiling) macro map over the whole floor: R = albedo multiplier (0.5 = ×1), G = roughness
 * offset (0.5 = 0, wax lanes lower), B = puddle mask (mirror-smooth, darker). Footprint `sx × sz` metres centred on the origin.
 */
export function floorMacro(sx: number, sz: number, w: number, puddles: readonly { x: number; z: number; r: number }[], seed = 17): THREE.DataTexture {
  const h = Math.max(16, Math.round((w * sz) / sx));
  const lo = fbm(w, h, 3, 5, seed, 0.55);
  const mid = fbm(w, h, 12, 4, seed + 1, 0.55);
  const warp = fbm(w, h, 6, 3, seed + 2, 0.5);
  const data = rgba(w, h, (i, x, y, c) => {
    const wx = ((x + 0.5) / w - 0.5) * sx;
    const wz = ((y + 0.5) / h - 0.5) * sz;
    // traffic wear: the middle of the room is more burnished, edges duller and dustier
    const edge = Math.min(sx / 2 - Math.abs(wx), sz / 2 - Math.abs(wz));
    const dusty = 1 - smooth(0.2, 1.6, edge);
    let wet = 0;
    for (const p of puddles) {
      const d = Math.hypot(wx - p.x, wz - p.z) / p.r + (warp.d[i]! - 0.5) * 0.9;
      wet = Math.max(wet, 1 - smooth(0.75, 1, d));
    }
    // waxed / burnished lanes: smoother, never a mirror
    const wax = smooth(0.45, 0.75, lo.d[i]!) * (1 - dusty);
    c[0] = 0.5 * (0.86 + lo.d[i]! * 0.26 - dusty * 0.06 + (mid.d[i]! - 0.5) * 0.08);
    c[1] = 0.5 + (mid.d[i]! - 0.5) * 0.12 + dusty * 0.2 - wax * 0.14;
    c[2] = wet;
  });
  return dataTexture(data, w, h, { repeat: false });
}

/**
 * Neutral light wood planks (4 per tile, boards along u): tinted per use through vertex colours (oak,
 * walnut, pine, deck). Grain is a warped stripe field stretched along the board, plus pores and a few knots.
 */
export function woodSet(size: number, anisotropy: number, seed = 21): PbrSet {
  const stretch = 16;
  const along = fbm(Math.max(16, size / stretch), size, 4, 4, seed, 0.55);
  const pores = fbm(Math.max(16, size / 4), size, 16, 3, seed + 1, 0.6);
  const warp = fbm(size, size, 2, 3, seed + 2, 0.5);
  const rnd = mulberry32(seed);
  const planks = 4;
  const ph = size / planks;
  const tint: number[] = [];
  const freq: number[] = [];
  const knots: { x: number; y: number; r: number }[] = [];
  for (let p = 0; p < planks; p++) {
    tint.push(0.82 + rnd() * 0.3);
    freq.push(18 + rnd() * 14);
    if (rnd() < 0.6) knots.push({ x: rnd() * size, y: (p + 0.25 + rnd() * 0.5) * ph, r: size * (0.008 + rnd() * 0.01) });
  }
  const aw = along.w;
  const pw = pores.w;
  const grainF = new Float32Array(size * size);
  const seamF = new Float32Array(size * size);
  const height = field(size);
  for (let y = 0; y < size; y++) {
    const p = Math.floor(y / ph);
    const ly = y - p * ph;
    const seam = 1 - smooth(0.5, 2.2, Math.min(ly, ph - ly));
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const ax = Math.floor((x / size) * aw);
      let k = 0;
      for (const kn of knots) {
        const dx = Math.min(Math.abs(x - kn.x), size - Math.abs(x - kn.x)) * 0.35;
        const dy = y - kn.y;
        const d = Math.hypot(dx, dy) / kn.r;
        if (d < 4) k += Math.exp(-d * d * 0.35) * (1 - d / 4);
      }
      const phase = (ly / ph) * freq[p]! + along.d[y * aw + ax]! * 5 + warp.d[i]! * 3 + k * 2.5;
      const ring = Math.pow(Math.abs(Math.sin(phase * Math.PI)), 0.6);
      const pore = pores.d[y * pw + Math.floor((x / size) * pw)]!;
      const g = clamp01(ring * 0.65 + pore * 0.35 + k * 0.6);
      grainF[i] = g;
      seamF[i] = seam;
      height.d[i] = 0.6 - (1 - ring) * 0.03 - (pore < 0.35 ? 0.03 : 0) - seam * 0.4;
    }
  }
  const normal = normalFromHeight(height, size / 420);
  const map = rgba(size, size, (i, _x, y, c) => {
    const p = Math.floor(y / ph);
    const k = tint[p]! * (0.74 + grainF[i]! * 0.32) * (1 - seamF[i]! * 0.6);
    c[0] = 0.74 * k;
    c[1] = 0.58 * k;
    c[2] = 0.43 * k;
  });
  const orm = rgba(size, size, (i, _x, _y, c) => {
    c[0] = 1 - seamF[i]! * 0.5;
    c[1] = 0.55 + (1 - grainF[i]!) * 0.15 + seamF[i]! * 0.3;
    c[2] = 0;
  });
  return {
    map: dataTexture(map, size, size, { anisotropy, srgb: true }),
    normalMap: dataTexture(normal, size, size, { anisotropy }),
    orm: dataTexture(orm, size, size, { anisotropy }),
  };
}

/** Pebbled leather grain normal + roughness (ORM) tile. */
export function leatherSet(size: number, anisotropy: number, seed = 31): { normalMap: THREE.DataTexture; orm: THREE.DataTexture } {
  const cells = worley(size, Math.round(size / 9), seed);
  const crease = fbm(size, size, 8, 4, seed + 1, 0.55);
  const height = field(size);
  for (let i = 0; i < size * size; i++) height.d[i] = smooth(0, 0.55, cells.dist.d[i]!) * -0.3 + 0.6 - (Math.abs(crease.d[i]! - 0.5) < 0.01 ? 0.15 : 0);
  const orm = rgba(size, size, (i, _x, _y, c) => {
    c[0] = 0.85 + 0.15 * (1 - smooth(0.3, 0.7, cells.dist.d[i]!));
    c[1] = 0.38 + cells.dist.d[i]! * 0.25 + (crease.d[i]! - 0.5) * 0.3;
    c[2] = 0;
  });
  return { normalMap: dataTexture(normalFromHeight(blur(height, 1), size / 96), size, size, { anisotropy }), orm: dataTexture(orm, size, size, { anisotropy }) };
}

/** Plain-weave fabric normal tile. */
export function weaveNormal(size: number, anisotropy: number): THREE.DataTexture {
  const h = field(size);
  const threads = 32;
  const fuzz = fbm(size, size, 32, 2, 41, 0.5);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * threads * Math.PI * 2;
      const v = (y / size) * threads * Math.PI * 2;
      const over = Math.sin(u * 0.5) * Math.sin(v * 0.5) > 0 ? 1 : 0;
      h.d[y * size + x] = 0.5 + 0.25 * (over ? Math.abs(Math.sin(v)) : Math.abs(Math.sin(u))) + (fuzz.d[y * size + x]! - 0.5) * 0.1;
    }
  }
  return dataTexture(normalFromHeight(h, size / 64), size, size, { anisotropy });
}

/** Metal grunge: roughness (G) breakup with fine scratches, AO (R) in blotches. Shared by all painted / bare steel. */
export function grungeOrm(size: number, anisotropy: number, seed = 51): THREE.DataTexture {
  const lo = fbm(size, size, 4, 5, seed, 0.6);
  const hi = fbm(size, size, 48, 3, seed + 1, 0.6);
  const rnd = mulberry32(seed);
  const scratch = new Float32Array(size * size);
  for (let s = 0; s < size / 4; s++) {
    let x = rnd() * size;
    let y = rnd() * size;
    const a = rnd() * Math.PI;
    const len = 10 + rnd() * size * 0.15;
    for (let k = 0; k < len; k++) {
      x += Math.cos(a);
      y += Math.sin(a);
      const i = (((Math.floor(y) % size) + size) % size) * size + (((Math.floor(x) % size) + size) % size);
      scratch[i] = 1;
    }
  }
  const data = rgba(size, size, (i, _x, _y, c) => {
    c[0] = 0.8 + lo.d[i]! * 0.2;
    c[1] = clamp01(0.75 + (lo.d[i]! - 0.5) * 0.7 + (hi.d[i]! - 0.5) * 0.3 - scratch[i]! * 0.25);
    c[2] = 1;
  });
  return dataTexture(data, size, size, { anisotropy });
}

/** Flat-woven kilim runner: border bands, stepped diamonds, wool fuzz. 2:1 aspect. */
export function rugMap(w: number, anisotropy: number, seed = 5): { map: THREE.DataTexture; normalMap: THREE.DataTexture } {
  const h = w / 2;
  const fuzz = fbm(w, h, 64, 3, seed, 0.6);
  const lo = fbm(w, h, 6, 3, seed + 1, 0.5);
  const rust: [number, number, number] = [0.36, 0.15, 0.12];
  const indigo: [number, number, number] = [0.12, 0.16, 0.3];
  const cream: [number, number, number] = [0.8, 0.72, 0.58];
  const ochre: [number, number, number] = [0.6, 0.44, 0.22];
  const teal: [number, number, number] = [0.12, 0.34, 0.36];
  const map = rgba(w, h, (i, x, y, c) => {
    const u = x / w;
    const v = y / h;
    const bu = Math.min(u, 1 - u) * 2;
    const bv = Math.min(v, 1 - v);
    const b = Math.min(bu * 0.5, bv);
    let col = rust;
    if (b < 0.035) col = indigo;
    else if (b < 0.05) col = cream;
    else if (b < 0.1) {
      // border: little stepped triangles
      const t = Math.floor((bu < bv * 2 ? v : u) * 48);
      col = (t + Math.floor((b - 0.05) * 80)) % 2 === 0 ? ochre : indigo;
    } else if (b < 0.115) col = cream;
    else {
      // field: three big stepped medallions along u
      const cu = (u * 3) % 1 - 0.5;
      const cv = v - 0.5;
      const d = Math.floor((Math.abs(cu) * 2.2 + Math.abs(cv) * 1.3) * 12);
      col = d < 2 ? cream : d < 4 ? teal : d < 5 ? ochre : d < 7 ? indigo : d % 2 === 0 ? rust : [rust[0] * 0.85, rust[1] * 0.85, rust[2] * 0.85];
    }
    const k = (0.72 + fuzz.d[i]! * 0.3) * (0.86 + lo.d[i]! * 0.2);
    c[0] = col[0] * k;
    c[1] = col[1] * k;
    c[2] = col[2] * k;
  });
  const hgt: Field = { w, h, d: Float32Array.from(fuzz.d) };
  return { map: dataTexture(map, w, h, { anisotropy, srgb: true, repeat: false }), normalMap: dataTexture(normalFromHeight(hgt, w / 256), w, h, { anisotropy }) };
}

/** Window-pane grime (RGBA, alpha = dirt): corners and bottom edge, rain streaks, smudges. One pane per tile. */
export function glassDirt(size: number, seed = 61): THREE.DataTexture {
  const smudge = fbm(size, size, 4, 5, seed, 0.6);
  const streakN = fbm(size, size, 32, 3, seed + 1, 0.5);
  const data = rgba(size, size, (i, x, y, c) => {
    const u = x / size;
    const v = y / size;
    const edge = Math.min(u, 1 - u, v * 0.6, 1 - v);
    const rim = 1 - smooth(0, 0.16, edge);
    // streaks run down from the top rail (v = 1) and fade
    const sx = streakN.d[Math.floor(v * 0.06 * size) * size + x]!;
    const streak = smooth(0.62, 0.75, sx) * smooth(0.0, 0.7, v) * 0.5;
    const a = clamp01(rim * 0.55 + smooth(0.55, 0.8, smudge.d[i]!) * 0.35 + streak + (v < 0.12 ? (0.12 - v) * 3 : 0));
    c[0] = 0.62;
    c[1] = 0.6;
    c[2] = 0.55;
    c[3] = a * 0.7;
  });
  return dataTexture(data, size, size, { srgb: true });
}

/** Spot-light cookie: reflector rings, soft rim and an off-centre smudge so pools are not perfect discs. */
export function cookieMap(size: number, seed = 71): THREE.DataTexture {
  const n = fbm(size, size, 4, 3, seed, 0.5);
  const data = rgba(size, size, (i, x, y, c) => {
    const u = (x + 0.5) / size - 0.5;
    const v = (y + 0.5) / size - 0.5;
    const r = Math.hypot(u, v) * 2;
    const rings = 0.88 + 0.12 * Math.cos(r * 38) * smooth(0.2, 0.6, r);
    const k = (1 - smooth(0.7, 1, r)) * rings * (0.85 + n.d[i]! * 0.3) * (1 + 0.15 * smooth(0.5, 0, Math.hypot(u - 0.08, v + 0.05) * 2));
    c[0] = k;
    c[1] = k * 0.97;
    c[2] = k * 0.92;
  });
  return dataTexture(data, size, size, { srgb: true, repeat: false });
}

/** Leaf albedo: midrib, veins and a lighter edge; mapped across the leaf blade's own extent. */
export function leafMap(size: number, seed = 81): THREE.DataTexture {
  const n = fbm(size, size, 8, 3, seed, 0.5);
  const data = rgba(size, size, (i, x, y, c) => {
    const u = x / size - 0.5;
    const v = y / size;
    const mid = 1 - smooth(0.004, 0.018, Math.abs(u));
    const t = v * 8 - Math.abs(u) * 5;
    const vein = (1 - smooth(0.02, 0.07, Math.abs(t - Math.round(t)))) * smooth(0.02, 0.05, Math.abs(u));
    const k = 0.85 + n.d[i]! * 0.25;
    c[0] = (0.17 + mid * 0.25 + vein * 0.06) * k;
    c[1] = (0.36 + mid * 0.28 + vein * 0.08) * k;
    c[2] = (0.13 + mid * 0.12) * k;
  });
  return dataTexture(data, size, size, { srgb: true, repeat: false });
}

/** Rolled gravel (one tile ≈ 1.2 m): packed stones (Worley cells) in greys and buff, rough, with a normal map. */
export function gravelSet(size: number, anisotropy: number): PbrSet {
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
  const orm = rgba(size, size, (i, _x, _y, c) => {
    c[0] = 0.55 + 0.45 * (1 - smooth(0.35, 0.7, stones.dist.d[i]!));
    c[1] = 0.86 + fine.d[i]! * 0.1;
    c[2] = 0;
  });
  return {
    map: dataTexture(map, size, size, { srgb: true, anisotropy }),
    normalMap: dataTexture(normalFromHeight(h, size / 64), size, size, { anisotropy }),
    orm: dataTexture(orm, size, size, { anisotropy }),
  };
}
