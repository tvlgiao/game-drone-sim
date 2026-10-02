import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { LEVELS, DEFAULT_LEVEL, LAST_LEVEL_KEY, buildLevel, isPlayableLevel, loadLastLevel, nextLevel, saveLastLevel } from '../../src/levels/registry';
import { NIGHT_LOFT } from '../../src/levels/night-loft';
import { TRAINING_LEVEL } from '../../src/levels/training';
import { LOFT_LEVEL, levelColliders } from '../../src/game/level-data';
import { OUT_OF_BOUNDS_RESPAWN, RaceController, bestSplitsKey, bestTimeKey, migrateBestTimes, outOfBounds, readBestTime } from '../../src/game/race';
import { PhysicsWorld, createDroneState } from '../../src/physics/physics-world';
import { Simulation } from '../../src/physics/simulation';
import { CameraRig } from '../../src/render/camera-rig';
import type { DroneState, GameEvent } from '../../src/types';

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

describe('level registry', () => {
  it('lists Training first and Night Loft, with no tier or lock fields', () => {
    expect(LEVELS.map((l) => l.id)).toEqual(['training', 'night-loft']);
    for (const l of LEVELS) expect(l).not.toHaveProperty('tier');
  });

  it('buildLevel wraps each definition with colliders, surfaces and a resolved ready promise', async () => {
    for (const l of LEVELS) {
      const rt = buildLevel(l.id);
      expect(rt.def.id).toBe(l.id);
      await expect(rt.ready).resolves.toBeUndefined();
      expect(rt.colliders.length).toBeGreaterThan(0);
    }
    expect(() => buildLevel('city')).toThrow(/Unknown level/);
  });

  it('Night Loft is LOFT_LEVEL unchanged plus identity, environment and room bounds', () => {
    const { id, kind, env, bounds, pilotPlatform, ...rest } = NIGHT_LOFT;
    expect(rest).toEqual(LOFT_LEVEL);
    expect([id, kind, bounds.kind, pilotPlatform]).toEqual(['night-loft', 'indoor', 'room', 2.4]);
    expect(env.sky).toBe('night-loft');
    expect(buildLevel('night-loft').colliders).toEqual(levelColliders(LOFT_LEVEL));
  });

  it('remembers the last level; unknown or unreadable values fall back to the default', () => {
    const s = new MemStorage();
    // a first-time pilot starts on the beginner field
    expect(DEFAULT_LEVEL).toBe('training');
    expect(loadLastLevel(s)).toBe('training');
    saveLastLevel(s, 'night-loft');
    expect(loadLastLevel(s)).toBe('night-loft');
    s.setItem(LAST_LEVEL_KEY, 'city');
    expect(loadLastLevel(s)).toBe(DEFAULT_LEVEL);
    expect(loadLastLevel(null)).toBe(DEFAULT_LEVEL);
    const throwing = { getItem: () => { throw new Error('denied'); } } as unknown as Storage;
    expect(loadLastLevel(throwing)).toBe(DEFAULT_LEVEL);
    expect(isPlayableLevel('alpine')).toBe(false);
  });

  it('nextLevel cycles through the list both ways', () => {
    expect(nextLevel('training')).toBe('night-loft');
    expect(nextLevel('night-loft')).toBe('training');
    expect(nextLevel('training', -1)).toBe('night-loft');
  });
});

describe('Training Field data', () => {
  const b = TRAINING_LEVEL.bounds;
  it('is an 80 × 80 m field with a 40 m ceiling, pilot at the south edge and spawn on the pad 3 m ahead', () => {
    expect(b).toEqual({ kind: 'rect', min: [-40, -40], max: [40, 40], maxAgl: 40 });
    expect(TRAINING_LEVEL.pilot).toEqual([0, 1.7, 36]);
    const pad = TRAINING_LEVEL.props.find((p) => p.kind === 'pad')!;
    expect(pad.position[2]).toBe(33);
    expect(TRAINING_LEVEL.spawn.position[0]).toBe(pad.position[0]);
    expect(TRAINING_LEVEL.spawn.position[2]).toBe(pad.position[2]);
  });

  it('has three 1.25 m rings at the design coordinates, all inside bounds, below the ceiling and clear of the ground', () => {
    const r = TRAINING_LEVEL.rings;
    expect(r.map((x) => x.position)).toEqual([
      [0, 3, 22],
      [14, 4, 8],
      [-4, 3, 28],
    ]);
    expect(r[0]!.direction).toEqual([0, 0, -1]);
    expect(r[2]!.direction).toEqual([0, 0, 1]);
    for (const ring of r) {
      expect(ring.radius).toBe(1.25);
      expect(Math.hypot(...ring.direction)).toBeCloseTo(1, 9);
      const [x, y, z] = ring.position;
      const R = ring.radius + ring.tube;
      expect(outOfBounds(b, x - R, y, z - R) || outOfBounds(b, x + R, y + R, z + R)).toBe(false);
      expect(y - R).toBeGreaterThan(1);
      // all about 30 m from the pilot or nearer (R1 is 31.3 m): one fixed LOS view at the default FOV
      expect(Math.hypot(x - TRAINING_LEVEL.pilot[0], z - TRAINING_LEVEL.pilot[2])).toBeLessThanOrEqual(32);
    }
  });

  it('every collider-bearing prop inside the field stays clear of the rings and the pad; trees stay outside the field', () => {
    for (const p of TRAINING_LEVEL.props) {
      if (p.kind === 'tree') expect(Math.max(Math.abs(p.position[0]), Math.abs(p.position[2]))).toBeGreaterThan(40);
      if (p.colliders.length === 0) continue;
      for (const r of TRAINING_LEVEL.rings) expect(Math.hypot(p.position[0] - r.position[0], p.position[2] - r.position[2])).toBeGreaterThan(2);
      expect(Math.hypot(p.position[0], p.position[2] - 33)).toBeGreaterThan(3.5);
    }
  });
});

function drone(x: number, y: number, z: number): DroneState {
  const d = createDroneState();
  d.position.set(x, y, z);
  return d;
}

/** Steps the race `seconds` with the drone held at (x, y, z); returns every event. */
function hold(rc: RaceController, x: number, y: number, z: number, seconds: number, dt = 0.01): GameEvent[] {
  const out: GameEvent[] = [];
  const d = drone(x, y, z);
  const prev = new Vector3(x, y, z);
  for (let t = 0; t < seconds - 1e-9; t += dt) out.push(...rc.step(dt, prev, d, []));
  return out;
}

describe('soft bounds', () => {
  it('outOfBounds: rect footprint, AGL ceiling, rooms never', () => {
    const b = TRAINING_LEVEL.bounds;
    expect(outOfBounds(b, 0, 10, 0)).toBe(false);
    expect(outOfBounds(b, 40.01, 10, 0)).toBe(true);
    expect(outOfBounds(b, 0, 10, -40.01)).toBe(true);
    expect(outOfBounds(b, 0, 40.01, 0)).toBe(true);
    expect(outOfBounds(b, 0, 45, 0, 10)).toBe(false);
    expect(outOfBounds(NIGHT_LOFT.bounds, 999, 999, 999)).toBe(false);
  });

  it('counts down 5 s outside, then respawns at the spawn (free fly)', () => {
    const rc = new RaceController(buildLevel('training'), null);
    rc.startFreeFly();
    hold(rc, 0, 1, 30, 0.05);
    const ev = hold(rc, 50, 5, 0, OUT_OF_BOUNDS_RESPAWN + 0.05);
    const firstRespawn = ev.findIndex((e) => e.type === 'respawn');
    const counts = ev.slice(0, firstRespawn).filter((e) => e.type === 'out-of-bounds').map((e) => (e as { seconds: number }).seconds);
    expect(counts).toEqual([5, 4, 3, 2, 1]);
    expect(ev.filter((e) => e.type === 'respawn')).toHaveLength(1);
    expect(rc.respawnPoint().position.toArray()).toEqual(TRAINING_LEVEL.spawn.position);
    expect(rc.snapshot().status).toBe('freefly');
  });

  it('above the ceiling also counts; flying back in cancels with in-bounds and no respawn', () => {
    const rc = new RaceController(buildLevel('training'), null);
    rc.startFreeFly();
    hold(rc, 0, 1, 30, 0.05);
    const out = hold(rc, 0, 41, 0, 3);
    expect(out.some((e) => e.type === 'out-of-bounds')).toBe(true);
    const back = hold(rc, 0, 30, 0, 4);
    expect(back.map((e) => e.type)).toEqual(['in-bounds']);
  });

  it('a timer interrupted by returning starts over at 5 s', () => {
    const rc = new RaceController(buildLevel('training'), null);
    rc.startFreeFly();
    hold(rc, 0, 1, 30, 0.05);
    hold(rc, 50, 5, 0, 4);
    hold(rc, 0, 5, 0, 0.1);
    const ev = hold(rc, 50, 5, 0, 4);
    expect(ev.some((e) => e.type === 'respawn')).toBe(false);
  });

  it('the loft has no soft bounds', () => {
    const rc = new RaceController(buildLevel('night-loft'), null);
    rc.startFreeFly();
    hold(rc, 0, 1, 0, 0.05);
    expect(hold(rc, 500, 50, 0, 6).filter((e) => e.type !== 'collision')).toEqual([]);
  });
});

describe('best times by LevelId', () => {
  it('migrates the Night Loft display-name keys once and removes them', () => {
    const s = new MemStorage();
    s.setItem('drone-sim.best.Night Loft', '41.5');
    s.setItem('drone-sim.splits.Night Loft', '[1,2]');
    migrateBestTimes(s);
    expect(s.getItem(bestTimeKey('night-loft'))).toBe('41.5');
    expect(s.getItem(bestSplitsKey('night-loft'))).toBe('[1,2]');
    expect(s.getItem('drone-sim.best.Night Loft')).toBeNull();
    expect(s.getItem('drone-sim.splits.Night Loft')).toBeNull();
    expect(new RaceController(buildLevel('night-loft'), s).snapshot().bestTime).toBe(41.5);
  });

  it('an existing id key wins over the legacy one', () => {
    const s = new MemStorage();
    s.setItem('drone-sim.best.Night Loft', '50');
    s.setItem(bestTimeKey('night-loft'), '40');
    migrateBestTimes(s);
    expect(readBestTime(s, 'night-loft')).toBe(40);
    expect(s.getItem('drone-sim.best.Night Loft')).toBeNull();
  });

  it('levels keep separate bests and setLevel reloads them', () => {
    const s = new MemStorage();
    s.setItem(bestTimeKey('training'), '22');
    s.setItem(bestTimeKey('night-loft'), '44');
    const rc = new RaceController(buildLevel('training'), s);
    expect(rc.snapshot().bestTime).toBe(22);
    rc.setLevel(buildLevel('night-loft'));
    expect(rc.snapshot()).toMatchObject({ bestTime: 44, status: 'menu', totalRings: 12 });
    expect(readBestTime(s, 'city')).toBeNull();
    expect(readBestTime(null, 'training')).toBeNull();
  });
});

describe('outdoor physics and surfaces', () => {
  it('the drone rests on flat ground under open sky: a ground contact, no walls or ceiling', () => {
    const w = new PhysicsWorld(buildLevel('training'));
    w.reset(new Vector3(5, 0.3, 5), 0);
    const ids = new Set<string>();
    for (let i = 0; i < 3000; i++) for (const c of w.step(0.001, [0, 0, 0, 0])) ids.add(c.colliderId);
    expect([...ids]).toEqual(['ground']);
    expect(w.state.position.y).toBeGreaterThan(0);
    expect(w.state.position.y).toBeLessThan(0.1);
  });

  it('nothing stops the drone where the loft walls would be, high up outdoors', () => {
    const w = new PhysicsWorld(buildLevel('training'));
    w.reset(new Vector3(0, 20, 0), 0);
    w.state.velocity.set(40, 0, 0);
    for (let i = 0; i < 1000; i++) expect(w.step(0.001, [0, 0, 0, 0])).toHaveLength(0);
    expect(w.state.position.x).toBeGreaterThan(20);
  });

  it('setLevel swaps loft ↔ training and back to the same loft behaviour', () => {
    const sim = new Simulation(buildLevel('night-loft'));
    sim.world.setLevel(buildLevel('training'));
    expect(sim.world.state.position.toArray()).toEqual(TRAINING_LEVEL.spawn.position);
    // straight through where the loft's west pillars stood: none of the loft's colliders remain
    sim.world.reset(new Vector3(-4.5, 3, 4), 0);
    sim.world.state.velocity.set(0, 0, -12);
    for (let i = 0; i < 1000; i++) expect(sim.world.step(0.001, [0.5, 0.5, 0.5, 0.5])).toHaveLength(0);
    expect(sim.world.state.position.z).toBeLessThan(-4);
    sim.world.setLevel(buildLevel('night-loft'));
    sim.world.reset(new Vector3(-4, 3, 4), 0);
    sim.world.state.velocity.set(0, 30, 0);
    const ids = new Set<string>();
    for (let i = 0; i < 400; i++) for (const c of sim.world.step(0.001, [0, 0, 0, 0])) ids.add(c.colliderId);
    expect(ids.has('ceiling')).toBe(true);
  });

  it('surfaces on flat ground: 0 on grass, the pad top on the pad, cone tops are not landing spots', () => {
    const s = buildLevel('training').surfaces;
    expect(s.topBelow(10, 5, 10)).toBe(0);
    expect(s.topBelow(0, 5, 33)).toBeCloseTo(0.01, 6);
    expect(s.topBelow(-2.6, 5, 29)).toBe(0);
  });

  it('a race checkpoint respawn sets the drone down on the ground below the ring', () => {
    const rc = new RaceController(buildLevel('training'), null);
    rc.startRace();
    hold(rc, 0, 0.06, 33, 3.2);
    const d = drone(0, 3, 22.2);
    rc.step(0.01, new Vector3(0, 3, 21.9), d, []);
    rc.step(0.01, new Vector3(0, 3, 22.2), d, []);
    expect(rc.snapshot().nextRing).toBe(0);
    const prev = new Vector3(0, 3, 22.3);
    d.position.set(0, 3, 21.9);
    rc.step(0.01, prev, d, []);
    expect(rc.snapshot().nextRing).toBe(1);
    const p = rc.respawnPoint();
    expect(p.position.y).toBeCloseTo(TRAINING_LEVEL.spawn.position[1], 6);
  });
});

describe('camera rig outdoors', () => {
  const settle = (rig: CameraRig, d: DroneState, mode: 'los' | 'chase' | 'fpv'): void => {
    for (let t = 0; t < 2; t += 1 / 60) rig.update({ dt: 1 / 60, time: t, drone: d, mode, cameraTiltDeg: 25, fovDeg: 110, speed: 0 });
  };

  it('chase is not boxed in: 30 m out and 25 m up it keeps its normal offset', () => {
    const rig = new CameraRig([0, 1.7, 36], null);
    rig.setLevel(TRAINING_LEVEL);
    const d = drone(30, 25, -30);
    settle(rig, d, 'chase');
    expect(rig.camera.position.z - d.position.z).toBeCloseTo(1, 1);
    expect(rig.camera.position.y - d.position.y).toBeCloseTo(0.35, 1);
    expect(rig.camera.far).toBeGreaterThan(500);
  });

  it('chase never goes under the ground', () => {
    const rig = new CameraRig([0, 1.7, 36], null);
    rig.setLevel(TRAINING_LEVEL);
    const d = drone(0, 0.05, 0);
    d.velocity.set(0, -6, 0);
    settle(rig, d, 'chase');
    expect(rig.camera.position.y).toBeGreaterThanOrEqual(0.15 - 1e-9);
  });

  it('LOS rests on the focus ring outdoors, and the room overview indoors', () => {
    const rig = new CameraRig([0, 1.7, 36], null);
    rig.setLevel(TRAINING_LEVEL);
    const ring = new Vector3(14, 4, 8);
    rig.setFocus(ring);
    const d = drone(14, 4, 8);
    settle(rig, d, 'los');
    const fwd = new Vector3(0, 0, -1).applyQuaternion(rig.camera.quaternion);
    const to = ring.clone().sub(rig.camera.position).normalize();
    expect(fwd.dot(to)).toBeGreaterThan(0.99);
    rig.setLevel(NIGHT_LOFT);
    rig.setFocus(ring);
    expect(rig.camera.far).toBe(90);
    settle(rig, drone(-9, 1, 5.8), 'los');
    const f2 = new Vector3(0, 0, -1).applyQuaternion(rig.camera.quaternion);
    expect(f2.dot(ring.clone().sub(rig.camera.position).normalize())).toBeLessThan(0.99);
  });
});
