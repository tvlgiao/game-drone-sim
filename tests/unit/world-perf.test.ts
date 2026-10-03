/**
 * Performance budget (design 07 §2.3): an LOD0 chunk (terrain + water + roads + objects) builds in < 40 ms
 * in Node on a dev machine; warm `heightAt` stays in the low microseconds (physics calls it every step).
 * Fresh chunks each time (new terrain, villages and roads), after a JIT warm-up elsewhere in the world.
 */
import { describe, expect, it } from 'vitest';
import { buildChunk } from '../../src/world/chunk-gen';
import { createWorld } from '../../src/world/world';

const BUDGET_MS = 40;

function stats(xs: number[]): { median: number; p95: number; max: number } {
  const s = [...xs].sort((a, b) => a - b);
  return { median: s[s.length >> 1]!, p95: s[Math.floor(s.length * 0.95)]!, max: s[s.length - 1]! };
}

describe('world performance budget', () => {
  for (const preset of ['infinite', 'alpine'] as const) {
    it(`${preset}: LOD0 chunk p95 < ${BUDGET_MS} ms`, () => {
      const spec = { seed: 42, preset, genVersion: 1 };
      const warm = createWorld(spec);
      for (let k = 0; k < 12; k++) buildChunk(warm, { cx: 60 + k, cz: -60, lod: 0 });
      // Each chunk is timed best-of-3, every run on a fresh world (cold village / road caches): the CPU cost
      // of the chunk, without the scheduler noise of other test files running in parallel.
      const times: Record<number, number[]> = { 0: [], 1: [], 2: [] };
      for (let k = 0; k < 24; k++) {
        for (const lod of [0, 1, 2] as const) {
          const cx = (k % 6) - 3 + lod * 20;
          const cz = Math.floor(k / 6) - 2;
          let best = Infinity;
          for (let rep = 0; rep < 3; rep++) {
            const w = createWorld(spec);
            const t0 = performance.now();
            buildChunk(w, { cx, cz, lod });
            best = Math.min(best, performance.now() - t0);
          }
          times[lod]!.push(best);
        }
      }
      const s0 = stats(times[0]!);
      const s1 = stats(times[1]!);
      const s2 = stats(times[2]!);
      const f = (s: { median: number; p95: number; max: number }): string => `median ${s.median.toFixed(1)} / p95 ${s.p95.toFixed(1)} / max ${s.max.toFixed(1)} ms`;
      console.log(`[world-perf] ${preset} LOD0 ${f(s0)}; LOD1 ${f(s1)}; LOD2 ${f(s2)}`);
      expect(s0.p95).toBeLessThan(BUDGET_MS);
      expect(s2.median).toBeLessThan(s0.median);
    }, 60_000);
  }

  it('warm heightAt costs a few microseconds', () => {
    const f = createWorld({ seed: 42, preset: 'infinite', genVersion: 1 }).field;
    for (let i = 0; i < 20000; i++) f.heightAt(-100 + (i % 200), 150 + Math.floor(i / 200));
    const N = 200_000;
    const t0 = performance.now();
    let acc = 0;
    for (let i = 0; i < N; i++) acc += f.heightAt(-100 + (i % 200) * 0.5, 150 + (Math.floor(i / 200) % 100) * 0.5);
    const us = ((performance.now() - t0) * 1000) / N;
    console.log(`[world-perf] infinite heightAt warm ${us.toFixed(2)} µs/call`);
    expect(Number.isFinite(acc)).toBe(true);
    expect(us).toBeLessThan(20);
  });
});
