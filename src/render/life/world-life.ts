/**
 * Ambient life of a generated outdoor level (City, Alpine Valley, Infinite), docs/12: it ticks the level's traffic
 * around the drone and draws it, and owns the other animated layers (birds, roof life, countryside). Built and
 * disposed with the WorldLevelView; budgets per tier from `budget.ts`.
 */
import * as THREE from 'three';
import type { FormFactor } from '../../core/device';
import type { QualityTier } from '../../types';
import type { LevelRuntime } from '../../levels/runtime';
import type { LevelFrame } from '../level-view';
import type { InstanceUniforms } from '../outdoor/terrain-materials';
import type { WorldOrigin } from '../outdoor/world-origin';
import { lifeBudget, type LifeBudget } from './budget';
import { TrafficView } from './traffic-view';
import { BirdsView, BIRD_KIND, type BirdGroup } from './birds-view';
import { BirdFlocks } from '../../world/life/birds';
import { blockCentre, CITY_BLOCKS, CITY_RIVER } from '../../world/city-gen';
import { countrysideAround } from '../../world/life/countryside';
import { buildRuralNetwork } from '../../world/traffic/rural-roads';
import { TrafficSim } from '../../world/traffic/traffic-sim';
import { CountrysideView } from './countryside-view';
import { CityLifeView } from './city-life';

export class WorldLife {
  readonly group = new THREE.Group();
  private readonly rt: LevelRuntime;
  private budget: LifeBudget;
  private readonly form: FormFactor;
  private traffic: TrafficView | null = null;
  private readonly birds: BirdsView;
  private readonly origin: WorldOrigin;
  private countryside: CountrysideView | null = null;
  private cityLife: CityLifeView | null = null;
  /** where the countryside placement / the rural road network were last built around */
  private readonly placedAt = new THREE.Vector3(Infinity, 0, Infinity);
  private readonly roadsAt = new THREE.Vector3(Infinity, 0, Infinity);
  private rural: TrafficSim | null = null;
  private ruralView: TrafficView | null = null;
  private readonly shared: InstanceUniforms;
  private readonly wind: THREE.Vector2;
  private readonly fogColor = new THREE.Color();
  private fogDensity = 0;
  /** ms the last countryside / road rebuild took */
  placeMs = 0;
  /** CPU time of the last traffic tick (ms) */
  trafficMs = 0;

  constructor(rt: LevelRuntime, shared: InstanceUniforms, origin: WorldOrigin, tier: QualityTier, form: FormFactor, wind: THREE.Vector2) {
    this.group.name = 'life';
    this.shared = shared;
    this.wind = wind;
    this.rt = rt;
    this.form = form;
    this.origin = origin;
    this.budget = lifeBudget(tier, form);
    const c = rt.content;
    const ground = (x: number, z: number): number => (rt.terrain ? rt.terrain.heightAt(x, z) : 0);
    const seed = c?.seed ?? 1;
    const s = rt.def.spawn.position;
    const groups: BirdGroup[] = [];
    if (c?.kind === 'city') {
      // pigeons over the park and the streets around the take-off, gulls over the river
      let park: [number, number] = [blockCentre(10), blockCentre(4)];
      for (let j = 0; j < CITY_BLOCKS; j++) for (let i = 0; i < CITY_BLOCKS; i++) if (c.city.blockClass(i, j) === 'park') park = [blockCentre(i), blockCentre(j)];
      // pigeons circle over the park and the two low-rise blocks nearest the take-off, above their roofs (≤ 20 m)
      const low: [number, number, number][] = [];
      for (let j = 0; j < CITY_BLOCKS; j++)
        for (let i = 0; i < CITY_BLOCKS; i++) if (c.city.blockClass(i, j) === 'low') low.push([blockCentre(i), blockCentre(j), (blockCentre(i) - s[0]) ** 2 + (blockCentre(j) - s[2]) ** 2]);
      low.sort((a, b) => a[2] - b[2]);
      const homes: [number, number][] = [park, ...low.slice(0, 2).map((b) => [b[0], b[1]] as [number, number])];
      groups.push({ sim: new BirdFlocks({ seed, flocks: 3, birds: 16, speed: 11, radius: [14, 24], height: [30, 44], keep: Infinity, place: [90, 220], ground, homes }, s[0], s[2]), kind: BIRD_KIND.pigeon, scale: 0.85 });
      groups.push({ sim: new BirdFlocks({ seed: seed + 1, flocks: 1, birds: 10, speed: 8.5, radius: [30, 55], height: [12, 30], keep: Infinity, place: [120, 260], ground, homes: [[CITY_RIVER.x, s[2] + 120]] }, s[0], s[2]), kind: BIRD_KIND.gull, scale: 1.25 });
    } else {
      const alpine = rt.def.id === 'alpine';
      groups.push({
        sim: new BirdFlocks({ seed, flocks: 3, birds: 16, speed: alpine ? 10 : 12.5, radius: [22, 45], height: alpine ? [40, 90] : [14, 45], keep: 650, place: [110, 380], ground }, s[0], s[2]),
        kind: alpine ? BIRD_KIND.crow : BIRD_KIND.swallow,
        scale: alpine ? 1.2 : 0.75,
      });
    }
    this.birds = new BirdsView(groups, shared, rt.life ?? null);
    this.birds.setBudget(this.budget.flocks, this.budget.birds);
    this.group.add(this.birds.group);
    if (c?.kind === 'city' && c.traffic) {
      const t = c.traffic;
      this.traffic = new TrafficView(t.sim, t.signals, t.roads.signals, shared, this.trafficOptions());
      this.group.add(this.traffic.group);
      this.applyTrafficBudget();
    }
    if (c?.kind === 'city') {
      this.cityLife = new CityLifeView(c.city, shared, rt.grid);
      this.cityLife.setBudget(this.budget);
      this.cityLife.setWind(wind);
      this.group.add(this.cityLife.group);
    }
    if (c?.kind === 'terrain') {
      this.countryside = new CountrysideView(shared, rt.life ?? null, rt.grid, ground);
      this.countryside.setBudget(this.budget);
      this.group.add(this.countryside.group);
    }
  }

  /** Countryside placement and the rural road network follow the drone (Infinite); Alpine is placed once. */
  private follow(d: THREE.Vector3): void {
    const c = this.rt.content;
    if (c?.kind !== 'terrain' || !this.countryside) return;
    const alpine = c.world.spec.preset === 'alpine';
    const t0 = performance.now();
    if ((d.x - this.placedAt.x) ** 2 + (d.z - this.placedAt.z) ** 2 > (alpine ? Infinity : 320 * 320) || !Number.isFinite(this.placedAt.x)) {
      const at = alpine ? [0, 0] : [d.x, d.z];
      this.placedAt.set(at[0]!, 0, at[1]!);
      // turbines face into the wind: front (+Z) = −wind
      const faceYaw = Math.atan2(-this.wind.x, -this.wind.y);
      const life = countrysideAround(c.world, at[0]!, at[1]!, alpine ? 1700 : 900, faceYaw, { turbines: !alpine, sheep: !alpine });
      this.countryside.setContent(life, this.origin.x, this.origin.z);
    }
    if ((d.x - this.roadsAt.x) ** 2 + (d.z - this.roadsAt.z) ** 2 > 420 * 420) {
      this.roadsAt.set(d.x, 0, d.z);
      const net = buildRuralNetwork(c.world, d.x, d.z, 750);
      if (this.rural) this.rt.life?.removeTraffic(this.rural);
      this.rural = new TrafficSim(net, null, { seed: (c.seed ^ Math.floor(d.x) ^ (Math.floor(d.z) << 8)) >>> 0, maxCars: 12, radius: 650, spawnInner: 0.5, vehicles: [0, 1, 2, 3] });
      this.rural.target = this.budget.ruralCars;
      this.rt.life?.addTraffic(this.rural);
      if (!this.ruralView) {
        this.ruralView = new TrafficView(this.rural, null, null, this.shared, { generic: this.budget.genericCars, glow: false, shadows: false, signalRange: 0 });
        this.group.add(this.ruralView.group);
      } else this.ruralView.setSim(this.rural);
    }
    const ms = performance.now() - t0;
    if (ms > 0.5) this.placeMs = ms;
  }

  private trafficOptions(): ConstructorParameters<typeof TrafficView>[4] {
    const b = this.budget;
    return { generic: b.genericCars, glow: b.carGlow, shadows: b.carShadows, signalRange: b.signalRange };
  }

  private applyTrafficBudget(): void {
    const c = this.rt.content;
    if (c?.kind !== 'city' || !c.traffic) return;
    const sim = c.traffic.sim;
    sim.target = this.budget.cars;
    sim.radius = this.budget.carRadius;
  }

  setQuality(tier: QualityTier): void {
    this.budget = lifeBudget(tier, this.form);
    this.traffic?.setOptions(this.trafficOptions());
    this.applyTrafficBudget();
    this.birds.setBudget(this.budget.flocks, this.budget.birds);
    this.countryside?.setBudget(this.budget);
    this.cityLife?.setBudget(this.budget);
    if (this.rural) this.rural.target = this.budget.ruralCars;
    this.ruralView?.setOptions({ generic: this.budget.genericCars, glow: false, shadows: false, signalRange: 0 });
  }

  /** 0 day … 1 night: car lamps, lit windows */
  setDusk(k: number): void {
    this.traffic?.setLights(Math.min(1, Math.max(0, (k - 0.25) / 0.5)));
  }

  setFog(density: number, color?: THREE.Color): void {
    this.fogDensity = density;
    if (color) this.fogColor.copy(color);
    this.traffic?.setFog(density);
  }

  update(f: LevelFrame): void {
    const c = this.rt.content;
    // floating origin: instances are drawn relative to it, the group carries the offset
    this.group.position.set(this.origin.x, 0, this.origin.z);
    this.birds.origin.x = this.origin.x;
    this.birds.origin.z = this.origin.z;
    this.birds.update(f.dt, f.drone);
    this.cityLife?.update(f.time, f.drone, this.wind, this.fogDensity, this.fogColor);
    if (this.countryside) {
      this.follow(f.drone);
      this.countryside.setOrigin(this.origin.x, this.origin.z);
      this.countryside.update(f.time, this.wind, this.fogDensity, this.fogColor);
    }
    if (this.rural && this.ruralView) {
      const d = f.drone;
      const g = this.rt.terrain ? this.rt.terrain.heightAt(d.x, d.z) : 0;
      this.rural.update(f.dt, d.x, d.y, d.z, d.y - g);
      this.ruralView.origin.x = this.origin.x;
      this.ruralView.origin.z = this.origin.z;
      this.ruralView.update(this.rural.time, d);
    }
    if (c?.kind === 'city' && c.traffic && this.traffic) {
      const d = f.drone;
      const ground = this.rt.terrain ? this.rt.terrain.heightAt(d.x, d.z) : 0;
      const t0 = performance.now();
      c.traffic.sim.update(f.dt, d.x, d.y, d.z, d.y - Math.max(0, ground));
      this.trafficMs = performance.now() - t0;
      this.rt.life?.flushTrafficEvents();
      this.traffic.update(c.traffic.sim.time, d);
    }
  }

  stats(): Record<string, unknown> {
    const c = this.rt.content;
    const out: Record<string, unknown> = {};
    if (c?.kind === 'city' && c.traffic) {
      out.cars = c.traffic.sim.count;
      out.trafficMs = Math.round(this.trafficMs * 1000) / 1000;
      out.trafficDraws = this.traffic?.counts();
    }
    out.birds = this.birds.count;
    if (this.countryside) out.countryside = this.countryside.counts();
    if (this.cityLife) out.city = this.cityLife.counts();
    if (this.rural) out.ruralCars = this.rural.count;
    out.placeMs = Math.round(this.placeMs * 100) / 100;
    return out;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.traffic?.dispose();
    this.birds.dispose();
    this.countryside?.dispose();
    this.cityLife?.dispose();
    if (this.rural) this.rt.life?.removeTraffic(this.rural);
    this.ruralView?.dispose();
    this.group.clear();
  }
}
