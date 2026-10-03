/**
 * Scenery of generated outdoor levels (City, Alpine Valley, Infinite): sky dome and its PMREM environment, sun
 * and hemisphere light, fog matched to the horizon, then either the streamed terrain (chunks, scatter, far
 * backdrop, floating origin) or the City (instanced buildings, street ground, river). Budgets follow the
 * OutdoorProfile of the current quality tier (XR: low).
 */
import * as THREE from 'three';
import type { FormFactor } from '../../core/device';
import type { QualityProfile } from '../../core/quality';
import type { LevelRuntime, WorldContent } from '../../levels/runtime';
import { duskAmount } from '../../levels/skies';
import type { OutdoorLevel } from '../../types';
import type { LevelFrame, LevelView } from '../level-view';
import { CityView, cityRiverGeometry } from './city-view';
import { FarTerrain, farReach } from './far-terrain';
import { outdoorProfile, scaledProfile, type OutdoorProfile } from './outdoor-profile';
import { ScatterView } from './scatter-view';
import { SkyDome, skyEnvironment } from './sky';
import { roadMaterial, terrainDetailTexture, terrainMaterial, type InstanceUniforms } from './terrain-materials';
import { TerrainView } from './terrain-view';
import { setWaterTime, waterMaterial } from './water';
import { WorldOrigin } from './world-origin';

/** sky fill: low enough that slopes facing away from a low sun stay dark */
const HEMI = 0.62;
/**
 * Sun-follow shadow box, fitted to the view: it reaches FOLLOW_HALF around a point pushed ahead of the drone along
 * the camera → drone direction, so its edge lies beyond the detailed trees (impostors cast no shadow) instead of
 * a few metres in front of the chase camera. The City's towers need a wider, deeper box.
 */
const FOLLOW_HALF = 120;
/** share of the box half the centre is pushed ahead of the drone */
const FOLLOW_AHEAD = 0.6;
const FOLLOW_DEPTH = 600;
const CITY_FOLLOW_HALF = 300;
/** City trees switch detail around the drone after it moved this far, m */
const CITY_TREE_REBUILD = 40;
const CITY_FOLLOW_DEPTH = 1600;

const _v = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();

export class WorldLevelView implements LevelView {
  readonly group = new THREE.Group();
  readonly background: THREE.Color;
  readonly fog: THREE.FogExp2;
  readonly environment: THREE.Texture;
  readonly environmentIntensity = 0.85;
  readonly bloomThreshold = 1.6;
  readonly ringLight = new THREE.PointLight(0x19e6ff, 0, 7, 2);
  readonly origin = new WorldOrigin();
  private readonly level: OutdoorLevel;
  private readonly content: WorldContent;
  private readonly dome: SkyDome;
  private readonly envTarget: THREE.WebGLRenderTarget;
  private readonly sun: THREE.DirectionalLight;
  private readonly sunDir: THREE.Vector3;
  private readonly hemi: THREE.HemisphereLight;
  private readonly detail: THREE.DataTexture;
  private readonly shared: InstanceUniforms = { uTime: { value: 0 } };
  private readonly terrainMat: THREE.MeshStandardMaterial;
  private readonly roadMat: THREE.MeshStandardMaterial;
  private readonly waterMat: THREE.ShaderMaterial;
  private readonly scatter: ScatterView;
  private terrain: TerrainView | null = null;
  private far: FarTerrain | null = null;
  private city: CityView | null = null;
  private river: THREE.Mesh | null = null;
  private profile: OutdoorProfile;
  private baseProfile: OutdoorProfile;
  private viewScale = 1;
  private scatterTerrainVersion = -1;
  private scatterOrigin = -1;
  private followShadow = false;
  private cityTrees: Float32Array | null = null;
  /** drone position of the last City tree rebuild (detail follows the drone) */
  private readonly cityTreesAt = new THREE.Vector3();
  /** last horizontal camera → drone direction (FPV has none: keep the previous) */
  private readonly viewDir = new THREE.Vector3(0, 0, -1);
  private readonly shadowAt = new THREE.Vector3();
  private readonly form: FormFactor;
  cameraFar: number;

  constructor(rt: LevelRuntime, renderer: THREE.WebGLRenderer, form: FormFactor) {
    if (rt.def.kind !== 'outdoor' || !rt.content) throw new Error('WorldLevelView needs a generated outdoor level');
    this.level = rt.def;
    this.content = rt.content;
    this.form = form;
    this.group.name = 'world';
    const sky = typeof this.level.env.sky === 'string' ? null : this.level.env.sky;
    if (!sky) throw new Error('outdoor level without a sky');
    this.background = new THREE.Color(sky.horizon);
    this.baseProfile = outdoorProfile('high', form);
    this.profile = this.baseProfile;
    this.fog = new THREE.FogExp2(this.level.env.fog.color, 2.15 / this.fogDistance());
    this.cameraFar = this.farPlane();

    // below the horizon the dome shows the fog colour: past the last terrain the ground melts into the haze
    const haze = sky.horizon;
    this.dome = new SkyDome(sky, haze);
    this.group.add(this.dome.mesh);
    this.envTarget = skyEnvironment(renderer, sky, haze);
    this.environment = this.envTarget.texture;

    this.sunDir = new THREE.Vector3(...sky.sunDir).normalize();
    this.sun = new THREE.DirectionalLight(sky.sunColor, sky.sunIntensity);
    this.sun.name = 'sun';
    this.group.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight(sky.hemi[0], sky.hemi[1], HEMI);
    this.group.add(this.hemi, this.ringLight);

    this.detail = terrainDetailTexture(256, Math.min(renderer.capabilities.getMaxAnisotropy(), 8));
    this.terrainMat = terrainMaterial(this.detail);
    this.roadMat = roadMaterial(this.detail);
    this.waterMat = waterMaterial(sky, this.detail, true);
    const dusk = duskAmount(sky);
    this.scatter = new ScatterView(this.origin, this.shared, { treesLod0: this.profile.treesLod0, treesLod1: this.profile.treesLod1 });
    this.scatter.setDusk(dusk);

    const c = this.content;
    if (c.kind === 'terrain') {
      this.terrain = new TerrainView(c.stream, this.origin, { terrain: this.terrainMat, road: this.roadMat, water: this.waterMat }, { uploads: this.profile.uploads });
      this.group.add(this.terrain.group, this.scatter.group);
      const s = this.level.spawn.position;
      this.origin.set(Math.floor(s[0] / 128) * 128, Math.floor(s[2] / 128) * 128);
    } else {
      this.city = new CityView(c.city, c.outskirts, c.furniture, rt.terrain ?? { heightAt: () => 0 }, this.detail, this.shared, { outskirts: this.profile.outskirts, facadeDetail: this.profile.facadeDetail });
      this.city.setDusk(dusk);
      this.river = new THREE.Mesh(cityRiverGeometry(), this.waterMat);
      this.river.name = 'river';
      this.group.add(this.city.group, this.river, this.scatter.group);
      this.cityTrees = this.city.trees;
      this.cityTreesAt.set(this.level.spawn.position[0], 0, this.level.spawn.position[2]);
      this.scatter.rebuild(new Map(), this.cityTrees, this.cityTreesAt);
    }
    this.placeSun(new THREE.Vector3(...this.level.spawn.position));
  }

  private fogDistance(): number {
    return Math.min(this.level.env.fog.viewDistance, this.profile.fog);
  }

  private farPlane(): number {
    const fog = this.fogDistance();
    const reach = this.content.kind === 'terrain' ? Math.max(farReach(this.profile.stream.radius), this.profile.farRadius > 0 ? farReach(this.profile.farRadius) : 0) : fog;
    // short fog (Quest): a near far plane culls the rings and chunks the fog hides anyway
    return Math.max(fog < 500 ? fog * 1.1 : 600, Math.min(fog * 1.05, reach + 200));
  }

  update(f: LevelFrame): void {
    this.shared.uTime.value = f.time;
    setWaterTime(this.waterMat, f.time);
    this.dome.follow(f.camera);
    const d = f.drone;
    if (this.terrain) {
      this.origin.follow(d.x, d.z);
      this.terrain.update(d.x, d.z);
      this.far?.update(d.x, d.z, this.terrain, f.time * 1000);
      if (this.scatterTerrainVersion !== this.terrain.version || this.scatterOrigin !== this.origin.version) {
        this.scatterTerrainVersion = this.terrain.version;
        this.scatterOrigin = this.origin.version;
        this.scatter.rebuild(this.terrain.shown);
      }
    }
    if (this.cityTrees && (d.x - this.cityTreesAt.x) ** 2 + (d.z - this.cityTreesAt.z) ** 2 > CITY_TREE_REBUILD * CITY_TREE_REBUILD) {
      this.cityTreesAt.set(d.x, 0, d.z);
      this.scatter.rebuild(new Map(), this.cityTrees, this.cityTreesAt, this.profile.furnitureRange);
      this.city?.setFurniture(this.profile.furnitureRange, d.x, d.z, this.profile.kerbs);
    }
    if (this.followShadow) this.placeSun(this.shadowCentre(f.camera, d));
  }

  /** Shadow box centre: ahead of the drone along the horizontal camera → drone direction. */
  shadowCentre(camera: THREE.Vector3, drone: THREE.Vector3): THREE.Vector3 {
    const dx = drone.x - camera.x;
    const dz = drone.z - camera.z;
    const l = Math.sqrt(dx * dx + dz * dz);
    if (l > 0.5) this.viewDir.set(dx / l, 0, dz / l);
    const half = this.city ? CITY_FOLLOW_HALF : FOLLOW_HALF;
    return this.shadowAt.copy(drone).addScaledVector(this.viewDir, half * FOLLOW_AHEAD);
  }

  /** Sun light over `at`; with follow shadows the box is snapped to whole shadow texels (no shimmer). */
  private placeSun(at: THREE.Vector3): void {
    const L = this.sunDir;
    const sun = this.sun;
    const half = this.city ? CITY_FOLLOW_HALF : FOLLOW_HALF;
    const depth = this.city ? CITY_FOLLOW_DEPTH : FOLLOW_DEPTH;
    _right.set(0, 1, 0).cross(L).normalize();
    if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0);
    _up.crossVectors(L, _right).normalize();
    const texel = (half * 2) / Math.max(256, sun.shadow.mapSize.x);
    const r = Math.round(at.dot(_right) / texel) * texel;
    const u = Math.round(at.dot(_up) / texel) * texel;
    const l = at.dot(L);
    _v.copy(_right).multiplyScalar(r).addScaledVector(_up, u).addScaledVector(L, l);
    sun.target.position.copy(_v);
    sun.position.copy(_v).addScaledVector(L, depth / 2);
    sun.target.updateMatrixWorld();
    sun.updateMatrixWorld();
  }

  setQuality(p: QualityProfile): void {
    this.baseProfile = outdoorProfile(p.tier, this.form);
    this.applyProfile(p);
  }

  setViewScale(k: number): void {
    this.viewScale = Math.min(1, Math.max(0.5, k));
    this.applyProfile(null);
  }

  private applyProfile(q: QualityProfile | null): void {
    const prof = scaledProfile(this.baseProfile, this.viewScale);
    this.profile = prof;
    this.fog.density = 2.15 / this.fogDistance();
    this.cameraFar = this.farPlane();
    this.waterMat.uniforms.uDetailOn!.value = prof.waterDetail ? 1 : 0;
    this.scatter.caps = { treesLod0: prof.treesLod0, treesLod1: prof.treesLod1, rocks: prof.rocks };
    if (this.cityTrees) this.scatter.rebuild(new Map(), this.cityTrees, this.cityTreesAt, prof.furnitureRange);
    const c = this.content;
    if (c.kind === 'terrain' && this.terrain) {
      c.stream.configure(prof.stream);
      this.terrain.setUploads(prof.uploads);
      this.scatterTerrainVersion = -1;
      if (prof.farRadius > 0) {
        if (!this.far) {
          this.far = new FarTerrain(c.world.spec, c.stream.chunkBuilder, this.origin, this.terrainMat, this.waterMat, prof.farRadius, this.level.bounds.kind === 'rect' && this.level.bounds.max![0] < 10_000 ? this.level.bounds.max![0] + 1280 : undefined);
          this.group.add(this.far.group);
        } else this.far.setRadius(prof.farRadius);
      } else if (this.far) {
        this.far.dispose();
        this.far = null;
      }
    }
    if (this.city) {
      this.city.setOutskirts(prof.outskirts);
      this.city.setFurniture(prof.furnitureRange, this.cityTreesAt.x, this.cityTreesAt.z, prof.kerbs);
      this.city.setFacadeDetail(prof.facadeDetail);
    }
    if (!q) return;
    const shadows = q.shadows && prof.sunShadows;
    this.sun.castShadow = shadows;
    this.followShadow = shadows;
    this.scatter.setShadows(shadows);
    if (this.city) this.city.buildings.mesh.castShadow = shadows;
    const s = this.sun.shadow;
    const size = this.city ? q.shadowMapSize : Math.min(q.shadowMapSize, 2048);
    s.mapSize.set(size, size);
    s.map?.dispose();
    s.map = null;
    const cam = s.camera;
    const half = this.city ? CITY_FOLLOW_HALF : FOLLOW_HALF;
    cam.left = -half;
    cam.right = half;
    cam.top = half;
    cam.bottom = -half;
    cam.near = 1;
    cam.far = this.city ? CITY_FOLLOW_DEPTH : FOLLOW_DEPTH;
    cam.updateProjectionMatrix();
    const texel = (half * 2) / size;
    s.bias = -0.0004;
    s.normalBias = Math.max(0.04, texel * 0.9);
    s.autoUpdate = true;
    s.radius = 2;
    s.needsUpdate = true;
    this.hemi.intensity = shadows ? HEMI : HEMI * 1.15;
  }

  refreshShadows(): void {
    this.sun.shadow.needsUpdate = true;
  }

  get busy(): boolean {
    const c = this.content;
    if (c.kind !== 'terrain' || !this.terrain) return false;
    return c.stream.pending > 0 || this.terrain.uploadsLastFrame > 0 || (this.far !== null && this.far.stream.pending > 0);
  }

  stats(): Record<string, unknown> {
    const c = this.content;
    const base: Record<string, unknown> = { origin: [this.origin.x, this.origin.z], fog: Math.round(this.fogDistance()), far: Math.round(this.cameraFar), viewScale: this.viewScale, instances: this.scatter.counts() };
    if (c.kind === 'terrain' && this.terrain) {
      base.chunks = this.terrain.shown.size;
      base.created = this.terrain.created;
      base.pooled = this.terrain.pooled;
      base.uploads = this.terrain.uploadsLastFrame;
      base.colliderChunks = c.stream.colliderChunks.size;
      base.pending = c.stream.pending;
      base.builder = c.stream.builderKind;
      base.failures = c.stream.failures;
      base.farChunks = this.far?.count ?? 0;
      base.radius = this.profile.stream.radius;
    }
    if (this.city) base.buildings = this.city.buildings.count;
    return base;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.terrain?.dispose();
    this.far?.dispose();
    this.city?.dispose();
    this.river?.geometry.dispose();
    this.scatter.dispose();
    this.dome.dispose();
    this.envTarget.dispose();
    this.sun.shadow.map?.dispose();
    this.sun.dispose();
    this.hemi.dispose();
    this.ringLight.dispose();
    this.detail.dispose();
    this.terrainMat.dispose();
    this.roadMat.dispose();
    this.waterMat.dispose();
    this.group.clear();
  }
}
