/**
 * Countryside life on screen (docs/12): wind turbines turning (one draw), grazing herds (one draw), a tractor
 * ploughing (one draw), chimney smoke (the shared puff draw). Turbine towers and rotor discs, and the animals, are
 * static colliders in the level's grid (re-registered when the placement moves with the drone); the tractor is a
 * kinematic mover. Placement comes from `countrysideAround` (generated worlds) or the level's own list (Training).
 */
import * as THREE from 'three';
import type { ColliderGrid } from '../../physics/collider-grid';
import type { Collider } from '../../types';
import type { CountrysideLife } from '../../world/life/countryside';
import { TURBINE_RADIUS } from '../../world/life/countryside';
import type { EmitterSource, LifeEmitter, LifeHub } from '../../world/life/hub';
import { Tractor } from '../../world/life/tractor';
import type { InstanceUniforms } from '../outdoor/terrain-materials';
import { ANIMAL_COLOR, ANIMAL_PRE, AnimLayer, LIFE_LOCAL_PARS_F, LIFE_LOCAL_PARS_V, PuffLayer, PUFF_KIND, TURBINE_PRE } from './ambient';
import { animalModel, tractorModel, turbineModel, TURBINE_HUB, TURBINE_ROTOR } from './life-models';
import type { LifeBudget } from './budget';

const OWNER_TURBINES = 'life:turbines';
const OWNER_ANIMALS = 'life:animals';

export class CountrysideView implements EmitterSource {
  readonly group = new THREE.Group();
  readonly puffs = new PuffLayer();
  private readonly turbines: AnimLayer;
  private readonly animals: AnimLayer;
  private readonly tractorLayer: AnimLayer;
  private tractor: Tractor | null = null;
  private content: CountrysideLife = { chimneys: [], herds: [], turbines: [], tractor: null };
  private readonly hub: LifeHub | null;
  private readonly grid: ColliderGrid | null;
  private readonly ground: (x: number, z: number) => number;
  private budget: LifeBudget | null = null;
  private readonly origin = { x: 0, z: 0 };
  private readonly sources: number[] = [];

  constructor(shared: InstanceUniforms, hub: LifeHub | null, grid: ColliderGrid | null, ground: (x: number, z: number) => number) {
    this.group.name = 'countryside';
    this.hub = hub;
    this.grid = grid;
    this.ground = ground;
    this.turbines = new AnimLayer(turbineModel(), { key: 'turbines', pre: TURBINE_PRE, roughness: 0.55, envMapIntensity: 0.7 }, shared, true);
    this.animals = new AnimLayer(
      animalModel(),
      { key: 'animals', pre: ANIMAL_PRE, vertexPars: LIFE_LOCAL_PARS_V, fragmentPars: LIFE_LOCAL_PARS_F, fragment: ANIMAL_COLOR, roughness: 0.95 },
      shared,
      true,
    );
    this.tractorLayer = new AnimLayer(tractorModel(), { key: 'tractor', roughness: 0.6 }, shared, true);
    this.group.add(this.turbines.mesh, this.animals.mesh, this.tractorLayer.mesh, this.puffs.layer.mesh);
    hub?.addSource(this);
  }

  setBudget(b: LifeBudget): void {
    this.budget = b;
    this.puffs.budget = b.puffs;
    this.rebuild();
  }

  /** New placement (the drone moved on, or the level's fixed list), drawn relative to the floating origin. */
  setContent(c: CountrysideLife, ox: number, oz: number): void {
    this.content = c;
    this.origin.x = ox;
    this.origin.z = oz;
    if (this.tractor) this.hub?.movers.remove(this.tractor);
    this.tractor = c.tractor ? new Tractor(c.tractor, this.ground) : null;
    if (this.tractor && this.budget?.tractor !== false) this.hub?.movers.add(this.tractor);
    this.colliders();
    this.rebuild();
  }

  /** Rebases the instances to a new floating origin (same content). */
  setOrigin(ox: number, oz: number): void {
    if (ox === this.origin.x && oz === this.origin.z) return;
    this.origin.x = ox;
    this.origin.z = oz;
    this.rebuild();
  }

  private colliders(): void {
    if (!this.grid) return;
    const c = this.content;
    const cols: Collider[] = [];
    for (let k = 0; k < c.turbines.length; k += 4) {
      const x = c.turbines[k]!;
      const y = c.turbines[k + 1]!;
      const z = c.turbines[k + 2]!;
      const yaw = c.turbines[k + 3]!;
      const id = `turbine:${k / 4}`;
      cols.push({ id, shape: { kind: 'cylinder', center: [x, y + TURBINE_HUB / 2, z], radius: TURBINE_RADIUS, halfHeight: TURBINE_HUB / 2 } });
      // the rotor sweeps a disc in front of the nacelle: a thin box the drone cannot slip through between blades
      const fx = Math.sin(yaw) * 2.6;
      const fz = Math.cos(yaw) * 2.6;
      cols.push({ id, shape: { kind: 'box', center: [x + fx, y + TURBINE_HUB, z + fz], half: [TURBINE_ROTOR, TURBINE_ROTOR, 0.4], yaw } });
      cols.push({ id, shape: { kind: 'box', center: [x - fx * 0.5, y + TURBINE_HUB, z - fz * 0.5], half: [1.2, 1.3, 3.4], yaw } });
    }
    this.grid.insertOwned(OWNER_TURBINES, cols);
    const an: Collider[] = [];
    for (const h of c.herds) {
      const sheep = h.kind === 1;
      for (let i = 0; i < h.animals.length; i += 4) {
        const yaw = h.animals[i + 3]!;
        an.push({ id: `animal:${an.length}`, shape: { kind: 'box', center: [h.animals[i]!, h.animals[i + 1]! + (sheep ? 0.45 : 0.75), h.animals[i + 2]!], half: sheep ? [0.3, 0.45, 0.6] : [0.4, 0.75, 1.05], yaw } });
      }
    }
    this.grid.insertOwned(OWNER_ANIMALS, an);
  }

  private rebuild(): void {
    const c = this.content;
    const b = this.budget;
    const ox = this.origin.x;
    const oz = this.origin.z;
    const t = this.turbines.layer;
    t.begin();
    for (let k = 0; k < c.turbines.length; k += 4) t.push(c.turbines[k]! - ox, c.turbines[k + 1]!, c.turbines[k + 2]! - oz, c.turbines[k + 3]!, 1, 1, 1, 0);
    t.end();
    const a = this.animals.layer;
    a.begin();
    let n = 0;
    const cap = b ? b.animals : Infinity;
    for (const h of c.herds) {
      for (let i = 0; i < h.animals.length && n < cap; i += 4, n++) {
        const sheep = h.kind === 1;
        const breed = sheep ? 2 : (Math.floor(h.x * 7 + h.z * 3) & 1) === 0 ? 0 : 1;
        const s = sheep ? 0.62 : 1;
        a.push(h.animals[i]! - ox, h.animals[i + 1]!, h.animals[i + 2]! - oz, h.animals[i + 3]!, s * (sheep ? 1.15 : 1), s, s * 0.85, breed);
      }
    }
    a.end();
    // chimney smoke (none on the Quest tier)
    this.sources.length = 0;
    for (let k = 0; k < c.chimneys.length; k += 3) this.sources.push(c.chimneys[k]!, c.chimneys[k + 1]!, c.chimneys[k + 2]!, PUFF_KIND.smoke);
    this.puffs.set(this.sources, this.sources.length / 4, ox, oz, 6);
    this.puffs.layer.mesh.visible = this.puffs.layer.count > 0 && (b ? b.puffs > 0 : true);
    this.tractorLayer.layer.begin();
    this.tractorLayer.layer.end();
  }

  update(time: number, wind: THREE.Vector2, fogDensity: number, fogColor: THREE.Color): void {
    this.puffs.uniforms.uTime.value = time;
    this.puffs.uniforms.uWindDir.value.copy(wind);
    this.puffs.uniforms.uFogDensity.value = fogDensity;
    this.puffs.uniforms.uFogColor.value.copy(fogColor);
    const tl = this.tractorLayer.layer;
    tl.begin();
    if (this.tractor && this.budget?.tractor !== false) {
      this.tractor.update(time);
      const tr = this.tractor;
      tl.push(tr.x - this.origin.x, tr.y, tr.z - this.origin.z, tr.yaw, 1, 1, 1, 0);
    }
    tl.end();
  }

  collectEmitters(out: LifeEmitter[], n: number): number {
    const c = this.content;
    for (let k = 0; k < c.turbines.length && n < out.length; k += 4) {
      const e = out[n++]!;
      e.kind = 'turbine';
      e.x = c.turbines[k]!;
      e.y = c.turbines[k + 1]! + TURBINE_HUB;
      e.z = c.turbines[k + 2]!;
      e.vx = e.vy = e.vz = 0;
      e.speed = 0.26;
      e.intensity = 0.5;
      e.variant = 0;
    }
    for (const h of c.herds) {
      if (n >= out.length) break;
      const e = out[n++]!;
      e.kind = 'herd';
      e.x = h.x;
      e.y = this.ground(h.x, h.z) + 1;
      e.z = h.z;
      e.vx = e.vy = e.vz = 0;
      e.speed = 0;
      e.intensity = Math.min(1, h.animals.length / 40);
      e.variant = h.kind;
    }
    if (this.tractor && n < out.length) {
      const e = out[n++]!;
      e.kind = 'tractor';
      e.x = this.tractor.x;
      e.y = this.tractor.y + 1.5;
      e.z = this.tractor.z;
      e.vx = this.tractor.vx;
      e.vy = 0;
      e.vz = this.tractor.vz;
      e.speed = 2.4;
      e.intensity = 0.8;
      e.variant = 0;
    }
    return n;
  }

  counts(): Record<string, number> {
    return { turbines: this.turbines.count, animals: this.animals.count, tractor: this.tractorLayer.count, puffs: this.puffs.count };
  }

  dispose(): void {
    this.hub?.removeSource(this);
    if (this.tractor) this.hub?.movers.remove(this.tractor);
    this.grid?.removeOwner(OWNER_TURBINES);
    this.grid?.removeOwner(OWNER_ANIMALS);
    this.group.removeFromParent();
    this.turbines.dispose();
    this.animals.dispose();
    this.tractorLayer.dispose();
    this.puffs.dispose();
    this.group.clear();
  }
}
