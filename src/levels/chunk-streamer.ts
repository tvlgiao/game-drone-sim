/**
 * Chunk streaming for terrain levels (design 07 §2.3), the data side: which chunks exist around the drone
 * and at which LOD, building them through a ChunkBuilder (worker, inline fallback), and registering the
 * objects of the 3 × 3 chunks around the drone in the level's ColliderGrid. DOM-free and three-free: it
 * runs before any view exists (the level's `ready` promise) and in Node tests. The renderer
 * (render/outdoor/terrain-view.ts) turns `cells` into meshes at its own upload pace.
 */
import { chunkColliders, CHUNK_SIZE, type ChunkData, type Lod } from '../world/chunk-gen';
import { ChunkCancelledError, type ChunkBuilder } from '../world/worker/chunk-builder';
import type { WorldSpec } from '../world/world';
import type { ColliderGrid } from '../physics/collider-grid';

export interface StreamConfig {
  /** chunks kept on each side of the drone's chunk: a (2r + 1)² square */
  radius: number;
  /** a chunk is LOD0 while its centre is closer than this (Chebyshev, in chunks), LOD1 below `lod1`, else LOD2 */
  lod0: number;
  lod1: number;
  /** jobs handed to the builder at once; the rest wait here and are re-prioritised on every update */
  maxInFlight: number;
  /** request trees, rocks, houses, bridges and colliders (the far backdrop needs ground only) */
  objects: boolean;
  /** added to every builder priority: a backdrop streamer sharing the builder queues behind the near one */
  priorityBase: number;
}

export const DEFAULT_STREAM: Readonly<StreamConfig> = { radius: 3, lod0: 1.5, lod1: 2.5, maxInFlight: 4, objects: true, priorityBase: 0 };
/** LOD and drop hysteresis, in chunks (07 §2.3): a chunk on a boundary does not flip back and forth */
export const STREAM_HYSTERESIS = 0.25;
/** chunks around the drone's own whose objects are registered with physics (07 §1.3) */
export const COLLIDER_RING = 1;
/** built chunks kept after they leave the square (cheap revisits) */
export const CHUNK_CACHE = 160;
/** a chunk whose build failed (not cancelled) is retried after this many ms */
export const RETRY_MS = 1000;

/** One square cell of the streamed area. `data` is what is presented now (possibly not yet the wanted LOD). */
export interface StreamCell {
  readonly cx: number;
  readonly cz: number;
  readonly key: number;
  want: Lod;
  data: ChunkData | null;
  /** LOD of the job in flight for this cell, or -1 */
  loading: number;
  /** Chebyshev distance from the focus to the chunk centre, in chunks (updated every update) */
  dist: number;
  retryAt: number;
}

export interface StreamOptions {
  spec: WorldSpec;
  builder: ChunkBuilder;
  /** where chunk objects are registered for physics (null: render only) */
  grid: ColliderGrid | null;
  config?: Partial<StreamConfig>;
  /** cells outside this chunk-index box are never requested (bounded levels) */
  limits?: { minCx: number; maxCx: number; minCz: number; maxCz: number };
  now?: () => number;
  /** dispose() also disposes the builder (default true; false when the builder is shared) */
  ownsBuilder?: boolean;
}

/** Packs a chunk index pair into one non-negative integer (|cx|, |cz| < 32768: ±4 000 km). */
export function cellKey(cx: number, cz: number): number {
  return (cx + 32768) * 65536 + (cz + 32768);
}

export function colliderOwner(cx: number, cz: number): string {
  return `chunk:${cx},${cz}`;
}

/** LOD for a chunk at centre distance `d` (no hysteresis). */
export function lodAt(d: number, c: Pick<StreamConfig, 'lod0' | 'lod1'>): Lod {
  return d < c.lod0 ? 0 : d < c.lod1 ? 1 : 2;
}

/** LOD with hysteresis: the current LOD holds while it is a valid choice anywhere within ±STREAM_HYSTERESIS. */
export function lodFor(d: number, c: Pick<StreamConfig, 'lod0' | 'lod1'>, current: number): Lod {
  if (current >= 0 && current <= 2 && lodAt(d - STREAM_HYSTERESIS, c) <= current && current <= lodAt(d + STREAM_HYSTERESIS, c)) return current as Lod;
  return lodAt(d, c);
}

/** Distance from fractional chunk coordinate `f` to the chunk interval [c, c + 1] (0 inside). */
function axisBoxDist(c: number, f: number): number {
  return Math.max(0, c - f, f - (c + 1));
}

export class ChunkStreamer {
  readonly spec: WorldSpec;
  private readonly builder: ChunkBuilder;
  private readonly grid: ColliderGrid | null;
  private readonly limits: StreamOptions['limits'];
  private readonly now: () => number;
  private readonly ownsBuilder: boolean;
  private cfg: StreamConfig;
  private readonly cellMap = new Map<number, StreamCell>();
  private readonly cache = new Map<string, ChunkData>();
  private readonly registered = new Set<number>();
  private inFlight = 0;
  private fx = 0;
  private fz = 0;
  private focused = false;
  private disposed = false;
  private readyKeys: number[] = [];
  private readyResolve: (() => void) | null = null;
  private readyDone = false;
  private readonly candidates: StreamCell[] = [];
  /** bumps whenever a cell's presented data changes or a cell leaves: views rebuild derived buffers on change */
  version = 0;
  /** builds that failed (not cancelled) */
  failures = 0;
  lastError: unknown = null;
  /** resolves once every chunk of the 3 × 3 around the primed point has data and its colliders are in */
  readonly ready: Promise<void>;

  constructor(opts: StreamOptions) {
    this.spec = opts.spec;
    this.builder = opts.builder;
    this.grid = opts.grid;
    this.limits = opts.limits;
    this.now = opts.now ?? (() => performance.now());
    this.ownsBuilder = opts.ownsBuilder ?? true;
    this.cfg = { ...DEFAULT_STREAM, ...opts.config };
    this.ready = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });
  }

  get config(): Readonly<StreamConfig> {
    return this.cfg;
  }

  get builderKind(): ChunkBuilder['kind'] {
    return this.builder.kind;
  }

  /** the builder this streamer submits to (a backdrop streamer can share it) */
  get chunkBuilder(): ChunkBuilder {
    return this.builder;
  }

  /** cells of the streamed square (and those still inside the drop hysteresis) */
  get cells(): ReadonlyMap<number, StreamCell> {
    return this.cellMap;
  }

  /** 0..1: share of the 3 × 3 around the primed point that is built */
  get progress(): number {
    if (this.readyDone) return 1;
    if (this.readyKeys.length === 0) return 0;
    let n = 0;
    for (const k of this.readyKeys) if (this.cellMap.get(k)?.data) n++;
    return n / this.readyKeys.length;
  }

  get pending(): number {
    return this.inFlight;
  }

  /** owners currently registered with the grid (chunk keys), for tests and stats */
  get colliderChunks(): ReadonlySet<number> {
    return this.registered;
  }

  configure(c: Partial<StreamConfig>): void {
    this.cfg = { ...this.cfg, ...c };
    if (this.focused) this.update(this.fx * CHUNK_SIZE, this.fz * CHUNK_SIZE);
  }

  /** Starts streaming around (x, z): `ready` waits for the 3 × 3 around this point. */
  prime(x: number, z: number): void {
    const cx = Math.floor(x / CHUNK_SIZE);
    const cz = Math.floor(z / CHUNK_SIZE);
    this.readyKeys = [];
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (this.inLimits(cx + dx, cz + dz)) this.readyKeys.push(cellKey(cx + dx, cz + dz));
    this.update(x, z);
  }

  /**
   * Re-centres on (x, z) in metres: picks LODs, drops chunks beyond the square (with hysteresis), moves
   * collider registration with the drone and hands the nearest missing chunks to the builder. Returns
   * true when the presented set changed since the last call.
   */
  update(x: number, z: number): boolean {
    if (this.disposed) return false;
    const v0 = this.version;
    this.focused = true;
    this.fx = x / CHUNK_SIZE;
    this.fz = z / CHUNK_SIZE;
    const fcx = Math.floor(this.fx);
    const fcz = Math.floor(this.fz);
    const r = this.cfg.radius;

    let droppedLoading = false;
    for (const cell of this.cellMap.values()) {
      const boxD = Math.max(axisBoxDist(cell.cx, this.fx), axisBoxDist(cell.cz, this.fz));
      const inside = Math.max(Math.abs(cell.cx - fcx), Math.abs(cell.cz - fcz)) <= r;
      if (!inside && boxD > r + STREAM_HYSTERESIS) {
        if (cell.loading >= 0) droppedLoading = true;
        this.drop(cell);
      }
    }
    if (droppedLoading) this.builder.cancel((_, req) => !this.cellMap.has(cellKey(req.cx, req.cz)));
    for (let cz = fcz - r; cz <= fcz + r; cz++) {
      for (let cx = fcx - r; cx <= fcx + r; cx++) {
        if (!this.inLimits(cx, cz)) continue;
        const key = cellKey(cx, cz);
        if (!this.cellMap.has(key)) this.cellMap.set(key, { cx, cz, key, want: 2, data: null, loading: -1, dist: 0, retryAt: 0 });
      }
    }
    for (const cell of this.cellMap.values()) {
      cell.dist = Math.max(Math.abs(cell.cx + 0.5 - this.fx), Math.abs(cell.cz + 0.5 - this.fz));
      cell.want = lodFor(cell.dist, this.cfg, cell.data ? cell.data.lod : cell.loading);
      if (cell.data?.lod !== cell.want && cell.loading < 0) {
        const hit = this.cache.get(`${cell.cx},${cell.cz},${cell.want}`);
        if (hit) this.present(cell, hit);
      }
    }
    this.syncColliders();
    this.request();
    this.checkReady();
    return this.version !== v0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.ownsBuilder) this.builder.dispose();
    else this.builder.cancel((spec, req) => spec === this.spec && this.cellMap.has(cellKey(req.cx, req.cz)));
    for (const key of this.registered) {
      const c = this.cellMap.get(key);
      if (c) this.grid?.removeOwner(colliderOwner(c.cx, c.cz));
    }
    this.registered.clear();
    this.cellMap.clear();
    this.cache.clear();
  }

  private inLimits(cx: number, cz: number): boolean {
    const l = this.limits;
    return !l || (cx >= l.minCx && cx <= l.maxCx && cz >= l.minCz && cz <= l.maxCz);
  }

  private drop(cell: StreamCell): void {
    if (this.registered.delete(cell.key)) this.grid?.removeOwner(colliderOwner(cell.cx, cell.cz));
    if (cell.data) this.remember(cell.data);
    this.cellMap.delete(cell.key);
    this.version++;
  }

  private remember(c: ChunkData): void {
    const k = `${c.cx},${c.cz},${c.lod}`;
    this.cache.delete(k);
    this.cache.set(k, c);
    while (this.cache.size > CHUNK_CACHE) this.cache.delete(this.cache.keys().next().value as string);
  }

  private present(cell: StreamCell, data: ChunkData): void {
    if (cell.data === data) return;
    if (cell.data) this.remember(cell.data);
    cell.data = data;
    this.version++;
  }

  /** Objects of the chunks within COLLIDER_RING of the drone's chunk are in the grid; they leave past the hysteresis. */
  private syncColliders(): void {
    const fcx = Math.floor(this.fx);
    const fcz = Math.floor(this.fz);
    for (const key of this.registered) {
      const c = this.cellMap.get(key);
      if (!c) {
        this.registered.delete(key);
        continue;
      }
      const boxD = Math.max(axisBoxDist(c.cx, this.fx), axisBoxDist(c.cz, this.fz));
      const near = Math.max(Math.abs(c.cx - fcx), Math.abs(c.cz - fcz)) <= COLLIDER_RING;
      if (!near && boxD > COLLIDER_RING + STREAM_HYSTERESIS) {
        this.grid?.removeOwner(colliderOwner(c.cx, c.cz));
        this.registered.delete(key);
      }
    }
    for (let cz = fcz - COLLIDER_RING; cz <= fcz + COLLIDER_RING; cz++) {
      for (let cx = fcx - COLLIDER_RING; cx <= fcx + COLLIDER_RING; cx++) {
        const key = cellKey(cx, cz);
        const c = this.cellMap.get(key);
        if (!c?.data || this.registered.has(key)) continue;
        this.grid?.insertOwned(colliderOwner(cx, cz), chunkColliders(c.data));
        this.registered.add(key);
      }
    }
  }

  /** Hands the most urgent missing chunks to the builder: holes first, then by distance. */
  private request(): void {
    const free = this.cfg.maxInFlight - this.inFlight;
    if (free <= 0) return;
    const now = this.now();
    const list = this.candidates;
    list.length = 0;
    for (const c of this.cellMap.values()) if (c.loading < 0 && c.data?.lod !== c.want && now >= c.retryAt) list.push(c);
    if (list.length === 0) return;
    list.sort((a, b) => (a.data ? 1 : 0) - (b.data ? 1 : 0) || a.dist - b.dist);
    const n = Math.min(free, list.length);
    for (let i = 0; i < n; i++) this.start(list[i]!);
    list.length = 0;
  }

  private start(cell: StreamCell): void {
    const lod = cell.want;
    cell.loading = lod;
    this.inFlight++;
    const priority = this.cfg.priorityBase + (cell.data ? 100 : 0) + cell.dist;
    this.builder.build(this.spec, { cx: cell.cx, cz: cell.cz, lod, objects: this.cfg.objects }, priority).then(
      (data) => this.arrived(cell, data),
      (err: unknown) => this.failed(cell, err),
    );
  }

  private arrived(cell: StreamCell, data: ChunkData): void {
    this.inFlight--;
    if (this.disposed) return;
    cell.loading = -1;
    const live = this.cellMap.get(cell.key) === cell;
    if (!live) this.remember(data);
    else if (!cell.data || Math.abs(data.lod - cell.want) < Math.abs(cell.data.lod - cell.want)) this.present(cell, data);
    else this.remember(data);
    if (this.focused) {
      this.syncColliders();
      this.request();
      this.checkReady();
    }
  }

  private failed(cell: StreamCell, err: unknown): void {
    this.inFlight--;
    cell.loading = -1;
    if (this.disposed) return;
    if (!(err instanceof ChunkCancelledError)) {
      this.failures++;
      this.lastError = err;
      cell.retryAt = this.now() + RETRY_MS;
      if (this.failures === 1) console.warn('Chunk build failed; retrying', cell.cx, cell.cz, err);
    }
    if (this.focused) this.request();
  }

  private checkReady(): void {
    if (this.readyDone || this.readyKeys.length === 0) return;
    for (const k of this.readyKeys) {
      const c = this.cellMap.get(k);
      if (!c?.data) return;
      if (this.grid && !this.registered.has(k)) return;
    }
    this.readyDone = true;
    this.readyResolve?.();
    this.readyResolve = null;
  }
}
