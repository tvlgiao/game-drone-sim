/** Night-loft scenery: room shell, props, lighting rig, window shafts and dust (the loft code, moved unchanged). */
import * as THREE from 'three';
import type { FormFactor } from '../core/device';
import { qualityProfile, type QualityProfile } from '../core/quality';
import type { IndoorLevel } from '../types';
import { StaticBatcher } from './batcher';
import type { LevelFrame, LevelView } from './level-view';
import { Lights, MOON_DIR } from './lights';
import type { Materials } from './materials';
import { buildProps, type LiveProps } from './props';
import { buildRoom } from './room';
import { Atmosphere } from './vfx/atmosphere';

export class IndoorLevelView implements LevelView {
  readonly group = new THREE.Group();
  readonly background = new THREE.Color(0x04060b);
  readonly fog: THREE.FogExp2;
  readonly environment: THREE.Texture;
  readonly environmentIntensity = 0.55;
  readonly bloomThreshold = 0.85;
  private readonly lights: Lights;
  private readonly live: LiveProps;
  private readonly staticMeshes: THREE.Mesh[];
  private readonly atmos: Atmosphere;

  constructor(level: IndoorLevel, renderer: THREE.WebGLRenderer, mats: Materials, form: FormFactor) {
    this.group.name = 'world';
    this.fog = new THREE.FogExp2(level.env.fog.color, 2.15 / level.env.fog.viewDistance);
    const batch = new StaticBatcher();
    const windows = buildRoom(level.room, mats, batch);
    this.live = buildProps(level.props, mats, batch, this.group);
    this.staticMeshes = batch.build(this.group);
    for (const m of this.staticMeshes) {
      // floor/rug/glass/emissive surfaces do not need to cast
      if (m.material === mats.floor || m.material === mats.skyline || m.material === mats.glass || m.material === mats.neon) m.castShadow = false;
      if (m.material === mats.skyline || m.material === mats.neon) m.receiveShadow = false;
      if (m.material === mats.glass) m.renderOrder = 6;
    }
    this.lights = new Lights(this.group, level);
    this.environment = this.lights.buildEnvironment(renderer);

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
  }

  refreshShadows(): void {
    this.lights.refreshShadows();
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const m of this.staticMeshes) m.geometry.dispose();
    for (const d of this.live.disposables) d.dispose();
    this.atmos.dispose();
    this.lights.dispose();
    this.group.clear();
  }
}
