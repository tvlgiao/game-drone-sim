/**
 * Living world (docs/12) beyond the traffic: birds scatter from the drone, rivers flow the way the generator's
 * water surface falls (lakes do not flow), the countryside placement is deterministic and on open ground, the
 * life hub hands audio its emitters and events, and the views allocate nothing per frame and give everything back
 * on dispose.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { BirdFlocks, BIRD_STATE, SCARE_RADIUS } from '../../src/world/life/birds';
import { waterFlow, FLAT_SLOPE } from '../../src/world/life/water-flow';
import { countrysideAround } from '../../src/world/life/countryside';
import { LifeHub, type LifeEmitter } from '../../src/world/life/hub';
import { Tractor, TRACTOR_SPEED } from '../../src/world/life/tractor';
import { buildRuralNetwork } from '../../src/world/traffic/rural-roads';
import { TrafficSim, type TrafficEmitter } from '../../src/world/traffic/traffic-sim';
import { buildChunk, CHUNK_SIZE } from '../../src/world/chunk-gen';
import { baseSample } from '../../src/world/base-terrain';
import { LAKE_LEVEL } from '../../src/world/base-terrain';
import { createWorld, GEN_VERSION } from '../../src/world/world';
import { BIOME, biomeSample } from '../../src/world/terrain-field';
import { cityRuntime } from '../../src/levels/city';
import { ColliderGrid } from '../../src/physics/collider-grid';
import { WorldOrigin } from '../../src/render/outdoor/world-origin';
import { WorldLife } from '../../src/render/life/world-life';
import { LIFE_BUDGETS, lifeBudget } from '../../src/render/life/budget';
import { LoftLife, neonLevel, bulbLevel } from '../../src/render/life/loft-life';
import { gustAt } from '../../src/render/life/gust';
import type { LevelRuntime } from '../../src/levels/runtime';
import type { LevelFrame } from '../../src/render/level-view';

const flat = (): number => 0;

describe('birds', () => {
  const make = (): BirdFlocks => new BirdFlocks({ seed: 7, flocks: 2, birds: 12, speed: 11, radius: [20, 30], height: [20, 30], keep: Infinity, place: [100, 200], ground: flat, homes: [[0, 0], [400, 0]] }, 0, 0);

  it('circle their homes while the drone is far away', () => {
    const b = make();
    for (let i = 0; i < 600; i++) b.update(1 / 60, 2000, 30, 2000);
    expect(b.state[0]).toBe(BIRD_STATE.circling);
    expect(b.scatters).toBe(0);
    const c = new Float64Array(3);
    b.centre(0, c);
    expect(Math.hypot(c[0]!, c[2]!)).toBeLessThan(45);
    expect(c[1]).toBeGreaterThan(12);
  });

  it('scatter when the drone comes close: they flee faster, away from it, and regroup further off', () => {
    const b = make();
    for (let i = 0; i < 300; i++) b.update(1 / 60, 2000, 30, 2000);
    const c = new Float64Array(3);
    b.centre(0, c);
    // the drone flies into flock 0
    const d = [c[0]!, c[1]!, c[2]!];
    const before = new Float64Array(b.perFlock);
    for (let i = 0; i < b.perFlock; i++) before[i] = Math.hypot(b.x[i]! - d[0]!, b.y[i]! - d[1]!, b.z[i]! - d[2]!);
    const events: number[] = [];
    b.update(1 / 60, d[0]!, d[1]!, d[2]!);
    b.drainScatters((k) => events.push(k));
    expect(events).toEqual([0]);
    expect(b.state[0]).toBe(BIRD_STATE.scattered);
    // the other flock, 400 m away, keeps circling
    expect(b.state[1]).toBe(BIRD_STATE.circling);
    for (let i = 0; i < 90; i++) b.update(1 / 60, d[0]!, d[1]!, d[2]!);
    let fled = 0;
    for (let i = 0; i < b.perFlock; i++) {
      const now = Math.hypot(b.x[i]! - d[0]!, b.y[i]! - d[1]!, b.z[i]! - d[2]!);
      if (now > before[i]! + 5) fled++;
      expect(Math.hypot(b.vx[i]!, b.vy[i]!, b.vz[i]!)).toBeGreaterThan(11 * 1.4);
    }
    expect(fled).toBeGreaterThan(b.perFlock * 0.8);
    // a new home away from the drone
    expect(Math.hypot(b.hx[0]! - d[0]!, b.hz[0]! - d[2]!)).toBeGreaterThan(SCARE_RADIUS * 3);
  });

  it('are deterministic per seed', () => {
    const a = make();
    const b = make();
    for (let i = 0; i < 500; i++) {
      a.update(1 / 60, 30 * Math.sin(i / 50), 25, 0);
      b.update(1 / 60, 30 * Math.sin(i / 50), 25, 0);
    }
    expect(Array.from(a.x)).toEqual(Array.from(b.x));
  });
});

describe('river flow', () => {
  const world = createWorld({ seed: 42, preset: 'infinite', genVersion: GEN_VERSION });
  /** a chunk with a river channel (not a lake) through it */
  function riverChunk(): ReturnType<typeof buildChunk> {
    const s = baseSample();
    for (let r = 0; r < 40; r++) {
      for (let cx = -r; cx <= r; cx++) {
        for (let cz = -r; cz <= r; cz++) {
          if (Math.max(Math.abs(cx), Math.abs(cz)) !== r) continue;
          world.base.sample((cx + 0.5) * CHUNK_SIZE, (cz + 0.5) * CHUNK_SIZE, s);
          if (s.riverD > 4 || s.water <= LAKE_LEVEL + 0.5) continue;
          const c = buildChunk(world, { cx, cz, lod: 0 });
          if (c.water.positions.length / 3 > 200) return c;
        }
      }
    }
    throw new Error('no river found');
  }

  it('runs down the generator\'s water surface, along the channel', () => {
    const c = riverChunk();
    const p = c.water.positions;
    const n = p.length / 3;
    const depth = new Float32Array(n);
    const side = c.gridSize;
    const step = CHUNK_SIZE / (side - 1);
    for (let k = 0; k < n; k++) {
      const i = Math.round(p[k * 3]! / step);
      const j = Math.round(p[k * 3 + 2]! / step);
      depth[k] = p[k * 3 + 1]! - c.positions[(j * side + i) * 3 + 1]!;
    }
    const flow = waterFlow(p, c.water.indices, depth);
    const s = baseSample();
    let checked = 0;
    let downhill = 0;
    let along = 0;
    for (let k = 0; k < n; k++) {
      const fx = flow[k * 2]!;
      const fz = flow[k * 2 + 1]!;
      const sp = Math.hypot(fx, fz);
      if (sp === 0 || depth[k]! < 0.5) continue;
      const x = c.originX + p[k * 3]!;
      const z = c.originZ + p[k * 3 + 2]!;
      // the generator's own water level (lp − 1.2 on Infinite rivers) a few metres up- and downstream
      const wl = (dx: number, dz: number): number => world.base.sample(x + dx, z + dz, s).lp - 1.2;
      const down = wl((fx / sp) * 6, (fz / sp) * 6);
      const up = wl((-fx / sp) * 6, (-fz / sp) * 6);
      checked++;
      if (down < up) downhill++;
      // the channel runs along the flow: the river's centre-line distance changes little that way
      const d0 = world.base.sample(x, z, s).riverD;
      const dAlong = Math.abs(world.base.sample(x + (fx / sp) * 4, z + (fz / sp) * 4, s).riverD - d0);
      const dAcross = Math.abs(world.base.sample(x - (fz / sp) * 4, z + (fx / sp) * 4, s).riverD - d0);
      if (dAlong <= dAcross + 0.5) along++;
    }
    expect(checked).toBeGreaterThan(80);
    expect(downhill / checked).toBeGreaterThan(0.9);
    expect(along / checked).toBeGreaterThan(0.75);
  });

  it('flat water (a lake, the City river) does not flow', () => {
    // a level square of water: every vertex at the same height
    const pos: number[] = [];
    const idx: number[] = [];
    for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) pos.push(i * 4, LAKE_LEVEL, j * 4);
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
      const a = j * 5 + i;
      idx.push(a, a + 5, a + 1, a + 1, a + 5, a + 6);
    }
    const f = waterFlow(pos, idx, new Float32Array(25).fill(2));
    expect(Array.from(f).every((v) => v === 0)).toBe(true);
    expect(FLAT_SLOPE).toBeGreaterThan(0);
  });
});

describe('countryside', () => {
  const world = createWorld({ seed: 1234, preset: 'infinite', genVersion: GEN_VERSION });

  it('is the same for the same spot, and puts herds, turbines and the tractor on open ground', () => {
    const a = countrysideAround(world, 0, 0, 900, 0.4);
    const b = countrysideAround(createWorld({ seed: 1234, preset: 'infinite', genVersion: GEN_VERSION }), 0, 0, 900, 0.4);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.chimneys.length).toBeGreaterThan(0);
    expect(a.herds.length).toBeGreaterThan(0);
    const s = biomeSample();
    for (const h of a.herds) {
      for (let i = 0; i < h.animals.length; i += 4) {
        world.field.biomeAt(h.animals[i]!, h.animals[i + 2]!, s);
        expect([BIOME.meadow, BIOME.farmland, BIOME.scrub]).toContain(s.biome);
        expect(h.animals[i + 1]).toBeCloseTo(world.field.heightAt(h.animals[i]!, h.animals[i + 2]!), 6);
      }
    }
    for (let k = 0; k < a.turbines.length; k += 4) {
      world.field.biomeAt(a.turbines[k]!, a.turbines[k + 2]!, s);
      expect(s.water).toBe(-Infinity);
      expect(s.village).toBeLessThan(0.02);
    }
    expect(a.tractor).not.toBeNull();
  });

  it('the tractor ploughs its field at walking pace and is a moving collider', () => {
    const t = new Tractor({ x: 100, z: 50, yaw: 0.3, halfW: 22, halfL: 30 }, () => 5);
    const pts: [number, number][] = [];
    for (let s = 0; s < 120; s += 0.5) {
      t.update(s);
      pts.push([t.x, t.z]);
      // inside the field (rotated rectangle, plus the headland turns)
      const lx = Math.cos(0.3) * (t.x - 100) - Math.sin(0.3) * (t.z - 50);
      const lz = Math.sin(0.3) * (t.x - 100) + Math.cos(0.3) * (t.z - 50);
      expect(Math.abs(lx)).toBeLessThan(22 + 1);
      expect(Math.abs(lz)).toBeLessThan(30 + 4);
      expect(Math.hypot(t.vx, t.vz)).toBeCloseTo(TRACTOR_SPEED, 6);
    }
    const out: never[] = [];
    expect(t.queryMovers(t.x - 1, 0, t.z - 1, t.x + 1, 10, t.z + 1, out)).toBe(1);
    expect(t.queryMovers(t.x + 50, 0, t.z, t.x + 60, 10, t.z + 1, out)).toBe(0);
  });

  it('rural roads carry a few cars on the right of the road, following the ground', () => {
    const net = buildRuralNetwork(world, 0, 0, 900);
    expect(net.edges.length).toBeGreaterThan(1);
    const sim = new TrafficSim(net, null, { seed: 3, maxCars: 8, radius: 800 });
    for (let i = 0; i < 600; i++) sim.update(1 / 60, 0, 100, 0, 100);
    expect(sim.count).toBeGreaterThan(3);
    for (let c = 0; c < sim.capacity; c++) {
      if (!sim.alive[c]) continue;
      // wheels on the ground (± the road lift and the chord of a slope)
      expect(Math.abs(sim.y[c]! - world.field.heightAt(sim.x[c]!, sim.z[c]!))).toBeLessThan(1.5);
    }
  });
});

describe('life hub (audio hooks)', () => {
  it('lists the nearest cars first, and forwards horns from the traffic', () => {
    const rt = cityRuntime();
    const hub = rt.life!;
    const sim = hub.trafficSims[0]!;
    for (let i = 0; i < 120; i++) sim.update(1 / 60, 0, 40, 0, 40);
    const out: TrafficEmitter[] = [];
    const n = hub.getTrafficEmitters(0, 2, 0, 8, out);
    expect(n).toBe(8);
    for (let i = 1; i < n; i++) expect(out[i]!.distance).toBeGreaterThanOrEqual(out[i - 1]!.distance);
    const all: LifeEmitter[] = [];
    expect(hub.emitters(0, 2, 0, 5, all)).toBe(5);
    expect(all[0]!.kind).toBe('car');
    // events
    const heard: number[] = [];
    const off = hub.on('horn', (e) => heard.push(e.x));
    hub.emit('horn', 1, 2, 3);
    off();
    hub.emit('horn', 4, 5, 6);
    expect(heard).toEqual([1]);
  });
});

describe('budgets per tier', () => {
  it('shrink from ultra to low; Quest (low) has one car draw, no smoke, no light pools, traffic within 250 m', () => {
    const tiers = ['ultra', 'high', 'medium', 'low'] as const;
    for (const k of ['cars', 'carRadius', 'signalRange', 'ruralCars', 'flocks', 'birds', 'puffs', 'animals'] as const) {
      const v = tiers.map((t) => LIFE_BUDGETS[t][k]);
      expect(v).toEqual([...v].sort((a, b) => b - a));
    }
    const q = LIFE_BUDGETS.low;
    expect(q.genericCars).toBe(true);
    expect(q.puffs).toBe(0);
    expect(q.carGlow).toBe(false);
    expect(q.carRadius).toBeLessThanOrEqual(250);
    expect(lifeBudget('ultra', 'phone')).toBe(LIFE_BUDGETS.medium);
  });
});

describe('gusts and the loft', () => {
  it('gust bands travel downwind', () => {
    // the peak of the band moves along the wind at ~12 m/s
    const peak = (t: number): number => {
      let best = -1;
      let at = 0;
      for (let x = 0; x < 140; x += 0.5) {
        const g = gustAt(x, 0, 1, 0, t);
        if (g > best) {
          best = g;
          at = x;
        }
      }
      return at;
    };
    const a = peak(10);
    const b = peak(10.5);
    expect(b - a).toBeGreaterThan(3);
    expect(b - a).toBeLessThan(10);
  });

  it('the OPEN neon stutters a few times a minute, the tired bulb dips', () => {
    let off = 0;
    let dips = 0;
    for (let t = 0; t < 120; t += 0.01) {
      if (neonLevel(t) < 0.5) off++;
      if (bulbLevel(t) < 0.5) dips++;
    }
    expect(off).toBeGreaterThan(20);
    expect(off).toBeLessThan(12000 * 0.2);
    expect(dips).toBeGreaterThan(5);
  });
});

/** Ids handed out by three's global counters (as in vfx.test). */
function idWatermark(): { object3d: number; geometry: number; material: number; texture: number } {
  const g = new THREE.BufferGeometry();
  const m = new THREE.MeshBasicMaterial();
  const t = new THREE.Texture();
  const w = { object3d: new THREE.Object3D().id, geometry: g.id, material: (m as unknown as { id: number }).id, texture: t.id };
  g.dispose();
  m.dispose();
  t.dispose();
  return w;
}

function frame(i: number, drone: THREE.Vector3, camera: THREE.Vector3): LevelFrame {
  return { time: i / 60, dt: 1 / 60, px: 800, drone, camera, wash: 0, fanAngle: 0 };
}

describe('views: no allocation per frame, everything given back', () => {
  it('City life: 1000 frames allocate no three.js objects; dispose frees its geometries and grid owners', () => {
    const rt = cityRuntime();
    const shared = { uTime: { value: 0 } };
    const life = new WorldLife(rt, shared, new WorldOrigin(), 'ultra', 'desktop', new THREE.Vector2(1, 0));
    const drone = new THREE.Vector3(-480, 30, -180);
    const cam = new THREE.Vector3(-490, 33, -170);
    const f = { time: 0, dt: 1 / 60, px: 800, drone, camera: cam, wash: 0, fanAngle: 0 };
    for (let i = 0; i < 60; i++) life.update(frame(i, drone, cam));
    const ids = idWatermark();
    for (let i = 60; i < 1060; i++) {
      f.time = i / 60;
      life.update(f);
    }
    const after = idWatermark();
    expect(after.object3d - ids.object3d).toBe(1);
    expect(after.geometry - ids.geometry).toBe(1);
    expect(after.material - ids.material).toBe(1);
    expect(after.texture - ids.texture).toBe(1);
    const s = life.stats() as { cars: number; birds: number };
    expect(s.cars).toBeGreaterThan(150);
    expect(s.birds).toBeGreaterThan(20);
    // dispose: geometries freed, the flags leave the grid, sources leave the hub
    const disposed: number[] = [];
    life.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry.addEventListener('dispose', () => disposed.push(m.geometry.id));
    });
    const meshes = (() => {
      let n = 0;
      life.group.traverse((o) => ((o as THREE.Mesh).isMesh ? n++ : 0));
      return n;
    })();
    expect(rt.grid!.has('life:flags')).toBe(true);
    life.dispose();
    expect(disposed.length).toBe(meshes);
    expect(rt.grid!.has('life:flags')).toBe(false);
    const out: LifeEmitter[] = [];
    // only the City traffic is left in the hub (it belongs to the runtime)
    expect(rt.life!.emitters(0, 0, 0, 50, out)).toBeGreaterThan(0);
    expect(out.slice(0, rt.life!.emitters(0, 0, 0, 50, out)).every((e) => e.kind === 'car')).toBe(true);
  });

  it('Infinite countryside: placement, colliders and movers come and go with the view', () => {
    const world = createWorld({ seed: 1234, preset: 'infinite', genVersion: GEN_VERSION });
    const grid = new ColliderGrid();
    const hub = new LifeHub();
    const rt = {
      def: { id: 'infinite', kind: 'outdoor', spawn: { position: [0, 20, 0], yaw: 0 } },
      terrain: world.field,
      grid,
      life: hub,
      content: { kind: 'terrain', world, seed: 1234, stream: null, code: '' },
    } as unknown as LevelRuntime;
    const life = new WorldLife(rt, { uTime: { value: 0 } }, new WorldOrigin(), 'high', 'desktop', new THREE.Vector2(0.6, 0.8));
    const drone = new THREE.Vector3(0, 40, 0);
    for (let i = 0; i < 120; i++) life.update(frame(i, drone, drone));
    expect(grid.has('life:animals')).toBe(true);
    expect(grid.has('life:turbines')).toBe(true);
    expect(hub.movers.size).toBeGreaterThanOrEqual(2);
    const s = life.stats() as { countryside: Record<string, number>; ruralCars: number };
    expect(s.countryside.animals).toBeGreaterThan(0);
    expect(s.ruralCars).toBeGreaterThan(0);
    const ids = idWatermark();
    for (let i = 120; i < 1120; i++) life.update(frame(i, drone, drone));
    const after = idWatermark();
    expect(after.geometry - ids.geometry).toBe(1);
    expect(after.material - ids.material).toBe(1);
    expect(after.object3d - ids.object3d).toBe(1);
    life.dispose();
    expect(grid.size).toBe(0);
    expect(hub.movers.size).toBe(0);
  });

  it('the loft: neon, bulb and router animate without allocating', () => {
    const neon = new THREE.MeshBasicMaterial({ vertexColors: true });
    const light = new THREE.PointLight(0xffffff, 9);
    const halos = new THREE.InstancedMesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial(), 2);
    halos.setColorAt(0, new THREE.Color(1, 0.6, 0.3));
    halos.setColorAt(1, new THREE.Color(1, 0.6, 0.3));
    const life = new LoftLife({ neon, bulbLight: light, halos, haloIndex: 1 });
    life.update(0);
    const ids = idWatermark();
    let minBulb = 1;
    for (let i = 0; i < 1000; i++) {
      light.intensity = 9;
      life.update(30 + i / 20);
      minBulb = Math.min(minBulb, life.bulb);
    }
    const after = idWatermark();
    expect(after.object3d - ids.object3d).toBe(1);
    expect(after.material - ids.material).toBe(1);
    expect(minBulb).toBeLessThan(0.6);
    expect(typeof neon.onBeforeCompile).toBe('function');
    life.dispose();
  });
});
