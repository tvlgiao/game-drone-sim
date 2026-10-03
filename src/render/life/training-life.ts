/**
 * Life around the Training Field (docs/12): swallows over the meadow, a row of wind turbines on the rise to the
 * north, a herd of cows in the paddock east of the field, a tractor ploughing the parcel by the red barn, smoke from
 * the farmhouse chimney and the odd car on the farm road. All outside the flying field and its fence.
 */
import * as THREE from 'three';
import type { QualityTier } from '../../types';
import type { LevelRuntime } from '../../levels/runtime';
import { BirdFlocks } from '../../world/life/birds';
import type { CountrysideLife, Herd } from '../../world/life/countryside';
import { EDGE_LANE, makeEdge, type Edge, type Network } from '../../world/traffic/network';
import { TrafficSim } from '../../world/traffic/traffic-sim';
import { terrainHeight } from '../outdoor/ground';
import type { InstanceUniforms } from '../outdoor/terrain-materials';
import { BirdsView, BIRD_KIND } from './birds-view';
import { lifeBudget, type LifeBudget } from './budget';
import { CountrysideView } from './countryside-view';
import { TrafficView } from './traffic-view';

/** the farm road of the Training scenery (scenery.ts `road`): z along x */
const roadZ = (x: number): number => -150 - Math.sin(x / 140) * 25;

function farmRoad(): Network {
  const edges: Edge[] = [];
  for (const dir of [1, -1]) {
    const xs: number[] = [];
    const zs: number[] = [];
    const ys: number[] = [];
    for (let k = 0; k <= 86; k++) {
      const x = dir > 0 ? -516 + k * 12 : 516 - k * 12;
      // lane 1.4 m right of the centre: heading +x, right is +z
      const dz = (roadZ(x + 1) - roadZ(x - 1)) / 2;
      const l = Math.hypot(1, dz);
      const z = roadZ(x) + (dir * 1.4) / l;
      xs.push(x - (dir * 1.4 * dz) / l);
      zs.push(z);
      ys.push(terrainHeight(x, z) + 0.05);
    }
    edges.push(makeEdge(edges.length, EDGE_LANE, xs, zs, ys, { limit: 14 }));
  }
  return { edges, spawnable: [0, 1], nodes: [] };
}

function herd(cx: number, cz: number, n: number, seed: number): Herd {
  const animals: number[] = [];
  let s = seed;
  const r = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = 0; i < n; i++) {
    const x = cx + (r() - 0.5) * 30;
    const z = cz + (r() - 0.5) * 22;
    animals.push(x, terrainHeight(x, z), z, r() * Math.PI * 2);
  }
  return { animals, kind: 0, x: cx, z: cz };
}

export class TrainingLife {
  readonly group = new THREE.Group();
  private readonly birds: BirdsView;
  private readonly countryside: CountrysideView;
  private readonly cars: TrafficSim;
  private readonly carView: TrafficView;
  private readonly rt: LevelRuntime | null;
  private budget: LifeBudget;
  private readonly wind: THREE.Vector2;
  private readonly fogColor: THREE.Color;
  private readonly fog: THREE.FogExp2;

  constructor(rt: LevelRuntime | null, shared: InstanceUniforms, wind: THREE.Vector2, fog: THREE.FogExp2, tier: QualityTier) {
    this.group.name = 'life';
    this.rt = rt;
    this.wind = wind;
    this.fog = fog;
    this.fogColor = fog.color;
    this.budget = lifeBudget(tier);
    const ground = (x: number, z: number): number => terrainHeight(x, z);
    const hub = rt?.life ?? null;
    this.birds = new BirdsView(
      [
        {
          sim: new BirdFlocks({ seed: 0x7a1, flocks: 2, birds: 14, speed: 12.5, radius: [20, 38], height: [12, 30], keep: Infinity, place: [90, 200], ground, homes: [[-110, 70], [130, -60]] }, 0, 0),
          kind: BIRD_KIND.swallow,
          scale: 0.75,
        },
      ],
      shared,
      hub,
    );
    this.countryside = new CountrysideView(shared, hub, rt?.grid ?? null, ground);
    // turbines on the rise to the north, facing into the wind
    const face = Math.atan2(-wind.x, -wind.y);
    const turbines: number[] = [];
    for (const a of [-0.95, -0.72, -0.49, -0.26]) {
      const x = Math.sin(a) * 560;
      const z = -Math.cos(a) * 560;
      turbines.push(x, terrainHeight(x, z) - 0.5, z, face);
    }
    const life: CountrysideLife = {
      chimneys: [-327, terrainHeight(-330, -210) + 9.8, -210],
      herds: [herd(150, 120, 8, 77)],
      turbines,
      tractor: { x: 150, z: -330, yaw: 0.25, halfW: 22, halfL: 30 },
    };
    this.countryside.setContent(life, 0, 0);
    this.countryside.setBudget(this.budget);
    this.cars = new TrafficSim(farmRoad(), null, { seed: 0x7a2, maxCars: 3, radius: 900, spawnInner: 0.55, vehicles: [0, 1, 2, 3] });
    this.cars.target = 2;
    hub?.addTraffic(this.cars);
    this.carView = new TrafficView(this.cars, null, null, shared, { generic: true, glow: false, shadows: false, signalRange: 0 });
    this.birds.setBudget(this.budget.flocks, this.budget.birds);
    this.group.add(this.birds.group, this.countryside.group, this.carView.group);
  }

  setQuality(tier: QualityTier): void {
    this.budget = lifeBudget(tier);
    this.birds.setBudget(this.budget.flocks, this.budget.birds);
    this.countryside.setBudget(this.budget);
  }

  update(time: number, dt: number, drone: THREE.Vector3): void {
    this.birds.update(dt, drone);
    this.countryside.update(time, this.wind, this.fog.density, this.fogColor);
    this.cars.update(dt, drone.x, drone.y, drone.z, drone.y);
    this.carView.update(this.cars.time, drone);
  }

  stats(): Record<string, unknown> {
    return { birds: this.birds.count, countryside: this.countryside.counts(), ruralCars: this.cars.count };
  }

  dispose(): void {
    this.rt?.life?.removeTraffic(this.cars);
    this.group.removeFromParent();
    this.birds.dispose();
    this.countryside.dispose();
    this.carView.dispose();
    this.group.clear();
  }
}
