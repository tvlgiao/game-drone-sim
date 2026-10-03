/** Runtime of a streamed terrain level: the authored definition plus the world, its chunk streamer and `ready`. */
import type { OutdoorLevel } from '../types';
import { CHUNK_SIZE } from '../world/chunk-gen';
import { encodeSeed } from '../world/seed-code';
import { createChunkBuilder, type ChunkBuilder } from '../world/worker/chunk-builder';
import type { World } from '../world/world';
import { ChunkStreamer, type StreamConfig } from './chunk-streamer';
import { createRuntime, type LevelRuntime } from './runtime';

export interface StreamedLevelOptions {
  /** chunk builder (tests pass an inline one); default: module worker with inline fallback */
  builder?: ChunkBuilder;
  config?: Partial<StreamConfig>;
}

/** Chunk index box covering ±half metres (bounded worlds stop streaming at their edge, plus one ring of scenery). */
export function chunkLimits(half: number): { minCx: number; maxCx: number; minCz: number; maxCz: number } {
  const lo = Math.floor(-half / CHUNK_SIZE) - 1;
  const hi = Math.ceil(half / CHUNK_SIZE);
  return { minCx: lo, maxCx: hi, minCz: lo, maxCz: hi };
}

export function streamedRuntime(def: OutdoorLevel, world: World, opts: StreamedLevelOptions & { half?: number } = {}): LevelRuntime {
  const base = createRuntime(def, world.field);
  const stream = new ChunkStreamer({
    spec: world.spec,
    builder: opts.builder ?? createChunkBuilder(),
    grid: base.grid,
    config: opts.config,
    limits: opts.half === undefined ? undefined : chunkLimits(opts.half),
  });
  stream.prime(def.spawn.position[0], def.spawn.position[2]);
  const seed = world.spec.seed >>> 0;
  return {
    ...base,
    ready: stream.ready,
    content: { kind: 'terrain', world, stream, seed, code: encodeSeed(seed, world.spec.genVersion) },
    progress: () => stream.progress,
    dispose: () => stream.dispose(),
  };
}
