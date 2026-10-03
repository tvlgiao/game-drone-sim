/**
 * City traffic (docs/12): cars keep to their lane on the right, stop at red lights, never overlap, live within the
 * radius around the drone, replay identically per seed, never touch a race ring, and are kinematic colliders the
 * drone can hit.
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { generateCity, streetLine } from '../../src/world/city-gen';
import {
  CAR_FLAG,
  carsOverlap,
  createCityTraffic,
  DESPAWN_MARGIN,
  EDGE_CONNECTOR,
  EDGE_LANE,
  LANE_OFFSET,
  ringConflicts,
  SIGNAL,
  SIGNAL_ALL_RED,
  SIGNAL_GREEN,
  SIGNAL_YELLOW,
  SignalPlan,
  STOP_LINE,
  TrafficSim,
  VEHICLES,
  type CityTraffic,
} from '../../src/world/traffic';
import type { MoverCollider } from '../../src/world/life/movers';
import { cityRuntime, CITY_SEED } from '../../src/levels/city';
import { PhysicsWorld } from '../../src/physics/physics-world';

const DT = 1 / 60;
const city = generateCity(CITY_SEED);

function run(t: CityTraffic, frames: number, each?: (f: number) => void, focus: [number, number, number] = [0, 40, 0]): void {
  for (let f = 0; f < frames; f++) {
    t.sim.update(DT, focus[0], focus[1], focus[2], focus[1]);
    each?.(f);
  }
}

function digest(sim: TrafficSim): string {
  const parts: string[] = [];
  for (let c = 0; c < sim.capacity; c++) if (sim.alive[c]) parts.push(`${c}:${sim.type[c]}:${sim.paint[c]}:${sim.edge[c]}:${sim.s[c]!.toFixed(6)}:${sim.v[c]!.toFixed(6)}`);
  return parts.join('|');
}

describe('city road graph', () => {
  const t = createCityTraffic(city);
  const { roads } = t;

  it('one lane each way between neighbouring intersections, on the right of the centre line, stop lines at 13 m', () => {
    const lanes = roads.edges.filter((e) => e.kind === EDGE_LANE);
    // 14 × 14 grid: 2 × 2 × 14 × 13 directed lanes
    expect(lanes.length).toBe(2 * 2 * 14 * 13);
    for (const e of lanes) {
      const dx = e.px[1]! - e.px[0]!;
      const dz = e.pz[1]! - e.pz[0]!;
      const l = Math.hypot(dx, dz);
      expect(l).toBeCloseTo(80 - 2 * STOP_LINE, 6);
      const hx = dx / l;
      const hz = dz / l;
      // the street centre line through the lane's start: the lane sits LANE_OFFSET to the right of the heading
      const node = roads.nodes[e.node]!;
      const offX = e.px[0]! - (Math.abs(hx) > 0.5 ? e.px[0]! : node.x);
      const offZ = e.pz[0]! - (Math.abs(hz) > 0.5 ? e.pz[0]! : node.z);
      const right = offX * -hz + offZ * hx;
      expect(right).toBeCloseTo(LANE_OFFSET, 6);
      // the lane ends on the stop line
      expect(Math.abs((e.px[1]! - node.x) * hx + (e.pz[1]! - node.z) * hz)).toBeCloseTo(STOP_LINE, 6);
    }
  });

  it('connectors join each lane end to the straight / right / left lane starts (no U-turns)', () => {
    for (const e of roads.edges) {
      if (e.kind !== EDGE_LANE) continue;
      expect(e.next.length).toBeGreaterThanOrEqual(1);
      expect(e.next.length).toBeLessThanOrEqual(3);
      for (const n of e.next) {
        const c = roads.edges[n]!;
        expect(c.kind).toBe(EDGE_CONNECTOR);
        expect(c.from).toBe(e.id);
        expect(c.px[0]).toBeCloseTo(e.px[1]!, 9);
        expect(c.pz[0]).toBeCloseTo(e.pz[1]!, 9);
        const out = roads.edges[c.next[0]!]!;
        expect(c.px[c.px.length - 1]).toBeCloseTo(out.px[0]!, 9);
        // a U-turn would come back on the opposite lane of the same street: never
        expect(out.node).not.toBe(roads.nodes.indexOf(roads.nodes[e.node]!) === e.node ? -2 : -3);
        const back = Math.abs(out.px[1]! - e.px[0]!) < 5 && Math.abs(out.pz[1]! - e.pz[0]!) < 5;
        expect(back).toBe(false);
      }
    }
  });

  it('a traffic light per approach: pole on the right-hand corner, never inside a lane', () => {
    const nApproaches = roads.nodes.reduce((a, n) => a + n.approaches.length, 0);
    expect(roads.signals.length / 6).toBe(nApproaches);
    for (let k = 0; k < roads.signals.length; k += 6) {
      const x = roads.signals[k]!;
      const z = roads.signals[k + 2]!;
      // on a sidewalk corner: more than 8 m (half a street) from both street centre lines through the node
      const node = roads.nodes[roads.signals[k + 3]!]!;
      expect(Math.max(Math.abs(x - node.x), Math.abs(z - node.z))).toBeGreaterThan(8);
      expect(Math.min(Math.abs(x - node.x), Math.abs(z - node.z))).toBeGreaterThan(8);
    }
    expect(roads.signalColliders.length).toBeGreaterThan(nApproaches);
  });
});

describe('traffic lights', () => {
  it('cycle green → yellow → red, never green on both axes, offsets differ between intersections', () => {
    const plan = new SignalPlan(7, [[0, 1, 2, 3], [0, 2], [1, 3, 0]]);
    for (let t = 0; t < 200; t += 0.25) {
      for (let n = 0; n < 3; n++) {
        const x = plan.state(n, 0, t) !== SIGNAL.red || plan.state(n, 2, t) !== SIGNAL.red;
        const z = plan.state(n, 1, t) !== SIGNAL.red || plan.state(n, 3, t) !== SIGNAL.red;
        expect(x && z).toBe(false);
        // the two approaches of one axis always show the same
        expect(plan.state(n, 0, t)).toBe(plan.state(n, 2, t));
      }
    }
    // one green span of SIGNAL_GREEN, then SIGNAL_YELLOW of yellow
    let green = 0;
    let yellow = 0;
    const cyc = plan.cycle(0);
    for (let t = 0; t < cyc; t += 0.01) {
      const s = plan.state(0, 1, t);
      if (s === SIGNAL.green) green += 0.01;
      if (s === SIGNAL.yellow) yellow += 0.01;
    }
    expect(green).toBeCloseTo(SIGNAL_GREEN, 1);
    expect(yellow).toBeCloseTo(SIGNAL_YELLOW, 1);
    expect(cyc).toBeCloseTo(2 * (SIGNAL_GREEN + SIGNAL_YELLOW + SIGNAL_ALL_RED), 9);
  });
});

describe('city traffic simulation', () => {
  it('200+ cars for three minutes: no two cars ever overlap, nobody runs a red light, cars keep to the right', () => {
    const t = createCityTraffic(city);
    const sim = t.sim;
    const prevEdge = new Int32Array(sim.capacity).fill(-1);
    let overlaps = 0;
    let redCrossings = 0;
    let crossings = 0;
    let offLane = 0;
    let checked = 0;
    run(t, 60 * 180, (f) => {
      for (let c = 0; c < sim.capacity; c++) {
        if (!sim.alive[c]) {
          prevEdge[c] = -1;
          continue;
        }
        const e = sim.edge[c]!;
        const was = prevEdge[c]!;
        // a car that just left a lane for a connector: the light was green or yellow, or turned red after it
        // committed on yellow (at most the all-red time ago)
        if (was >= 0 && was !== e && t.roads.edges[was]!.kind === EDGE_LANE && t.roads.edges[e]!.kind === EDGE_CONNECTOR) {
          crossings++;
          const lane = t.roads.edges[was]!;
          const now = t.signals.state(lane.node, lane.approach, sim.time);
          const before = t.signals.state(lane.node, lane.approach, sim.time - SIGNAL_ALL_RED - 2 * DT);
          if (now === SIGNAL.red && before === SIGNAL.red) redCrossings++;
        }
        prevEdge[c] = e;
        // on a lane (not turning): the car's centre is LANE_OFFSET to the right of the street centre line
        const edge = t.roads.edges[e]!;
        const L = VEHICLES[sim.type[c]!]!.length;
        if (edge.kind === EDGE_LANE && sim.s[c]! > L + 0.5) {
          checked++;
          const hx = Math.sin(sim.yaw[c]!);
          const hz = Math.cos(sim.yaw[c]!);
          const node = t.roads.nodes[edge.node]!;
          const right = Math.abs(hx) > 0.5 ? (sim.z[c]! - node.z) * hx : (sim.x[c]! - node.x) * -hz;
          if (Math.abs(right - LANE_OFFSET) > 0.05) offLane++;
        }
      }
      if (f % 6 === 0) {
        for (let a = 0; a < sim.capacity; a++) {
          if (!sim.alive[a]) continue;
          for (let b = a + 1; b < sim.capacity; b++) if (sim.alive[b] && carsOverlap(sim, a, b)) overlaps++;
        }
      }
    });
    expect(sim.count).toBeGreaterThanOrEqual(200);
    expect(crossings).toBeGreaterThan(500);
    expect(checked).toBeGreaterThan(100_000);
    expect(overlaps).toBe(0);
    expect(redCrossings).toBe(0);
    expect(sim.redRuns).toBe(0);
    expect(offLane).toBe(0);
  }, 60_000);

  it('a car alone on a red approach stops before the stop line and waits for green', () => {
    const t = createCityTraffic(city, { maxCars: 1, radius: 2000 });
    const sim = t.sim;
    // find a lane and a moment its light just turned red, spawn one car 60 m before its end
    const lane = t.roads.edges.find((e) => e.kind === EDGE_LANE && e.node >= 0)!;
    let t0 = 0;
    while (t.signals.state(lane.node, lane.approach, t0) !== SIGNAL.red || t.signals.state(lane.node, lane.approach, t0 - 0.1) === SIGNAL.red) t0 += 0.05;
    sim.time = t0;
    sim.target = 0;
    sim.update(0, lane.midX, 100, lane.midZ, 100);
    (sim as unknown as { spawnAt(e: number, s: number, type: number): number }).spawnAt(lane.id, 8, 0);
    const c = sim.alive.indexOf(1);
    expect(c).toBeGreaterThanOrEqual(0);
    let maxS = 0;
    let crossedAt = -1;
    for (let f = 0; f < 60 * 40 && crossedAt < 0; f++) {
      sim.update(DT, lane.midX, 100, lane.midZ, 100);
      if (sim.edge[c] === lane.id) maxS = Math.max(maxS, sim.s[c]!);
      else crossedAt = sim.time;
    }
    // it stopped behind the line (front bumper within 3 m of it) and only went on green
    expect(maxS).toBeLessThanOrEqual(lane.length);
    expect(maxS).toBeGreaterThan(lane.length - 4);
    expect(crossedAt).toBeGreaterThan(t0);
    expect(t.signals.state(lane.node, lane.approach, crossedAt - DT)).toBe(SIGNAL.green);
  });

  it('two cars reaching the box in the same step from crossing approaches: only one gets in', () => {
    const t = createCityTraffic(city, { maxCars: 2, radius: 5000 });
    const sim = t.sim;
    const node = t.roads.nodes.findIndex((n) => n.approaches.includes(0) && n.approaches.includes(1));
    const lx = t.roads.edges.find((e) => e.kind === EDGE_LANE && e.node === node && e.approach === 0)!;
    const lz = t.roads.edges.find((e) => e.kind === EDGE_LANE && e.node === node && e.approach === 1)!;
    // a moment the x axis has green (the z car committed on the yellow before)
    let t0 = 0;
    while (t.signals.state(node, 0, t0) !== SIGNAL.green || t.signals.state(node, 0, t0 - 0.2) === SIGNAL.green) t0 += 0.05;
    sim.time = t0 + 0.05;
    sim.target = 0;
    const spawn = (sim as unknown as { spawnAt(e: number, s: number, type: number): number }).spawnAt.bind(sim);
    for (const order of [
      [lx, lz],
      [lz, lx],
    ]) {
      sim.clear();
      const cars = order.map((l) => spawn(l.id, l.length - 0.05, 0));
      for (const c of cars) {
        sim.v[c] = 8;
        if (sim.edge[c] === lz.id) sim.flags[c] |= CAR_FLAG.committed;
      }
      sim.update(DT, lx.px[1]!, 500, lx.pz[1]!, 500);
      const inBox = cars.filter((c) => sim.alive[c] && t.roads.edges[sim.edge[c]!]!.kind === EDGE_CONNECTOR);
      expect(inBox.length).toBe(1);
    }
  });

  it('brakes for the drone hovering low in its lane, not for one flying over', () => {
    const t = createCityTraffic(city, { maxCars: 1, radius: 2000 });
    const sim = t.sim;
    const lane = t.roads.edges.find((e) => e.kind === EDGE_LANE && e.node >= 0)!;
    // a moment with a long green ahead
    let t0 = 0;
    while (t.signals.state(lane.node, lane.approach, t0) !== SIGNAL.green || t.signals.state(lane.node, lane.approach, t0 - 0.1) === SIGNAL.green) t0 += 0.05;
    const trial = (droneY: number): number => {
      sim.clear();
      sim.time = t0;
      sim.target = 0;
      (sim as unknown as { spawnAt(e: number, s: number, type: number): number }).spawnAt(lane.id, 6, 0);
      const c = sim.alive.indexOf(1);
      // the drone 30 m along the lane, on its centre line
      const hx = (lane.px[1]! - lane.px[0]!) / lane.length;
      const hz = (lane.pz[1]! - lane.pz[0]!) / lane.length;
      const dx = lane.px[0]! + hx * 34;
      const dz = lane.pz[0]! + hz * 34;
      let maxS = 0;
      for (let f = 0; f < 60 * 8; f++) {
        sim.update(DT, dx, droneY, dz, droneY);
        if (sim.edge[c] === lane.id) maxS = Math.max(maxS, sim.s[c]!);
      }
      return maxS;
    };
    // hovering at 1 m: the car's front stays short of the drone
    expect(trial(1)).toBeLessThan(34 - 0.5);
    // at 20 m it drives on underneath
    expect(trial(20)).toBeGreaterThan(40);
  });

  it('cars live within the radius around the drone; a jump repopulates around the new spot, not under it', () => {
    const t = createCityTraffic(city, { maxCars: 120, radius: 250 });
    const sim = t.sim;
    const check = (fx: number, fz: number): void => {
      for (let c = 0; c < sim.capacity; c++) {
        if (!sim.alive[c]) continue;
        expect(Math.hypot(sim.x[c]! - fx, sim.z[c]! - fz)).toBeLessThanOrEqual(250 + DESPAWN_MARGIN + 1);
      }
    };
    run(t, 300, () => check(0, 0), [0, 30, 0]);
    expect(sim.count).toBe(120);
    // jump ~640 m: every old car goes, the disc around the new spot fills at once (a respawn shows a living street)
    const fx = 450;
    const fz = -450;
    sim.update(DT, fx, 30, fz, 30);
    check(fx, fz);
    expect(sim.count).toBeGreaterThan(30);
    // from then on, while the drone flies on at 15 m/s, new cars appear between 0.6 R and R, never under it
    const alive = new Uint8Array(sim.alive);
    let fresh = 0;
    let px = fx;
    for (let f = 0; f < 1800; f++) {
      px = fx - (f / 60) * 15;
      sim.update(DT, px, 30, fz, 30);
      for (let c = 0; c < sim.capacity; c++) {
        if (sim.alive[c] && !alive[c]) {
          fresh++;
          const d = Math.hypot(sim.x[c]! - px, sim.z[c]! - fz);
          expect(d).toBeGreaterThanOrEqual(0.6 * 250 - 6);
          expect(d).toBeLessThanOrEqual(250 + 6);
        }
        alive[c] = sim.alive[c]!;
      }
    }
    expect(fresh).toBeGreaterThan(10);
    // and it fills up again
    run(t, 600, () => check(px, fz), [px, 30, fz]);
    expect(sim.count).toBeGreaterThan(100);
  });

  it('is deterministic per seed: same seed and inputs → the same traffic; another seed → different traffic', () => {
    const a = createCityTraffic(city);
    const b = createCityTraffic(city);
    const other = createCityTraffic(generateCity(CITY_SEED + 1));
    run(a, 900);
    run(b, 900);
    run(other, 900);
    expect(digest(a.sim)).toBe(digest(b.sim));
    expect(digest(a.sim).length).toBeGreaterThan(1000);
    expect(digest(other.sim)).not.toBe(digest(a.sim));
  });

  it('every vehicle type turns up, with paint from its own palette (taxis yellow)', () => {
    const t = createCityTraffic(city);
    run(t, 600);
    const n = t.sim.countByType();
    for (let k = 0; k < VEHICLES.length; k++) expect(n[k], VEHICLES[k]!.name).toBeGreaterThan(0);
    for (let c = 0; c < t.sim.capacity; c++) if (t.sim.alive[c] && t.sim.type[c] === 5) expect(t.sim.paint[c]).toBe(12);
  });

  it('cars carry brake lights while slowing or queued', () => {
    const t = createCityTraffic(city);
    let braking = 0;
    run(t, 600, () => {
      for (let c = 0; c < t.sim.capacity; c++) if (t.sim.alive[c] && t.sim.flags[c]! & CAR_FLAG.brake) braking++;
    });
    expect(braking).toBeGreaterThan(1000);
  });

  it('CPU: one update of ~220 cars stays well under 1 ms', () => {
    const t = createCityTraffic(city);
    run(t, 120);
    const times: number[] = [];
    for (let f = 0; f < 600; f++) {
      const t0 = performance.now();
      t.sim.update(DT, 0, 40, 0, 40);
      times.push(performance.now() - t0);
    }
    times.sort((x, y) => x - y);
    const median = times[300]!;
    console.log(`[traffic] ${t.sim.count} cars: median ${median.toFixed(3)} ms, p95 ${times[570]!.toFixed(3)} ms`);
    expect(t.sim.count).toBeGreaterThanOrEqual(200);
    expect(median).toBeLessThan(1);
  });
});

describe('race rings and traffic', () => {
  it('no ring volume reaches a lane or connector envelope (25 seeds): cars never touch the race', () => {
    for (let s = 0; s < 25; s++) {
      const c = generateCity(CITY_SEED + s * 7919);
      const t = createCityTraffic(c);
      expect(t.ringEdges.reduce((a, b) => a + b, 0), `seed ${s}`).toBe(0);
    }
  });

  it('a ring that did reach a lane would flag it, and the cars on it stop being colliders', () => {
    const t = createCityTraffic(city);
    const lane = t.roads.edges.find((e) => e.kind === EDGE_LANE)!;
    const ring = { id: 'low', position: [lane.midX, 2.5, lane.midZ] as [number, number, number], direction: [1, 0, 0] as [number, number, number], radius: 1.75, tube: 0.12 };
    const flags = ringConflicts(t.roads, [ring]);
    expect(flags[lane.id]).toBe(1);
    expect(flags.reduce((a, b) => a + b, 0)).toBeLessThan(6);
    const sim = new TrafficSim(t.roads, t.signals, { seed: 1, maxCars: 1, radius: 2000, noCollide: flags });
    sim.target = 0;
    (sim as unknown as { spawnAt(e: number, s: number, type: number): number }).spawnAt(lane.id, 20, 0);
    const out: MoverCollider[] = [];
    expect(sim.queryMovers(-1e4, -10, -1e4, 1e4, 10, 1e4, out)).toBe(0);
    const plain = new TrafficSim(t.roads, t.signals, { seed: 1, maxCars: 1, radius: 2000 });
    plain.target = 0;
    (plain as unknown as { spawnAt(e: number, s: number, type: number): number }).spawnAt(lane.id, 20, 0);
    expect(plain.queryMovers(-1e4, -10, -1e4, 1e4, 10, 1e4, out)).toBe(1);
  });
});

describe('cars are kinematic colliders', () => {
  it('movers report the car box, its yaw and velocity', () => {
    const t = createCityTraffic(city);
    run(t, 120);
    const out: MoverCollider[] = [];
    const n = t.sim.queryMovers(-1e4, -10, -1e4, 1e4, 10, 1e4, out);
    expect(n).toBe(t.sim.count);
    for (let i = 0; i < n; i++) {
      const m = out[i]!;
      const c = Number(m.id.split(':')[1]);
      expect(m.shape.kind).toBe('box');
      expect(m.shape.center[0]).toBeCloseTo(t.sim.x[c]!, 9);
      expect(m.velocity[0]).toBeCloseTo(t.sim.vx[c]!, 9);
      expect(m.velocity[2]).toBeCloseTo(t.sim.vz[c]!, 9);
    }
  });

  it('the drone hovering in a car\'s path gets hit (a contact with the car) and is pushed along', () => {
    const rt = cityRuntime();
    const content = rt.content!;
    const traffic = content.kind === 'city' ? content.traffic! : null;
    expect(traffic).not.toBeNull();
    const sim = traffic!.sim;
    const world = new PhysicsWorld(rt);
    expect(rt.life!.movers.size).toBe(1);
    // one car driving down a lane with a long green; the drone sits 1 m off the ground right in front of it, and the
    // car does not see it (focus far away: it does not brake for a drone it is not told about)
    const lane = traffic!.roads.edges.find((e) => e.kind === EDGE_LANE && e.node >= 0 && Math.abs(e.px[0]! - streetLine(3)) < 30)!;
    sim.target = 0;
    sim.clear();
    (sim as unknown as { spawnAt(e: number, s: number, type: number): number }).spawnAt(lane.id, 12, 0);
    const c = sim.alive.indexOf(1);
    sim.v[c] = 12;
    const hx = (lane.px[1]! - lane.px[0]!) / lane.length;
    const hz = (lane.pz[1]! - lane.pz[0]!) / lane.length;
    world.reset(new Vector3(lane.px[0]! + hx * 22, 0.9, lane.pz[0]! + hz * 22), 0);
    const ids = new Set<string>();
    let maxImpact = 0;
    const drone = world.state.position;
    for (let f = 0; f < 120; f++) {
      // the car is told the drone is high up: it does not brake
      sim.update(DT, drone.x, 500, drone.z, 500);
      sim.v[c] = Math.max(sim.v[c]!, 10);
      for (let k = 0; k < 16; k++) {
        for (const ct of world.step(DT / 16, [0.45, 0.45, 0.45, 0.45])) {
          ids.add(ct.colliderId);
          maxImpact = Math.max(maxImpact, ct.impactSpeed);
        }
      }
    }
    expect([...ids].some((id) => id.startsWith('car:'))).toBe(true);
    expect(maxImpact).toBeGreaterThan(5);
    // pushed along the car's heading
    const v = world.state.velocity;
    expect(v.x * hx + v.z * hz).toBeGreaterThan(1);
  });
});
