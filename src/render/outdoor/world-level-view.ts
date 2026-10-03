/**
 * Scenery of generated outdoor levels (City, Alpine Valley, Infinite) on the shared render pipeline: the
 * physical sky dome and its stand-in environment, a sun and hemisphere light, fog matched to the horizon, then
 * either the streamed terrain (chunks, scatter, far backdrop, floating origin) or the City (instanced buildings,
 * street ground, river). Budgets follow the OutdoorProfile of the current quality tier (XR: low).
 *
 * Pipeline seams (docs/10): the ground is the material library's terrain (base grass + triplanar rock by the
 * generator's per-vertex rock weight + wet banks + soil, CC0 where loaded), water the shared water material, the
 * time of day a sky preset (`setTime`), the GameView swaps the sun for its cascades on ultra / high (the
 * drone-following shadow box below is the medium-tier path only when a profile asks for it), captures the
 * environment from `probe` and takes the look for the time of day from looks.ts.
 */
import * as THREE from 'three';
import type { FormFactor } from '../../core/device';
import type { QualityProfile } from '../../core/quality';
import { worldField, type LevelRuntime, type WorldContent } from '../../levels/runtime';
import { duskAmount, SKIES } from '../../levels/skies';
import type { OutdoorLevel, SkyDef } from '../../types';
import type { LevelFrame, LevelProbe, LevelView } from '../level-view';
import type { WorldTime } from '../looks';
import type { MaterialLibrary, MaterialScope } from '../materials/library';
import type { WaterProbe } from '../vfx/director';
import { CityView, cityRiverGeometry } from './city-view';
import { FarTerrain, farReach } from './far-terrain';
import { outdoorProfile, scaledProfile, type OutdoorProfile } from './outdoor-profile';
import { ScatterView } from './scatter-view';
import { SkyDome, skyEnvironment } from './sky';
import { roadMaterial, terrainDetailTexture, type InstanceUniforms } from './terrain-materials';
import { TerrainView } from './terrain-view';
import { rippleTexture, setWaterDetail, setWaterSky, setWaterTime, waterMaterial } from './water';
import { WorldOrigin } from './world-origin';

/** sky fill: low enough that slopes facing away from a low sun stay dark */
const HEMI = 0.62;
/**
 * Sun-follow shadow box (tiers with shadow maps but no cascades), fitted to the view: it reaches FOLLOW_HALF around
 * a point pushed ahead of the drone along the camera → drone direction. The City's towers need a wider, deeper box.
 */
const FOLLOW_HALF = 120;
/** share of the box half the centre is pushed ahead of the drone */
const FOLLOW_AHEAD = 0.6;
const FOLLOW_DEPTH = 600;
const CITY_FOLLOW_HALF = 300;
/** City trees switch detail around the drone after it moved this far, m */
const CITY_TREE_REBUILD = 40;
const CITY_FOLLOW_DEPTH = 1600;
/** view distance the sun cascades cover (m): tree and tower shadows out to the mid ground */
const CASCADE_FAR_TERRAIN = 260;
const CASCADE_FAR_CITY = 420;
/** rock layer: tint by sky preset family (linear), fine and coarse tile (m) */
const ROCK_TINT = 0x6c6c6a;
const ROCK_METERS = 11;
const ROCK_MACRO_METERS = 61;

const _v = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();

export interface WorldViewOptions {
  /** sky preset to draw at (default: the level's own) */
  time?: WorldTime;
  /** pilot's View distance scale (VIEW_DISTANCE_SCALE) */
  viewDistance?: number;
}

export class WorldLevelView implements LevelView {
  readonly group = new THREE.Group();
  readonly background: THREE.Color;
  readonly fog: THREE.FogExp2;
  readonly environmentIntensity = 0.85;
  readonly bloomThreshold = 1.6;
  readonly ringLight = new THREE.PointLight(0x19e6ff, 0, 7, 2);
  readonly probe: LevelProbe;
  readonly shadowFar: number;
  readonly origin = new WorldOrigin();
  /** water surface under (x, z) or −Infinity (prop-wash spray, the drone's wash height over a river) */
  readonly waterProbe: WaterProbe;
  private readonly level: OutdoorLevel;
  private readonly content: WorldContent;
  private readonly scope: MaterialScope;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly dome: SkyDome;
  private envTarget: THREE.WebGLRenderTarget;
  private readonly sun: THREE.DirectionalLight;
  private readonly sunDir = new THREE.Vector3();
  private readonly hemi: THREE.HemisphereLight;
  private readonly detail: THREE.DataTexture;
  private readonly ripple: THREE.DataTexture;
  private readonly shared: InstanceUniforms = { uTime: { value: 0 } };
  private readonly terrainMat: THREE.MeshStandardMaterial;
  private readonly roadMat: THREE.MeshStandardMaterial;
  private readonly waterMat: THREE.MeshStandardMaterial;
  private readonly scatter: ScatterView;
  private terrain: TerrainView | null = null;
  private far: FarTerrain | null = null;
  private city: CityView | null = null;
  private river: THREE.Mesh | null = null;
  private profile: OutdoorProfile;
  private baseProfile: OutdoorProfile;
  private sky: SkyDef;
  private _time: WorldTime;
  /** adaptive step (render scale stuck at its floor) × the pilot's View distance */
  private viewScale = 1;
  private viewSetting = 1;
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

  constructor(rt: LevelRuntime, renderer: THREE.WebGLRenderer, library: MaterialLibrary, form: FormFactor, opts: WorldViewOptions = {}) {
    if (rt.def.kind !== 'outdoor' || !rt.content) throw new Error('WorldLevelView needs a generated outdoor level');
    this.level = rt.def;
    this.content = rt.content;
    this.form = form;
    this.renderer = renderer;
    this.group.name = 'world';
    this.scope = library.scope(rt.def.id);
    this._time = opts.time ?? rt.def.env.time ?? 'afternoon';
    this.sky = SKIES[this._time];
    this.viewSetting = opts.viewDistance ?? 1;
    const sky = this.sky;
    const haze = sky.haze ?? sky.horizon;
    this.background = new THREE.Color(haze);
    this.baseProfile = outdoorProfile(library.profile.tier, form);
    this.profile = scaledProfile(this.baseProfile, this.viewSetting);
    this.fog = new THREE.FogExp2(haze, 2.15 / this.fogDistance());
    this.cameraFar = this.farPlane();
    this.shadowFar = this.content.kind === 'city' ? CASCADE_FAR_CITY : CASCADE_FAR_TERRAIN;

    // below the horizon the dome shows the fog colour: past the last terrain the ground melts into the haze
    this.dome = new SkyDome(sky, haze);
    this.group.add(this.dome.mesh);
    this.envTarget = skyEnvironment(renderer, sky, haze);

    this.sun = new THREE.DirectionalLight(sky.sunColor, sky.sunIntensity);
    this.sun.name = 'sun';
    this.sunDir.set(...sky.sunDir).normalize();
    this.group.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight(sky.hemi[0], sky.hemi[1], HEMI);
    this.group.add(this.hemi, this.ringLight);

    const lowTier = library.profile.tier === 'low';
    this.detail = terrainDetailTexture(256, Math.min(renderer.capabilities.getMaxAnisotropy(), 8));
    this.ripple = rippleTexture(lowTier ? 64 : 256);
    // ground: vertex-colour palette (the generator's biomes, fields, banks) over the grass set as detail, rock by
    // the per-vertex weight (and on any steep slope, so the far backdrop's cliffs match), wet banks, soil
    this.terrainMat = this.scope.terrain({
      base: 'grass',
      uvMeters: 1,
      rockAttribute: 'aRock',
      wetAttribute: 'aWet',
      slopeRock: 0.1,
      rockMeters: ROCK_METERS,
      rockMacroMeters: ROCK_MACRO_METERS,
      rockTint: ROCK_TINT,
      soil: !lowTier,
      srgbColors: true,
      snow: true,
      envMapIntensity: 0.8,
      worldUv: true,
      // the procedural stand-in (low tier) is a coarser grain than the scan: less of it
      detail: lowTier ? 0.2 : 0.55,
      // grass relief that reads at drone height without crumpling the meadow (the stand-in's clumps stamp
      // circles on the ground: barely any of its relief)
      normalScale: lowTier ? 0.12 : 0.45,
      // grass seen against a low sun: no specular glitter off the blades' normal map
      roughness: 1.35,
    });
    this.roadMat = roadMaterial(this.detail);
    this.waterMat = waterMaterial(sky, this.ripple, this.profile.waterDetail);
    const dusk = duskAmount(sky);
    this.scatter = new ScatterView(this.origin, this.shared, { treesLod0: this.profile.treesLod0, treesLod1: this.profile.treesLod1 });
    this.scatter.setDusk(dusk);

    const field = worldField(rt);
    this.waterProbe = field ? (x, z) => field.waterLevelAt(x, z) : () => -Infinity;

    const c = this.content;
    const s = this.level.spawn.position;
    if (c.kind === 'terrain') {
      this.terrain = new TerrainView(c.stream, this.origin, { terrain: this.terrainMat, road: this.roadMat, water: this.waterMat }, { uploads: this.profile.uploads });
      this.group.add(this.terrain.group, this.scatter.group);
      this.origin.set(Math.floor(s[0] / 128) * 128, Math.floor(s[2] / 128) * 128);
      // everything the streamer already built goes up now: the environment capture sees the land around the spawn
      this.terrain.setUploads(1024);
      this.terrain.update(s[0], s[2]);
      this.terrain.setUploads(this.profile.uploads);
      this.scatterTerrainVersion = this.terrain.version;
      this.scatterOrigin = this.origin.version;
      this.scatter.rebuild(this.terrain.shown);
    } else {
      this.city = new CityView(c.city, c.outskirts, c.furniture, rt.terrain ?? { heightAt: () => 0 }, this.detail, this.shared, this.scope, { outskirts: this.profile.outskirts, facadeDetail: this.profile.facadeDetail });
      this.city.setDusk(dusk);
      this.river = new THREE.Mesh(cityRiverGeometry(), this.waterMat);
      this.river.name = 'river';
      this.river.receiveShadow = true;
      this.group.add(this.city.group, this.river, this.scatter.group);
      this.cityTrees = this.city.trees;
      this.cityTreesAt.set(s[0], 0, s[2]);
      this.scatter.rebuild(new Map(), this.cityTrees, this.cityTreesAt);
    }
    this.placeSun(new THREE.Vector3(...s));
    // the environment is captured above the take-off, clear of the drone and the pilot
    const groundY = rt.terrain ? rt.terrain.heightAt(s[0], s[2]) : 0;
    this.probe = { position: new THREE.Vector3(s[0], Math.max(s[1], groundY) + 6, s[2]), near: 0.5, far: 3000, minSize: 64, always: false };
    // the dome rides with the camera; until the first frame it must surround the probe (a capture from outside
    // the sphere would see no sky at all)
    this.dome.follow(this.probe.position);
  }

  /** Stand-in environment (the sky over a hazy ground) until / unless the GameView captures the level. */
  get environment(): THREE.Texture {
    return this.envTarget.texture;
  }

  /** the sky preset drawn now */
  get time(): WorldTime {
    return this._time;
  }

  /** Nothing here env-maps itself: the GameView's capture only feeds scene.environment / the SH probe. */
  setEnvironment(_env: THREE.Texture): void {}

  /**
   * Time of day: sky dome, sun, sky light, fog and its colour, the water's sky, lit windows. The GameView then
   * re-captures the environment and swaps the look.
   */
  setTime(time: WorldTime): void {
    if (time === this._time) return;
    this._time = time;
    const sky = SKIES[time];
    this.sky = sky;
    const haze = sky.haze ?? sky.horizon;
    this.background.set(haze);
    this.fog.color.set(haze);
    this.dome.setSky(sky, haze);
    this.envTarget.dispose();
    this.envTarget = skyEnvironment(this.renderer, sky, haze);
    this.sun.color.set(sky.sunColor);
    this.sun.intensity = sky.sunIntensity;
    this.sunDir.set(...sky.sunDir).normalize();
    this.hemi.color.set(sky.hemi[0]);
    this.hemi.groundColor.set(sky.hemi[1]);
    setWaterSky(this.waterMat, sky);
    const dusk = duskAmount(sky);
    this.scatter.setDusk(dusk);
    this.city?.setDusk(dusk);
    this.placeSun(this.shadowAt.lengthSq() > 0 ? this.shadowAt : new THREE.Vector3(...this.level.spawn.position));
    // the GameView re-captures from the probe right away: the dome must surround it (the next frame moves it back)
    this.dome.follow(this.probe.position);
  }

  private fogDistance(): number {
    return Math.min(this.level.env.fog.viewDistance * Math.max(1, this.viewSetting), this.profile.fog);
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

  /** Adaptive step (GameView: render scale pinned at its floor). */
  setViewScale(k: number): void {
    this.viewScale = Math.min(1, Math.max(0.5, k));
    this.applyProfile(null);
  }

  /** The pilot's View distance (Settings): 0.5 short … 1.3 long, 1 = the tier's own. */
  setViewDistance(k: number): void {
    if (k === this.viewSetting) return;
    this.viewSetting = k;
    this.applyProfile(null);
  }

  private applyProfile(q: QualityProfile | null): void {
    const prof = scaledProfile(this.baseProfile, this.viewScale * this.viewSetting);
    this.profile = prof;
    this.fog.density = 2.15 / this.fogDistance();
    this.cameraFar = this.farPlane();
    setWaterDetail(this.waterMat, prof.waterDetail);
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
    // casters for whichever sun shadow runs: the GameView's cascades (ultra / high) or the follow box below
    const casters = q.shadows && (prof.sunShadows || q.sunCascades);
    this.scatter.setShadows(casters);
    if (this.city) this.city.buildings.mesh.castShadow = casters;
    const follow = q.shadows && prof.sunShadows && !q.sunCascades;
    this.sun.castShadow = follow;
    this.followShadow = follow;
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
    this.hemi.intensity = casters ? HEMI : HEMI * 1.15;
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
    const base: Record<string, unknown> = { origin: [this.origin.x, this.origin.z], time: this._time, fog: Math.round(this.fogDistance()), far: Math.round(this.cameraFar), viewScale: this.viewScale, viewDistance: this.viewSetting, instances: this.scatter.counts() };
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
    this.ripple.dispose();
    this.roadMat.dispose();
    this.waterMat.dispose();
    this.scope.dispose();
    this.group.clear();
  }
}
