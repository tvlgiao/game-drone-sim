import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import {
  RaceController,
  RESPAWN_OFFSET,
  bestTimeKey,
  ringCrossing,
  yawTowards,
} from '../../src/game/race';
import type { Contact, DroneState, GameEvent, LevelDef } from '../../src/types';
import { LOFT_LEVEL } from '../../src/game/level-data';
import { Simulation } from '../../src/physics/simulation';

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

/** Two rings along −Z, 5 m apart, radius 0.75. */
const LEVEL: LevelDef = {
  name: 'Test',
  room: { size: [20, 6, 20], windows: [] },
  props: [],
  rings: [
    { id: 'r0', position: [0, 1.5, -2], direction: [0, 0, -1], radius: 0.75, tube: 0.07 },
    { id: 'r1', position: [0, 1.5, -7], direction: [0, 0, -1], radius: 0.75, tube: 0.07 },
  ],
  spawn: { position: [0, 0.06, 2], yaw: 0 },
  pilot: [0, 1.7, 4],
};

const DT = 0.001;

function drone(pos = new Vector3(0, 1.5, 0)): DroneState {
  return {
    position: pos,
    velocity: new Vector3(),
    orientation: new Quaternion(),
    angularVelocity: new Vector3(),
    motors: [0, 0, 0, 0],
    armed: true,
    batteryVoltage: 16.8,
  };
}

function contact(impactSpeed: number): Contact {
  return { normal: new Vector3(0, 1, 0), depth: 0.001, point: new Vector3(), impactSpeed, colliderId: 'floor' };
}

/** Runs `seconds` of steps with the drone standing still; returns all events. */
function idle(rc: RaceController, seconds: number, s = drone(), contacts: Contact[] = []): GameEvent[] {
  const out: GameEvent[] = [];
  const prev = s.position.clone();
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) out.push(...rc.step(DT, prev, s, contacts));
  return out;
}

/** Moves the drone in small steps along a straight segment; returns events. */
function fly(rc: RaceController, s: DroneState, to: Vector3, stepLen = 0.01): GameEvent[] {
  const out: GameEvent[] = [];
  const from = s.position.clone();
  const n = Math.max(1, Math.ceil(from.distanceTo(to) / stepLen));
  const prev = new Vector3();
  for (let i = 1; i <= n; i++) {
    prev.copy(s.position);
    s.position.lerpVectors(from, to, i / n);
    out.push(...rc.step(DT, prev, s, []));
  }
  return out;
}

function startedRace(storage: Storage | null = new MemStorage()): RaceController {
  const rc = new RaceController(LEVEL, storage);
  rc.startRace();
  idle(rc, 3.001);
  expect(rc.snapshot().status).toBe('racing');
  return rc;
}

describe('ringCrossing', () => {
  const c: [number, number, number] = [0, 0, 0];
  const d: [number, number, number] = [0, 0, -1];
  const out = new Vector3();
  it('passes in the ring direction inside the radius', () => {
    expect(ringCrossing(new Vector3(0.2, 0.1, 0.05), new Vector3(0.2, 0.1, -0.05), c, d, 0.75, out)).not.toBeNull();
    expect(out.z).toBeCloseTo(0);
  });
  it('rejects the reverse direction', () => {
    expect(ringCrossing(new Vector3(0, 0, -0.05), new Vector3(0, 0, 0.05), c, d, 0.75, out)).toBeNull();
  });
  it('rejects crossings outside the radius', () => {
    expect(ringCrossing(new Vector3(0.8, 0, 0.05), new Vector3(0.8, 0, -0.05), c, d, 0.75, out)).toBeNull();
  });
});

describe('RaceController countdown', () => {
  it('emits respawn + 3, then 2, 1 each second and race-start at 0', () => {
    const rc = new RaceController(LEVEL, null);
    rc.startRace();
    const seen: { t: number; e: GameEvent }[] = [];
    const s = drone();
    for (let i = 1; i <= 3200; i++) for (const e of rc.step(DT, s.position, s, [])) seen.push({ t: i * DT, e });
    const types = seen.map(({ e }) => (e.type === 'countdown' ? `c${e.value}` : e.type));
    expect(types).toEqual(['respawn', 'c3', 'c2', 'c1', 'race-start']);
    expect(seen[2]!.t).toBeCloseTo(1.001, 2);
    expect(seen[3]!.t).toBeCloseTo(2.001, 2);
    expect(seen[4]!.t).toBeCloseTo(3.0, 2);
    const snap = rc.snapshot();
    expect(snap.status).toBe('racing');
    expect(snap.time).toBeLessThan(0.21);
    expect(snap.time).toBeGreaterThan(0.19);
  });

  it('timer does not run during countdown', () => {
    const rc = new RaceController(LEVEL, null);
    rc.startRace();
    idle(rc, 2.5);
    expect(rc.snapshot().time).toBe(0);
    expect(rc.snapshot().countdown).toBe(1);
  });
});

describe('RaceController rings', () => {
  it('counts the next ring passed in its direction', () => {
    const rc = startedRace();
    const s = drone(new Vector3(0, 1.5, 0));
    const ev = fly(rc, s, new Vector3(0, 1.5, -3));
    const passed = ev.filter((e) => e.type === 'ring-passed');
    expect(passed).toHaveLength(1);
    expect(passed[0]).toMatchObject({ index: 0 });
    expect(rc.snapshot().nextRing).toBe(1);
  });

  it('ignores a ring crossed backwards', () => {
    const rc = startedRace();
    const s = drone(new Vector3(0, 1.5, -3));
    expect(fly(rc, s, new Vector3(0, 1.5, 0)).some((e) => e.type === 'ring-passed')).toBe(false);
    expect(rc.snapshot().nextRing).toBe(0);
  });

  it('ignores a crossing outside the radius', () => {
    const rc = startedRace();
    const s = drone(new Vector3(1, 1.5, 0));
    expect(fly(rc, s, new Vector3(1, 1.5, -3)).some((e) => e.type === 'ring-passed')).toBe(false);
  });

  it('ignores rings flown out of order', () => {
    const rc = startedRace();
    const s = drone(new Vector3(3, 1.5, -6));
    fly(rc, s, new Vector3(0, 1.5, -6));
    expect(fly(rc, s, new Vector3(0, 1.5, -8)).some((e) => e.type === 'ring-passed')).toBe(false);
    expect(rc.snapshot().nextRing).toBe(0);
  });

  it('free-fly passes rings in any order and has no timer', () => {
    const rc = new RaceController(LEVEL, null);
    rc.startFreeFly();
    const s = drone(new Vector3(3, 1.5, -6));
    idle(rc, 0.01, s);
    fly(rc, s, new Vector3(0, 1.5, -6));
    const ev = fly(rc, s, new Vector3(0, 1.5, -8));
    expect(ev.filter((e) => e.type === 'ring-passed')).toMatchObject([{ index: 1 }]);
    expect(rc.snapshot().time).toBe(0);
    expect(rc.snapshot().nextRing).toBe(-1);
  });
});

describe('RaceController finish + best time', () => {
  it('finishes after the last ring and persists the best time', () => {
    const storage = new MemStorage();
    const rc = startedRace(storage);
    const s = drone(new Vector3(0, 1.5, 0));
    const ev = fly(rc, s, new Vector3(0, 1.5, -8));
    const fin = ev.find((e) => e.type === 'race-finish');
    expect(fin).toBeDefined();
    expect(fin).toMatchObject({ best: true });
    const snap = rc.snapshot();
    expect(snap.status).toBe('finished');
    expect(Number(storage.getItem(bestTimeKey('Test')))).toBeCloseTo(snap.time, 6);
    expect(snap.bestTime).toBeCloseTo(snap.time, 6);

    // Slower second run: not a new best, stored value unchanged, split delta is positive.
    const rc2 = startedRace(storage);
    const s2 = drone(new Vector3(0, 1.5, 0));
    idle(rc2, 0.5, s2);
    const ev2 = fly(rc2, s2, new Vector3(0, 1.5, -8));
    expect(ev2.find((e) => e.type === 'race-finish')).toMatchObject({ best: false });
    expect(rc2.snapshot().lastSplit).toBeGreaterThan(0.4);
    expect(Number(storage.getItem(bestTimeKey('Test')))).toBeCloseTo(snap.time, 6);
  });

  it('survives throwing and missing storage', () => {
    for (const st of [new ThrowingStorage(), null]) {
      const rc = startedRace(st);
      const s = drone(new Vector3(0, 1.5, 0));
      expect(fly(rc, s, new Vector3(0, 1.5, -8)).some((e) => e.type === 'race-finish')).toBe(true);
    }
  });

  it('ignores corrupt stored best', () => {
    const storage = new MemStorage();
    storage.setItem(bestTimeKey('Test'), 'garbage');
    expect(new RaceController(LEVEL, storage).snapshot().bestTime).toBeNull();
  });
});

describe('RaceController crash', () => {
  it('light hit emits collision, hard hit crashes and respawns after 1.5 s', () => {
    const rc = startedRace();
    const light = idle(rc, 0.001, drone(), [contact(1.5)]);
    expect(light.map((e) => e.type)).toEqual(['collision']);
    expect(idle(rc, 0.001, drone(), [contact(0.5)])).toEqual([]);
    expect(rc.snapshot().status).toBe('racing');

    const hard = idle(rc, 0.001, drone(), [contact(5.5)]);
    expect(hard.map((e) => e.type)).toEqual(['crash']);
    expect(rc.snapshot().status).toBe('crashed');
    expect(idle(rc, 1.49).some((e) => e.type === 'respawn')).toBe(false);
    expect(idle(rc, 0.02).some((e) => e.type === 'respawn')).toBe(true);
    expect(rc.snapshot().status).toBe('racing');
  });

  it('exactly 5 m/s is not a crash', () => {
    const rc = startedRace();
    expect(idle(rc, 0.001, drone(), [contact(5)]).map((e) => e.type)).toEqual(['collision']);
  });

  it('upside down on the floor for more than 1 s crashes', () => {
    const rc = startedRace();
    const s = drone(new Vector3(0, 0.1, 0));
    s.orientation.setFromAxisAngle(new Vector3(1, 0, 0), Math.PI);
    expect(idle(rc, 0.99, s).some((e) => e.type === 'crash')).toBe(false);
    expect(idle(rc, 0.02, s).some((e) => e.type === 'crash')).toBe(true);
  });

  it('upside down high in the air is not a crash', () => {
    const rc = startedRace();
    const s = drone(new Vector3(0, 2, 0));
    s.orientation.setFromAxisAngle(new Vector3(1, 0, 0), Math.PI);
    expect(idle(rc, 2, s).some((e) => e.type === 'crash')).toBe(false);
  });

  it('free-fly crashes respawn too', () => {
    const rc = new RaceController(LEVEL, null);
    rc.startFreeFly();
    idle(rc, 0.001, drone(), [contact(8)]);
    expect(rc.snapshot().status).toBe('crashed');
    expect(idle(rc, 1.6).some((e) => e.type === 'respawn')).toBe(true);
    expect(rc.snapshot().status).toBe('freefly');
  });

  it('requestReset respawns on the next step', () => {
    const rc = startedRace();
    rc.requestReset();
    expect(idle(rc, 0.001).map((e) => e.type)).toEqual(['respawn']);
  });
});

describe('RaceController respawn point', () => {
  it('uses the level spawn before any ring', () => {
    const rc = startedRace();
    const p = rc.respawnPoint();
    expect(p.position.toArray()).toEqual(LEVEL.spawn.position);
    expect(p.yaw).toBe(LEVEL.spawn.yaw);
  });

  it('sits on the floor past the last passed ring, facing the next one', () => {
    const rc = startedRace();
    const s = drone(new Vector3(0, 1.5, 0));
    fly(rc, s, new Vector3(0, 1.5, -3));
    const p = rc.respawnPoint();
    expect(p.position.x).toBeCloseTo(0);
    expect(p.position.y).toBeCloseTo(LEVEL.spawn.position[1]);
    expect(p.position.z).toBeCloseTo(-2 - RESPAWN_OFFSET);
    expect(p.yaw).toBeCloseTo(0); // next ring straight ahead along −Z
  });

  it('yaw convention: 0 faces −Z, +π/2 faces −X (left turn)', () => {
    expect(yawTowards({ x: 0, z: 0 }, { x: 0, z: -1 })).toBeCloseTo(0);
    expect(yawTowards({ x: 0, z: 0 }, { x: -1, z: 0 })).toBeCloseTo(Math.PI / 2);
    expect(yawTowards({ x: 0, z: 0 }, { x: 1, z: 0 })).toBeCloseTo(-Math.PI / 2);
  });

  it('lands on a prop top below the checkpoint instead of the floor', () => {
    const lvl: LevelDef = {
      ...LEVEL,
      props: [{ id: 'crate', kind: 'crate', position: [0, 0, -3.2], size: [1, 0.8, 1], colliders: [{ id: 'crate', shape: { kind: 'box', center: [0, 0.4, -3.2], half: [0.5, 0.4, 0.5] } }] }],
    };
    const rc = new RaceController(lvl, null);
    rc.startRace();
    idle(rc, 3.01);
    fly(rc, drone(new Vector3(0, 1.5, 0)), new Vector3(0, 1.5, -3));
    expect(rc.respawnPoint().position.y).toBeCloseTo(0.8 + LEVEL.spawn.position[1]);
  });

  it('never loops crash → respawn: a disarmed quad set down at every Loft checkpoint stays put', () => {
    for (let i = 0; i < LOFT_LEVEL.rings.length - 1; i++) {
      const rc = new RaceController(LOFT_LEVEL, null);
      rc.startRace();
      idle(rc, 3.01);
      (rc as unknown as { lastPassed: number }).lastPassed = i;
      const p = rc.respawnPoint();
      const sim = new Simulation(LOFT_LEVEL);
      sim.world.reset(p.position, p.yaw);
      sim.setArmed(false, { throttle: 0, yaw: 0, pitch: 0, roll: 0 });
      const prev = new Vector3();
      const crashes: number[] = [];
      for (let k = 0; k < 3000; k++) {
        prev.copy(sim.world.state.position);
        const contacts = sim.step(DT, { throttle: 0, yaw: 0, pitch: 0, roll: 0 });
        for (const e of rc.step(DT, prev, sim.world.state, contacts)) if (e.type === 'crash') crashes.push(k);
      }
      expect({ ring: i, crashes }).toEqual({ ring: i, crashes: [] });
      expect(sim.world.state.position.distanceTo(p.position)).toBeLessThan(0.2);
    }
  });

  it('keeps the checkpoint on the floor for low rings on the real level', () => {
    const lvl: LevelDef = { ...LOFT_LEVEL, rings: [{ ...LOFT_LEVEL.rings[0]!, position: [0, 0.2, 0], direction: [0, -1, 0] }, LOFT_LEVEL.rings[1]!] };
    const rc = new RaceController(lvl, null);
    rc.startRace();
    idle(rc, 3.01);
    const s = drone(new Vector3(0, 0.5, 0));
    fly(rc, s, new Vector3(0, -0.05, 0));
    expect(rc.snapshot().nextRing).toBe(1);
    expect(rc.respawnPoint().position.y).toBeCloseTo(LOFT_LEVEL.spawn.position[1]);
  });
});

describe('RaceController pause', () => {
  it('pause freezes the timer and resume continues', () => {
    const rc = startedRace();
    idle(rc, 1);
    const t0 = rc.snapshot().time;
    rc.pause();
    expect(rc.snapshot().status).toBe('paused');
    idle(rc, 2);
    expect(rc.snapshot().time).toBe(t0);
    rc.resume();
    expect(rc.snapshot().status).toBe('racing');
    idle(rc, 0.5);
    expect(rc.snapshot().time).toBeCloseTo(t0 + 0.5, 6);
  });

  it('pause during countdown holds the countdown', () => {
    const rc = new RaceController(LEVEL, null);
    rc.startRace();
    idle(rc, 1.5);
    rc.pause();
    idle(rc, 5);
    rc.resume();
    expect(rc.snapshot().status).toBe('countdown');
  });
});
