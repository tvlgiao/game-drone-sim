/**
 * ChunkStreamer (design 07 §2.3): nearest-first requests, LOD and drop hysteresis, the 3 × 3 under the drone
 * kept, colliders registered only for the ring around the drone's chunk, `ready` / progress, cache reuse,
 * cancellation and retry after a failed build.
 */
import { describe, expect, it } from 'vitest';
import { ChunkStreamer, cellKey, colliderOwner, lodAt, lodFor, RETRY_MS, STREAM_HYSTERESIS, type StreamConfig } from '../../src/levels/chunk-streamer';
import { ColliderGrid } from '../../src/physics/collider-grid';
import { CHUNK_SIZE } from '../../src/world/chunk-gen';
import { ManualBuilder, SPEC, flush } from './stream-helpers';

const C = CHUNK_SIZE;
const cfg = (c: Partial<StreamConfig> = {}): Partial<StreamConfig> => ({ radius: 2, lod0: 1.5, lod1: 2.5, maxInFlight: 4, ...c });

function streamer(builder = new ManualBuilder(), grid: ColliderGrid | null = new ColliderGrid(), c: Partial<StreamConfig> = {}, now?: () => number): ChunkStreamer {
  return new ChunkStreamer({ spec: SPEC, builder, grid, config: cfg(c), now });
}

/** Drives the streamer with an auto-completing builder until nothing is pending. */
async function settle(s: ChunkStreamer, x: number, z: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    s.update(x, z);
    await flush();
    if (s.pending === 0) {
      s.update(x, z);
      await flush();
      if (s.pending === 0) return;
    }
  }
  throw new Error('streamer did not settle');
}

describe('LOD choice', () => {
  it('lodAt splits by centre distance', () => {
    const c = { lod0: 1.5, lod1: 2.5 };
    expect([0, 1.49, 1.5, 2.49, 2.5, 7].map((d) => lodAt(d, c))).toEqual([0, 0, 1, 1, 2, 2]);
  });

  it('a chunk keeps its LOD within ±0.25 chunk of a boundary, and switches beyond', () => {
    const c = { lod0: 1.5, lod1: 2.5 };
    expect(STREAM_HYSTERESIS).toBe(0.25);
    // coarsening: LOD0 holds until 1.75
    expect(lodFor(1.7, c, 0)).toBe(0);
    expect(lodFor(1.76, c, 0)).toBe(1);
    // refining: LOD1 holds down to 1.25
    expect(lodFor(1.3, c, 1)).toBe(1);
    expect(lodFor(1.24, c, 1)).toBe(0);
    // nothing loaded yet: plain thresholds
    expect(lodFor(1.7, c, -1)).toBe(1);
    expect(lodFor(2.6, c, 1)).toBe(1);
    expect(lodFor(2.8, c, 1)).toBe(2);
  });
});

describe('ChunkStreamer requests', () => {
  it('asks for the nearest chunks first, the holes before any LOD upgrade, at most maxInFlight at a time', async () => {
    const b = new ManualBuilder();
    const s = streamer(b, null, { maxInFlight: 3 });
    s.prime(C * 0.5, C * 0.5);
    expect(b.jobs.length).toBe(3);
    expect([b.log[0]!.cx, b.log[0]!.cz]).toEqual([0, 0]);
    // keep completing: the distance of each request never decreases until every chunk has data
    const dist = (r: { cx: number; cz: number }): number => Math.max(Math.abs(r.cx + 0.5 - 0.5), Math.abs(r.cz + 0.5 - 0.5));
    for (let i = 0; i < 30 && b.jobs.length; i++) {
      b.complete(1);
      await flush();
      expect(b.jobs.length).toBeLessThanOrEqual(3);
    }
    const ds = b.log.map(dist);
    for (let i = 1; i < 25; i++) expect(ds[i]!).toBeGreaterThanOrEqual(ds[i - 1]!);
    // the full 5 × 5 square, each at its LOD: 9 × LOD0, 16 × LOD1
    expect(s.cells.size).toBe(25);
    const lods = [...s.cells.values()].map((c) => c.data?.lod);
    expect(lods.filter((l) => l === 0).length).toBe(9);
    expect(lods.filter((l) => l === 1).length).toBe(16);
  });

  it('ready waits for the 3 × 3 around the primed point (data and colliders); progress counts it', async () => {
    const b = new ManualBuilder();
    const grid = new ColliderGrid();
    const s = streamer(b, grid, { maxInFlight: 1 });
    let ready = false;
    void s.ready.then(() => (ready = true));
    s.prime(C * 3.5, C * -1.5);
    expect(s.progress).toBe(0);
    for (let k = 1; k <= 9; k++) {
      expect(ready).toBe(false);
      b.complete(1);
      await flush();
      expect(s.progress).toBeCloseTo(k / 9, 6);
    }
    expect(ready).toBe(true);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) expect(grid.has(colliderOwner(3 + dx, -2 + dz))).toBe(true);
  });

  it('LOD changes keep the old data shown until the new LOD arrives', async () => {
    const b = new ManualBuilder();
    const s = streamer(b, null, { maxInFlight: 25 });
    s.prime(C * 0.5, C * 0.5);
    b.complete();
    await flush();
    const far = s.cells.get(cellKey(2, 0))!;
    expect(far.data?.lod).toBe(1);
    // fly 2 chunks east: (2, 0) wants LOD0 now
    s.update(C * 2.5, C * 0.5);
    expect(far.want).toBe(0);
    expect(far.loading).toBe(0);
    expect(far.data?.lod).toBe(1);
    b.complete();
    await flush();
    expect(far.data?.lod).toBe(0);
  });
});

describe('ChunkStreamer square', () => {
  it('drops chunks past the square only beyond the hysteresis; the 3 × 3 around the drone always stays', async () => {
    const b = new ManualBuilder(true);
    const s = streamer(b, null, { radius: 1 });
    await settle(s, C * 0.5, C * 0.5);
    expect(s.cells.size).toBe(9);
    // just across the east edge of chunk 0: chunk −1 is now 2 away by index but only 0.1 chunk past the square
    s.update(C * 1.1, C * 0.5);
    expect(s.cells.has(cellKey(-1, 0))).toBe(true);
    // further: dropped
    s.update(C * 1.3, C * 0.5);
    expect(s.cells.has(cellKey(-1, 0))).toBe(false);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) expect(s.cells.has(cellKey(1 + dx, dz))).toBe(true);
  });

  it('revisiting a dropped chunk reuses the cached build instead of asking again', async () => {
    const b = new ManualBuilder(true);
    const s = streamer(b, null, { radius: 1 });
    await settle(s, C * 0.5, C * 0.5);
    const before = b.log.length;
    await settle(s, C * 4.5, C * 0.5);
    const mid = b.log.length;
    await settle(s, C * 0.5, C * 0.5);
    expect(mid).toBeGreaterThan(before);
    expect(b.log.length).toBe(mid);
  });

  it('queued builds of chunks that left the square are cancelled', async () => {
    const b = new ManualBuilder();
    const s = streamer(b, null, { radius: 2, maxInFlight: 25 });
    s.prime(C * 0.5, C * 0.5);
    expect(b.jobs.length).toBe(25);
    s.update(C * 20.5, C * 0.5);
    expect(b.cancelled).toBe(25);
    await flush();
    expect(s.pending).toBeLessThanOrEqual(25);
  });

  it('a failed build is retried after RETRY_MS, not at once', async () => {
    const b = new ManualBuilder();
    let t = 0;
    const s = streamer(b, null, { radius: 0, maxInFlight: 1 }, () => t);
    b.fail = () => true;
    s.prime(C * 0.5, C * 0.5);
    b.complete();
    await flush();
    expect(s.failures).toBe(1);
    s.update(C * 0.5, C * 0.5);
    expect(b.jobs.length).toBe(0);
    t = RETRY_MS + 1;
    b.fail = null;
    s.update(C * 0.5, C * 0.5);
    expect(b.jobs.length).toBe(1);
    b.complete();
    await flush();
    expect(s.cells.get(cellKey(0, 0))!.data).not.toBeNull();
  });

  it('dispose stops the builder and takes every chunk collider out of the grid', async () => {
    const b = new ManualBuilder(true);
    const grid = new ColliderGrid();
    const s = streamer(b, grid);
    await settle(s, C * 0.5, C * 0.5);
    expect(grid.size).toBe(9);
    s.dispose();
    expect(b.disposed).toBe(true);
    expect(grid.size).toBe(0);
  });
});

describe('collider registration follows the drone', () => {
  it('only the chunks within one ring of the drone’s chunk are in the grid, along a flight of 6 chunks', async () => {
    const b = new ManualBuilder(true);
    const grid = new ColliderGrid();
    const s = streamer(b, grid, { radius: 3 });
    for (let step = 0; step <= 60; step++) {
      const x = C * (0.5 + step * 0.1);
      await settle(s, x, C * 0.5);
      const fx = x / C;
      const fcx = Math.floor(fx);
      for (const key of s.colliderChunks) {
        const c = s.cells.get(key)!;
        const boxD = Math.max(0, c.cx - fx, fx - (c.cx + 1), c.cz - 0.5, 0.5 - (c.cz + 1));
        // inside the ring, or still within the hysteresis just past it
        expect(Math.max(Math.abs(c.cx - fcx), Math.abs(c.cz)) <= 1 || boxD <= 1 + STREAM_HYSTERESIS).toBe(true);
        expect(grid.has(colliderOwner(c.cx, c.cz))).toBe(true);
      }
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) expect(grid.has(colliderOwner(fcx + dx, dz))).toBe(true);
      // never the whole streamed square: at most 4 × 3 chunks (ring + hysteresis column)
      expect(s.colliderChunks.size).toBeLessThanOrEqual(12);
    }
    expect(grid.has(colliderOwner(0, 0))).toBe(false);
    expect(grid.size).toBe(s.colliderChunks.size);
  });
});
