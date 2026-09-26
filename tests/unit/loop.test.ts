import { describe, expect, it } from 'vitest';
import { FixedLoop, FpsMeter } from '../../src/core/loop';

describe('FixedLoop', () => {
  it('runs floor(frame/dt) steps and returns the remainder as alpha', () => {
    const loop = new FixedLoop(0.001, 250);
    let n = 0;
    const alpha = loop.advance(0.0165, () => n++);
    expect(n).toBe(16);
    expect(alpha).toBeCloseTo(0.5, 6);
    expect(alpha).toBeGreaterThanOrEqual(0);
    expect(alpha).toBeLessThan(1);
  });

  it('carries the remainder into the next frame (no time lost at 120 Hz)', () => {
    const loop = new FixedLoop(0.001, 250);
    let n = 0;
    for (let i = 0; i < 120; i++) loop.advance(1 / 120, () => n++);
    expect(n).toBeGreaterThanOrEqual(999);
    expect(n).toBeLessThanOrEqual(1000);
  });

  it('caps steps per frame and drops the backlog (spiral-of-death guard)', () => {
    const loop = new FixedLoop(0.001, 100);
    let n = 0;
    loop.advance(0.25, () => n++);
    expect(n).toBe(100);
    n = 0;
    loop.advance(0, () => n++);
    expect(n).toBe(0);
  });

  it('ignores negative frame times', () => {
    const loop = new FixedLoop(0.001, 250);
    let n = 0;
    expect(loop.advance(-1, () => n++)).toBe(0);
    expect(n).toBe(0);
  });
});

describe('FpsMeter', () => {
  it('converges to the true frame rate', () => {
    const m = new FpsMeter();
    for (let i = 0; i < 400; i++) m.sample(1 / 120);
    expect(m.fps).toBeCloseTo(120, 0);
  });
});
