/**
 * Dev-only harness for world-worker.spec.ts (served by `vite`, not built): builds the golden chunks through
 * the real module-worker WorkerChunkBuilder and through InlineChunkBuilder, and evaluates the golden heights,
 * so the spec can compare this engine's bytes with the Node fixture.
 */
import { chunkDigest } from '../../src/world/chunk-gen';
import { InlineChunkBuilder, WorkerChunkBuilder } from '../../src/world/worker/chunk-builder';
import { GOLDEN_CHUNKS, GOLDEN_SEEDS, goldenHeights } from '../unit/world-golden';

export interface HarnessResult {
  workerKind: string;
  worker: Record<string, string>;
  inline: Record<string, string>;
  heights: Record<string, Record<string, number[]>>;
  /** a chunk's positions arrived as a transferred, non-empty Float32Array */
  transferredBytes: number;
}

async function run(): Promise<HarnessResult> {
  const worker = new WorkerChunkBuilder({ workers: 2 });
  const inline = new InlineChunkBuilder();
  const w = await Promise.all(GOLDEN_CHUNKS.map((g) => worker.build(g.spec, g.req)));
  const i = await Promise.all(GOLDEN_CHUNKS.map((g) => inline.build(g.spec, g.req)));
  const res: HarnessResult = {
    workerKind: worker.kind,
    worker: Object.fromEntries(GOLDEN_CHUNKS.map((g, k) => [g.key, chunkDigest(w[k]!)])),
    inline: Object.fromEntries(GOLDEN_CHUNKS.map((g, k) => [g.key, chunkDigest(i[k]!)])),
    heights: {},
    transferredBytes: w[0]!.positions.byteLength,
  };
  for (const preset of ['infinite', 'alpine', 'training'] as const) {
    res.heights[preset] = {};
    for (const seed of GOLDEN_SEEDS) res.heights[preset]![String(seed)] = goldenHeights(preset, seed);
  }
  worker.dispose();
  inline.dispose();
  return res;
}

const out = window as unknown as { __worldHarness?: Promise<HarnessResult> };
out.__worldHarness = run();
out.__worldHarness.then(
  () => (document.getElementById('status')!.textContent = 'done'),
  (e: unknown) => (document.getElementById('status')!.textContent = `error: ${String(e)}`),
);
