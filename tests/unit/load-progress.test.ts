import { describe, expect, it } from 'vitest';
import { CREEP_SHARE, LoadProgress, levelStages, type LoadStage } from '../../src/ui/load-progress';
import { Slicer, yieldToMain } from '../../src/core/yield';

const STAGES: LoadStage[] = [
  { id: 'a', label: 'A', weight: 1 },
  { id: 'b', label: 'B', weight: 3 },
  { id: 'c', label: 'C', weight: 1 },
];

describe('LoadProgress weighting', () => {
  it('target is the weighted sum of the stages reported so far', () => {
    const p = new LoadProgress(STAGES);
    expect(p.target).toBe(0);
    p.report('a', 1);
    expect(p.target).toBeCloseTo(1 / 5);
    p.report('b', 0.5);
    expect(p.target).toBeCloseTo((1 + 1.5) / 5);
    expect(p.stage.id).toBe('b');
    p.report('c', 1);
    expect(p.target).toBeCloseTo(1);
  });

  it('a later stage completes the earlier ones; stale reports change nothing', () => {
    const p = new LoadProgress(STAGES);
    p.report('b', 0.2);
    expect(p.target).toBeCloseTo((1 + 0.6) / 5);
    p.report('a', 0.9); // earlier stage
    p.report('b', 0.1); // smaller fraction
    p.report('zzz', 1); // unknown
    p.report('b', Number.NaN);
    expect(p.target).toBeCloseTo((1 + 0.6) / 5);
    expect(p.stage.id).toBe('b');
  });

  it('weights are normalised; levelStages put generation first for generated worlds', () => {
    for (const kind of ['indoor', 'authored', 'terrain', 'city'] as const) {
      const st = levelStages(kind);
      expect(st.map((s) => s.id)).toEqual(['code', 'generate', 'textures', 'scene', 'shaders', 'lighting', 'warm']);
      const p = new LoadProgress(st);
      p.report('warm', 1);
      expect(p.target).toBeCloseTo(1);
    }
    const terrain = levelStages('terrain');
    const authored = levelStages('authored');
    expect(terrain[1]!.label).toBe('Generating terrain');
    expect(levelStages('city')[1]!.label).toBe('Building city');
    expect(terrain[1]!.weight).toBeGreaterThan(authored[1]!.weight);
    expect(() => new LoadProgress([])).toThrow();
  });
});

describe('LoadProgress shown value', () => {
  it('never decreases, whatever the reports and the clock do', () => {
    const p = new LoadProgress(levelStages('terrain'), 0);
    let last = 0;
    let t = 0;
    const steps: [string, number][] = [
      ['code', 1],
      ['generate', 0.3],
      ['generate', 0.2],
      ['generate', 0.9],
      ['textures', 0.5],
      ['code', 0],
      ['scene', 1],
      ['shaders', 0.4],
      ['lighting', 1],
    ];
    for (const [id, f] of steps) {
      p.report(id, f, t);
      for (let i = 0; i < 20; i++) {
        t += i % 5 === 0 ? 0 : 16; // repeated timestamps too
        const v = p.tick(t);
        expect(v).toBeGreaterThanOrEqual(last);
        expect(v).toBeLessThanOrEqual(1);
        last = v;
      }
    }
    // a clock going backwards does not move it back either
    expect(p.tick(t - 5000)).toBeGreaterThanOrEqual(last);
  });

  it('a small report after a long creep does not pull the bar back', () => {
    const p = new LoadProgress(STAGES, 0);
    p.report('b', 0, 0);
    let v = 0;
    for (let t = 16; t <= 4000; t += 16) v = p.tick(t);
    expect(v).toBeGreaterThan(p.target + 0.1); // crept well past the reported fraction
    p.report('b', 0.05, 4000);
    for (let t = 4016; t <= 4500; t += 16) {
      const nv = p.tick(t);
      expect(nv).toBeGreaterThanOrEqual(v);
      v = nv;
    }
  });

  it('creeps inside a silent stage, never past its share of the stage', () => {
    const p = new LoadProgress(STAGES, 0);
    p.report('b', 0, 0);
    const start = p.target;
    const end = (1 + 3) / 5;
    let v = 0;
    let moved = 0;
    for (let t = 16; t <= 60_000; t += 16) {
      const nv = p.tick(t);
      if (t <= 1000 && nv > v) moved++;
      v = nv;
    }
    expect(moved).toBeGreaterThan(30); // the bar keeps moving during the first second
    expect(v).toBeGreaterThan(start + (end - start) * 0.5);
    expect(v).toBeLessThanOrEqual(start + (end - start) * CREEP_SHARE + 1e-9);
  });

  it('closes the rest fast once complete (the hand-off does not wait on a tail)', () => {
    const p = new LoadProgress(STAGES, 0);
    p.report('c', 0.2, 0);
    let t = 0;
    for (; t < 500; t += 16) p.tick(t);
    expect(p.shownValue).toBeLessThan(0.95);
    p.complete();
    const start = t;
    while (p.tick(t) < 1 && t - start < 2000) t += 16;
    expect(t - start).toBeLessThanOrEqual(300);
  });

  it('reaches exactly 1 after complete()', () => {
    const p = new LoadProgress(STAGES, 0);
    p.report('a', 1, 0);
    p.tick(16);
    p.complete();
    expect(p.completed).toBe(true);
    let v = 0;
    for (let t = 32; t < 3000 && v < 1; t += 16) v = p.tick(t);
    expect(v).toBe(1);
    expect(p.shownValue).toBe(1);
    p.report('a', 0, 3000);
    expect(p.tick(3016)).toBe(1);
  });
});

describe('cooperative yielding', () => {
  it('Slicer is due once its budget is spent and starts a new slice after yield()', async () => {
    const s = new Slicer(5);
    expect(s.due()).toBe(false);
    const t0 = performance.now();
    while (performance.now() - t0 < 6) {
      // spin past the budget
    }
    expect(s.due()).toBe(true);
    await s.yield();
    expect(s.due()).toBe(false);
  });

  it('yieldToMain lets queued tasks run', async () => {
    let ran = false;
    setTimeout(() => (ran = true), 0);
    for (let i = 0; i < 50 && !ran; i++) await yieldToMain();
    expect(ran).toBe(true);
  });
});
