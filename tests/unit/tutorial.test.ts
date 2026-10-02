import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  HINT_AFTER,
  TUTORIAL_KEY,
  TUTORIAL_STEPS,
  TutorialMachine,
  angleDelta,
  headingOf,
  loadTutorialRecord,
  saveTutorialRecord,
  shouldOfferTutorial,
  type TutorialCtx,
  type TutorialEvent,
  type TutorialQuat,
  type TutorialStepId,
} from '../../src/game/tutorial';

class MemStorage implements Storage {
  private m = new Map<string, string>();
  get length(): number {
    return this.m.size;
  }
  clear(): void {
    this.m.clear();
  }
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
}

class ThrowingStorage extends MemStorage {
  override getItem(): string | null {
    throw new Error('denied');
  }
  override setItem(): void {
    throw new Error('quota');
  }
}

const DT = 1 / 60;
const DEG = Math.PI / 180;

/** Quaternion for a heading turned `deg` to the right of −Z (rotation about +Y by −deg). */
function yawQuat(deg: number): TutorialQuat {
  const h = (-deg * DEG) / 2;
  return { x: 0, y: Math.sin(h), z: 0, w: Math.cos(h) };
}

type CtxPatch = Partial<Omit<TutorialCtx, 'drone'>> & { vel?: [number, number, number]; heading?: number };

function ctx(p: CtxPatch = {}): TutorialCtx {
  const [vx, vy, vz] = p.vel ?? [0, 0, 0];
  return {
    dt: p.dt ?? DT,
    drone: { velocity: { x: vx, y: vy, z: vz }, orientation: yawQuat(p.heading ?? 0) },
    agl: p.agl ?? 0.05,
    armed: p.armed ?? false,
    flightMode: p.flightMode ?? 'angle',
    cameraMode: p.cameraMode ?? 'los',
    source: p.source ?? 'keyboard',
    ringsPassed: p.ringsPassed ?? 0,
    confirm: p.confirm ?? false,
  };
}

const idOf = (m: TutorialMachine): TutorialStepId => m.step.id;
const indexOfStep = (id: TutorialStepId): number => TUTORIAL_STEPS.findIndex((s) => s.id === id);

/** A running machine sitting at the start of step `id`. */
function at(id: TutorialStepId, storage: Storage | null = new MemStorage()): TutorialMachine {
  const m = new TutorialMachine({ storage, now: () => 1000 });
  m.start('acro', indexOfStep(id) + 1);
  expect(idOf(m)).toBe(id);
  return m;
}

/** Runs `frames` updates of the same ctx; returns all events. */
function run(m: TutorialMachine, c: TutorialCtx | ((i: number) => TutorialCtx), frames: number): TutorialEvent[] {
  const out: TutorialEvent[] = [];
  for (let i = 0; i < frames; i++) out.push(...m.update(typeof c === 'function' ? c(i) : c));
  return out;
}

const secs = (s: number): number => Math.round(s / DT);

describe('tutorial helpers', () => {
  it('headingOf: 0 facing −Z, + turning right, ± wraps at 180°', () => {
    expect(headingOf(yawQuat(0))).toBeCloseTo(0, 9);
    expect(headingOf(yawQuat(90))).toBeCloseTo(Math.PI / 2, 9);
    expect(headingOf(yawQuat(-45))).toBeCloseTo(-Math.PI / 4, 9);
    expect(Math.abs(headingOf(yawQuat(180))!)).toBeCloseTo(Math.PI, 9);
  });

  it('headingOf: + is a right turn in three.js terms (nose swings toward +X, the camera-right side)', () => {
    // a right turn seen from above is a negative rotation about +Y; the nose (−Z) then points toward +X
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2);
    const nose = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    expect(nose.x).toBeCloseTo(1, 9);
    expect(headingOf({ x: q.x, y: q.y, z: q.z, w: q.w })).toBeCloseTo(Math.PI / 2, 9);
    const left = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 4);
    expect(headingOf({ x: left.x, y: left.y, z: left.z, w: left.w })).toBeCloseTo(-Math.PI / 4, 9);
  });

  it('headingOf ignores pitch (nose 30° down still reads the yaw) and is null for a vertical nose', () => {
    // yaw 90° right then pitch 30° nose-down about the body X axis
    const y = yawQuat(90);
    const a = (-30 * DEG) / 2;
    const p = { x: Math.sin(a), y: 0, z: 0, w: Math.cos(a) };
    const q = {
      w: y.w * p.w - y.x * p.x - y.y * p.y - y.z * p.z,
      x: y.w * p.x + y.x * p.w + y.y * p.z - y.z * p.y,
      y: y.w * p.y - y.x * p.z + y.y * p.w + y.z * p.x,
      z: y.w * p.z + y.x * p.y - y.y * p.x + y.z * p.w,
    };
    expect(headingOf(q)).toBeCloseTo(Math.PI / 2, 6);
    const up = { x: Math.sin(Math.PI / 4), y: 0, z: 0, w: Math.cos(Math.PI / 4) };
    expect(headingOf(up)).toBeNull();
  });

  it('angleDelta takes the short way across ±π', () => {
    expect(angleDelta(170 * DEG, -170 * DEG)).toBeCloseTo(20 * DEG, 9);
    expect(angleDelta(-170 * DEG, 170 * DEG)).toBeCloseTo(-20 * DEG, 9);
    expect(angleDelta(0, Math.PI)).toBeCloseTo(Math.PI, 9);
  });

  it('has the twelve steps of §4 in order', () => {
    expect(TUTORIAL_STEPS.map((s) => s.id)).toEqual([
      'welcome', 'arm', 'throttle', 'hover', 'yaw', 'pitch-roll', 'land', 'disarm', 'modes', 'cameras', 'ring', 'done',
    ]);
  });
});

describe('step completion', () => {
  it('1 welcome: only confirm advances (arming, flying, cameras do not)', () => {
    const m = at('welcome');
    run(m, ctx({ armed: true, agl: 2, cameraMode: 'fpv', flightMode: 'acro', ringsPassed: 3 }), 120);
    expect(idOf(m)).toBe('welcome');
    const ev = m.update(ctx({ confirm: true }));
    expect(ev).toContainEqual({ type: 'step', index: 1, id: 'arm' });
    expect(idOf(m)).toBe('arm');
  });

  it('2 arm: completes when armed', () => {
    const m = at('arm');
    run(m, ctx({ confirm: true, agl: 0.05 }), 30);
    expect(idOf(m)).toBe('arm');
    m.update(ctx({ armed: true }));
    expect(idOf(m)).toBe('throttle');
  });

  it('3 throttle: completes at 1.5 m AGL, armed; progress tracks height', () => {
    const m = at('throttle');
    m.update(ctx({ armed: true, agl: 0.75 }));
    expect(m.progress).toBeCloseTo(0.5, 6);
    m.update(ctx({ armed: true, agl: 1.49 }));
    expect(idOf(m)).toBe('throttle');
    m.update(ctx({ armed: false, agl: 2 }));
    expect(idOf(m)).toBe('throttle');
    m.update(ctx({ armed: true, agl: 1.5 }));
    expect(idOf(m)).toBe('hover');
  });

  it('4 hover: needs 3 s continuous inside [1, 3] m with |vy| < 0.4', () => {
    const m = at('hover');
    const steady = ctx({ armed: true, agl: 2 });
    run(m, steady, secs(2.9));
    expect(idOf(m)).toBe('hover');
    expect(m.progress).toBeGreaterThan(0.9);
    // one frame out of the band restarts the 3 s window
    m.update(ctx({ armed: true, agl: 3.01 }));
    expect(m.progress).toBe(0);
    run(m, steady, secs(2.9));
    expect(idOf(m)).toBe('hover');
    m.update(ctx({ armed: true, agl: 2, vel: [0, 0.4, 0] }));
    expect(m.progress).toBe(0);
    m.update(ctx({ armed: true, agl: 0.99 }));
    expect(m.progress).toBe(0);
    run(m, ctx({ armed: true, agl: 1, vel: [3, -0.39, 0] }), secs(3) + 1);
    expect(idOf(m)).toBe('yaw');
  });

  it('4 hover: the window edges are inclusive at 1 m and 3 m', () => {
    const lo = at('hover');
    run(lo, ctx({ armed: true, agl: 1 }), secs(3) + 1);
    expect(idOf(lo)).toBe('yaw');
    const hi = at('hover');
    run(hi, ctx({ armed: true, agl: 3 }), secs(3) + 1);
    expect(idOf(hi)).toBe('yaw');
  });

  it('5 yaw: integrates 180° right and 180° left as two bars', () => {
    const m = at('yaw');
    const rate = 90; // deg/s
    let h = 170; // crosses the ±180° seam on the way right
    const step = (dir: 1 | -1) => () => {
      h += dir * rate * DT;
      return ctx({ armed: true, agl: 2, heading: h });
    };
    run(m, step(1), secs(2) + 2);
    expect(idOf(m)).toBe('yaw');
    const [right, left] = m.parts();
    expect(right!.value).toBeCloseTo(1, 6);
    expect(left!.value).toBe(0);
    expect(m.progress).toBeCloseTo(0.5, 6);
    run(m, step(-1), secs(1));
    expect(m.parts()[1]!.value).toBeCloseTo(0.5, 1);
    expect(idOf(m)).toBe('yaw');
    run(m, step(-1), secs(1) + 2);
    expect(idOf(m)).toBe('pitch-roll');
  });

  it('5 yaw: slow drift below 15°/s never counts', () => {
    const m = at('yaw');
    let h = 0;
    run(m, () => ctx({ armed: true, agl: 2, heading: (h += 10 * DT) }), secs(60));
    expect(m.parts()[0]!.value).toBe(0);
    expect(idOf(m)).toBe('yaw');
  });

  it('6 pitch & roll: 4 m each way in the drone heading frame', () => {
    const m = at('pitch-roll');
    // heading 90° right = facing +X: world +X is "forward", +Z is "right"
    const fly = (v: [number, number, number]) => ctx({ armed: true, agl: 2, heading: 90, vel: v });
    run(m, fly([2, 0, 0]), secs(2) + 1); // forward
    run(m, fly([-2, 0, 0]), secs(2) + 1); // back
    run(m, fly([0, 0, 2]), secs(2) + 1); // right
    const parts = Object.fromEntries(m.parts().map((p) => [p.id, p.value]));
    expect(parts).toMatchObject({ forward: 1, back: 1, right: 1, left: 0 });
    expect(idOf(m)).toBe('pitch-roll');
    run(m, fly([0, 0, -2]), secs(1));
    expect(idOf(m)).toBe('pitch-roll');
    run(m, fly([0, 0, -2]), secs(1) + 2);
    expect(idOf(m)).toBe('land');
  });

  it('6 pitch & roll: drift under 0.3 m/s, ground sliding and disarmed motion do not count', () => {
    const m = at('pitch-roll');
    run(m, ctx({ armed: true, agl: 2, vel: [0, 0, -0.29] }), secs(30));
    run(m, ctx({ armed: true, agl: 0.1, vel: [0, 0, -3] }), secs(5));
    run(m, ctx({ armed: false, agl: 2, vel: [0, 0, -3] }), secs(5));
    expect(m.progress).toBe(0);
  });

  it('7 land: armed, AGL < 0.15 and speed < 0.3 for 1 s', () => {
    const m = at('land');
    m.update(ctx({ armed: true, agl: 2 }));
    run(m, ctx({ armed: true, agl: 0.1 }), secs(0.9));
    expect(idOf(m)).toBe('land');
    expect(m.progress).toBeLessThan(1);
    m.update(ctx({ armed: true, agl: 0.1, vel: [0.3, 0, 0] }));
    run(m, ctx({ armed: true, agl: 0.1 }), secs(0.9));
    expect(idOf(m)).toBe('land');
    run(m, ctx({ armed: true, agl: 0.14 }), secs(0.2));
    expect(idOf(m)).toBe('disarm');
  });

  it('7 land: a disarmed drone on the ground (crash-landed) does not count', () => {
    const m = at('land');
    run(m, ctx({ armed: false, agl: 0.05 }), secs(3));
    expect(idOf(m)).toBe('land');
  });

  it('8 disarm: completes when disarmed', () => {
    const m = at('disarm');
    run(m, ctx({ armed: true }), 30);
    expect(idOf(m)).toBe('disarm');
    m.update(ctx({ armed: false }));
    expect(idOf(m)).toBe('modes');
  });

  it('9 angle vs acro: acro seen, then angle', () => {
    const m = at('modes');
    run(m, ctx({ flightMode: 'angle' }), 30);
    expect(m.progress).toBe(0);
    m.update(ctx({ flightMode: 'acro' }));
    expect(m.progress).toBe(0.5);
    run(m, ctx({ flightMode: 'acro' }), 30);
    expect(idOf(m)).toBe('modes');
    m.update(ctx({ flightMode: 'angle' }));
    expect(idOf(m)).toBe('cameras');
  });

  it('9 angle vs acro: an acro pilot arriving in acro gets no credit until a switch into acro this step', () => {
    const m = at('modes');
    run(m, ctx({ flightMode: 'acro' }), 30);
    expect(m.progress).toBe(0);
    expect(m.parts().map((p) => p.value)).toEqual([0, 0]);
    m.update(ctx({ flightMode: 'angle' }));
    expect(m.progress).toBe(0);
    m.update(ctx({ flightMode: 'acro' }));
    expect(m.progress).toBe(0.5);
    m.update(ctx({ flightMode: 'angle' }));
    expect(idOf(m)).toBe('cameras');
  });

  it('10 cameras: LOS, FPV and chase each active once', () => {
    const m = at('cameras');
    m.update(ctx({ cameraMode: 'los' }));
    m.update(ctx({ cameraMode: 'fpv' }));
    m.update(ctx({ cameraMode: 'los' }));
    expect(m.progress).toBeCloseTo(2 / 3, 6);
    expect(idOf(m)).toBe('cameras');
    m.update(ctx({ cameraMode: 'chase' }));
    expect(idOf(m)).toBe('ring');
  });

  it('11 first ring: one more ring than when the step started (any baseline, resets rebase)', () => {
    const m = at('ring');
    run(m, ctx({ ringsPassed: 5, armed: true, agl: 2 }), 10);
    expect(idOf(m)).toBe('ring');
    m.update(ctx({ ringsPassed: 0 }));
    expect(idOf(m)).toBe('ring');
    m.update(ctx({ ringsPassed: 1 }));
    expect(idOf(m)).toBe('done');
  });

  it('12 done: phase done, record done, progress 1, nothing else advances', () => {
    const storage = new MemStorage();
    const m = at('ring', storage);
    m.update(ctx({ ringsPassed: 0 }));
    const ev = m.update(ctx({ ringsPassed: 1 }));
    expect(ev).toEqual([{ type: 'step', index: 11, id: 'done' }, { type: 'done' }]);
    expect(m.phase).toBe('done');
    expect(m.overall).toBe(1);
    expect(m.update(ctx({ confirm: true }))).toEqual([]);
    expect(loadTutorialRecord(storage)).toEqual({ done: true, skipped: false, step: 12, at: 1000 });
  });

  it('advances at most one step per update', () => {
    const m = at('throttle');
    // agl ≥ 1.5 completes throttle; hover needs time, so it must not complete in the same frame
    m.update(ctx({ armed: true, agl: 2 }));
    expect(idOf(m)).toBe('hover');
    expect(m.progress).toBe(0);
  });
});

describe('scripted full run', () => {
  it('goes from welcome to done with plausible flight data', () => {
    const storage = new MemStorage();
    const m = new TutorialMachine({ storage, now: () => 42 });
    const ev = m.start('acro');
    expect(ev).toEqual([{ type: 'step', index: 0, id: 'welcome' }]);
    const seen: TutorialStepId[] = [];
    const push = (e: TutorialEvent[]) => e.forEach((x) => x.type === 'step' && seen.push(x.id));
    push(m.update(ctx({ confirm: true })));
    push(m.update(ctx({ armed: true })));
    push(run(m, (i) => ctx({ armed: true, agl: Math.min(2, i * 0.05) }), 40));
    push(run(m, ctx({ armed: true, agl: 2 }), secs(3) + 2));
    let h = 0;
    push(run(m, () => ctx({ armed: true, agl: 2, heading: (h += 120 * DT) }), secs(1.5) + 2));
    push(run(m, () => ctx({ armed: true, agl: 2, heading: (h -= 120 * DT) }), secs(1.5) + 2));
    for (const v of [[0, 0, -2], [0, 0, 2], [2, 0, 0], [-2, 0, 0]] as [number, number, number][]) {
      push(run(m, ctx({ armed: true, agl: 2, heading: 0, vel: v }), secs(2) + 1));
    }
    push(run(m, (i) => ctx({ armed: true, agl: Math.max(0.05, 2 - i * 0.05) }), secs(2)));
    push(m.update(ctx({ armed: false })));
    // the modes step starts in angle (main.ts), even for this acro pilot
    push(m.update(ctx({ flightMode: 'angle' })));
    push(m.update(ctx({ flightMode: 'acro' })));
    push(m.update(ctx({ flightMode: 'angle' })));
    for (const c of ['los', 'fpv', 'chase'] as const) push(m.update(ctx({ cameraMode: c })));
    push(m.update(ctx({ ringsPassed: 0, armed: true })));
    push(m.update(ctx({ ringsPassed: 1, armed: true })));
    expect(seen).toEqual(['arm', 'throttle', 'hover', 'yaw', 'pitch-roll', 'land', 'disarm', 'modes', 'cameras', 'ring', 'done']);
    expect(m.phase).toBe('done');
    expect(m.playerFlightMode).toBe('acro');
  });
});

describe('forced angle mode and locked buttons', () => {
  it('angle forced on steps 2–8 only; arm locked on the welcome card; mode toggle locked while forced', () => {
    const forced: Record<string, boolean> = {};
    const locked: Record<string, readonly string[]> = {};
    for (const s of TUTORIAL_STEPS.slice(0, -1)) {
      const m = at(s.id);
      forced[s.id] = m.requiredFlightMode() === 'angle';
      locked[s.id] = m.lockedButtons();
    }
    expect(forced).toEqual({
      welcome: false, arm: true, throttle: true, hover: true, yaw: true, 'pitch-roll': true, land: true, disarm: true,
      modes: false, cameras: false, ring: false,
    });
    expect(locked.welcome).toEqual(['arm']);
    expect(locked.hover).toEqual(['toggleMode']);
    expect(locked.modes).toEqual([]);
  });

  it('nothing is forced or locked when idle, skipped or done', () => {
    const m = new TutorialMachine();
    expect(m.requiredFlightMode()).toBeNull();
    m.start('angle', 3);
    expect(m.requiredFlightMode()).toBe('angle');
    m.skip();
    expect(m.requiredFlightMode()).toBeNull();
    expect(m.lockedButtons()).toEqual([]);
  });
});

describe('crash → repeat step', () => {
  it('a crash restarts the current step and asks for a respawn', () => {
    const m = at('hover');
    run(m, ctx({ armed: true, agl: 2 }), secs(2));
    expect(m.progress).toBeGreaterThan(0.6);
    expect(m.crash()).toBe(true);
    expect(idOf(m)).toBe('hover');
    expect(m.progress).toBe(0);
    run(m, ctx({ armed: true, agl: 2 }), secs(2));
    expect(idOf(m)).toBe('hover');
  });

  it('a crash clears accumulated sub-goals (yaw bars)', () => {
    const m = at('yaw');
    let h = 0;
    run(m, () => ctx({ armed: true, agl: 2, heading: (h += 90 * DT) }), secs(1));
    expect(m.parts()[0]!.value).toBeGreaterThan(0.4);
    m.crash();
    expect(m.parts().map((p) => p.value)).toEqual([0, 0]);
  });

  it('is ignored when the tutorial is not running', () => {
    const m = new TutorialMachine();
    expect(m.crash()).toBe(false);
    m.start('angle');
    m.skip();
    expect(m.crash()).toBe(false);
  });
});

describe('hint timer', () => {
  it('hints once after 20 s without progress, clears on progress', () => {
    const m = at('throttle');
    const idle = ctx({ armed: true, agl: 0.05 });
    const ev1 = run(m, idle, secs(HINT_AFTER) - 2);
    expect(ev1).toEqual([]);
    expect(m.hint).toBe(false);
    const ev2 = run(m, idle, 4);
    expect(ev2).toEqual([{ type: 'hint', id: 'throttle' }]);
    expect(m.hint).toBe(true);
    expect(run(m, idle, secs(30))).toEqual([]);
    m.update(ctx({ armed: true, agl: 0.5 }));
    expect(m.hint).toBe(false);
  });

  it('progress restarts the 20 s count', () => {
    const m = at('throttle');
    run(m, ctx({ armed: true, agl: 0.05 }), secs(HINT_AFTER - 1));
    m.update(ctx({ armed: true, agl: 0.5 }));
    expect(run(m, ctx({ armed: true, agl: 0.5 }), secs(HINT_AFTER - 1))).toEqual([]);
    expect(m.hint).toBe(false);
  });

  it('progress that falls back (hover window reset) does not count as progress', () => {
    const m = at('hover');
    run(m, ctx({ armed: true, agl: 2 }), secs(1));
    const ev = run(m, (i) => ctx({ armed: true, agl: i % 2 ? 2 : 5 }), secs(HINT_AFTER) + 2);
    expect(ev).toContainEqual({ type: 'hint', id: 'hover' });
  });

  it('restarts with each step', () => {
    const m = at('arm');
    run(m, ctx(), secs(HINT_AFTER - 1));
    m.update(ctx({ armed: true }));
    expect(run(m, ctx({ armed: true, agl: 0.05 }), secs(HINT_AFTER - 1))).toEqual([]);
  });
});

describe('skip, persistence and replay', () => {
  it('skip persists {skipped} and the first-run prompt is never offered again', () => {
    const storage = new MemStorage();
    expect(shouldOfferTutorial(loadTutorialRecord(storage))).toBe(true);
    const m = new TutorialMachine({ storage, now: () => 7 });
    expect(m.skip()).toEqual([{ type: 'skipped' }]);
    expect(m.phase).toBe('skipped');
    expect(JSON.parse(storage.getItem(TUTORIAL_KEY)!)).toEqual({ done: false, skipped: true, step: 1, at: 7 });
    expect(shouldOfferTutorial(loadTutorialRecord(storage))).toBe(false);
    expect(m.skip()).toEqual([]);
  });

  it('skip mid-way records the step reached', () => {
    const storage = new MemStorage();
    const m = at('yaw', storage);
    m.skip();
    expect(loadTutorialRecord(storage)).toMatchObject({ skipped: true, step: 5, done: false });
  });

  it('each step entry is saved (resume point); the first-run prompt is shown once, not again for an unfinished run', () => {
    const storage = new MemStorage();
    const m = at('welcome', storage);
    m.update(ctx({ confirm: true }));
    expect(loadTutorialRecord(storage)).toEqual({ done: false, skipped: false, step: 2, at: 1000 });
    expect(shouldOfferTutorial(loadTutorialRecord(storage))).toBe(false);
  });

  it('no hold-to-skip: only skip() ends the run, on any source', () => {
    for (const source of ['gamepad', 'xr', 'keyboard', 'touch'] as const) {
      const m = at('hover');
      run(m, ctx({ source }), secs(5));
      expect(m.phase).toBe('running');
      expect(m.skip()).toEqual([{ type: 'skipped' }]);
      expect(m.phase).toBe('skipped');
    }
  });

  it('replay after finishing starts at step 1 and keeps done', () => {
    const storage = new MemStorage();
    const m = at('ring', storage);
    m.update(ctx({ ringsPassed: 0 }));
    m.update(ctx({ ringsPassed: 1 }));
    expect(m.phase).toBe('done');
    expect(m.start('angle')).toEqual([{ type: 'step', index: 0, id: 'welcome' }]);
    expect(m.phase).toBe('running');
    expect(m.progress).toBe(0);
    expect(loadTutorialRecord(storage)).toMatchObject({ done: true, step: 1 });
    m.skip();
    expect(loadTutorialRecord(storage)).toMatchObject({ done: true, skipped: true });
  });

  it('replay after a skip runs again (skip is not sticky on the machine)', () => {
    const m = new TutorialMachine();
    m.skip();
    m.start('angle');
    expect(m.phase).toBe('running');
    m.update(ctx({ confirm: true }));
    expect(idOf(m)).toBe('arm');
  });

  it('start clamps the resume step and never starts on the done card', () => {
    const m = new TutorialMachine();
    m.start('angle', 99);
    expect(idOf(m)).toBe('ring');
    m.start('angle', -3);
    expect(idOf(m)).toBe('welcome');
    m.start('angle', Number.NaN);
    expect(idOf(m)).toBe('welcome');
  });

  it('records: corrupt / foreign data → null or sane values; storage errors never throw', () => {
    const s = new MemStorage();
    s.setItem(TUTORIAL_KEY, '{nope');
    expect(loadTutorialRecord(s)).toBeNull();
    s.setItem(TUTORIAL_KEY, '[1,2]');
    expect(loadTutorialRecord(s)).toBeNull();
    s.setItem(TUTORIAL_KEY, JSON.stringify({ done: 'yes', skipped: 1, step: 40, at: 'x' }));
    expect(loadTutorialRecord(s)).toEqual({ done: false, skipped: false, step: 12, at: 0 });
    expect(loadTutorialRecord(null)).toBeNull();
    const t = new ThrowingStorage();
    expect(loadTutorialRecord(t)).toBeNull();
    expect(() => saveTutorialRecord(t, { done: true, skipped: false, step: 1, at: 0 })).not.toThrow();
    const m = new TutorialMachine({ storage: t });
    expect(() => m.start('angle')).not.toThrow();
    expect(() => m.skip()).not.toThrow();
  });

  it('a bad dt (NaN, negative) never advances timers', () => {
    const m = at('hover');
    run(m, ctx({ armed: true, agl: 2, dt: Number.NaN }), 600);
    run(m, ctx({ armed: true, agl: 2, dt: -1 }), 600);
    expect(m.progress).toBe(0);
    expect(m.hint).toBe(false);
  });
});
