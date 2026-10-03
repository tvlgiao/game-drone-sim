import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { DRY_SEARCH_RADIUS, RaceController } from '../../src/game/race';
import { createDroneState } from '../../src/physics/physics-world';
import { findDryGround, isUnderWater, type HeightField } from '../../src/physics/terrain';
import type { DroneState, GameEvent, RingDef } from '../../src/types';
import { HILLS, box, outdoor, raised } from './terrain-helpers';

function drone(x: number, y: number, z: number): DroneState {
  const d = createDroneState();
  d.position.set(x, y, z);
  return d;
}

function hold(rc: RaceController, d: DroneState, seconds: number, dt = 0.01): GameEvent[] {
  const out: GameEvent[] = [];
  const prev = d.position.clone();
  for (let t = 0; t < seconds - 1e-9; t += dt) out.push(...rc.step(dt, prev, d, []));
  return out;
}

const ring = (x: number, y: number, z: number): RingDef => ({ id: 'r', position: [x, y, z], direction: [0, 0, -1], radius: 1.25, tube: 0.1 });

/** Race through ring 0 (direction −z) and return the checkpoint respawn. */
function passRing(rc: RaceController, r: RingDef): ReturnType<RaceController['respawnPoint']> {
  rc.startRace();
  hold(rc, drone(r.position[0], r.position[1], r.position[2] + 5), 3.2);
  const d = drone(r.position[0], r.position[1], r.position[2] + 0.3);
  rc.step(0.01, d.position.clone(), d, []);
  const prev = d.position.clone();
  d.position.z = r.position[2] - 0.3;
  rc.step(0.01, prev, d, []);
  expect(rc.snapshot().nextRing).toBe(1);
  return rc.respawnPoint();
}

/** A lake (water at 0) west of x = 20; the shore rises east of it. */
const LAKE: HeightField = { heightAt: (x) => (x < 20 ? -2 : (x - 20) * 0.5), waterLevelAt: () => 0 };
const OCEAN: HeightField = { heightAt: () => -5, waterLevelAt: () => 0 };

describe('respawn on terrain', () => {
  it('a checkpoint over water moves to the nearest dry ground (8 directions, ≤ 40 m)', () => {
    const rt = outdoor(LAKE, { rings: [ring(0, 3, 0), ring(0, 3, -30)], spawn: { position: [30, LAKE.heightAt(30, 0) + 0.06, 0], yaw: 0 } });
    const p = passRing(new RaceController(rt, null), rt.def.rings[0]!).position;
    expect(isUnderWater(LAKE, p.x, p.z)).toBe(false);
    // east is the only dry direction; the first dry probe is 20 m out (the shoreline, water level = ground)
    expect(p.x).toBeCloseTo(20, 6);
    expect(p.z).toBeCloseTo(-1.2, 6);
    expect(p.y).toBeCloseTo(LAKE.heightAt(20, 0) + 0.06, 6);
    expect(Math.hypot(p.x - 0, p.z + 1.2)).toBeLessThanOrEqual(DRY_SEARCH_RADIUS);
  });

  it('with no dry ground within 40 m the checkpoint falls back to the level spawn', () => {
    const rt = outdoor(OCEAN, { rings: [ring(0, 3, 0), ring(0, 3, -30)], spawn: { position: [100, 0.06, 0], yaw: 0.5 } });
    const r = passRing(new RaceController(rt, null), rt.def.rings[0]!);
    expect(r.position.toArray()).toEqual([100, 0.06, 0]);
    expect(r.yaw).toBe(0.5);
  });

  it('findDryGround prefers the closest shore and leaves a dry start where it is', () => {
    const out = { x: 0, z: 0 };
    expect(findDryGround(LAKE, 25, 3, out)).toBe(true);
    expect(out).toEqual({ x: 25, z: 3 });
    expect(findDryGround(LAKE, 17, 0, out)).toBe(true);
    expect(out.x).toBeCloseTo(21, 9);
    expect(findDryGround(OCEAN, 0, 0, out)).toBe(false);
    expect(findDryGround(HILLS, 0, 0, out)).toBe(true);
  });

  it('on hills the respawn keeps the spawn’s clearance over the ground below the ring', () => {
    const sp: [number, number, number] = [10, HILLS.heightAt(10, 10) + 0.06, 10];
    const rt = outdoor(HILLS, { rings: [ring(-20, HILLS.heightAt(-20, 0) + 3, 0), ring(0, 30, -30)], spawn: { position: sp, yaw: 0 } });
    const p = passRing(new RaceController(rt, null), rt.def.rings[0]!).position;
    expect(p.y).toBeCloseTo(HILLS.heightAt(p.x, p.z) + 0.06, 9);
  });

  it('a rooftop in the collider grid is a landing surface for the respawn', () => {
    const rt = outdoor(raised(4), { rings: [ring(0, 15, 0), ring(0, 15, -30)], spawn: { position: [30, 4.06, 0], yaw: 0 } });
    rt.grid!.insertOwned('chunk', [box('block', [0, 9, -1], [5, 5, 5])]);
    const p = passRing(new RaceController(rt, null), rt.def.rings[0]!).position;
    expect(p.y).toBeCloseTo(14.06, 9);
  });
});

describe('surfaces from the height field and the collider grid', () => {
  it('ground is heightAt; streamed box tops count while their chunk is loaded', () => {
    const rt = outdoor(HILLS);
    expect(rt.surfaces.topBelow(7, 100, -3)).toBe(HILLS.heightAt(7, -3));
    const g = HILLS.heightAt(40, 40);
    rt.grid!.insertOwned('c', [box('roof', [40, g + 5, 40], [3, 5, 3], 0.7)]);
    expect(rt.surfaces.topBelow(40, g + 20, 40)).toBeCloseTo(g + 10, 9);
    // under the roof's top (inside / beside the house) the ground is what counts
    expect(rt.surfaces.topBelow(40, g + 5, 40)).toBe(g);
    rt.grid!.removeOwner('c');
    expect(rt.surfaces.topBelow(40, g + 20, 40)).toBe(g);
  });
});

describe('race checks use height above the ground', () => {
  const inverted = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI);

  it('upside down 0.2 m above a 50 m plateau is a crash; 5 m above it is not', () => {
    const rt = outdoor(raised(50));
    const rc = new RaceController(rt, null);
    rc.startFreeFly();
    const low = drone(0, 50.2, 0);
    low.orientation.copy(inverted);
    expect(hold(rc, low, 1.2).some((e) => e.type === 'crash')).toBe(true);
    const rc2 = new RaceController(rt, null);
    rc2.startFreeFly();
    const high = drone(0, 55, 0);
    high.orientation.copy(inverted);
    expect(hold(rc2, high, 1.2).some((e) => e.type === 'crash')).toBe(false);
  });

  it('the altitude cap (bounds.maxAgl) is above the ground under the drone', () => {
    const rt = outdoor(raised(100), { bounds: { kind: 'infinite', maxAgl: 120 } });
    const rc = new RaceController(rt, null);
    rc.startFreeFly();
    expect(hold(rc, drone(0, 210, 0), 0.5).some((e) => e.type === 'out-of-bounds')).toBe(false);
    expect(hold(rc, drone(0, 230, 0), 0.5).some((e) => e.type === 'out-of-bounds')).toBe(true);
  });
});
