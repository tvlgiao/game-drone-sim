/**
 * TerrainView / ScatterView / WorldOrigin in Node (three without WebGL): ring-ordered uploads paced per frame
 * with the 3 × 3 under the drone never waiting, pooled geometries reused while streaming, LOD2 chunks in one
 * batch, floating-origin rebases that leave every vertex and instance where it was, and a dispose that frees
 * every geometry it created.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ChunkStreamer, type StreamConfig } from '../../src/levels/chunk-streamer';
import { ColliderGrid } from '../../src/physics/collider-grid';
import { ScatterView } from '../../src/render/outdoor/scatter-view';
import { TerrainView } from '../../src/render/outdoor/terrain-view';
import { REBASE_DISTANCE, WorldOrigin } from '../../src/render/outdoor/world-origin';
import { CHUNK_SIZE } from '../../src/world/chunk-gen';
import { ManualBuilder, SPEC, flush } from './stream-helpers';

const C = CHUNK_SIZE;

function setup(c: Partial<StreamConfig> = {}, uploads = 2): { b: ManualBuilder; s: ChunkStreamer; o: WorldOrigin; v: TerrainView; mats: THREE.Material[] } {
  const b = new ManualBuilder(true);
  const s = new ChunkStreamer({ spec: SPEC, builder: b, grid: new ColliderGrid(), config: { radius: 2, lod0: 1.5, lod1: 2.5, maxInFlight: 64, ...c } });
  const o = new WorldOrigin();
  const mats = [new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial()];
  const v = new TerrainView(s, o, { terrain: mats[0]!, road: mats[1]!, water: mats[2]! }, { uploads });
  return { b, s, o, v, mats };
}

/** Frames until the streamer is idle and every built chunk is shown. */
async function frames(v: TerrainView, s: ChunkStreamer, x: number, z: number, max = 400): Promise<number> {
  for (let i = 1; i <= max; i++) {
    v.update(x, z);
    await flush();
    let missing = 0;
    for (const c of s.cells.values()) if (!c.data || v.shown.get(c.key)?.data !== c.data) missing++;
    if (s.pending === 0 && missing === 0) return i;
  }
  throw new Error('did not settle');
}

describe('TerrainView uploads', () => {
  it('uploads nearest first, `uploads` per frame, except the 3 × 3 under the drone which never waits', async () => {
    const { b, s, v } = setup({ maxInFlight: 64, radius: 3 }, 1);
    s.prime(C * 0.5, C * 0.5);
    await flush();
    expect(b.log.length).toBe(49);
    const order: number[] = [];
    v.update(C * 0.5, C * 0.5);
    // first frame: the whole 3 × 3 (urgent) plus one more
    expect(v.uploadsLastFrame).toBe(10);
    for (const c of v.shown.values()) order.push(c.dist);
    for (let i = 0; i < 50; i++) {
      const before = new Set(v.shown.keys());
      v.update(C * 0.5, C * 0.5);
      expect(v.uploadsLastFrame).toBeLessThanOrEqual(1);
      for (const [k, c] of v.shown) if (!before.has(k)) order.push(c.dist);
    }
    expect(v.shown.size).toBe(49);
    expect(order[10]).toBe(2);
    expect(order[order.length - 1]).toBe(3);
    for (let i = 10; i < order.length; i++) expect(order[i]!).toBeGreaterThanOrEqual(order[i - 1]! - 1e-9);
  });

  it('LOD2 chunks have no mesh of their own: one batch draws them', async () => {
    const { s, v } = setup({ radius: 3 });
    s.prime(C * 0.5, C * 0.5);
    await frames(v, s, C * 0.5, C * 0.5);
    const lod2 = [...v.shown.values()].filter((c) => c.lod === 2);
    expect(lod2.length).toBe(49 - 25);
    expect(lod2.every((c) => c.mesh === null)).toBe(true);
    expect(v.batched).toBe(lod2.length);
    const meshes = v.group.children.filter((o) => o.name.startsWith('chunk '));
    expect(meshes.length).toBe(25);
  });

  it('streaming back and forth reuses pooled meshes instead of creating new ones', async () => {
    const { s, v } = setup({ radius: 2 });
    s.prime(C * 0.5, C * 0.5);
    let x = C * 0.5;
    await frames(v, s, x, C * 0.5);
    const first = v.created;
    for (let lap = 0; lap < 3; lap++) {
      for (let k = 0; k < 6; k++) {
        x += C * (lap % 2 === 0 ? 1 : -1);
        await frames(v, s, x, C * 0.5);
      }
    }
    // LOD0 + LOD1 meshes alive at once are at most 25 (+ a few in flight between LODs); creation stays bounded
    expect(v.created).toBeLessThanOrEqual(first + 12);
    expect(v.pooled).toBeGreaterThan(0);
  });

  it('dispose frees every geometry the view created (pooled, shown and batches)', async () => {
    const { s, v } = setup({ radius: 2 });
    const geos = new Set<THREE.BufferGeometry>();
    const disposed = new Set<THREE.BufferGeometry>();
    const track = (): void => {
      v.group.traverse((o) => {
        const g = (o as THREE.Mesh).geometry;
        if (g && !geos.has(g)) {
          geos.add(g);
          g.addEventListener('dispose', () => disposed.add(g));
        }
      });
    };
    s.prime(C * 0.5, C * 0.5);
    for (let k = 0; k < 8; k++) {
      await frames(v, s, C * (0.5 + k * 2), C * 0.5);
      track();
    }
    v.dispose();
    expect(geos.size).toBeGreaterThan(10);
    // batches replaced while growing were disposed when replaced; the rest now
    expect([...geos].filter((g) => !disposed.has(g))).toEqual([]);
    expect(v.group.children.length).toBe(0);
  });
});

describe('floating origin', () => {
  it('rebases to a chunk multiple once the drone is over 1024 m away, not before', () => {
    const o = new WorldOrigin();
    expect(REBASE_DISTANCE).toBe(1024);
    expect(o.follow(1000, 200)).toBe(false);
    expect(o.follow(1024, 0)).toBe(false);
    expect(o.follow(1030, 0)).toBe(true);
    expect([o.x, o.z, o.version]).toEqual([1024, 0, 1]);
    expect(o.follow(-200, 0)).toBe(true);
    expect([o.x, o.z]).toEqual([-256, 0]);
  });

  it('a rebase leaves every chunk vertex and scatter instance at the same world position', async () => {
    const { s, o, v } = setup({ radius: 1 });
    const scatter = new ScatterView(o, { uTime: { value: 0 } }, { treesLod0: 100, treesLod1: 100 });
    const root = new THREE.Group();
    root.add(v.group, scatter.group);
    const x = 40_000.5 * 1;
    s.prime(x, C * 0.5);
    await frames(v, s, x, C * 0.5);
    scatter.rebuild(v.shown);
    const worldOf = (): { verts: number[]; trees: number[] } => {
      root.updateMatrixWorld(true);
      const verts: number[] = [];
      const p = new THREE.Vector3();
      for (const c of [...v.shown.values()].sort((a, b) => a.key - b.key)) {
        if (!c.mesh) continue;
        const pos = c.mesh.geometry.getAttribute('position');
        p.fromBufferAttribute(pos, 100).applyMatrix4(c.mesh.matrixWorld);
        verts.push(p.x, p.y, p.z);
      }
      const trees: number[] = [];
      for (const m of scatter.group.children as THREE.Mesh[]) {
        const a = m.geometry.getAttribute('aInst') as THREE.InstancedBufferAttribute | undefined;
        if (!a || (m.geometry as THREE.InstancedBufferGeometry).instanceCount === 0) continue;
        for (let i = 0; i < (m.geometry as THREE.InstancedBufferGeometry).instanceCount; i++) {
          p.set(a.getX(i), a.getY(i), a.getZ(i)).applyMatrix4(m.matrixWorld);
          trees.push(p.x, p.y, p.z);
        }
      }
      return { verts, trees };
    };
    const before = worldOf();
    expect(before.verts.length).toBe(27);
    expect(before.trees.length).toBe(27);
    // the far-away origin is rebased under the drone: buffers become small numbers, the world stays put
    expect(o.follow(x, C * 0.5)).toBe(true);
    v.update(x, C * 0.5);
    scatter.rebuild(v.shown);
    const after = worldOf();
    for (let i = 0; i < before.verts.length; i++) expect(after.verts[i]!).toBeCloseTo(before.verts[i]!, 6);
    for (let i = 0; i < before.trees.length; i++) expect(after.trees[i]!).toBeCloseTo(before.trees[i]!, 3);
    // and the stored (GPU) coordinates are now origin-relative
    const anyChunk = [...v.shown.values()].find((c) => c.mesh)!;
    expect(Math.abs(anyChunk.mesh!.position.x)).toBeLessThan(2 * C);
    const inst = (scatter.group.children as THREE.Mesh[]).find((m) => (m.geometry as THREE.InstancedBufferGeometry).instanceCount > 0)!;
    expect(Math.abs((inst.geometry.getAttribute('aInst') as THREE.BufferAttribute).getX(0))).toBeLessThan(2 * C);
    scatter.dispose();
  });
});

describe('ScatterView', () => {
  it('spends the LOD0 tree budget on the nearest LOD0 chunks, then LOD1, and skips the rest', async () => {
    const { s, o, v } = setup({ radius: 2 });
    s.prime(C * 0.5, C * 0.5);
    await frames(v, s, C * 0.5, C * 0.5);
    const scatter = new ScatterView(o, { uTime: { value: 0 } }, { treesLod0: 4, treesLod1: 10 });
    scatter.rebuild(v.shown);
    const n = scatter.counts();
    // every fake chunk has one broadleaf tree: 4 detailed (nearest LOD0 chunks), 10 simplified, 11 dropped
    expect(n.broadleaf0).toBe(4);
    expect(n.billboards).toBe(10);
    expect(scatter.drawCount).toBe(2);
    scatter.caps = { treesLod0: 9, treesLod1: 100 };
    scatter.rebuild(v.shown);
    expect(scatter.counts().broadleaf0).toBe(9);
    expect(scatter.counts().billboards).toBe(16);
    // a big detailed budget is still only spent on LOD0 chunks
    scatter.caps = { treesLod0: 20, treesLod1: 100 };
    scatter.rebuild(v.shown);
    expect(scatter.counts().broadleaf0).toBe(9);
    scatter.dispose();
  });

  it('trees are taken nearest first whatever order the chunks are listed in', async () => {
    const { s, o, v } = setup({ radius: 1 });
    s.prime(C * 0.5, C * 0.5);
    await frames(v, s, C * 0.5, C * 0.5);
    const near = [...v.shown.values()].find((c) => c.cx === 0 && c.cz === 0)!;
    const far = [...v.shown.values()].find((c) => c.cx === 1 && c.cz === 1)!;
    // the farther chunk first in the map
    const listed = new Map([
      [far.key, far],
      [near.key, near],
    ]);
    const scatter = new ScatterView(o, { uTime: { value: 0 } }, { treesLod0: 1, treesLod1: 0 });
    scatter.rebuild(listed);
    const a = (scatter.group.children as THREE.Mesh[]).find((m) => m.name === 'broadleaf0')!.geometry.getAttribute('aInst') as THREE.InstancedBufferAttribute;
    expect(a.getX(0) + scatter.group.position.x).toBeCloseTo(64, 6);
    scatter.dispose();
  });

  it('the single detailed tree goes to the chunk under the drone, also after the drone moved', async () => {
    const { s, o, v } = setup({ radius: 2 });
    s.prime(C * 0.5, C * 0.5);
    await frames(v, s, C * 0.5, C * 0.5);
    await frames(v, s, C * 3.5, C * 0.5);
    const scatter = new ScatterView(o, { uTime: { value: 0 } }, { treesLod0: 1, treesLod1: 0 });
    scatter.rebuild(v.shown);
    const layer = (scatter.group.children as THREE.Mesh[]).find((m) => m.name === 'broadleaf0')!;
    const a = layer.geometry.getAttribute('aInst') as THREE.InstancedBufferAttribute;
    // the fake tree stands in the middle of its chunk: chunk (3, 0)
    expect(a.getX(0) + scatter.group.position.x).toBeCloseTo(3 * C + 64, 6);
    scatter.dispose();
  });
});
