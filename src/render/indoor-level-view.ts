/**
 * Night-loft scenery: room shell, props, the city outside, lighting rig, lamp halos, window shafts and
 * dust. Materials come from a library scope (freed on switch). The GameView captures the lit room from
 * `probe` (ibl.ts) and hands it back through `setEnvironment`, so floor, glass and metal reflect the actual
 * windows, bulbs and neon; the floor and windows box-project it on every tier.
 */
import * as THREE from 'three';
import type { FormFactor } from '../core/device';
import { isQuestBrowser } from '../core/xr';
import { MOBILE_MAX_TEXTURE, qualityProfile, type QualityProfile } from '../core/quality';
import type { IndoorLevel } from '../types';
import { StaticBatcher } from './batcher';
import type { LevelFrame, LevelProbe, LevelView } from './level-view';
import { Lights, MOON_DIR } from './lights';
import { buildCity, prewarmCity, type CityBackdrop } from './loft/city';
import { Halos } from './loft/halos';
import { LoftMaterials, type LoftMaterialOptions } from './loft/materials';
import { MoonPools } from './loft/moon-pools';
import type { MaterialLibrary, MaterialScope } from './materials/library';
import { DETAIL_SUFFIX, buildProps, type LiveProps } from './props';
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

/** phones, tablets and the Quest (mobile GPU + CPU: generation time and memory) get half-size maps */
function loftTextureCap(form: FormFactor): number {
  const quest = typeof navigator !== 'undefined' && isQuestBrowser(navigator.userAgent);
  return form === 'desktop' && !quest ? 2048 : MOBILE_MAX_TEXTURE / 2;
}

function loftOptions(level: IndoorLevel, renderer: THREE.WebGLRenderer, maxTexture: number): LoftMaterialOptions {
  return { anisotropy: renderer.capabilities.getMaxAnisotropy(), maxTexture, room: level.room.size, puddles: PUDDLES };
}

export class IndoorLevelView implements LevelView {
  /**
   * Generates the loft's art (materials into `scope`, the city backdrop maps) one piece per task ahead of the
   * constructor, so building the room on the loading screen is not one long frozen frame.
   */
  static async prewarm(level: IndoorLevel, renderer: THREE.WebGLRenderer, scope: MaterialScope, form: FormFactor, pause: () => Promise<void>): Promise<void> {
    const maxTexture = loftTextureCap(form);
    await LoftMaterials.prewarm(scope, loftOptions(level, renderer, maxTexture), pause);
    await pause();
    await prewarmCity(MOON_DIR, maxTexture, pause);
  }

  readonly group = new THREE.Group();
  readonly background = new THREE.Color(0x04060b);
  readonly fog: THREE.FogExp2;
  readonly environmentIntensity = 0.85;
  readonly bloomThreshold = 0.85;
  readonly probe: LevelProbe;
  private readonly scope: MaterialScope;
  private readonly mats: LoftMaterials;
  private readonly lights: Lights;
  private readonly live: LiveProps;
  private readonly staticMeshes: THREE.Mesh[];
  /** small-dressing batches the low tier hides */
  private readonly detail: THREE.Mesh[];
  private readonly city: CityBackdrop;
  private readonly halos: Halos;
  private readonly pools: MoonPools;
  private readonly atmos: Atmosphere;
  private standIn: THREE.Texture | null = null;
  private readonly renderer: THREE.WebGLRenderer;

  constructor(level: IndoorLevel, renderer: THREE.WebGLRenderer, library: MaterialLibrary, form: FormFactor) {
    this.renderer = renderer;
    this.group.name = 'world';
    this.fog = new THREE.FogExp2(level.env.fog.color, 2.15 / level.env.fog.viewDistance);
    // phones, tablets and the Quest (mobile GPU + CPU: generation time and memory) get half-size maps
    const maxTexture = loftTextureCap(form);
    this.scope = library.scope(level.id);
    this.mats = new LoftMaterials(this.scope, loftOptions(level, renderer, maxTexture));
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
    this.detail = this.staticMeshes.filter((m) => m.name.split('|')[0]!.endsWith(DETAIL_SUFFIX));
    this.lights = new Lights(this.group, level);
    // light cookies: reflector rings break up the spot pools
    for (const s of this.lights.spots) s.map = this.mats.cookie;

    // the capture point is the box projection's origin: reflections line up with the walls
    this.probe = { position: this.mats.box.probe, near: 0.05, far: 85, minSize: 128, always: true };

    this.halos = new Halos(this.live.lamps);
    this.pools = new MoonPools(windows, MOON_DIR);
    this.group.add(this.halos.mesh, this.pools.mesh);

    const warm = level.props
      .filter((p) => p.kind === 'bulb-hanging' || p.kind === 'lamp-floor')
      .map((p) => new THREE.Vector3(p.position[0], p.position[1] + (p.kind === 'lamp-floor' ? p.size[1] - 0.2 : 0), p.position[2]));
    this.atmos = new Atmosphere(windows, MOON_DIR, warm, qualityProfile('ultra', form).particles);
    this.group.add(this.atmos.shafts, this.atmos.dust);
  }

  /** Fallback only (the capture failed): the old hand-built dark-loft stand-in, made on first use. */
  get environment(): THREE.Texture {
    this.standIn ??= this.lights.buildEnvironment(this.renderer);
    return this.standIn;
  }

  setEnvironment(env: THREE.Texture): void {
    this.mats.setProbe(env);
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
    // Without shadow maps the moon would light every wall that faces it through the brick: a cold wash the
    // shadowed tiers never show. There it is off (one light less on the Quest); the window pools draw the
    // moonlight on the floor and the SH probe (ibl.ts) carries the room's ambient, warm like the high tiers.
    this.pools.mesh.visible = !p.shadows;
    this.lights.moon.visible = p.shadows;
    // Quest budget: rivets, bolts, duct seams and bulb cages read at a metre, not through a headset at 72 Hz
    for (const m of this.detail) m.visible = p.tier !== 'low';
    this.lights.moon.intensity = MOON_INTENSITY;
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
    this.scope.dispose();
    this.group.clear();
  }
}
