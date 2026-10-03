import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { ACRO_TIP, ACRO_TIP_KEY, AcroTip, attitudeOf } from '../../src/ui/acro-aid';

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
}

describe('Acro tip (touch pilots, once)', () => {
  it('the first switch to Acro on touch gets the tip; later switches and new launches do not', () => {
    const storage = memoryStorage();
    const tip = new AcroTip(storage);
    expect(tip.take('touch', 'angle')).toBeNull();
    expect(tip.take('touch', 'acro')).toBe(ACRO_TIP);
    expect(tip.take('touch', 'acro')).toBeNull();
    expect(storage.getItem(ACRO_TIP_KEY)).toBe('1');
    expect(new AcroTip(storage).take('touch', 'acro')).toBeNull();
  });

  it('keyboard, gamepad and Quest pilots never get it, and it stays due for a later touch switch', () => {
    const tip = new AcroTip(memoryStorage());
    for (const src of ['keyboard', 'gamepad', 'xr', 'none'] as const) expect(tip.take(src, 'acro')).toBeNull();
    expect(tip.take('touch', 'acro')).toBe(ACRO_TIP);
  });

  it('blocked storage: once per launch', () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    } as unknown as Storage;
    const tip = new AcroTip(blocked);
    expect(tip.take('touch', 'acro')).toBe(ACRO_TIP);
    expect(tip.take('touch', 'acro')).toBeNull();
  });

  it('says what Acro does and how to get back to stable flight', () => {
    expect(ACRO_TIP).toMatch(/no self-level/);
    expect(ACRO_TIP).toMatch(/Angle/);
  });
});

describe('artificial horizon attitude', () => {
  const q = (axis: [number, number, number], deg: number): Quaternion => new Quaternion().setFromAxisAngle(new Vector3(...axis), (deg * Math.PI) / 180);

  it('level, then right wing down is + roll, nose up is + pitch', () => {
    const l = attitudeOf(new Quaternion());
    expect([Math.abs(l.rollDeg), Math.abs(l.pitchDeg), l.inverted]).toEqual([0, 0, false]);
    // right wing down = rotation about body −Z (forward) … i.e. about +Z by a negative angle
    const r = attitudeOf(q([0, 0, 1], -30));
    expect(r.rollDeg).toBeCloseTo(30, 6);
    expect(r.pitchDeg).toBeCloseTo(0, 6);
    const p = attitudeOf(q([1, 0, 0], 20));
    expect(p.pitchDeg).toBeCloseTo(20, 6);
    expect(p.rollDeg).toBeCloseTo(0, 6);
  });

  it('a yaw does not move the horizon; belly up reads inverted', () => {
    const y = attitudeOf(q([0, 1, 0], 120));
    expect(y.rollDeg).toBeCloseTo(0, 6);
    expect(y.pitchDeg).toBeCloseTo(0, 6);
    const inv = attitudeOf(q([0, 0, 1], 180));
    expect(inv.inverted).toBe(true);
    expect(Math.abs(inv.rollDeg)).toBeCloseTo(180, 6);
    expect(attitudeOf(q([0, 0, 1], 80)).inverted).toBe(false);
    expect(attitudeOf(q([0, 0, 1], 100)).inverted).toBe(true);
  });
});
