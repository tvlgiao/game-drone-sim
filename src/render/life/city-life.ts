/**
 * City roofs come alive (docs/12): fans spinning in the rooftop AC units near the drone (one draw), steam from a few
 * of them (the shared puff draw), flags on some low and mid-rise roofs (one draw), and red obstruction lights
 * blinking on the corners of the towers (one draw). Lit windows switch on and off in the facade shader itself.
 */
import * as THREE from 'three';
import type { ColliderGrid } from '../../physics/collider-grid';
import type { Collider } from '../../types';
import { BUILDING_STRIDE, ROOF_PROP_STRIDE, type City } from '../../world/city-gen';
import { hash2, rehash, u01 } from '../../world/rng';
import { CITY_RING_CLEARANCE } from '../../world/city-gen';
import { distanceToShape } from '../../world/routes';
import type { InstanceUniforms } from '../outdoor/terrain-materials';
import { AnimLayer, BEACON_COLOR, FAN_PRE, FLAG_COLOR, FLAG_PRE, LIFE_LOCAL_PARS_F, LIFE_LOCAL_PARS_V, PuffLayer, PUFF_KIND } from './ambient';
import { acFanModel, beaconModel, flagModel } from './life-models';
import type { LifeBudget } from './budget';

/** fans and steam within this distance of the drone, m (rebuilt every REBUILD m) */
const FAN_RANGE = 220;
const REBUILD = 40;
const OWNER_FLAGS = 'life:flags';

export class CityLifeView {
  readonly group = new THREE.Group();
  readonly puffs = new PuffLayer();
  private readonly fans: AnimLayer;
  private readonly flags: AnimLayer;
  private readonly beacons: AnimLayer;
  private readonly city: City;
  private readonly grid: ColliderGrid | null;
  private readonly at = new THREE.Vector3(Infinity, 0, Infinity);
  private budget: LifeBudget | null = null;
  /** flag poles x, y, z, colour (fixed for the level) */
  private readonly flagSpots: number[] = [];
  private readonly steam: number[] = [];
  private windYaw = 0;

  constructor(city: City, shared: InstanceUniforms, grid: ColliderGrid | null) {
    this.group.name = 'city-life';
    this.city = city;
    this.grid = grid;
    this.fans = new AnimLayer(acFanModel(), { key: 'ac-fans', pre: FAN_PRE, roughness: 0.6 }, shared, false);
    this.flags = new AnimLayer(
      flagModel(),
      { key: 'flags', pre: FLAG_PRE, vertexPars: LIFE_LOCAL_PARS_V, fragmentPars: LIFE_LOCAL_PARS_F, fragment: FLAG_COLOR, roughness: 0.8, side: THREE.DoubleSide },
      shared,
      false,
    );
    this.beacons = new AnimLayer(beaconModel(), { key: 'beacons', fragment: BEACON_COLOR, roughness: 0.4 }, shared, false);
    this.group.add(this.fans.mesh, this.flags.mesh, this.beacons.mesh, this.puffs.layer.mesh);

    // flags on about one roof in nine below 70 m, poles are colliders
    const b = city.buildings;
    const cols: Collider[] = [];
    for (let k = 0; k < b.length; k += BUILDING_STRIDE) {
      const x = b[k]!, y = b[k + 1]!, z = b[k + 2]!, w = b[k + 3]!, h = b[k + 4]!, d = b[k + 5]!;
      if (b[k + 7] === 1 || h > 70 || w < 10) continue;
      const hh = hash2(city.seed, Math.floor(x), Math.floor(z), 0xf1a6);
      if (u01(hh) > 0.11) continue;
      const fx = x - w / 2 + 1.2;
      const fz = z - d / 2 + 1.2;
      const pole = { kind: 'cylinder' as const, center: [fx, y + h + 3.5, fz] as [number, number, number], radius: 1.9, halfHeight: 3.5 };
      // never within a ring's clearance (the race stays clear, like the street furniture)
      if (city.rings.some((r) => distanceToShape(r.position[0], r.position[1], r.position[2], pole) < r.radius + CITY_RING_CLEARANCE)) continue;
      this.flagSpots.push(fx, y + h, fz, Math.floor(u01(rehash(hh, 3)) * 4));
      cols.push({ id: `flag:${cols.length}`, shape: { kind: 'cylinder', center: [fx, y + h + 3.5, fz], radius: 0.1, halfHeight: 3.5 } });
    }
    this.grid?.insertOwned(OWNER_FLAGS, cols);
    // obstruction lights on the four roof corners of every tower over 90 m
    const bl = this.beacons.layer;
    bl.begin();
    for (let k = 0; k < b.length; k += BUILDING_STRIDE) {
      const x = b[k]!, y = b[k + 1]!, z = b[k + 2]!, w = b[k + 3]!, h = b[k + 4]!, d = b[k + 5]!;
      if (h < 90) continue;
      for (const [sx, sz] of [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ] as const) {
        bl.push(x + sx * (w / 2 - 0.4), y + h, z + sz * (d / 2 - 0.4), 0, 1, 1, 1, 0);
      }
    }
    bl.end();
    // steam: one AC unit in eight
    const rp = city.roofProps;
    for (let k = 0; k < rp.length; k += ROOF_PROP_STRIDE) {
      if (rp[k] !== 0) continue;
      const x = rp[k + 1]!;
      const z = rp[k + 3]!;
      if (u01(hash2(city.seed, Math.floor(x * 3), Math.floor(z * 3), 0x57ea)) > 0.125) continue;
      this.steam.push(x, rp[k + 2]! + rp[k + 5]! + 0.2, z, PUFF_KIND.steam);
    }
  }

  setBudget(b: LifeBudget): void {
    this.budget = b;
    this.puffs.budget = b.puffs;
    this.fans.mesh.visible = b.roofLife;
    this.flags.mesh.visible = b.roofLife;
    this.beacons.mesh.visible = b.roofLife;
    this.at.set(Infinity, 0, Infinity);
  }

  /** wind direction (x, z), the flags stream downwind */
  setWind(w: THREE.Vector2): void {
    // the cloth runs along local +X: R_y(yaw)·(1, 0, 0) = (cos yaw, −sin yaw) = w
    const yaw = Math.atan2(-w.y, w.x);
    if (Math.abs(yaw - this.windYaw) < 1e-6 && this.flags.layer.count > 0) return;
    this.windYaw = yaw;
    const fl = this.flags.layer;
    fl.begin();
    for (let k = 0; k < this.flagSpots.length; k += 4) fl.push(this.flagSpots[k]!, this.flagSpots[k + 1]!, this.flagSpots[k + 2]!, yaw, 1, 1, 1, this.flagSpots[k + 3]!);
    fl.end();
    this.flags.mesh.visible = this.budget?.roofLife !== false && fl.count > 0;
  }

  update(time: number, drone: THREE.Vector3, wind: THREE.Vector2, fogDensity: number, fogColor: THREE.Color): void {
    const u = this.puffs.uniforms;
    u.uTime.value = time;
    u.uWindDir.value.copy(wind);
    u.uFogDensity.value = fogDensity;
    u.uFogColor.value.copy(fogColor);
    if ((drone.x - this.at.x) ** 2 + (drone.z - this.at.z) ** 2 < REBUILD * REBUILD) return;
    this.at.copy(drone);
    const r2 = FAN_RANGE * FAN_RANGE;
    const fl = this.fans.layer;
    fl.begin();
    if (this.budget?.roofLife !== false) {
      const rp = this.city.roofProps;
      for (let k = 0; k < rp.length; k += ROOF_PROP_STRIDE) {
        if (rp[k] !== 0) continue;
        const x = rp[k + 1]!;
        const z = rp[k + 3]!;
        if ((x - drone.x) ** 2 + (z - drone.z) ** 2 > r2) continue;
        fl.push(x, rp[k + 2]! + rp[k + 5]!, z, 0, 1, 1, 1, 0);
      }
    }
    fl.end();
    this.fans.mesh.visible = this.budget?.roofLife !== false && fl.count > 0;
    // steam from the vents nearest the drone first (the budget caps the puffs)
    const near: number[] = [];
    for (let k = 0; k < this.steam.length; k += 4) {
      const x = this.steam[k]!;
      const z = this.steam[k + 2]!;
      if ((x - drone.x) ** 2 + (z - drone.z) ** 2 < 450 * 450) near.push(x, this.steam[k + 1]!, z, this.steam[k + 3]!);
    }
    this.puffs.set(near, near.length / 4, 0, 0, 5);
    this.puffs.layer.mesh.visible = this.puffs.layer.count > 0;
  }

  counts(): Record<string, number> {
    return { fans: this.fans.count, flags: this.flags.count, beacons: this.beacons.count, steam: this.puffs.count };
  }

  dispose(): void {
    this.grid?.removeOwner(OWNER_FLAGS);
    this.group.removeFromParent();
    this.fans.dispose();
    this.flags.dispose();
    this.beacons.dispose();
    this.puffs.dispose();
    this.group.clear();
  }
}
