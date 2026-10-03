/**
 * Chunk meshes for streamed terrain (design 07 §2.3): turns the ChunkStreamer's cells into ground meshes in ring
 * order (nearest first), at most `uploads` new chunks per frame except under the drone, where a missing chunk
 * never waits. Geometries are pooled per LOD (index buffers shared), so streaming allocates nothing once warm.
 * LOD2 chunks (the outer rings) share one batched draw instead of a mesh each; roads and water of every shown
 * chunk are batched into one draw each. Batches are rebuilt only when the shown set changes.
 * Everything is stored relative to the floating origin (world-origin.ts).
 */
import * as THREE from 'three';
import { waterFlow } from '../../world/life/water-flow';
import { cellKey, type ChunkStreamer, type StreamCell } from '../../levels/chunk-streamer';
import { chunkIndices, CHUNK_SIZE, LOD_QUADS, type ChunkData, type Lod } from '../../world/chunk-gen';
import { SURFACE_BANK, SURFACE_ROCK, SURFACE_STRIDE } from '../../world/chunk-gen-v2';
import type { WorldOrigin } from './world-origin';

/** free meshes kept for reuse across all LODs (07 §2.3) */
export const POOL_LIMIT = 128;
/** a chunk this close (Chebyshev, in chunks) to the drone's chunk is uploaded at once when it has no mesh */
const URGENT_RING = 1;

export interface ShownChunk {
  readonly key: number;
  readonly cx: number;
  readonly cz: number;
  lod: Lod;
  data: ChunkData;
  /** null for LOD2 chunks, drawn by the LOD2 batch */
  mesh: THREE.Mesh | null;
  dist: number;
}

interface Pooled {
  lod: Lod;
  mesh: THREE.Mesh;
}

export interface TerrainMaterials {
  terrain: THREE.Material;
  road: THREE.Material;
  water: THREE.Material;
}

/**
 * Per-vertex surface weights of generator v2 (rock, wet bank) as two normalised byte attributes `aRock` / `aWet`
 * over one interleaved buffer, the layout `ChunkData.surface` already has. v1 chunks leave them at 0.
 */
export function addSurfaceAttributes(g: THREE.BufferGeometry, vertices: number, usage: THREE.Usage = THREE.StaticDrawUsage): THREE.InterleavedBuffer {
  const buf = new THREE.InterleavedBuffer(new Uint8Array(vertices * SURFACE_STRIDE), SURFACE_STRIDE).setUsage(usage);
  g.setAttribute('aRock', new THREE.InterleavedBufferAttribute(buf, 1, SURFACE_ROCK, true));
  g.setAttribute('aWet', new THREE.InterleavedBufferAttribute(buf, 1, SURFACE_BANK, true));
  return buf;
}

/** Copies a chunk's surface weights (zeros for v1 chunks) into the interleaved buffer at vertex `base`. */
function copySurface(buf: THREE.InterleavedBuffer, data: ChunkData, base: number, vertices: number): void {
  const a = buf.array as Uint8Array;
  const n = vertices * SURFACE_STRIDE;
  if (data.surface.length >= n) a.set(data.surface.subarray(0, n), base * SURFACE_STRIDE);
  else a.fill(0, base * SURFACE_STRIDE, base * SURFACE_STRIDE + n);
}

export function lodVertexCount(lod: Lod): number {
  const n = LOD_QUADS[lod]!;
  return (n + 1) * (n + 1) + 4 * n;
}

/** Growable ribbon batch (roads or water): one geometry, rebuilt from the shown chunks on change. */
class RibbonBatch {
  readonly mesh: THREE.Mesh;
  private capV = 0;
  private capI = 0;

  constructor(
    material: THREE.Material,
    name: string,
    private readonly road: boolean,
  ) {
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.grow(1024, 2048);
    this.mesh.visible = false;
  }

  rebuild(chunks: ReadonlyMap<number, ShownChunk>, origin: WorldOrigin, include: (c: ShownChunk) => boolean): void {
    let nv = 0;
    let ni = 0;
    for (const c of chunks.values()) {
      if (!include(c)) continue;
      const r = this.road ? c.data.roads : c.data.water;
      nv += r.positions.length / 3;
      ni += r.indices.length;
    }
    if (nv > this.capV || ni > this.capI) this.grow(Math.max(nv, this.capV * 2, 1024), Math.max(ni, this.capI * 2, 2048));
    const g = this.mesh.geometry;
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const idx = g.getIndex()!;
    const pa = pos.array as Float32Array;
    const ia = idx.array as Uint32Array;
    const ra = this.road ? ((g.getAttribute('aRoad') as THREE.BufferAttribute).array as Float32Array) : null;
    const sa = this.road ? null : ((g.getAttribute('aShore') as THREE.BufferAttribute).array as Float32Array);
    const fa = this.road ? null : ((g.getAttribute('aFlow') as THREE.BufferAttribute).array as Float32Array);
    let v = 0;
    let i = 0;
    for (const c of chunks.values()) {
      if (!include(c)) continue;
      const r = this.road ? c.data.roads : c.data.water;
      const ox = c.data.originX - origin.x;
      const oz = c.data.originZ - origin.z;
      const p = r.positions;
      const n = p.length / 3;
      for (let k = 0; k < n; k++) {
        pa[(v + k) * 3] = p[k * 3]! + ox;
        pa[(v + k) * 3 + 1] = p[k * 3 + 1]!;
        pa[(v + k) * 3 + 2] = p[k * 3 + 2]! + oz;
      }
      if (ra) {
        const col = r.colors;
        for (let k = 0; k < n; k++) {
          const across = (k % 3) - 1;
          // the centre vertex of this cross-section carries the dash in its colour
          const centre = k - (k % 3) + 1;
          ra[(v + k) * 2] = across;
          ra[(v + k) * 2 + 1] = col[centre * 3]! > 150 ? 1 : 0;
        }
      }
      if (sa) for (let k = 0; k < n; k++) sa[v + k] = shoreFoam(c.data, p[k * 3]!, p[k * 3 + 1]!, p[k * 3 + 2]!);
      if (fa) fa.set(chunkFlow(c.data), v * 2);
      const ix = r.indices;
      for (let k = 0; k < ix.length; k++) ia[i + k] = ix[k]! + v;
      v += n;
      i += ix.length;
    }
    pos.needsUpdate = true;
    idx.needsUpdate = true;
    if (ra) g.getAttribute('aRoad').needsUpdate = true;
    if (sa) g.getAttribute('aShore').needsUpdate = true;
    if (fa) g.getAttribute('aFlow').needsUpdate = true;
    g.setDrawRange(0, i);
    this.mesh.visible = i > 0;
  }

  private grow(nv: number, ni: number): void {
    this.mesh.geometry.dispose();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nv * 3), 3).setUsage(THREE.DynamicDrawUsage));
    // the standard program reads a normal: roads and water lie flat enough for straight up
    g.setAttribute('normal', upNormals(nv));
    if (this.road) {
      g.setAttribute('aRoad', new THREE.BufferAttribute(new Float32Array(nv * 2), 2).setUsage(THREE.DynamicDrawUsage));
    } else {
      g.setAttribute('aShore', new THREE.BufferAttribute(new Float32Array(nv), 1).setUsage(THREE.DynamicDrawUsage));
      // river flow along the generator's water surface (docs/12), m/s
      g.setAttribute('aFlow', new THREE.BufferAttribute(new Float32Array(nv * 2), 2).setUsage(THREE.DynamicDrawUsage));
    }
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(ni), 1).setUsage(THREE.DynamicDrawUsage));
    this.mesh.geometry = g;
    this.capV = nv;
    this.capI = ni;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
  }
}

/** Straight-up normals for `nv` vertices of a flat ribbon (roads, water). */
export function upNormals(nv: number): THREE.BufferAttribute {
  const n = new Float32Array(nv * 3);
  for (let k = 0; k < nv; k++) n[k * 3 + 1] = 1;
  return new THREE.BufferAttribute(n, 3);
}

const flowCache = new WeakMap<ChunkData, Float32Array>();

/** Per-vertex river flow of a chunk's water mesh (computed once per chunk). */
export function chunkFlow(d: ChunkData): Float32Array {
  let f = flowCache.get(d);
  if (f) return f;
  const p = d.water.positions;
  const n = p.length / 3;
  const depth = new Float32Array(n);
  for (let k = 0; k < n; k++) depth[k] = waterDepth(d, p[k * 3]!, p[k * 3 + 1]!, p[k * 3 + 2]!);
  f = waterFlow(p, d.water.indices, depth);
  flowCache.set(d, f);
  return f;
}

/** Water depth (m) of a water vertex at chunk-local (x, z) over the chunk's own ground grid. */
function waterDepth(d: ChunkData, x: number, y: number, z: number): number {
  const side = d.gridSize;
  const step = CHUNK_SIZE / (side - 1);
  const i = Math.min(side - 1, Math.max(0, Math.round(x / step)));
  const j = Math.min(side - 1, Math.max(0, Math.round(z / step)));
  return y - d.positions[(j * side + i) * 3 + 1]!;
}

/** water this shallow (m) over the chunk grid's ground foams at full strength; deeper fades out by FOAM_DEPTH */
const FOAM_DEPTH = 1.1;

/**
 * Shore foam 0..1 of a water vertex at chunk-local (x, z): from the water depth over the chunk's own ground grid
 * (water vertices sit on grid points), full where the bank rises above the surface.
 */
export function shoreFoam(d: ChunkData, x: number, y: number, z: number): number {
  const side = d.gridSize;
  const step = CHUNK_SIZE / (side - 1);
  const i = Math.min(side - 1, Math.max(0, Math.round(x / step)));
  const j = Math.min(side - 1, Math.max(0, Math.round(z / step)));
  const depth = y - d.positions[(j * side + i) * 3 + 1]!;
  if (depth <= 0) return 1;
  return depth >= FOAM_DEPTH ? 0 : 1 - depth / FOAM_DEPTH;
}

/** Every shown LOD2 chunk (grid + skirts) in one geometry: the outer rings cost one draw call. */
class Lod2Batch {
  readonly mesh: THREE.Mesh;
  private cap = 0;
  private surface: THREE.InterleavedBuffer | null = null;
  private readonly nv = lodVertexCount(2);
  private readonly idx = chunkIndices(2);

  constructor(material: THREE.Material) {
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    this.mesh.name = 'terrain-lod2';
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.grow(32);
    this.mesh.visible = false;
  }

  rebuild(chunks: ReadonlyMap<number, ShownChunk>, origin: WorldOrigin): number {
    let n = 0;
    for (const c of chunks.values()) if (c.lod === 2) n++;
    if (n > this.cap) this.grow(Math.max(n, this.cap * 2));
    const g = this.mesh.geometry;
    const pa = (g.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
    const na = (g.getAttribute('normal') as THREE.BufferAttribute).array as Int8Array;
    const ca = (g.getAttribute('color') as THREE.BufferAttribute).array as Uint8Array;
    const ia = g.getIndex()!.array as Uint32Array;
    const nv = this.nv;
    const ni = this.idx.length;
    let k = 0;
    for (const c of chunks.values()) {
      if (c.lod !== 2) continue;
      const d = c.data;
      const ox = d.originX - origin.x;
      const oz = d.originZ - origin.z;
      const base = k * nv;
      for (let v = 0; v < nv; v++) {
        pa[(base + v) * 3] = d.positions[v * 3]! + ox;
        pa[(base + v) * 3 + 1] = d.positions[v * 3 + 1]!;
        pa[(base + v) * 3 + 2] = d.positions[v * 3 + 2]! + oz;
      }
      na.set(d.normals, base * 3);
      ca.set(d.colors, base * 3);
      copySurface(this.surface!, d, base, nv);
      for (let i = 0; i < ni; i++) ia[k * ni + i] = this.idx[i]! + base;
      k++;
    }
    for (const a of ['position', 'normal', 'color']) g.getAttribute(a).needsUpdate = true;
    this.surface!.needsUpdate = true;
    g.getIndex()!.needsUpdate = true;
    g.setDrawRange(0, k * ni);
    this.mesh.visible = k > 0;
    return k;
  }

  private grow(chunks: number): void {
    this.mesh.geometry.dispose();
    const nv = chunks * this.nv;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nv * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal', new THREE.BufferAttribute(new Int8Array(nv * 3), 3, true).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(nv * 3), 3, true).setUsage(THREE.DynamicDrawUsage));
    this.surface = addSurfaceAttributes(g, nv, THREE.DynamicDrawUsage);
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(chunks * this.idx.length), 1).setUsage(THREE.DynamicDrawUsage));
    this.mesh.geometry = g;
    this.cap = chunks;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
  }
}

export class TerrainView {
  /** sits at the floating origin; children are origin-relative */
  readonly group = new THREE.Group();
  private readonly shownMap = new Map<number, ShownChunk>();
  private readonly free: Pooled[][] = [[], [], []];
  private readonly indices: THREE.BufferAttribute[];
  private readonly roads: RibbonBatch;
  private readonly water: RibbonBatch;
  private readonly lod2: Lod2Batch;
  private readonly pending: StreamCell[] = [];
  private originVersion = -1;
  private batchedVersion = -1;
  private uploads: number;
  /** bumps whenever the shown set or a shown chunk's data changes (scatter rebuilds on it) */
  version = 0;
  /** meshes created over the view's life (pool reuse keeps this flat while streaming) */
  created = 0;
  uploadsLastFrame = 0;
  /** chunks drawn by the LOD2 batch */
  batched = 0;

  constructor(
    private readonly stream: ChunkStreamer,
    private readonly origin: WorldOrigin,
    private readonly mats: TerrainMaterials,
    opts: { uploads?: number } = {},
  ) {
    this.group.name = 'terrain';
    this.uploads = opts.uploads ?? 2;
    this.indices = ([0, 1, 2] as const).map((l) => new THREE.BufferAttribute(chunkIndices(l), 1));
    this.roads = new RibbonBatch(mats.road, 'roads', true);
    this.water = new RibbonBatch(mats.water, 'water', false);
    this.lod2 = new Lod2Batch(mats.terrain);
    this.group.add(this.lod2.mesh, this.roads.mesh, this.water.mesh);
  }

  setUploads(n: number): void {
    this.uploads = Math.max(1, n);
  }

  get shown(): ReadonlyMap<number, ShownChunk> {
    return this.shownMap;
  }

  /** free meshes waiting in the pool */
  get pooled(): number {
    return this.free[0]!.length + this.free[1]!.length + this.free[2]!.length;
  }

  /** Streams around the drone (x, z), then uploads the nearest pending chunks. */
  update(x: number, z: number): void {
    this.stream.update(x, z);
    if (this.originVersion !== this.origin.version) {
      this.originVersion = this.origin.version;
      this.group.position.set(this.origin.x, 0, this.origin.z);
      for (const s of this.shownMap.values()) s.mesh?.position.set(s.data.originX - this.origin.x, 0, s.data.originZ - this.origin.z);
      this.batchedVersion = -1;
    }
    const cells = this.stream.cells;
    for (const s of this.shownMap.values()) {
      const c = cells.get(s.key);
      if (!c || !c.data) this.release(s);
    }
    const list = this.pending;
    list.length = 0;
    for (const c of cells.values()) {
      if (!c.data) continue;
      const s = this.shownMap.get(c.key);
      if (s) s.dist = c.dist;
      if (!s || s.data !== c.data) list.push(c);
    }
    list.sort((a, b) => a.dist - b.dist);
    const fcx = Math.floor(x / CHUNK_SIZE);
    const fcz = Math.floor(z / CHUNK_SIZE);
    let budget = this.uploads;
    let done = 0;
    for (const c of list) {
      const urgent = !this.shownMap.has(c.key) && Math.max(Math.abs(c.cx - fcx), Math.abs(c.cz - fcz)) <= URGENT_RING;
      if (!urgent && budget <= 0) continue;
      if (!urgent) budget--;
      this.upload(c);
      done++;
    }
    list.length = 0;
    this.uploadsLastFrame = done;
    if (this.batchedVersion !== this.version) {
      this.batchedVersion = this.version;
      this.batched = this.lod2.rebuild(this.shownMap, this.origin);
      this.roads.rebuild(this.shownMap, this.origin, (c) => c.lod <= 1);
      this.water.rebuild(this.shownMap, this.origin, () => true);
    }
  }

  /** The shown chunk at (cx, cz), if any. */
  chunkAt(cx: number, cz: number): ShownChunk | undefined {
    return this.shownMap.get(cellKey(cx, cz));
  }

  private upload(c: StreamCell): void {
    const data = c.data!;
    let s = this.shownMap.get(c.key);
    if (s && s.lod !== data.lod) {
      this.release(s);
      s = undefined;
    }
    if (!s) {
      let mesh: THREE.Mesh | null = null;
      if (data.lod < 2) {
        mesh = this.acquire(data.lod).mesh;
        this.group.add(mesh);
      }
      s = { key: c.key, cx: c.cx, cz: c.cz, lod: data.lod, data, mesh, dist: c.dist };
      this.shownMap.set(c.key, s);
    }
    s.data = data;
    if (s.mesh) {
      fillChunkGeometry(s.mesh.geometry, data);
      s.mesh.position.set(data.originX - this.origin.x, 0, data.originZ - this.origin.z);
      s.mesh.name = `chunk ${c.cx},${c.cz} lod${data.lod}`;
    }
    this.version++;
  }

  private acquire(lod: Lod): Pooled {
    const hit = this.free[lod]!.pop();
    if (hit) {
      hit.mesh.visible = true;
      return hit;
    }
    const nv = lodVertexCount(lod);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nv * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Int8Array(nv * 3), 3, true));
    g.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(nv * 3), 3, true));
    addSurfaceAttributes(g, nv);
    g.setIndex(this.indices[lod]!);
    g.boundingBox = new THREE.Box3();
    g.boundingSphere = new THREE.Sphere();
    const mesh = new THREE.Mesh(g, this.mats.terrain);
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = true;
    this.created++;
    return { lod, mesh };
  }

  private release(s: ShownChunk): void {
    this.shownMap.delete(s.key);
    if (s.mesh) {
      s.mesh.removeFromParent();
      if (this.pooled < POOL_LIMIT) this.free[s.lod]!.push({ lod: s.lod, mesh: s.mesh });
      else disposeChunkGeometry(s.mesh.geometry);
    }
    this.version++;
  }

  dispose(): void {
    for (const s of this.shownMap.values()) if (s.mesh) disposeChunkGeometry(s.mesh.geometry);
    this.lod2.dispose();
    for (const list of this.free) for (const p of list) disposeChunkGeometry(p.mesh.geometry);
    this.shownMap.clear();
    for (const list of this.free) list.length = 0;
    this.roads.dispose();
    this.water.dispose();
    this.group.removeFromParent();
    this.group.clear();
  }
}

/**
 * Frees a chunk geometry. The index attribute is shared per LOD: three drops its GL buffer with the geometry
 * and re-uploads it for the next geometry that draws with it, so this is only done on pool overflow and dispose.
 */
function disposeChunkGeometry(g: THREE.BufferGeometry): void {
  g.dispose();
}

/** Copies a chunk's arrays into a pooled geometry of the same LOD and fits its bounds (culling). */
export function fillChunkGeometry(g: THREE.BufferGeometry, data: ChunkData): void {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const nor = g.getAttribute('normal') as THREE.BufferAttribute;
  const col = g.getAttribute('color') as THREE.BufferAttribute;
  (pos.array as Float32Array).set(data.positions);
  (nor.array as Int8Array).set(data.normals);
  (col.array as Uint8Array).set(data.colors);
  pos.needsUpdate = true;
  nor.needsUpdate = true;
  col.needsUpdate = true;
  const rock = g.getAttribute('aRock') as THREE.InterleavedBufferAttribute | undefined;
  if (rock) {
    copySurface(rock.data, data, 0, pos.count);
    rock.data.needsUpdate = true;
  }
  const box = g.boundingBox ?? (g.boundingBox = new THREE.Box3());
  box.min.set(0, data.minY, 0);
  box.max.set(CHUNK_SIZE, data.maxY, CHUNK_SIZE);
  const sphere = g.boundingSphere ?? (g.boundingSphere = new THREE.Sphere());
  box.getBoundingSphere(sphere);
}
