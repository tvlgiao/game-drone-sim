import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { PhysicsWorld } from '../../src/physics/physics-world';
import { createSphereHit, sphereVsPlane, sphereVsTerrain, TERRAIN_NORMAL_EPS } from '../../src/physics/collision';
import { CENTER_COLLIDER_OFFSET, DEFAULT_DRONE, MOTOR_LAYOUT, hoverThrottle } from '../../src/physics/drone-params';
import { LEVEL_OWNER } from '../../src/levels/runtime';
import type { HeightField } from '../../src/physics/terrain';
import { CLIFF, FLAT, HILLS, WALL, box, outdoor, raised, rng, slope } from './terrain-helpers';

const DT = 0.001;
const OFF = [0, 0, 0, 0];
const REST_Y = DEFAULT_DRONE.colliderRadius - CENTER_COLLIDER_OFFSET[1];

function counting(f: HeightField): HeightField & { calls: number } {
  const c = { calls: 0, heightAt: (x: number, z: number) => (c.calls++, f.heightAt(x, z)) };
  return c;
}

/** Deepest bottom of any collision sphere below the terrain under its centre (m, > 0 = buried). */
function buried(w: PhysicsWorld, f: HeightField): number {
  const s = w.state;
  let worst = -Infinity;
  const c = new Vector3();
  const spheres: [readonly number[], number][] = [[CENTER_COLLIDER_OFFSET, DEFAULT_DRONE.colliderRadius], ...MOTOR_LAYOUT.map((m): [readonly number[], number] => [m.position, DEFAULT_DRONE.propColliderRadius])];
  for (const [off, r] of spheres) {
    c.fromArray(off as number[]).applyQuaternion(s.orientation).add(s.position);
    worst = Math.max(worst, f.heightAt(c.x, c.z) - (c.y - r));
  }
  return worst;
}

describe('sphereVsTerrain', () => {
  it('on flat ground equals the ground plane test exactly', () => {
    const a = createSphereHit();
    const b = createSphereHit();
    const c = new Vector3(3, 0.05, -2);
    expect(sphereVsTerrain(c, 0.075, FLAT, a)).toBe(true);
    expect(sphereVsPlane(c, 0.075, 0, 1, 0, 0, b)).toBe(true);
    expect(a.depth).toBe(b.depth);
    expect(a.normal.toArray()).toEqual(b.normal.toArray());
    expect(a.point.toArray()).toEqual(b.point.toArray());
  });

  it('measures depth along the slope normal (not straight down) and returns the uphill-facing normal', () => {
    const g = 1; // 45°
    const hit = createSphereHit();
    // centre 0.1 m vertically above the surface → 0.1·cos45° ≈ 0.0707 m from the plane
    const c = new Vector3(2, 2 + 0.1, 0);
    expect(sphereVsTerrain(c, 0.075, slope(g), hit)).toBe(true);
    expect(hit.depth).toBeCloseTo(0.075 - 0.1 / Math.SQRT2, 9);
    expect(hit.normal.x).toBeCloseTo(-1 / Math.SQRT2, 9);
    expect(hit.normal.y).toBeCloseTo(1 / Math.SQRT2, 9);
    expect(hit.normal.z).toBeCloseTo(0, 12);
    // contact point lies on the slope
    expect(hit.point.y).toBeCloseTo(hit.point.x * g, 9);
    // 0.11 m vertically = 0.078 m along the normal: clear
    expect(sphereVsTerrain(new Vector3(2, 2.11, 0), 0.075, slope(g), hit)).toBe(false);
  });

  it('a sphere well above the ground costs one height sample (early out)', () => {
    const f = counting(HILLS);
    const hit = createSphereHit();
    const h = HILLS.heightAt(5, 5);
    expect(sphereVsTerrain(new Vector3(5, h + 1.2, 5), 0.1, f, hit)).toBe(false);
    expect(f.calls).toBe(1);
    f.calls = 0;
    sphereVsTerrain(new Vector3(5, h + 0.5, 5), 0.1, f, hit);
    expect(f.calls).toBe(5);
  });

  it('uses ±0.25 m central differences', () => {
    expect(TERRAIN_NORMAL_EPS).toBe(0.25);
    const seen: number[] = [];
    sphereVsTerrain(new Vector3(1, 0, 1), 0.1, { heightAt: (x) => (seen.push(x), 0) }, createSphereHit());
    expect([...new Set(seen)].sort()).toEqual([0.75, 1, 1.25]);
  });
});

describe('drone on terrain', () => {
  it('comes to rest on flat terrain at the same height as on the Training ground, with terrain contacts only', () => {
    const w = new PhysicsWorld(outdoor(FLAT));
    w.reset(new Vector3(5, 0.3, 5), 0);
    const ids = new Set<string>();
    for (let i = 0; i < 3000; i++) for (const c of w.step(DT, OFF)) ids.add(c.colliderId);
    expect([...ids]).toEqual(['terrain']);
    expect(Math.abs(w.state.position.y - REST_Y)).toBeLessThan(1e-3);
    expect(w.state.velocity.length()).toBeLessThan(1e-3);
  });

  it('rests on a raised plateau (h = 50) instead of falling to y = 0', () => {
    const w = new PhysicsWorld(outdoor(raised(50)));
    w.reset(new Vector3(0, 50.5, 0), 0);
    for (let i = 0; i < 3000; i++) w.step(DT, OFF);
    expect(Math.abs(w.state.position.y - 50 - REST_Y)).toBeLessThan(1e-3);
  });

  it('reset() lifts a spawn below the terrain onto it', () => {
    const w = new PhysicsWorld(outdoor(raised(12)));
    w.reset(new Vector3(0, 0, 0), 0);
    expect(w.state.position.y).toBeGreaterThanOrEqual(12 + REST_Y);
    expect(w.groundAt(3, 4)).toBe(12);
  });

  it('slides / tumbles down a 31° slope (steeper than friction holds) and never sinks into it', () => {
    const f = slope(0.6);
    const w = new PhysicsWorld(outdoor(f));
    w.reset(new Vector3(0, 0.3, 0), 0);
    let worst = -Infinity;
    for (let i = 0; i < 3000; i++) {
      w.step(DT, OFF);
      worst = Math.max(worst, buried(w, f));
    }
    // downhill is −x
    expect(w.state.position.x).toBeLessThan(-1);
    expect(w.state.position.y).toBeLessThan(0);
    expect(worst).toBeLessThan(20);
  });

  it('holds on a gentle 8° slope (friction wins)', () => {
    const f = slope(0.14);
    const w = new PhysicsWorld(outdoor(f));
    w.reset(new Vector3(0, 0.2, 0), 0);
    for (let i = 0; i < 3000; i++) w.step(DT, OFF);
    const x0 = w.state.position.x;
    for (let i = 0; i < 1000; i++) w.step(DT, OFF);
    expect(Math.abs(w.state.position.x - x0)).toBeLessThan(20);
  });

  const fields: [string, HeightField, number][] = [
    ['rolling hills', HILLS, 0],
    ['68° cliff ramp', CLIFF, 0],
    ['vertical 30 m wall', WALL, 0],
  ];
  for (const [name, f] of fields) {
    for (const [dir, vy] of [
      ['level', 0],
      ['diving', -10],
    ] as const) {
      it(`no tunnelling at 40 m/s into ${name} (${dir})`, () => {
        const w = new PhysicsWorld(outdoor(f));
        const x0 = -5;
        w.reset(new Vector3(x0, f.heightAt(x0, 0) + 1.5, 0), Math.PI / 2);
        w.state.velocity.set(40, vy, 0);
        let worst = -Infinity;
        let hits = 0;
        for (let i = 0; i < 1500; i++) {
          const cs = w.step(DT, OFF);
          hits += cs.length;
          worst = Math.max(worst, buried(w, f));
        }
        expect(hits).toBeGreaterThan(0);
        // a step's penetration is resolved in place: never more than a few cm under the surface
        expect(worst).toBeLessThan(0.05);
        expect(w.state.position.y).toBeGreaterThan(f.heightAt(w.state.position.x, w.state.position.z));
        if (f === WALL) expect(w.state.position.x).toBeLessThan(10);
      });
    }
  }

  it('flying 20 m above the hills never tests the terrain per sphere (one height sample per step)', () => {
    const f = counting(HILLS);
    const w = new PhysicsWorld(outdoor(f));
    w.reset(new Vector3(0, 40, 0), 0);
    const h = hoverThrottle();
    for (let i = 0; i < 4; i++) w.state.motors[i] = h;
    f.calls = 0;
    for (let i = 0; i < 100; i++) w.step(DT, [h, h, h, h]);
    expect(f.calls).toBe(100);
  });
});

describe('outdoor colliders through the grid', () => {
  it('a streamed building stops the drone; once its chunk is removed the drone flies through', () => {
    const rt = outdoor(FLAT);
    rt.grid!.insertOwned('chunk:0,-1', [box('house', [0, 4, -10], [4, 4, 2])]);
    const w = new PhysicsWorld(rt);
    const fly = (): Set<string> => {
      w.reset(new Vector3(0, 3, 0), 0);
      w.state.velocity.set(0, 0, -15);
      const ids = new Set<string>();
      for (let i = 0; i < 2000; i++) for (const c of w.step(DT, [0.5, 0.5, 0.5, 0.5])) ids.add(c.colliderId);
      return ids;
    };
    const blocked = fly();
    expect(blocked.has('house')).toBe(true);
    expect(w.state.position.z).toBeGreaterThan(-8.1);
    rt.grid!.removeOwner('chunk:0,-1');
    expect(fly().has('house')).toBe(false);
    expect(w.state.position.z).toBeLessThan(-12);
  });

  it('the level’s own colliders (Training poles) are in the grid under LEVEL_OWNER', () => {
    const rt = outdoor(FLAT, { statics: [{ id: 'pole', shape: { kind: 'cylinder', center: [0, 3, -6], radius: 0.12, halfHeight: 3 } }] });
    expect(rt.grid!.has(LEVEL_OWNER)).toBe(true);
    const w = new PhysicsWorld(rt);
    w.reset(new Vector3(0, 2, 0), 0);
    w.state.velocity.set(0, 0, -10);
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) for (const c of w.step(DT, [0.5, 0.5, 0.5, 0.5])) ids.add(c.colliderId);
    expect(ids.has('pole')).toBe(true);
  });

  it('ground effect: a rooftop under the rotors counts, high over the terrain', () => {
    const rt = outdoor(FLAT);
    rt.grid!.insertOwned('roof', [box('roof', [0, 10, 0], [5, 10, 5])]);
    const w = new PhysicsWorld(rt);
    const h = hoverThrottle();
    w.reset(new Vector3(0, 20.06, 0), 0);
    for (let i = 0; i < 4; i++) w.state.motors[i] = h;
    w.step(DT, [h, h, h, h]);
    expect(w.groundEffect[0]).toBeGreaterThan(1.01);
    w.reset(new Vector3(8, 20.06, 0), 0);
    for (let i = 0; i < 4; i++) w.state.motors[i] = h;
    w.step(DT, [h, h, h, h]);
    expect(w.groundEffect[0]).toBeLessThan(1.0001);
  });

  it('ground effect over terrain uses the height under each rotor', () => {
    const w = new PhysicsWorld(outdoor(raised(30)));
    const h = hoverThrottle();
    w.reset(new Vector3(0, 30.06, 0), 0);
    for (let i = 0; i < 4; i++) w.state.motors[i] = h;
    w.step(DT, [h, h, h, h]);
    expect(w.groundEffect[0]).toBeGreaterThan(1.01);
  });
});

/** Value noise, 6 octaves: a stand-in for the world engine's height function cost. */
function noiseField(seed: number): HeightField {
  const hash = (ix: number, iz: number): number => {
    let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iz, 0x165667b1) ^ seed;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const vnoise = (x: number, z: number): number => {
    const ix = Math.floor(x);
    const iz = Math.floor(z);
    const fx = x - ix;
    const fz = z - iz;
    const sx = fx * fx * (3 - 2 * fx);
    const sz = fz * fz * (3 - 2 * fz);
    const a = hash(ix, iz);
    const b = hash(ix + 1, iz);
    const c = hash(ix, iz + 1);
    const d = hash(ix + 1, iz + 1);
    return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
  };
  return {
    heightAt: (x, z) => {
      let h = 0;
      let amp = 12;
      let f = 1 / 90;
      for (let o = 0; o < 6; o++) {
        h += vnoise(x * f, z * f) * amp;
        amp *= 0.5;
        f *= 2;
      }
      return h;
    },
  };
}

describe('outdoor step budget', () => {
  it('≤ 20 µs per step on average over noise terrain + 450 streamed colliders (budget 10 µs)', () => {
    const field = noiseField(7);
    const rt = outdoor(field);
    const r = rng(9);
    for (let cx = -1; cx <= 1; cx++) {
      for (let cz = -1; cz <= 1; cz++) {
        const batch = [];
        for (let i = 0; i < 50; i++) {
          const x = cx * 64 + (r() - 0.5) * 64;
          const z = cz * 64 + (r() - 0.5) * 64;
          const g = field.heightAt(x, z);
          batch.push(r() < 0.5 ? box(`b${cx},${cz},${i}`, [x, g + 4, z], [3, 4, 3], r() * 3) : { id: `t${cx},${cz},${i}`, shape: { kind: 'cylinder' as const, center: [x, g + 5, z] as [number, number, number], radius: 1.5, halfHeight: 5 } });
        }
        rt.grid!.insertOwned(`${cx},${cz}`, batch);
      }
    }
    const w = new PhysicsWorld(rt);
    const h = hoverThrottle();
    const cmd = [h, h, h, h];
    // 80 % cruising 3–25 m up across the chunks, 20 % sitting on the ground (worst case: every sphere tested)
    const run = (steps: number): number => {
      let contacts = 0;
      const t0 = performance.now();
      for (let i = 0; i < steps; i++) {
        if (i % 1000 === 0) {
          const low = (i / 1000) % 5 === 4;
          const x = (r() - 0.5) * 150;
          const z = (r() - 0.5) * 150;
          w.reset(new Vector3(x, field.heightAt(x, z) + (low ? 0 : 3 + r() * 22), z), r() * 6);
          if (!low) {
            w.state.velocity.set((r() - 0.5) * 30, 0, (r() - 0.5) * 30);
            for (let k = 0; k < 4; k++) w.state.motors[k] = h;
          }
        }
        contacts += w.step(DT, (i / 1000) % 5 === 4 ? OFF : cmd).length;
      }
      expect(contacts).toBeGreaterThan(0);
      return ((performance.now() - t0) * 1000) / steps;
    };
    run(5000); // warm-up (JIT)
    const us = Math.min(run(20000), run(20000));
    expect(us, `${us.toFixed(2)} µs/step`).toBeLessThan(20);
  });
});
