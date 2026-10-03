/**
 * Night-loft scenery: room shell, props, the city outside, lighting rig, lamp halos, window shafts and
 * dust. The loft owns its materials (built per level, freed on switch) and captures a probe of the lit
 * room for reflections, so floor, glass and metal reflect the actual windows, bulbs and neon.
 */
import * as THREE from 'three';
import type { FormFactor } from '../core/device';
import { isQuestBrowser } from '../core/xr';
import { MOBILE_MAX_TEXTURE, qualityProfile, type QualityProfile } from '../core/quality';
import type { IndoorLevel } from '../types';
import { StaticBatcher } from './batcher';
import { LoftMaterials } from './env-materials/loft-materials';
import type { LevelFrame, LevelView } from './level-view';
import { Lights, MOON_DIR } from './lights';
import { buildCity, type CityBackdrop } from './loft/city';
import { Halos } from './loft/halos';
import { MoonPools } from './loft/moon-pools';
import type { Materials } from './materials';
import { buildProps, type LiveProps } from './props';
import { buildRoom } from './room';
import { Atmosphere } from './vfx/atmosphere';

/** rain that came in under the east and south windows, and a drip from the roof */
const PUDDLES = [
  { x: 11.2, z: 0.6, r: 0.85 },
  { x: 0.8, z: 6.35, r: 0.7 },
  { x: -4.6, z: -0.9, r: 0.45 },
] as const;

/** meshes that never cast (flat, emissive or transparent) */
const NO_CAST = new Set(['floor', 'rug', 'glass', 'glow', 'bulbShell', 'neon', 'spill', 'decals']);
/** meshes that are unlit / additive: no shadow lookups either */
const NO_RECEIVE = new Set(['glass', 'glow', 'bulbShell', 'neon', 'spill']);
const RENDER_ORDER: Record<string, number> = { decals: 1, spill: 4, neon: 4, bulbShell: 4, glass: 6 };
/** Lights' moon intensity with shadows (its constructor value) */
const MOON_INTENSITY = 2.6;
const PROBE_SIZE = 256;

export class IndoorLevelView implements LevelView {
  readonly group = new THREE.Group();
  readonly background = new THREE.Color(0x04060b);
  readonly fog: THREE.FogExp2;
  readonly environment: THREE.Texture;
  readonly environmentIntensity = 0.85;
  readonly bloomThreshold = 0.85;
  private readonly mats: LoftMaterials;
  private readonly lights: Lights;
  private readonly live: LiveProps;
  private readonly staticMeshes: THREE.Mesh[];
  private readonly city: CityBackdrop;
  private readonly halos: Halos;
  private readonly pools: MoonPools;
  private readonly atmos: Atmosphere;
  private readonly probe: THREE.WebGLRenderTarget;

  /** `_shared` (the GameView's drone materials) is not used by the loft: it owns its own set. */
  constructor(level: IndoorLevel, renderer: THREE.WebGLRenderer, _shared: Materials, form: FormFactor) {
    this.group.name = 'world';
    this.fog = new THREE.FogExp2(level.env.fog.color, 2.15 / level.env.fog.viewDistance);
    // phones, tablets and the Quest (mobile GPU + CPU: generation time and memory) get half-size maps
    const quest = typeof navigator !== 'undefined' && isQuestBrowser(navigator.userAgent);
    const maxTexture = form === 'desktop' && !quest ? 2048 : MOBILE_MAX_TEXTURE / 2;
    this.mats = new LoftMaterials({ anisotropy: renderer.capabilities.getMaxAnisotropy(), maxTexture, room: level.room.size, puddles: PUDDLES });
    const batch = new StaticBatcher();
    const windows = buildRoom(level.room, this.mats, batch);
    this.live = buildProps(level.props, this.mats, batch, this.group);
    this.city = buildCity(windows, level.room.size, MOON_DIR, this.mats, batch, this.group, maxTexture);
    this.staticMeshes = batch.build(this.group);
    for (const m of this.staticMeshes) {
      const key = m.name.slice('static:'.length).split('|')[0]!;
      if (NO_CAST.has(key)) m.castShadow = false;
      if (NO_RECEIVE.has(key)) m.receiveShadow = false;
      m.renderOrder = RENDER_ORDER[key] ?? 0;
    }
    this.lights = new Lights(this.group, level);
    // light cookies: reflector rings break up the spot pools
    for (const s of this.lights.spots) s.map = this.mats.cookie;

    this.probe = captureProbe(renderer, this.group, this.mats.box.probe, this.mats);
    this.environment = this.probe.texture;
    this.mats.setProbe(this.environment);

    this.halos = new Halos(this.live.lamps);
    this.pools = new MoonPools(windows, MOON_DIR);
    this.group.add(this.halos.mesh, this.pools.mesh);

    const warm = level.props
      .filter((p) => p.kind === 'bulb-hanging' || p.kind === 'lamp-floor')
      .map((p) => new THREE.Vector3(p.position[0], p.position[1] + (p.kind === 'lamp-floor' ? p.size[1] - 0.2 : 0), p.position[2]));
    this.atmos = new Atmosphere(windows, MOON_DIR, warm, qualityProfile('ultra', form).particles);
    this.group.add(this.atmos.shafts, this.atmos.dust);
  }

  get ringLight(): THREE.PointLight {
    return this.lights.ringLight;
  }

  update(f: LevelFrame): void {
    this.lights.update(f.time);
    if (this.live.fan) this.live.fan.rotation.y = f.fanAngle;
    if (this.live.tvScreen) this.live.tvScreen.material.uniforms.uTime.value = f.time;
    this.atmos.update(f.time, f.px, f.drone, f.wash);
  }

  setQuality(p: QualityProfile): void {
    this.lights.setQuality(p);
    this.atmos.setQuality(p.particles, p.shafts);
    this.halos.setBloom(p.bloom);
    // without shadow maps the moon would light the whole floor through the walls: keep a little of it as
    // fill and draw the window pools instead
    this.pools.mesh.visible = !p.shadows;
    this.lights.moon.intensity = p.shadows ? MOON_INTENSITY : MOON_INTENSITY * 0.22;
  }

  refreshShadows(): void {
    this.lights.refreshShadows();
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const m of this.staticMeshes) m.geometry.dispose();
    for (const d of this.live.disposables) d.dispose();
    this.city.dispose();
    this.halos.dispose();
    this.pools.dispose();
    this.atmos.dispose();
    this.lights.dispose();
    this.probe.dispose();
    this.mats.dispose();
    this.group.clear();
  }
}

/**
 * One-off PMREM of the lit room from `at` (before shafts and dust exist). Shadow maps are off for the
 * capture: they are not rendered yet, and the probe is blurry enough not to miss them. Leaves floor and
 * glass pointing at a disposed stand-in: the caller sets the real probe right after.
 */
function captureProbe(renderer: THREE.WebGLRenderer, root: THREE.Object3D, at: THREE.Vector3, mats: LoftMaterials): THREE.WebGLRenderTarget {
  const pmrem = new THREE.PMREMGenerator(renderer);
  // a blank stand-in of the same PMREM size: the capture then compiles the materials with the env-map
  // programs they will use in the game, instead of compiling every loft shader twice
  const stand = pmrem.fromScene(new THREE.Scene(), 0, 0.1, 1, { size: PROBE_SIZE });
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05070c);
  scene.environment = stand.texture;
  mats.setProbe(stand.texture);
  const parent = root.parent;
  scene.add(root);
  scene.updateMatrixWorld(true);
  const shadows = renderer.shadowMap.enabled;
  renderer.shadowMap.enabled = false;
  const target = pmrem.fromScene(scene, 0, 0.05, 85, { size: PROBE_SIZE, position: at });
  pmrem.dispose();
  stand.dispose();
  renderer.shadowMap.enabled = shadows;
  scene.remove(root);
  parent?.add(root);
  return target;
}
