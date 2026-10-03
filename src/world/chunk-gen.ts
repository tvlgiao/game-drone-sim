/**
 * Chunk meshing (design 07 §2.3): 128 m chunks keyed by integers (cx, cz); nested LOD grids so shared
 * vertices coincide — LOD0 64×64 quads (2 m), LOD1 32×32 (4 m), LOD2 16×16 (8 m) — with 6 m skirts.
 *
 * Coordinates: x and z in every array are relative to the chunk origin (originX, originZ) =
 * (cx·128, cz·128) so float32 keeps millimetre precision anywhere in the 50 km world; y is absolute.
 *
 * Vertex layout: the (n+1)² grid row-major (row = z), then 4n skirt vertices around the border
 * (z = 0 edge west→east, x = 128 edge north→south, z = 128 edge east→west, x = 0 edge south→north).
 * Index buffers are shared per LOD: `chunkIndices(lod)`.
 */
import type { Climate } from './base-terrain';
import { clamp, mix } from './math';
import { hash2, SALT, u01 } from './rng';
import type { Collider } from '../types';
import { chunkObjects, CHUNK_SIZE, COLLIDER_STRIDE, OBJECT_KIND, SHAPE } from './scatter';
import { ROAD_HALF_WIDTH } from './roads';
import { BIOME, biomeSample, classify, FEATURE_CELL, terrainSample, type BiomeSample } from './terrain-field';
import type { World } from './world';
import { shadeV2, SURFACE_STRIDE, waterMeshV2 } from './chunk-gen-v2';

export { CHUNK_SIZE } from './scatter';
export type Lod = 0 | 1 | 2;
export const LOD_QUADS: readonly number[] = [64, 32, 16];
export const LOD_STEP: readonly number[] = [2, 4, 8];
export const SKIRT_DEPTH = 6;
/** Road ribbon lift above the terrain, m. */
export const ROAD_LIFT = 0.06;

if (FEATURE_CELL !== CHUNK_SIZE) throw new Error('feature cells must match chunks');

export interface ChunkRequest {
  cx: number;
  cz: number;
  lod: Lod;
  /** trees, rocks, houses, bridges and colliders (default true) */
  objects?: boolean;
}

export interface RibbonMesh {
  positions: Float32Array;
  /** RGB per vertex (roads only; empty for water) */
  colors: Uint8Array;
  indices: Uint16Array | Uint32Array;
}

export interface ChunkData {
  cx: number;
  cz: number;
  lod: Lod;
  seed: number;
  genVersion: number;
  originX: number;
  originZ: number;
  /** vertices per side (n + 1) */
  gridSize: number;
  positions: Float32Array;
  normals: Int8Array;
  colors: Uint8Array;
  /**
   * Generator v2: per-vertex surface weights, SURFACE_STRIDE bytes (rock, bank) 0..255, for the renderer's rock
   * and wet-bank blending. Empty for v1 chunks.
   */
  surface: Uint8Array;
  minY: number;
  maxY: number;
  water: RibbonMesh;
  roads: RibbonMesh;
  trees: Float32Array;
  rocks: Float32Array;
  houses: Float32Array;
  bridges: Float32Array;
  colliders: Float32Array;
}

export function chunkKey(cx: number, cz: number, lod: number): string {
  return `${cx},${cz},${lod}`;
}

const indexCache: (Uint16Array | undefined)[] = [];

/** Triangle indices of an LOD's grid plus skirt (counter-clockwise from above / outside). */
export function chunkIndices(lod: Lod): Uint16Array {
  const hit = indexCache[lod];
  if (hit) return hit;
  const n = LOD_QUADS[lod]!;
  const side = n + 1;
  const ring = 4 * n;
  const idx = new Uint16Array(n * n * 6 + ring * 6);
  let k = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * side + i;
      const b = a + 1;
      const c = a + side;
      const d = c + 1;
      idx[k++] = a;
      idx[k++] = c;
      idx[k++] = b;
      idx[k++] = b;
      idx[k++] = c;
      idx[k++] = d;
    }
  }
  const border = borderIndices(n);
  const skirt0 = side * side;
  for (let r = 0; r < ring; r++) {
    const a = border[r]!;
    const b = border[(r + 1) % ring]!;
    const sa = skirt0 + r;
    const sb = skirt0 + ((r + 1) % ring);
    idx[k++] = a;
    idx[k++] = b;
    idx[k++] = sb;
    idx[k++] = a;
    idx[k++] = sb;
    idx[k++] = sa;
  }
  indexCache[lod] = idx;
  return idx;
}

/** Grid indices of the border ring in skirt order. */
function borderIndices(n: number): Uint32Array {
  const side = n + 1;
  const out = new Uint32Array(4 * n);
  let k = 0;
  for (let i = 0; i < n; i++) out[k++] = i;
  for (let j = 0; j < n; j++) out[k++] = j * side + n;
  for (let i = n; i > 0; i--) out[k++] = n * side + i;
  for (let j = n; j > 0; j--) out[k++] = j * side;
  return out;
}

const PALETTE: Record<number, number> = {
  [BIOME.water]: 0x6b6248,
  [BIOME.beach]: 0xcdbf8e,
  [BIOME.meadow]: 0x6f9a45,
  [BIOME.farmland]: 0xb9a75a,
  [BIOME.forest]: 0x3f6b33,
  [BIOME.conifer]: 0x34553a,
  [BIOME.scrub]: 0xa39a5c,
  [BIOME.rock]: 0x7d7a74,
  [BIOME.snow]: 0xf0f4f7,
  [BIOME.village]: 0x8d9858,
  [BIOME.road]: 0x7f7a5e,
};
const ROCK = 0x7d7a74;
const SNOW = 0xf0f4f7;
const DRY_GRASS = 0xa3a356;
const LUSH_GRASS = 0x4f8a3c;
const FIELD_GREEN = 0x8fa34a;

function r8(c: number): number {
  return (c >> 16) & 255;
}
function g8(c: number): number {
  return (c >> 8) & 255;
}
function b8(c: number): number {
  return c & 255;
}

/** Vertex colour from a classified sample (writes 3 bytes at `o`). */
function shade(b: BiomeSample, stripe: number, jitter: number, out: Uint8Array, o: number): void {
  let r: number, g: number, bl: number;
  if (b.biome === BIOME.meadow || b.biome === BIOME.village) {
    const t = clamp((b.moisture - 0.25) / 0.6, 0, 1);
    const base = b.biome === BIOME.village ? PALETTE[BIOME.village]! : -1;
    r = base >= 0 ? r8(base) : mix(r8(DRY_GRASS), r8(LUSH_GRASS), t);
    g = base >= 0 ? g8(base) : mix(g8(DRY_GRASS), g8(LUSH_GRASS), t);
    bl = base >= 0 ? b8(base) : mix(b8(DRY_GRASS), b8(LUSH_GRASS), t);
  } else if (b.biome === BIOME.farmland) {
    const c = stripe < 0.5 ? PALETTE[BIOME.farmland]! : FIELD_GREEN;
    r = r8(c);
    g = g8(c);
    bl = b8(c);
  } else {
    const c = PALETTE[b.biome]!;
    r = r8(c);
    g = g8(c);
    bl = b8(c);
  }
  if (b.biome !== BIOME.water && b.biome !== BIOME.road) {
    const rock = clamp((b.slope - 0.6) / 0.35, 0, 1);
    r = mix(r, r8(ROCK), rock);
    g = mix(g, g8(ROCK), rock);
    bl = mix(bl, b8(ROCK), rock);
    r = mix(r, r8(SNOW), b.snow);
    g = mix(g, g8(SNOW), b.snow);
    bl = mix(bl, b8(SNOW), b.snow);
  }
  if (b.biome !== BIOME.road && b.road > 0) {
    const verge = b.road * 0.6;
    r = mix(r, r8(PALETTE[BIOME.road]!), verge);
    g = mix(g, g8(PALETTE[BIOME.road]!), verge);
    bl = mix(bl, b8(PALETTE[BIOME.road]!), verge);
  }
  const k = 0.94 + 0.12 * jitter;
  out[o] = clamp(Math.floor(r * k), 0, 255);
  out[o + 1] = clamp(Math.floor(g * k), 0, 255);
  out[o + 2] = clamp(Math.floor(bl * k), 0, 255);
}

const ASPHALT = [74, 74, 78];
const LINE = [232, 228, 208];

/** Road ribbons: 3 vertices across (edge, centre, edge), 3 m pieces, dashed centre line in vertex colour. */
function roadRibbons(w: World, cx: number, cz: number): RibbonMesh {
  const ox = cx * CHUNK_SIZE;
  const oz = cz * CHUNK_SIZE;
  const f = w.field;
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const fc = f.featureCell(cx, cz);
  for (const road of fc.roads) {
    const p = road.pts;
    const nv = p.length / 2;
    for (let i = 0; i < nv - 1; i++) {
      if (road.bridged[i]) continue;
      const ax = p[2 * i]!, az = p[2 * i + 1]!, bx = p[2 * i + 2]!, bz = p[2 * i + 3]!;
      const mx = (ax + bx) / 2;
      const mz = (az + bz) / 2;
      if (mx < ox || mx >= ox + CHUNK_SIZE || mz < oz || mz >= oz + CHUNK_SIZE) continue;
      const dx = bx - ax;
      const dz = bz - az;
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len === 0) continue;
      const pieces = Math.max(1, Math.ceil(len / 3));
      const nx = -dz / len;
      const nz = dx / len;
      const s0 = road.s[i]!;
      const first = pos.length / 3;
      for (let k = 0; k <= pieces; k++) {
        const t = k / pieces;
        const x = ax + dx * t;
        const z = az + dz * t;
        const dash = Math.floor((s0 + len * t) / 3) % 2 === 0;
        for (let side = -1; side <= 1; side++) {
          const vx = x + nx * ROAD_HALF_WIDTH * side;
          const vz = z + nz * ROAD_HALF_WIDTH * side;
          pos.push(vx - ox, f.heightAt(vx, vz) + ROAD_LIFT, vz - oz);
          const c = side === 0 && dash ? LINE : ASPHALT;
          col.push(c[0]!, c[1]!, c[2]!);
        }
        if (k > 0) {
          const a = first + (k - 1) * 3;
          const b = a + 3;
          // two strips; (−n, 0, +n) across with n the left normal makes these counter-clockwise from above
          for (let q = 0; q < 2; q++) {
            const a0 = a + q;
            const b0 = b + q;
            idx.push(a0, a0 + 1, b0, b0, a0 + 1, b0 + 1);
          }
        }
      }
    }
  }
  const nVerts = pos.length / 3;
  return {
    positions: Float32Array.from(pos),
    colors: Uint8Array.from(col),
    indices: nVerts > 65535 ? Uint32Array.from(idx) : Uint16Array.from(idx),
  };
}

/**
 * Chunk generation as a resumable job: yields once per grid row so InlineChunkBuilder can time-slice it;
 * the worker simply runs it to completion. Same code, same bytes.
 */
export function* buildChunkSteps(w: World, req: ChunkRequest): Generator<void, ChunkData, void> {
  const { cx, cz, lod } = req;
  const n = LOD_QUADS[lod]!;
  const step = LOD_STEP[lod]!;
  const side = n + 1;
  const ext = n + 3;
  const ox = cx * CHUNK_SIZE;
  const oz = cz * CHUNK_SIZE;
  const f = w.field;
  const base = w.base;
  const s = terrainSample();
  const climate: Climate = { moisture: 0, temperature: 0 };

  const H = new Float64Array(ext * ext);
  const water = new Float64Array(side * side);
  const village = new Float64Array(side * side);
  const roadD = new Float64Array(side * side);
  const riverD = new Float64Array(side * side);
  const moist = new Float64Array(side * side);
  const temp = new Float64Array(side * side);
  const farm = new Float64Array(side * side);

  for (let j = 0; j < ext; j++) {
    const z = oz + (j - 1) * step;
    for (let i = 0; i < ext; i++) {
      const x = ox + (i - 1) * step;
      f.sample(x, z, s);
      H[j * ext + i] = s.h;
      if (i >= 1 && i <= side && j >= 1 && j <= side) {
        const v = (j - 1) * side + (i - 1);
        water[v] = s.water;
        village[v] = s.village;
        roadD[v] = s.roadD;
        riverD[v] = s.riverD;
        f.climate(x, z, s, climate);
        moist[v] = climate.moisture;
        temp[v] = climate.temperature;
        farm[v] = f.farmAt(x, z);
      }
    }
    yield;
  }

  const ring = 4 * n;
  const nv = side * side + ring;
  const positions = new Float32Array(nv * 3);
  const normals = new Int8Array(nv * 3);
  const colors = new Uint8Array(nv * 3);
  const v2 = w.spec.genVersion >= 2;
  const surface = new Uint8Array(v2 ? nv * SURFACE_STRIDE : 0);
  const bs = biomeSample();
  const ts = terrainSample();
  let minY = Infinity;
  let maxY = -Infinity;
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      const v = j * side + i;
      const e = (j + 1) * ext + (i + 1);
      const h = H[e]!;
      positions[v * 3] = i * step;
      positions[v * 3 + 1] = h;
      positions[v * 3 + 2] = j * step;
      if (h < minY) minY = h;
      if (h > maxY) maxY = h;
      const gx = (H[e + 1]! - H[e - 1]!) / (2 * step);
      const gz = (H[e + ext]! - H[e - ext]!) / (2 * step);
      const inv = 1 / Math.sqrt(gx * gx + 1 + gz * gz);
      normals[v * 3] = Math.round(-gx * inv * 127);
      normals[v * 3 + 1] = Math.round(inv * 127);
      normals[v * 3 + 2] = Math.round(-gz * inv * 127);

      ts.h = h;
      ts.water = water[v]!;
      ts.village = village[v]!;
      ts.roadD = roadD[v]!;
      ts.riverD = riverD[v]!;
      climate.moisture = moist[v]!;
      climate.temperature = temp[v]!;
      const wx = ox + i * step;
      const wz = oz + j * step;
      classify(base, ts, Math.sqrt(gx * gx + gz * gz), climate, farm[v]!, bs, w.spec.genVersion);
      const hv = hash2(w.spec.seed, Math.floor(wx), Math.floor(wz), SALT.colour);
      const stripe = u01(hash2(w.spec.seed, Math.floor(wx / 24), Math.floor(wz / 48), SALT.farm));
      shade(bs, stripe, u01(hv), colors, v * 3);
      if (v2) shadeV2(bs, w.spec.seed, wx, wz, water[v]!, roadD[v]!, farm[v]!, lod, colors, v * 3, surface, v * SURFACE_STRIDE);
    }
  }
  const border = borderIndices(n);
  for (let r = 0; r < ring; r++) {
    const src = border[r]!;
    const dst = side * side + r;
    positions[dst * 3] = positions[src * 3]!;
    positions[dst * 3 + 1] = positions[src * 3 + 1]! - SKIRT_DEPTH;
    positions[dst * 3 + 2] = positions[src * 3 + 2]!;
    for (let c = 0; c < 3; c++) {
      normals[dst * 3 + c] = normals[src * 3 + c]!;
      colors[dst * 3 + c] = colors[src * 3 + c]!;
    }
    for (let c = 0; c < surface.length / nv; c++) surface[dst * SURFACE_STRIDE + c] = surface[src * SURFACE_STRIDE + c]!;
  }

  // Water surface over every quad with a wet corner (v2: continuous, dilated under the banks).
  let wPos: number[] = [];
  let wIdx: number[] = [];
  const wMap = new Int32Array(side * side).fill(-1);
  const wetAt = (v: number): boolean => water[v]! > H[(Math.floor(v / side) + 1) * ext + (v % side) + 1]!;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * side + i;
      const quad = [a, a + 1, a + side, a + side + 1];
      let level = -Infinity;
      for (const q of quad) if (wetAt(q) && water[q]! > level) level = water[q]!;
      if (level === -Infinity) continue;
      const ids: number[] = [];
      for (const q of quad) {
        let id = wMap[q]!;
        if (id < 0) {
          id = wPos.length / 3;
          wMap[q] = id;
          const y = wetAt(q) ? water[q]! : level;
          wPos.push((q % side) * step, y, Math.floor(q / side) * step);
        }
        ids.push(id);
      }
      wIdx.push(ids[0]!, ids[2]!, ids[1]!, ids[1]!, ids[2]!, ids[3]!);
    }
  }
  if (v2) {
    const m = waterMeshV2(n, step, water, (v) => H[(Math.floor(v / side) + 1) * ext + (v % side) + 1]!);
    wPos = m.positions;
    wIdx = m.indices;
  }
  const waterMesh: RibbonMesh = {
    positions: Float32Array.from(wPos),
    colors: new Uint8Array(0),
    indices: wPos.length / 3 > 65535 ? Uint32Array.from(wIdx) : Uint16Array.from(wIdx),
  };
  yield;

  const roads = roadRibbons(w, cx, cz);
  yield;

  const empty = new Float32Array(0);
  const objects = req.objects === false ? { trees: empty, rocks: empty, houses: empty, bridges: empty, colliders: empty } : chunkObjects(w, cx, cz);

  return {
    cx,
    cz,
    lod,
    seed: w.spec.seed,
    genVersion: w.spec.genVersion,
    originX: ox,
    originZ: oz,
    gridSize: side,
    positions,
    normals,
    colors,
    surface,
    minY: minY - SKIRT_DEPTH,
    maxY,
    water: waterMesh,
    roads,
    trees: objects.trees,
    rocks: objects.rocks,
    houses: objects.houses,
    bridges: objects.bridges,
    colliders: objects.colliders,
  };
}

/** Builds a chunk synchronously. */
export function buildChunk(w: World, req: ChunkRequest): ChunkData {
  const it = buildChunkSteps(w, req);
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
  }
}

/** Every buffer of a chunk result, for `postMessage` transfer lists. */
export function chunkBuffers(c: ChunkData): ArrayBuffer[] {
  const arrays = [c.positions, c.normals, c.colors, c.surface, c.water.positions, c.water.colors, c.water.indices, c.roads.positions, c.roads.colors, c.roads.indices, c.trees, c.rocks, c.houses, c.bridges, c.colliders];
  const out: ArrayBuffer[] = [];
  for (const a of arrays) if (a.byteLength > 0 && !out.includes(a.buffer as ArrayBuffer)) out.push(a.buffer as ArrayBuffer);
  return out;
}

/** FNV-1a digest of every array and scalar of a chunk (determinism checks across builders and engines). */
export function chunkDigest(c: ChunkData): string {
  let h = 0x811c9dc5;
  const mixBytes = (a: ArrayBufferView): void => {
    const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    h ^= b.length;
    h = Math.imul(h, 0x01000193);
    for (let i = 0; i < b.length; i++) {
      h ^= b[i]!;
      h = Math.imul(h, 0x01000193);
    }
  };
  mixBytes(Float64Array.of(c.cx, c.cz, c.lod, c.seed, c.genVersion, c.originX, c.originZ, c.gridSize, c.minY, c.maxY));
  for (const a of [c.positions, c.normals, c.colors, c.water.positions, c.water.indices, c.roads.positions, c.roads.colors, c.roads.indices, c.trees, c.rocks, c.houses, c.bridges, c.colliders]) mixBytes(a);
  // v2 only: v1 digests (golden fixture) stay byte-identical
  if (c.surface.byteLength > 0) mixBytes(c.surface);
  return (h >>> 0).toString(16).padStart(8, '0');
}

const KIND_NAME: Record<number, string> = { [OBJECT_KIND.tree]: 'tree', [OBJECT_KIND.house]: 'house', [OBJECT_KIND.rock]: 'rock', [OBJECT_KIND.bridge]: 'bridge' };

/**
 * A chunk's packed colliders as physics `Collider`s in absolute world coordinates. Ids are
 * `<kind>:<cx>,<cz>:<index>`, so contacts tell what was hit and stay unique across chunks.
 */
export function chunkColliders(c: Pick<ChunkData, 'cx' | 'cz' | 'originX' | 'originZ' | 'colliders'>): Collider[] {
  const out: Collider[] = [];
  const p = c.colliders;
  for (let k = 0, i = 0; k < p.length; k += COLLIDER_STRIDE, i++) {
    const id = `${KIND_NAME[p[k + 1]!] ?? 'object'}:${c.cx},${c.cz}:${i}`;
    const center: [number, number, number] = [c.originX + p[k + 2]!, p[k + 3]!, c.originZ + p[k + 4]!];
    if (p[k] === SHAPE.cylinder) out.push({ id, shape: { kind: 'cylinder', center, radius: p[k + 5]!, halfHeight: p[k + 6]! } });
    else out.push({ id, shape: { kind: 'box', center, half: [p[k + 5]!, p[k + 6]!, p[k + 7]!], yaw: p[k + 8]! } });
  }
  return out;
}
