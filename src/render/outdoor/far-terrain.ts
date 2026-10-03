/**
 * Far backdrop: ground-only LOD2 chunks from a second ChunkStreamer (sharing the near streamer's builder at a
 * lower priority), subsampled to 8 × 8 quads within FINE_RADIUS chunks and 4 × 4 beyond, batched into two ground
 * draws plus one water draw. Cells the near TerrainView already shows are left out, so the two never overlap;
 * the near chunks' skirts hide the seam. Rebuilt when either set changes (throttled) or the floating origin moves.
 */
import * as THREE from 'three';
import { ChunkStreamer } from '../../levels/chunk-streamer';
import { chunkLimits } from '../../levels/world-runtime';
import { CHUNK_SIZE, LOD_QUADS, type ChunkData } from '../../world/chunk-gen';
import type { WorldSpec } from '../../world/world';
import type { ChunkBuilder } from '../../world/worker/chunk-builder';
import { upNormals, type TerrainView } from './terrain-view';
import type { WorldOrigin } from './world-origin';

/** chunks (Chebyshev, centre distance) drawn with 8 × 8 quads; further ones get 4 × 4 */
export const FINE_RADIUS = 10;
const FAR_PRIORITY = 1000;
/** ms between rebuilds while only the near set changes */
const REBUILD_MS = 300;

/** One subsampled ground batch: `quads` × `quads` per chunk, same index pattern for every chunk. */
class GroundBatch {
  readonly mesh: THREE.Mesh;
  private cap = 0;
  private readonly verts: number;
  private readonly step: number;

  constructor(
    material: THREE.Material,
    name: string,
    readonly quads: number,
  ) {
    this.verts = (quads + 1) * (quads + 1);
    this.step = LOD_QUADS[2]! / quads;
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.grow(64);
    this.mesh.visible = false;
  }

  fill(list: readonly ChunkData[], origin: WorldOrigin): void {
    if (list.length > this.cap) this.grow(Math.max(list.length, this.cap * 2));
    const g = this.mesh.geometry;
    const pa = (g.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
    const na = (g.getAttribute('normal') as THREE.BufferAttribute).array as Int8Array;
    const ca = (g.getAttribute('color') as THREE.BufferAttribute).array as Uint8Array;
    const side = LOD_QUADS[2]! + 1;
    const q = this.quads;
    let v = 0;
    for (const d of list) {
      const ox = d.originX - origin.x;
      const oz = d.originZ - origin.z;
      for (let j = 0; j <= q; j++) {
        for (let i = 0; i <= q; i++) {
          const s = j * this.step * side + i * this.step;
          pa[v * 3] = d.positions[s * 3]! + ox;
          pa[v * 3 + 1] = d.positions[s * 3 + 1]!;
          pa[v * 3 + 2] = d.positions[s * 3 + 2]! + oz;
          for (let k = 0; k < 3; k++) {
            na[v * 3 + k] = d.normals[s * 3 + k]!;
            ca[v * 3 + k] = d.colors[s * 3 + k]!;
          }
          v++;
        }
      }
    }
    for (const n of ['position', 'normal', 'color']) g.getAttribute(n).needsUpdate = true;
    g.setDrawRange(0, list.length * q * q * 6);
    this.mesh.visible = list.length > 0;
  }

  private grow(chunks: number): void {
    this.mesh.geometry.dispose();
    const nv = chunks * this.verts;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nv * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal', new THREE.BufferAttribute(new Int8Array(nv * 3), 3, true).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(nv * 3), 3, true).setUsage(THREE.DynamicDrawUsage));
    // every chunk has the same grid: indices are written once per capacity
    const q = this.quads;
    const s = q + 1;
    const idx = new Uint32Array(chunks * q * q * 6);
    let k = 0;
    for (let c = 0; c < chunks; c++) {
      const base = c * this.verts;
      for (let j = 0; j < q; j++) {
        for (let i = 0; i < q; i++) {
          const a = base + j * s + i;
          idx[k++] = a;
          idx[k++] = a + s;
          idx[k++] = a + 1;
          idx[k++] = a + 1;
          idx[k++] = a + s;
          idx[k++] = a + s + 1;
        }
      }
    }
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    this.mesh.geometry = g;
    this.cap = chunks;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
  }
}

export class FarTerrain {
  readonly group = new THREE.Group();
  readonly stream: ChunkStreamer;
  private readonly fine: GroundBatch;
  private readonly coarse: GroundBatch;
  private readonly water: THREE.Mesh;
  private capWaterV = 0;
  private capWaterI = 0;
  private builtFar = -1;
  private builtNear = -1;
  private builtOrigin = -1;
  private lastBuild = -Infinity;
  private readonly fineList: ChunkData[] = [];
  private readonly coarseList: ChunkData[] = [];
  /** backdrop chunks in the current batches */
  count = 0;

  constructor(
    spec: WorldSpec,
    builder: ChunkBuilder,
    private readonly origin: WorldOrigin,
    terrainMat: THREE.Material,
    waterMat: THREE.Material,
    radius: number,
    half?: number,
  ) {
    this.group.name = 'far-terrain';
    this.stream = new ChunkStreamer({
      spec,
      builder,
      grid: null,
      ownsBuilder: false,
      config: { radius, lod0: -1, lod1: -1, maxInFlight: 2, objects: false, priorityBase: FAR_PRIORITY },
      limits: half === undefined ? undefined : chunkLimits(half),
    });
    this.fine = new GroundBatch(terrainMat, 'far-ground', 8);
    this.coarse = new GroundBatch(terrainMat, 'far-ground-coarse', 4);
    this.water = new THREE.Mesh(new THREE.BufferGeometry(), waterMat);
    this.water.name = 'far-water';
    this.water.frustumCulled = false;
    this.growWater(1024, 2048);
    this.water.visible = false;
    this.group.add(this.fine.mesh, this.coarse.mesh, this.water);
  }

  setRadius(r: number): void {
    this.stream.configure({ radius: r });
  }

  update(x: number, z: number, near: TerrainView, now: number): void {
    this.stream.update(x, z);
    const originMoved = this.builtOrigin !== this.origin.version;
    const farChanged = this.builtFar !== this.stream.version;
    const nearChanged = this.builtNear !== near.version;
    if (!originMoved && !farChanged && !nearChanged) return;
    if (!originMoved && now - this.lastBuild < REBUILD_MS) return;
    this.lastBuild = now;
    this.builtFar = this.stream.version;
    this.builtNear = near.version;
    this.builtOrigin = this.origin.version;
    this.rebuild(near);
  }

  private rebuild(near: TerrainView): void {
    const fine = this.fineList;
    const coarse = this.coarseList;
    fine.length = 0;
    coarse.length = 0;
    let wv = 0;
    let wi = 0;
    for (const c of this.stream.cells.values()) {
      if (!c.data || near.chunkAt(c.cx, c.cz)) continue;
      if (c.dist <= FINE_RADIUS + 0.5) {
        fine.push(c.data);
        wv += c.data.water.positions.length / 3;
        wi += c.data.water.indices.length;
      } else coarse.push(c.data);
    }
    this.count = fine.length + coarse.length;
    this.group.position.set(this.origin.x, 0, this.origin.z);
    this.fine.fill(fine, this.origin);
    this.coarse.fill(coarse, this.origin);

    if (wv > this.capWaterV || wi > this.capWaterI) this.growWater(Math.max(wv, this.capWaterV * 2), Math.max(wi, this.capWaterI * 2));
    const wg = this.water.geometry;
    const wp = (wg.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
    const wix = wg.getIndex()!.array as Uint32Array;
    let vv = 0;
    let ii = 0;
    for (const d of fine) {
      const w = d.water;
      const n = w.positions.length / 3;
      if (n === 0) continue;
      const ox = d.originX - this.origin.x;
      const oz = d.originZ - this.origin.z;
      for (let k = 0; k < n; k++) {
        wp[(vv + k) * 3] = w.positions[k * 3]! + ox;
        wp[(vv + k) * 3 + 1] = w.positions[k * 3 + 1]!;
        wp[(vv + k) * 3 + 2] = w.positions[k * 3 + 2]! + oz;
      }
      for (let k = 0; k < w.indices.length; k++) wix[ii + k] = w.indices[k]! + vv;
      vv += n;
      ii += w.indices.length;
    }
    wg.getAttribute('position').needsUpdate = true;
    wg.getIndex()!.needsUpdate = true;
    wg.setDrawRange(0, ii);
    this.water.visible = ii > 0;
    fine.length = 0;
    coarse.length = 0;
  }

  private growWater(nv: number, ni: number): void {
    this.water.geometry.dispose();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nv * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal', upNormals(nv));
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(ni), 1).setUsage(THREE.DynamicDrawUsage));
    this.water.geometry = g;
    this.capWaterV = nv;
    this.capWaterI = ni;
  }

  dispose(): void {
    this.stream.dispose();
    this.fine.dispose();
    this.coarse.dispose();
    this.water.geometry.dispose();
    this.group.removeFromParent();
    this.group.clear();
  }
}

/** Distance (m) the backdrop reaches from the drone: the camera far plane must cover it. */
export function farReach(radius: number): number {
  return (radius + 1) * CHUNK_SIZE * Math.SQRT2;
}
