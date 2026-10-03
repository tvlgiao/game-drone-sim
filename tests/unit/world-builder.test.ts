/**
 * ChunkBuilder: inline (time-sliced) and worker paths produce byte-identical chunks. Node has no Web Worker,
 * so here the worker is the real message handler behind a structured-clone + transfer boundary; the real
 * module Worker runs in Chromium / WebKit in tests/e2e/world-worker.spec.ts.
 */
import { describe, expect, it } from 'vitest';
import { buildChunk, chunkDigest, type ChunkData } from '../../src/world/chunk-gen';
import { ChunkCancelledError, createChunkBuilder, InlineChunkBuilder, WorkerChunkBuilder, type WorkerLike } from '../../src/world/worker/chunk-builder';
import { handleBuild, WorldCache, type BuildMessage, type WorkerReply } from '../../src/world/worker/protocol';
import { createWorld, type WorldSpec } from '../../src/world/world';

const SPEC: WorldSpec = { seed: 42, preset: 'infinite', genVersion: 1 };
const KEYS: [number, number, 0 | 1 | 2][] = [
  [-1, 1, 0],
  [0, 1, 0],
  [-1, 2, 1],
  [3, -2, 2],
];

/** In-process stand-in for a module worker: same handler, structured clone with transfer, async delivery. */
class FakeWorker implements WorkerLike {
  onmessage: ((e: MessageEvent<WorkerReply>) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  readonly worlds = new WorldCache();
  received = 0;
  terminated = false;
  constructor(private readonly failOn?: number) {}
  postMessage(message: BuildMessage): void {
    const msg = structuredClone(message);
    this.received++;
    setTimeout(() => {
      if (this.terminated) return;
      if (this.failOn !== undefined && this.received >= this.failOn) {
        this.onerror?.(new Error('worker crashed'));
        return;
      }
      const { reply, transfer } = handleBuild(msg, this.worlds);
      const cloned = structuredClone(reply, { transfer });
      // transferred buffers are detached on the sending side, like postMessage
      for (const b of transfer) expect(b.byteLength).toBe(0);
      this.onmessage?.({ data: cloned } as MessageEvent<WorkerReply>);
    }, 0);
  }
  terminate(): void {
    this.terminated = true;
  }
}

const digestOf = (c: ChunkData): string => chunkDigest(c);

describe('chunk builders', () => {
  it('inline and worker builders produce byte-identical chunks (== direct buildChunk)', async () => {
    const w = createWorld(SPEC);
    const direct = KEYS.map(([cx, cz, lod]) => digestOf(buildChunk(w, { cx, cz, lod })));
    const inline = new InlineChunkBuilder({ sliceMs: 1 });
    const workers: FakeWorker[] = [];
    const worker = new WorkerChunkBuilder({
      workers: 2,
      createWorker: () => {
        const f = new FakeWorker();
        workers.push(f);
        return f;
      },
    });
    const a = await Promise.all(KEYS.map(([cx, cz, lod]) => inline.build(SPEC, { cx, cz, lod })));
    const b = await Promise.all(KEYS.map(([cx, cz, lod]) => worker.build(SPEC, { cx, cz, lod })));
    expect(a.map(digestOf)).toEqual(direct);
    expect(b.map(digestOf)).toEqual(direct);
    expect(worker.kind).toBe('worker');
    // both workers took jobs
    expect(workers.map((f) => f.received).every((n) => n > 0)).toBe(true);
    // full structural equality, not only digests
    expect(b[0]).toEqual(a[0]);
    inline.dispose();
    worker.dispose();
    expect(workers.every((f) => f.terminated)).toBe(true);
  });

  it('inline builder time-slices: one slice stops at its budget and the job resumes in the next', async () => {
    // a clock that advances 1 ms per read: with a 3 ms budget each slice runs exactly two generator steps
    let clock = 0;
    const queue: (() => void)[] = [];
    const inline = new InlineChunkBuilder({ sliceMs: 3, now: () => clock++, schedule: (cb) => queue.push(cb) });
    let done = false;
    const p = inline.build(SPEC, { cx: 5, cz: 5, lod: 0 }).then((c) => {
      done = true;
      return c;
    });
    let slices = 0;
    while (!done) {
      const cb = queue.shift();
      if (cb) {
        slices++;
        cb();
      }
      await Promise.resolve();
    }
    // LOD0 = 67 sample rows + water + roads + objects ≈ 70 steps → ≈ 35 slices
    expect(slices).toBeGreaterThanOrEqual(30);
    expect(slices).toBeLessThanOrEqual(40);
    expect(digestOf(await p)).toBe(digestOf(buildChunk(createWorld(SPEC), { cx: 5, cz: 5, lod: 0 })));
  });

  it('runs lower priority numbers first and cancels queued jobs', async () => {
    const order: string[] = [];
    const inline = new InlineChunkBuilder({ sliceMs: 50 });
    const jobs = [
      inline.build(SPEC, { cx: 0, cz: 0, lod: 2 }, 5).then(() => order.push('p5')),
      inline.build(SPEC, { cx: 1, cz: 0, lod: 2 }, 1).then(() => order.push('p1')),
      inline.build(SPEC, { cx: 2, cz: 0, lod: 2 }, 3).then(() => order.push('p3')),
    ];
    const dropped = inline.build(SPEC, { cx: 9, cz: 9, lod: 2 }, 9);
    expect(inline.cancel((_s, r) => r.cx === 9)).toBe(1);
    await expect(dropped).rejects.toBeInstanceOf(ChunkCancelledError);
    await Promise.all(jobs);
    expect(order).toEqual(['p1', 'p3', 'p5']);
    expect(inline.pending).toBe(0);
  });

  it('a crashing worker fails over to inline and still delivers every chunk', async () => {
    const builder = new WorkerChunkBuilder({ workers: 1, createWorker: () => new FakeWorker(1) });
    const res = await Promise.all(KEYS.map(([cx, cz, lod]) => builder.build(SPEC, { cx, cz, lod })));
    expect(builder.kind).toBe('inline');
    const w = createWorld(SPEC);
    expect(res.map(digestOf)).toEqual(KEYS.map(([cx, cz, lod]) => digestOf(buildChunk(w, { cx, cz, lod }))));
    builder.dispose();
  });

  it('a worker that cannot be constructed falls back immediately; createChunkBuilder is inline without Worker', async () => {
    const builder = new WorkerChunkBuilder({
      workers: 2,
      createWorker: () => {
        throw new Error('module workers unsupported');
      },
    });
    expect(builder.kind).toBe('inline');
    const c = await builder.build(SPEC, { cx: 0, cz: 0, lod: 2 });
    expect(c.gridSize).toBe(17);
    builder.dispose();
    expect(typeof Worker).toBe('undefined');
    expect(createChunkBuilder().kind).toBe('inline');
  });

  it('errors from the generator reject only their own job', async () => {
    const inline = new InlineChunkBuilder();
    const bad = inline.build({ ...SPEC, genVersion: 99 }, { cx: 0, cz: 0, lod: 2 });
    const good = inline.build(SPEC, { cx: 0, cz: 0, lod: 2 });
    await expect(bad).rejects.toThrow(/version 99/);
    expect((await good).gridSize).toBe(17);
    const worker = new WorkerChunkBuilder({ workers: 1, createWorker: () => new FakeWorker() });
    await expect(worker.build({ ...SPEC, genVersion: 99 }, { cx: 0, cz: 0, lod: 2 })).rejects.toThrow(/version 99/);
    expect((await worker.build(SPEC, { cx: 0, cz: 0, lod: 2 })).gridSize).toBe(17);
    worker.dispose();
  });
});
