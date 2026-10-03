/** Test doubles for chunk streaming: a controllable ChunkBuilder and synthetic chunks. */
import { CHUNK_SIZE, LOD_QUADS, type ChunkData, type ChunkRequest, type Lod } from '../../src/world/chunk-gen';
import { COLLIDER_STRIDE, SHAPE, OBJECT_KIND } from '../../src/world/scatter';
import { ChunkCancelledError, type ChunkBuilder } from '../../src/world/worker/chunk-builder';
import type { WorldSpec } from '../../src/world/world';

export const SPEC: WorldSpec = { seed: 7, preset: 'infinite', genVersion: 1 };

/** A flat chunk at height `y` with one tree collider in its middle (and one tree instance). */
export function fakeChunk(req: ChunkRequest, y = 10): ChunkData {
  const lod = req.lod as Lod;
  const n = LOD_QUADS[lod]!;
  const side = n + 1;
  const nv = side * side + 4 * n;
  const positions = new Float32Array(nv * 3);
  const step = CHUNK_SIZE / n;
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      const v = j * side + i;
      positions[v * 3] = i * step;
      positions[v * 3 + 1] = y;
      positions[v * 3 + 2] = j * step;
    }
  }
  const normals = new Int8Array(nv * 3);
  for (let v = 0; v < nv; v++) normals[v * 3 + 1] = 127;
  const objects = req.objects !== false;
  const colliders = new Float32Array(objects ? COLLIDER_STRIDE : 0);
  if (objects) colliders.set([SHAPE.cylinder, OBJECT_KIND.tree, 64, y + 5, 64, 2, 5, 0, 0]);
  return {
    cx: req.cx,
    cz: req.cz,
    lod,
    seed: SPEC.seed,
    genVersion: 1,
    originX: req.cx * CHUNK_SIZE,
    originZ: req.cz * CHUNK_SIZE,
    gridSize: side,
    positions,
    normals,
    colors: new Uint8Array(nv * 3).fill(120),
    surface: new Uint8Array(0),
    minY: y - 6,
    maxY: y,
    water: { positions: new Float32Array(0), colors: new Uint8Array(0), indices: new Uint16Array(0) },
    roads: { positions: new Float32Array(0), colors: new Uint8Array(0), indices: new Uint16Array(0) },
    trees: objects ? Float32Array.of(64, y, 64, 1, 0, 1) : new Float32Array(0),
    rocks: new Float32Array(0),
    houses: new Float32Array(0),
    bridges: new Float32Array(0),
    colliders,
  };
}

interface Job {
  req: ChunkRequest;
  priority: number;
  resolve: (c: ChunkData) => void;
  reject: (e: unknown) => void;
}

/** Builder whose jobs complete only when the test says so (or immediately with `auto`). */
export class ManualBuilder implements ChunkBuilder {
  readonly kind = 'inline' as const;
  readonly jobs: Job[] = [];
  readonly log: ChunkRequest[] = [];
  cancelled = 0;
  disposed = false;
  fail: ((req: ChunkRequest) => boolean) | null = null;

  constructor(private readonly auto = false) {}

  get pending(): number {
    return this.jobs.length;
  }

  build(_spec: WorldSpec, req: ChunkRequest, priority = 0): Promise<ChunkData> {
    this.log.push({ ...req });
    return new Promise((resolve, reject) => {
      const job = { req: { ...req }, priority, resolve, reject };
      if (this.auto) queueMicrotask(() => this.finish(job));
      else this.jobs.push(job);
    });
  }

  private finish(job: Job): void {
    if (this.fail?.(job.req)) job.reject(new Error(`build ${job.req.cx},${job.req.cz} failed`));
    else job.resolve(fakeChunk(job.req));
  }

  /** Completes the queued jobs (all, or the first `n` in submission order). */
  complete(n = Infinity): number {
    const done = this.jobs.splice(0, Math.min(n, this.jobs.length));
    for (const j of done) this.finish(j);
    return done.length;
  }

  cancel(filter?: (spec: WorldSpec, req: ChunkRequest) => boolean): number {
    const keep: Job[] = [];
    let n = 0;
    for (const j of this.jobs) {
      if (!filter || filter(SPEC, j.req)) {
        j.reject(new ChunkCancelledError(j.req));
        n++;
      } else keep.push(j);
    }
    this.jobs.length = 0;
    this.jobs.push(...keep);
    this.cancelled += n;
    return n;
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
  }
}

/** Lets resolved promises' callbacks run. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}
