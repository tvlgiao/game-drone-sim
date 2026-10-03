/**
 * Chunk builders (design 07 §2.3). `WorkerChunkBuilder` runs chunk-gen in 1–2 module workers and receives
 * transferred typed arrays; `InlineChunkBuilder` runs the same generator on the calling thread, time-sliced
 * (default 3 ms per slice), for tests, WKWebView worker failures and no-worker environments. Both produce
 * byte-identical chunks. Jobs run lowest `priority` first, FIFO within a priority.
 */
import { buildChunkSteps, chunkKey, type ChunkData, type ChunkRequest } from '../chunk-gen';
import type { WorldSpec } from '../world';
import type { BuildMessage, WorkerReply } from './protocol';
import { WorldCache } from './protocol';

export interface ChunkBuilder {
  readonly kind: 'worker' | 'inline';
  build(spec: WorldSpec, req: ChunkRequest, priority?: number): Promise<ChunkData>;
  /** Drops queued (not started) jobs matching `filter` (all when omitted); their promises reject with ChunkCancelledError. Returns the count. */
  cancel(filter?: (spec: WorldSpec, req: ChunkRequest) => boolean): number;
  /** Jobs queued or running. */
  readonly pending: number;
  dispose(): void;
}

export class ChunkCancelledError extends Error {
  constructor(req: ChunkRequest) {
    super(`chunk ${chunkKey(req.cx, req.cz, req.lod)} cancelled`);
    this.name = 'ChunkCancelledError';
  }
}

interface Job {
  spec: WorldSpec;
  req: ChunkRequest;
  priority: number;
  seq: number;
  resolve: (c: ChunkData) => void;
  reject: (e: unknown) => void;
}

/** Priority queue on a sorted array (queues are short: a few hundred chunks at most). */
class JobQueue {
  private jobs: Job[] = [];
  private seq = 0;

  get size(): number {
    return this.jobs.length;
  }

  push(spec: WorldSpec, req: ChunkRequest, priority: number): Promise<ChunkData> {
    return new Promise<ChunkData>((resolve, reject) => {
      const job: Job = { spec, req, priority, seq: this.seq++, resolve, reject };
      let i = this.jobs.length;
      while (i > 0 && this.jobs[i - 1]!.priority > priority) i--;
      this.jobs.splice(i, 0, job);
    });
  }

  shift(): Job | undefined {
    return this.jobs.shift();
  }

  cancel(filter?: (spec: WorldSpec, req: ChunkRequest) => boolean): number {
    const keep: Job[] = [];
    let n = 0;
    for (const j of this.jobs) {
      if (!filter || filter(j.spec, j.req)) {
        j.reject(new ChunkCancelledError(j.req));
        n++;
      } else keep.push(j);
    }
    this.jobs = keep;
    return n;
  }
}

export interface InlineOptions {
  /** budget per slice, ms (default 3) */
  sliceMs?: number;
  now?: () => number;
  /** schedules the next slice (default setTimeout 0; pass requestAnimationFrame to slice per frame) */
  schedule?: (cb: () => void) => void;
}

export class InlineChunkBuilder implements ChunkBuilder {
  readonly kind = 'inline' as const;
  private readonly queue = new JobQueue();
  private readonly worlds = new WorldCache();
  private readonly sliceMs: number;
  private readonly now: () => number;
  private readonly schedule: (cb: () => void) => void;
  private current: { job: Job; it: Generator<void, ChunkData, void> } | null = null;
  private scheduled = false;
  private disposed = false;

  constructor(opts: InlineOptions = {}) {
    this.sliceMs = opts.sliceMs ?? 3;
    this.now = opts.now ?? (() => performance.now());
    this.schedule = opts.schedule ?? ((cb) => setTimeout(cb, 0));
  }

  get pending(): number {
    return this.queue.size + (this.current ? 1 : 0);
  }

  build(spec: WorldSpec, req: ChunkRequest, priority = 0): Promise<ChunkData> {
    if (this.disposed) return Promise.reject(new Error('ChunkBuilder disposed'));
    const p = this.queue.push(spec, req, priority);
    this.kick();
    return p;
  }

  cancel(filter?: (spec: WorldSpec, req: ChunkRequest) => boolean): number {
    return this.queue.cancel(filter);
  }

  dispose(): void {
    this.disposed = true;
    this.queue.cancel();
    if (this.current) {
      this.current.job.reject(new ChunkCancelledError(this.current.job.req));
      this.current = null;
    }
  }

  private kick(): void {
    if (this.scheduled || this.disposed) return;
    this.scheduled = true;
    this.schedule(() => this.slice());
  }

  private slice(): void {
    this.scheduled = false;
    if (this.disposed) return;
    const start = this.now();
    while (this.now() - start < this.sliceMs) {
      if (!this.current) {
        const job = this.queue.shift();
        if (!job) return;
        try {
          this.current = { job, it: buildChunkSteps(this.worlds.get(job.spec), job.req) };
        } catch (e) {
          job.reject(e);
          continue;
        }
      }
      const cur = this.current;
      try {
        const r = cur.it.next();
        if (r.done) {
          this.current = null;
          cur.job.resolve(r.value);
        }
      } catch (e) {
        this.current = null;
        cur.job.reject(e);
      }
    }
    if (this.current || this.queue.size > 0) this.kick();
  }
}

/** The parts of `Worker` the builder uses (tests pass an in-process fake). */
export interface WorkerLike {
  onmessage: ((e: MessageEvent<WorkerReply>) => void) | null;
  onerror: ((e: unknown) => void) | null;
  postMessage(message: BuildMessage): void;
  terminate(): void;
}

export interface WorkerOptions {
  /** worker count (default 2 when hardwareConcurrency ≥ 6, else 1) */
  workers?: number;
  createWorker?: () => WorkerLike;
  /** where jobs go once a worker fails (default: a new InlineChunkBuilder) */
  fallback?: () => ChunkBuilder;
}

/** Started but idle world workers: a level's builder takes them instead of cold-starting its own. */
const spare: WorkerLike[] = [];
/** at most this many idle workers are kept */
const SPARE_MAX = 2;

function spawnWorker(): WorkerLike {
  return new Worker(new URL('./world-worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike;
}

function defaultWorker(): WorkerLike {
  return spare.pop() ?? spawnWorker();
}

/**
 * Starts the world workers now (boot / idle menu time), so the first generated level does not wait for their
 * script to load and compile. Safe to call more than once; no-op without module workers.
 */
export function prewarmWorldWorkers(n = defaultWorkerCount()): void {
  if (typeof Worker === 'undefined') return;
  try {
    while (spare.length < Math.min(n, SPARE_MAX)) spare.push(spawnWorker());
  } catch {
    // no module workers here: the builder falls back to the inline one
  }
}

/** idle pre-started workers (tests) */
export function spareWorldWorkers(): number {
  return spare.length;
}

function defaultWorkerCount(): number {
  const hc = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
  return hc >= 6 ? 2 : 1;
}

interface Slot {
  worker: WorkerLike;
  job: Job | null;
  id: number;
}

export class WorkerChunkBuilder implements ChunkBuilder {
  private readonly queue = new JobQueue();
  private readonly slots: Slot[] = [];
  private readonly makeFallback: () => ChunkBuilder;
  private fallback: ChunkBuilder | null = null;
  private nextId = 1;
  private disposed = false;
  /** the workers are the default ones: an idle one goes back to the spare pool on dispose */
  private readonly reuse: boolean;

  constructor(opts: WorkerOptions = {}) {
    const n = Math.max(1, Math.min(2, opts.workers ?? defaultWorkerCount()));
    const create = opts.createWorker ?? defaultWorker;
    this.reuse = opts.createWorker === undefined;
    this.makeFallback = opts.fallback ?? (() => new InlineChunkBuilder());
    for (let i = 0; i < n; i++) {
      let worker: WorkerLike;
      try {
        worker = create();
      } catch {
        this.failOver();
        break;
      }
      const slot: Slot = { worker, job: null, id: 0 };
      worker.onmessage = (e) => this.onReply(slot, e.data);
      worker.onerror = () => this.failOver();
      this.slots.push(slot);
    }
  }

  /** 'inline' once the workers failed and jobs run on the fallback. */
  get kind(): 'worker' | 'inline' {
    return this.fallback ? 'inline' : 'worker';
  }

  get pending(): number {
    let busy = 0;
    for (const s of this.slots) if (s.job) busy++;
    return this.queue.size + busy + (this.fallback ? this.fallback.pending : 0);
  }

  build(spec: WorldSpec, req: ChunkRequest, priority = 0): Promise<ChunkData> {
    if (this.disposed) return Promise.reject(new Error('ChunkBuilder disposed'));
    if (this.fallback) return this.fallback.build(spec, req, priority);
    const p = this.queue.push(spec, req, priority);
    this.pump();
    return p;
  }

  cancel(filter?: (spec: WorldSpec, req: ChunkRequest) => boolean): number {
    return this.queue.cancel(filter) + (this.fallback ? this.fallback.cancel(filter) : 0);
  }

  dispose(): void {
    this.disposed = true;
    this.queue.cancel();
    for (const s of this.slots) {
      const busy = s.job !== null;
      if (s.job) s.job.reject(new ChunkCancelledError(s.job.req));
      s.job = null;
      s.worker.onmessage = null;
      s.worker.onerror = null;
      // an idle default worker stays warm for the next level; one still building (its reply would reach the next
      // owner) or a test fake is ended
      if (!busy && this.reuse && spare.length < SPARE_MAX) spare.push(s.worker);
      else s.worker.terminate();
    }
    this.slots.length = 0;
    this.fallback?.dispose();
  }

  private pump(): void {
    for (const s of this.slots) {
      if (s.job) continue;
      const job = this.queue.shift();
      if (!job) return;
      s.job = job;
      s.id = this.nextId++;
      s.worker.postMessage({ type: 'build', id: s.id, spec: job.spec, req: job.req });
    }
  }

  private onReply(slot: Slot, msg: WorkerReply): void {
    const job = slot.job;
    if (!job || msg.id !== slot.id) return;
    slot.job = null;
    if (msg.type === 'chunk') job.resolve(msg.chunk);
    else job.reject(new Error(msg.message));
    this.pump();
  }

  /** A worker failed to load or crashed: move every job to the inline fallback, for good. */
  private failOver(): void {
    if (this.fallback || this.disposed) return;
    const fb = this.makeFallback();
    this.fallback = fb;
    const moved: Job[] = [];
    for (const s of this.slots) {
      if (s.job) moved.push(s.job);
      s.job = null;
      s.worker.onmessage = null;
      s.worker.onerror = null;
      s.worker.terminate();
    }
    this.slots.length = 0;
    for (let j = this.queue.shift(); j; j = this.queue.shift()) moved.push(j);
    moved.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    for (const j of moved) fb.build(j.spec, j.req, j.priority).then(j.resolve, j.reject);
  }
}

/** Worker builder when `Worker` exists, else inline. */
export function createChunkBuilder(opts: WorkerOptions & InlineOptions = {}): ChunkBuilder {
  if (typeof Worker === 'undefined' && !opts.createWorker) return new InlineChunkBuilder(opts);
  return new WorkerChunkBuilder({ ...opts, fallback: opts.fallback ?? (() => new InlineChunkBuilder(opts)) });
}
