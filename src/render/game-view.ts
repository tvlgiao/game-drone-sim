/** The only render entry used by main.ts: owns renderer, scene, cameras, post FX and VFX. */
import * as THREE from 'three';
import { QUALITY_PROFILES, type QualityProfile } from '../core/quality';
import type { CameraMode, DroneState, GameEvent, LevelDef, QualityTier } from '../types';
import { StaticBatcher } from './batcher';
import { CameraRig } from './camera-rig';
import { DroneModel } from './drone-model';
import { Lights } from './lights';
import { MOON_DIR } from './lights';
import { Materials } from './materials';
import { PostFX } from './post';
import { buildProps, type LiveProps } from './props';
import { RingsView } from './rings-view';
import { buildRoom } from './room';
import { Atmosphere } from './vfx/atmosphere';
import { ContactShadow } from './vfx/contact-shadow';
import { ParticlePool } from './vfx/particles';
import { Shockwaves } from './vfx/shockwave';

export interface ViewFrame {
  dt: number;
  time: number;
  drone: DroneState;
  fanAngle: number;
  /** index of next ring, -1 none (free-fly shows all rings) */
  nextRing: number;
  cameraMode: CameraMode;
  cameraTiltDeg: number;
  fovDeg: number;
  /** m/s, for FX intensity */
  speed: number;
}

const FX_SCALE: Record<QualityTier, number> = { ultra: 1, high: 0.85, medium: 0.55, low: 0.3 };

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _c = new THREE.Color();
const _c2 = new THREE.Color();
const _size = new THREE.Vector2();
const WHITE = new THREE.Color(1, 1, 1);
const SPARK = new THREE.Color(1, 0.55, 0.16);

export class GameView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  private readonly level: LevelDef;
  private readonly mats: Materials;
  private readonly lights: Lights;
  private readonly rings: RingsView;
  private readonly drone: DroneModel;
  private readonly rig: CameraRig;
  private readonly fx: ParticlePool;
  private readonly soft: ParticlePool;
  private readonly waves: Shockwaves;
  private readonly atmos: Atmosphere;
  private readonly contact: ContactShadow;
  private readonly live: LiveProps;
  private readonly staticMeshes: THREE.Mesh[];
  private readonly envTexture: THREE.Texture;
  private readonly fill: THREE.PointLight;
  private post: PostFX | null = null;
  private profile: QualityProfile;
  private renderScale = 1;
  private width = 1;
  private height = 1;
  private pendingRespawn = false;
  private washAcc = 0;
  private bloomPulse = 0;
  private ringFlash = 0;
  private readonly ledColor = new THREE.Color();

  constructor(canvas: HTMLCanvasElement, level: LevelDef, tier: QualityTier) {
    this.level = level;
    this.profile = QUALITY_PROFILES[tier];
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: tier === 'low',
      powerPreference: 'high-performance',
      stencil: false,
      alpha: false,
      depth: true,
    });
    const r = this.renderer;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.shadowMap.autoUpdate = true; // per-light autoUpdate=false keeps static maps static
    r.info.autoReset = false;
    r.toneMappingExposure = 1.05;

    const scene = this.scene;
    scene.background = new THREE.Color(0x04060b);
    scene.fog = new THREE.FogExp2(0x0b0f1a, 0.016);

    this.mats = new Materials(r.capabilities.getMaxAnisotropy());
    const batch = new StaticBatcher();
    const windows = buildRoom(level.room, this.mats, batch);
    const world = new THREE.Group();
    world.name = 'world';
    scene.add(world);
    this.live = buildProps(level.props, this.mats, batch, world);
    this.staticMeshes = batch.build(world);
    for (const m of this.staticMeshes) {
      // floor/rug/glass/emissive surfaces do not need to cast
      if (m.material === this.mats.floor || m.material === this.mats.skyline || m.material === this.mats.glass || m.material === this.mats.neon) m.castShadow = false;
      if (m.material === this.mats.skyline || m.material === this.mats.neon) m.receiveShadow = false;
      if (m.material === this.mats.glass) m.renderOrder = 6;
    }

    this.lights = new Lights(scene, level);
    this.envTexture = this.lights.buildEnvironment(r);
    scene.environmentIntensity = 0.55;

    this.rings = new RingsView(level.rings);
    scene.add(this.rings.group);

    this.drone = new DroneModel(this.mats);
    scene.add(this.drone.root);

    this.rig = new CameraRig(level.pilot, level.room.size);
    this.fill = new THREE.PointLight(0xcfe0ff, 0.5, 3.5, 2);
    scene.add(this.fill);

    this.fx = new ParticlePool(4096, true);
    this.soft = new ParticlePool(2048, false);
    this.waves = new Shockwaves(8);
    scene.add(this.fx.points, this.soft.points, this.waves.group);

    const warm = level.props.filter((p) => p.kind === 'bulb-hanging' || p.kind === 'lamp-floor').map((p) => new THREE.Vector3(p.position[0], p.position[1] + (p.kind === 'lamp-floor' ? p.size[1] - 0.2 : 0), p.position[2]));
    this.atmos = new Atmosphere(windows, MOON_DIR, warm, QUALITY_PROFILES.ultra.particles);
    scene.add(this.atmos.shafts, this.atmos.dust);

    this.contact = new ContactShadow(level, this.mats.radial);
    scene.add(this.contact.group);

    this.applyQuality();
    this.resize(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight);
  }

  get camera(): THREE.PerspectiveCamera {
    return this.rig.camera;
  }

  get tier(): QualityTier {
    return this.profile.tier;
  }

  frame(f: ViewFrame): void {
    const dt = Math.min(Math.max(f.dt, 0), 0.1);
    const t = f.time;
    const r = this.renderer;
    r.info.reset();

    if (this.pendingRespawn) {
      this.pendingRespawn = false;
      this.spawnShimmer(f.drone.position);
      this.rig.snap();
    }

    this.lights.update(t);
    if (this.live.fan) this.live.fan.rotation.y = f.fanAngle;
    if (this.live.tvScreen) this.live.tvScreen.material.uniforms.uTime.value = t;

    this.rig.update({ dt, time: t, drone: f.drone, mode: f.cameraMode, cameraTiltDeg: f.cameraTiltDeg, fovDeg: f.fovDeg, speed: f.speed });
    const cam = this.rig.camera;
    this.drone.camera.visible = this.rig.fpvWeight < 0.5;
    this.drone.update(f.drone, dt, t, f.cameraTiltDeg, cam.position);

    this.rings.update(t, dt, f.nextRing);
    this.updateRingLight(t, dt, f.nextRing);

    // fill light near the camera so the quad reads clearly in chase/LOS
    this.fill.position.copy(cam.position);
    this.fill.intensity = 0.5 * (1 - this.rig.fpvWeight);

    // LED ground glow colour approximates the LED shader
    if (f.drone.armed) this.ledColor.setHSL((((-t * 0.7) % 1) + 1) % 1, 0.85, 0.55);
    else this.ledColor.setRGB(1, 0.3, 0.07);
    this.contact.update(f.drone.position, this.ledColor, f.drone.armed ? 1 : 0.35);

    // prop-wash
    let motors = 0;
    for (let i = 0; i < 4; i++) motors += f.drone.motors[i];
    motors *= 0.25;
    const h = this.contact.height;
    const near = Math.max(0, 1 - h / 0.8);
    if (f.drone.armed && motors > 0.18 && near > 0) this.emitPropWash(f.drone.position, motors, near, dt);
    const wash = f.drone.armed ? motors * Math.max(0, 1 - h / 2) : 0;

    r.getDrawingBufferSize(_size);
    const px = _size.y / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2));
    this.atmos.update(t, px, f.drone.position, wash);
    this.fx.update(t, px);
    this.soft.update(t, px);
    this.waves.update(dt);

    if (this.post) {
      const ca = this.rig.fpvWeight * THREE.MathUtils.clamp((f.speed - 5) / 14, 0, 1);
      this.post.setAberration(ca);
      this.bloomPulse = Math.max(0, this.bloomPulse - dt * 2.5);
      this.post.setBloomBoost(1 + this.bloomPulse * 0.8);
      this.post.render(dt);
    } else {
      r.render(this.scene, cam);
    }
  }

  private updateRingLight(t: number, dt: number, next: number): void {
    const L = this.lights.ringLight;
    this.ringFlash = Math.max(0, this.ringFlash - dt * 2);
    if (next >= 0 && next < this.rings.count) {
      this.rings.ringPosition(next, L.position);
      L.color.setRGB(0.15, 0.9, 1);
      L.intensity = 2.2 + Math.sin(t * 6) * 0.6 + this.ringFlash * 6;
      L.visible = true;
    } else {
      L.intensity = this.ringFlash * 6;
      L.visible = this.ringFlash > 0;
    }
  }

  handleEvent(e: GameEvent): void {
    const k = FX_SCALE[this.profile.tier];
    switch (e.type) {
      case 'ring-passed':
        this.ringBurst(e.index, e.position, k);
        break;
      case 'crash':
        this.crashFx(e.position, e.speed, k);
        break;
      case 'collision':
        if (e.contact.impactSpeed > 1.5) this.impactSparks(e.contact.point, e.contact.normal, e.contact.impactSpeed, k);
        break;
      case 'respawn':
        this.pendingRespawn = true;
        break;
      case 'armed':
        this.drone.flash(e.armed ? 3 : 1);
        break;
      default:
        break;
    }
  }

  private ringBurst(index: number, pos: THREE.Vector3, k: number): void {
    const def = this.level.rings[index];
    if (!def) return;
    this.rings.passed(index);
    this.drone.flash(4);
    this.ringFlash = 1;
    this.bloomPulse = 1;
    const col = this.rings.ringColor(index);
    _n.set(def.direction[0], def.direction[1], def.direction[2]);
    basis(_n, _t1, _t2);
    const cx = def.position[0];
    const cy = def.position[1];
    const cz = def.position[2];
    const R = def.radius + def.tube;
    const n = Math.round(220 * k);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const rr = R * (0.92 + Math.random() * 0.14);
      const sp = 1.2 + Math.random() * 3.2;
      const fw = 0.3 + Math.random() * 2.2;
      _c.copy(Math.random() < 0.3 ? WHITE : col);
      this.fx.emit(
        cx + (_t1.x * ca + _t2.x * sa) * rr, cy + (_t1.y * ca + _t2.y * sa) * rr, cz + (_t1.z * ca + _t2.z * sa) * rr,
        (_t1.x * ca + _t2.x * sa) * sp + _n.x * fw, (_t1.y * ca + _t2.y * sa) * sp + _n.y * fw, (_t1.z * ca + _t2.z * sa) * sp + _n.z * fw,
        _c.r, _c.g, _c.b, 0.6 + Math.random() * 0.7, 0.03 + Math.random() * 0.025, 0.12, 2.2, 0,
      );
    }
    // streak of sparkles through the gate following the drone
    const m = Math.round(60 * k);
    for (let i = 0; i < m; i++) {
      const a = Math.random() * Math.PI * 2;
      const rr = Math.random() * R * 0.6;
      const sp = 2 + Math.random() * 4;
      this.fx.emit(
        pos.x + (_t1.x * Math.cos(a) + _t2.x * Math.sin(a)) * rr, pos.y + (_t1.y * Math.cos(a) + _t2.y * Math.sin(a)) * rr, pos.z + (_t1.z * Math.cos(a) + _t2.z * Math.sin(a)) * rr,
        _n.x * sp, _n.y * sp, _n.z * sp,
        col.r, col.g, col.b, 0.4 + Math.random() * 0.4, 0.02, 0, 3, 0,
      );
    }
    _v.set(cx, cy, cz);
    this.waves.spawn(_v, _n, col, R, R * 2.8, 0.75);
    _c2.copy(col).lerp(WHITE, 0.6);
    this.waves.spawn(_v, _n, _c2, R * 0.95, R * 1.7, 0.4);
  }

  private crashFx(pos: THREE.Vector3, speed: number, k: number): void {
    this.rig.addTrauma(0.9);
    this.bloomPulse = 0.6;
    const n = Math.round((110 + Math.min(80, speed * 12)) * k);
    for (let i = 0; i < n; i++) {
      randomDir(_v, 0.35);
      const sp = 1.5 + Math.random() * (3 + speed * 0.6);
      _c.copy(SPARK).lerp(WHITE, Math.random() * 0.6);
      const life = 0.45 + Math.random() * 0.9;
      const size = 0.03 + Math.random() * 0.03;
      // three time-offset copies on the same trajectory read as a motion streak
      for (let j = 0; j < 3; j++) this.fx.emit(pos.x, pos.y, pos.z, _v.x * sp, _v.y * sp, _v.z * sp, _c.r, _c.g * (1 - j * 0.15), _c.b * (1 - j * 0.3), life, size * (1 - j * 0.28), 1, 1.2, 0, j * 0.012);
    }
    // impact flash
    for (let i = 0; i < 3; i++) this.fx.emit(pos.x, pos.y, pos.z, 0, 0, 0, 1, 0.6, 0.25, 0.12 + i * 0.06, 0.35 + i * 0.25, 0, 1, 0);
    const d = Math.round(40 * k) + 6;
    for (let i = 0; i < d; i++) {
      randomDir(_v, 0.5);
      const sp = 0.8 + Math.random() * 3;
      const pick = Math.random();
      if (pick < 0.55) _c.setRGB(0.03, 0.03, 0.035);
      else if (pick < 0.8) _c.setRGB(0.9, 0.3, 0.08);
      else _c.setRGB(0.1, 0.6, 0.8);
      this.soft.emit(pos.x, pos.y, pos.z, _v.x * sp, _v.y * sp, _v.z * sp, _c.r, _c.g, _c.b, 1.8 + Math.random() * 1.2, 0.006 + Math.random() * 0.01, 1, 0.5, 1);
    }
    const y = this.contact.surfaceY;
    if (pos.y - y < 0.6) {
      for (let i = 0; i < Math.round(28 * k); i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = 0.6 + Math.random() * 1.8;
        this.soft.emit(pos.x, y + 0.08, pos.z, Math.cos(a) * sp, 0.25 + Math.random() * 0.3, Math.sin(a) * sp, 0.5, 0.48, 0.45, 1 + Math.random() * 0.8, 0.08 + Math.random() * 0.06, 0, 2.2, 2);
      }
      _v.set(pos.x, y + 0.02, pos.z);
      _n.set(0, 1, 0);
      this.waves.spawn(_v, _n, SPARK, 0.1, 1.6, 0.6);
    } else {
      _n.set(0, 1, 0);
      this.waves.spawn(pos, _n, SPARK, 0.05, 0.9, 0.45);
    }
  }

  private impactSparks(point: THREE.Vector3, normal: THREE.Vector3, speed: number, k: number): void {
    this.rig.addTrauma(Math.min(0.35, speed * 0.06));
    const n = Math.max(4, Math.round(Math.min(40, speed * 7) * k));
    for (let i = 0; i < n; i++) {
      randomDir(_v, 0);
      if (_v.dot(normal) < 0) _v.addScaledVector(normal, -2 * _v.dot(normal));
      _v.addScaledVector(normal, 0.6).normalize();
      const sp = 0.8 + Math.random() * (1 + speed * 0.5);
      _c.copy(SPARK).lerp(WHITE, Math.random() * 0.5);
      const life = 0.3 + Math.random() * 0.45;
      for (let j = 0; j < 3; j++) this.fx.emit(point.x, point.y, point.z, _v.x * sp, _v.y * sp, _v.z * sp, _c.r, _c.g, _c.b, life, (0.022 + Math.random() * 0.01) * (1 - j * 0.28), 1, 1.5, 0, j * 0.01);
    }
  }

  private spawnShimmer(pos: THREE.Vector3): void {
    const k = FX_SCALE[this.profile.tier];
    this.drone.flash(5);
    const n = Math.round(150 * k);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 0.12 + Math.random() * 0.12;
      const y = (Math.random() - 0.5) * 0.3;
      const swirl = 1.2 + Math.random();
      _c.setRGB(0.3, 0.9, 1).lerp(WHITE, Math.random() * 0.5);
      this.fx.emit(
        pos.x + Math.cos(a) * r, pos.y + y, pos.z + Math.sin(a) * r,
        -Math.sin(a) * swirl - Math.cos(a) * 0.3, 0.6 + Math.random() * 0.8, Math.cos(a) * swirl - Math.sin(a) * 0.3,
        _c.r, _c.g, _c.b, 0.7 + Math.random() * 0.6, 0.008 + Math.random() * 0.008, -0.03, 1.5, 0, Math.random() * 0.25,
      );
    }
    _n.set(0, 1, 0);
    _c.setRGB(0.3, 0.9, 1);
    _v.copy(pos);
    _v.y = this.contact.surfaceY + 0.02;
    this.waves.spawn(_v, _n, _c, 0.05, 0.9, 0.6);
    this.waves.spawn(pos, _n, WHITE, 0.02, 0.5, 0.35);
  }

  private emitPropWash(pos: THREE.Vector3, motors: number, near: number, dt: number): void {
    const k = FX_SCALE[this.profile.tier];
    this.washAcc += dt * 240 * motors * Math.pow(near, 1.5) * k;
    const y = this.contact.surfaceY + 0.02;
    while (this.washAcc >= 1) {
      this.washAcc -= 1;
      const a = Math.random() * Math.PI * 2;
      const r = 0.04 + Math.random() * 0.1;
      const sp = (1 + Math.random() * 2) * (0.5 + motors);
      const g = 0.42 + Math.random() * 0.08;
      const size = 0.035 + Math.random() * 0.045;
      this.soft.emit(pos.x + Math.cos(a) * r, y + size * 0.5, pos.z + Math.sin(a) * r, Math.cos(a) * sp, 0.06 + Math.random() * 0.2, Math.sin(a) * sp, g, g * 0.96, g * 0.9, 0.6 + Math.random() * 0.5, size, 0, 2.6, 2);
    }
  }

  setQuality(tier: QualityTier): void {
    if (tier === this.profile.tier) return;
    this.profile = QUALITY_PROFILES[tier];
    this.applyQuality();
    this.resize(this.width, this.height);
  }

  private applyQuality(): void {
    const p = this.profile;
    const r = this.renderer;
    r.shadowMap.enabled = p.shadows;
    this.lights.setQuality(p);
    this.lights.refreshShadows();
    this.scene.environment = p.envMap ? this.envTexture : null;
    this.atmos.setQuality(p.particles, p.shafts);
    if (p.post) {
      if (!this.post) this.post = new PostFX(r, this.scene, this.rig.camera);
      this.post.configure(p);
      r.toneMapping = THREE.NoToneMapping;
    } else {
      this.post?.dispose();
      this.post = null;
      r.toneMapping = THREE.ACESFilmicToneMapping;
    }
  }

  setRenderScale(scale: number): void {
    const s = THREE.MathUtils.clamp(scale, 0.5, 1);
    if (Math.abs(s - this.renderScale) < 1e-3) return;
    this.renderScale = s;
    this.resize(this.width, this.height);
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    this.renderer.setPixelRatio(Math.min(dpr, this.profile.maxDpr) * this.renderScale);
    this.renderer.setSize(this.width, this.height, false);
    this.rig.camera.aspect = this.width / this.height;
    this.rig.camera.updateProjectionMatrix();
    this.post?.setSize(this.width, this.height);
  }

  stats(): { calls: number; triangles: number } {
    const i = this.renderer.info.render;
    return { calls: i.calls, triangles: i.triangles };
  }

  dispose(): void {
    this.post?.dispose();
    this.post = null;
    for (const m of this.staticMeshes) m.geometry.dispose();
    for (const d of this.live.disposables) d.dispose();
    this.rings.dispose();
    this.drone.dispose();
    this.fx.dispose();
    this.soft.dispose();
    this.waves.dispose();
    this.atmos.dispose();
    this.contact.dispose();
    this.lights.dispose();
    this.fill.dispose();
    this.mats.dispose();
    this.scene.clear();
    this.renderer.dispose();
  }
}

/** Orthonormal basis perpendicular to unit n. */
function basis(n: THREE.Vector3, t1: THREE.Vector3, t2: THREE.Vector3): void {
  if (Math.abs(n.y) < 0.9) t1.set(0, 1, 0);
  else t1.set(1, 0, 0);
  t1.crossVectors(n, t1).normalize();
  t2.crossVectors(n, t1).normalize();
}

/** Random unit vector with an upward bias (0 = uniform sphere). */
function randomDir(out: THREE.Vector3, upBias: number): THREE.Vector3 {
  const z = Math.random() * 2 - 1;
  const a = Math.random() * Math.PI * 2;
  const s = Math.sqrt(1 - z * z);
  out.set(s * Math.cos(a), z, s * Math.sin(a));
  out.y += upBias;
  return out.normalize();
}
