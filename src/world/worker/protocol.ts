/**
 * Messages between ChunkBuilder and the world worker, and the handler both sides share: the worker runs it
 * on `onmessage`, tests run it in-process. Worlds are cached per spec (they hold the per-thread LRU caches).
 */
import { buildChunk, chunkBuffers, type ChunkData, type ChunkRequest } from '../chunk-gen';
import { createWorld, worldKey, type World, type WorldSpec } from '../world';

export interface BuildMessage {
  type: 'build';
  id: number;
  spec: WorldSpec;
  req: ChunkRequest;
}

export type WorkerReply = { type: 'chunk'; id: number; chunk: ChunkData } | { type: 'error'; id: number; message: string };

const MAX_WORLDS = 4;

/** Small cache of worlds by spec; the oldest is dropped beyond MAX_WORLDS. */
export class WorldCache {
  private readonly worlds = new Map<string, World>();

  get(spec: WorldSpec): World {
    const key = worldKey(spec);
    let w = this.worlds.get(key);
    if (w) {
      this.worlds.delete(key);
      this.worlds.set(key, w);
      return w;
    }
    w = createWorld(spec);
    if (this.worlds.size >= MAX_WORLDS) {
      const oldest = this.worlds.keys().next();
      if (!oldest.done) this.worlds.delete(oldest.value);
    }
    this.worlds.set(key, w);
    return w;
  }
}

export function handleBuild(msg: BuildMessage, worlds: WorldCache): { reply: WorkerReply; transfer: ArrayBuffer[] } {
  try {
    const chunk = buildChunk(worlds.get(msg.spec), msg.req);
    return { reply: { type: 'chunk', id: msg.id, chunk }, transfer: chunkBuffers(chunk) };
  } catch (e) {
    return { reply: { type: 'error', id: msg.id, message: e instanceof Error ? e.message : String(e) }, transfer: [] };
  }
}
