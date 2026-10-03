/** The only render entry used by main.ts: owns renderer, scene, cameras, post FX and VFX. */
import * as THREE from 'three';
import { LosMarker } from './los-marker';
import { MOBILE_MAX_TEXTURE, qualityProfile, type QualityProfile } from '../core/quality';
import type { FormFactor } from '../core/device';
import type { CameraMode, DroneState, GameEvent, LevelDef, QualityTier } from '../types';
import type { LevelRuntime } from '../levels/runtime';
import { CameraRig } from './camera-rig';
import { DroneModel } from './drone-model';
import { IndoorLevelView } from './indoor-level-view';
import type { LevelView } from './level-view';
import { Materials } from './materials';
import { OutdoorLevelView } from './outdoor/outdoor-level-view';
import { WorldLevelView } from './outdoor/world-level-view';
import { PostFX } from './post';
import { RingsView } from './rings-view';
import { ContactShadow } from './vfx/contact-shadow';
import { ParticlePool } from './vfx/particles';
import { Shockwaves } from './vfx/shockwave';
import { XrPanel } from './xr-panel';
import { HeadingArrow } from './heading-arrow';

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
  /** draw the heading arrow (hidden in FPV regardless) */
  headingArrow?: boolean;
  /** still frame behind a DOM menu: nothing animates (dt = 0) and the camera jumps to its pose */
  still?: boolean;
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
const _eye = new THREE.Vector3();
const _focus = new THREE.Vector3();
const _yq = new THREE.Quaternion();
const _ye = new THREE.Euler(0, 0, 0, 'YXZ');
const Y_AXIS = new THREE.Vector3(0, 1, 0);
/** Quest 2 budget (72 Hz, two eyes on a mobile GPU): no post FX, no shadow maps, small particle pools. */
const XR_TIER: QualityTier = 'low';
/** seconds at the minimum render scale before generated levels shorten their view distance (07 §7) */
const VIEW_SCALE_AFTER = 3;
const VIEW_SCALE_STEP = 0.75;
/** head height used until the headset reports a pose (local-floor space) */
const XR_DEFAULT_HEAD = new THREE.Vector3(0, 1.6, 0);

export interface GameViewOptions {
  /** enable WebXR rendering (renderer.xr) */
  xr?: boolean;
  /** MSAA on the default framebuffer; the XR layer inherits it (headsets need it, post FX does not) */
  antialias?: boolean;
}

export class GameView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  private level: LevelDef;
  private levelView: LevelView;
  private readonly mats: Materials;
  private rings: RingsView;
  private readonly drone: DroneModel;
  private readonly rig: CameraRig;
  private readonly fx: ParticlePool;
  private readonly soft: ParticlePool;
  private readonly waves: Shockwaves;
  private readonly contact: ContactShadow;
  private readonly fill: THREE.PointLight;
  private readonly losMarker: LosMarker;
  private post: PostFX | null = null;
  private profile: QualityProfile;
  private renderScale = 1;
  private width = 1;
  private height = 1;
  private pendingRespawn = false;
  private washAcc = 0;
  private bloomPulse = 0;
  private shownFade = 0;
  private ringFlash = 0;
  private readonly ledColor = new THREE.Color();
  /** seconds the render scale has sat at its 0.5 floor */
  private lowScaleFor = 0;
  private viewScaled = false;

  private readonly form: FormFactor;

  /** XR: the headset camera rides in this dolly; the game moves the dolly, the player moves their head. */
  private readonly xrDolly = new THREE.Group();
  private readonly xrCam = new THREE.PerspectiveCamera(70, 1, 0.02, 90);
  /** in-headset HUD / menu card */
  readonly xrPanel = new XrPanel();
  /** dolly-local head position captured at session start / camera change (anchors eye + panel) */
  private readonly headRef = XR_DEFAULT_HEAD.clone();
  private recenter = true;
  private xrMode: CameraMode | null = null;
  private tierBeforeXr: QualityTier | null = null;
  /** frames drawn so far (main.ts freezes the view behind DOM menus) */
  frames = 0;
  /** platform under the VR pilot's feet in LOS (dolly-local, top at y = 0) */
  private readonly xrPlatform: THREE.Mesh;
  private readonly arrow = new HeadingArrow();

  /** `form` = device class: phones/tablets get capped DPR, ≤ 1024 px textures and smaller particle pools. */
  constructor(canvas: HTMLCanvasElement, level: LevelRuntime, tier: QualityTier, form: FormFactor = 'desktop', opts: GameViewOptions = {}) {
    this.form = form;
    const mobile = form !== 'desktop';
    this.profile = qualityProfile(tier, form);
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: tier === 'low' || opts.antialias === true,
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
    r.xr.enabled = opts.xr === true;

    const scene = this.scene;
    this.mats = new Materials(r.capabilities.getMaxAnisotropy(), mobile ? MOBILE_MAX_TEXTURE : 2048);

    this.drone = new DroneModel(this.mats);
    scene.add(this.drone.root);

    this.rig = new CameraRig(level.def.pilot, null);
    this.losMarker = new LosMarker();
    scene.add(this.losMarker.sprite);
    this.fill = new THREE.PointLight(0xcfe0ff, 0.5, 3.5, 2);
    scene.add(this.fill);

    this.fx = new ParticlePool(mobile ? 2048 : 4096, true);
    this.soft = new ParticlePool(mobile ? 1024 : 2048, false);
    this.waves = new Shockwaves(8);
    scene.add(this.fx.points, this.soft.points, this.waves.group);

    this.contact = new ContactShadow(level.surfaces, this.mats.radial);
    scene.add(this.contact.group);

    this.xrPlatform = xrPlatform();
    this.xrDolly.name = 'xr-dolly';
    this.xrDolly.add(this.xrCam, this.xrPanel.mesh, this.xrPlatform);
    scene.add(this.arrow.mesh);
    scene.add(this.xrDolly);

    this.level = level.def;
    this.levelView = this.buildLevelView(level);
    this.rings = new RingsView(level.def.rings);
    this.attachLevel(level);

    this.applyQuality();
    this.resize(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight);
  }

  /**
   * Swap the level: the old scenery and rings are disposed (geometry, textures, render targets,
   * shadow maps), the new ones built, and the camera rig re-targeted. Shared resources (drone,
   * materials, FX pools, post FX) stay.
   */
  loadLevel(level: LevelRuntime): void {
    this.levelView.dispose();
    this.rings.group.removeFromParent();
    this.rings.dispose();
    this.level = level.def;
    this.levelView = this.buildLevelView(level);
    this.rings = new RingsView(level.def.rings);
    this.attachLevel(level);
    this.applyQuality();
  }

  private buildLevelView(level: LevelRuntime): LevelView {
    const def = level.def;
    if (def.kind === 'indoor') return new IndoorLevelView(def, this.renderer, this.mats, this.form);
    if (level.content) return new WorldLevelView(level, this.renderer, this.form);
    return new OutdoorLevelView(def, this.renderer, this.renderer.capabilities.getMaxAnisotropy());
  }

  /** The scenery's far plane (generated levels see further than the rig's default). */
  private applyCameraFar(): void {
    const far = this.levelView.cameraFar;
    if (far === undefined || far === this.rig.camera.far) return;
    this.rig.camera.far = far;
    this.rig.camera.updateProjectionMatrix();
    this.xrCam.far = far;
    this.xrCam.updateProjectionMatrix();
  }

  private attachLevel(level: LevelRuntime): void {
    const v = this.levelView;
    this.scene.add(v.group, this.rings.group);
    this.scene.background = v.background;
    this.scene.fog = v.fog;
    this.scene.environmentIntensity = v.environmentIntensity;
    this.contact.surfaces = level.surfaces;
    this.rig.setLevel(level);
    this.xrCam.far = this.rig.camera.far;
    this.xrCam.updateProjectionMatrix();
    this.applyCameraFar();
    this.lowScaleFor = 0;
    this.viewScaled = false;
    this.ringFlash = 0;
    this.recenter = true;
    this.xrMode = null;
  }

  get camera(): THREE.PerspectiveCamera {
    return this.rig.camera;
  }

  get tier(): QualityTier {
    return this.profile.tier;
  }

  frame(f: ViewFrame): void {
    this.frames++;
    const dt = Math.min(Math.max(f.dt, 0), 0.1);
    const t = f.time;
    const r = this.renderer;
    r.info.reset();

    if (this.pendingRespawn) {
      this.pendingRespawn = false;
      this.spawnShimmer(f.drone.position);
      this.rig.snap();
    }

    const xr = r.xr.isPresenting;
    this.adaptViewDistance(f.still ? 0 : dt);
    // outdoor LOS: the pilot watches the next ring, the course overview between laps
    this.rig.setFocus(f.nextRing >= 0 && f.nextRing < this.rings.count ? this.rings.ringPosition(f.nextRing, _focus) : null);
    this.rig.shake = !xr;
    this.rig.allowRelocate = !xr;
    this.rig.update({ dt, time: t, drone: f.drone, mode: f.cameraMode, cameraTiltDeg: f.cameraTiltDeg, fovDeg: f.fovDeg, speed: f.speed, instant: f.still });
    // pilot relocation fades the view out and back in (CSS filter: no extra pass, idle when 0)
    const fade = this.rig.fade;
    if (fade !== this.shownFade) {
      this.shownFade = fade;
      r.domElement.style.filter = fade > 0 ? `brightness(${(1 - fade).toFixed(3)})` : '';
    }
    let cam: THREE.PerspectiveCamera = this.rig.camera;
    if (xr) {
      this.placeDolly(f.cameraMode);
      cam = this.xrCam;
      // head pose from the previous XR frame (three writes it during render)
      this.xrCam.getWorldPosition(_eye);
    } else {
      _eye.copy(cam.position);
    }
    this.drone.camera.visible = this.rig.fpvWeight < 0.5;
    this.drone.navLights.visible = this.rig.fpvWeight < 0.5;
    // VR FPV: each eye sits ±32 mm beside the lens, inside the ducts, so the quad would fill the view
    this.drone.root.visible = !(xr && this.rig.fpvWeight >= 0.5);
    this.drone.update(f.drone, dt, t, f.cameraTiltDeg, _eye);
    this.losMarker.update(f.drone.position, _eye, this.rig.losWeight, t);
    this.arrow.update(f.drone.position, f.drone.orientation, _eye, f.headingArrow === true && this.rig.fpvWeight < 0.5);

    this.rings.update(t, dt, f.nextRing);
    this.updateRingLight(t, dt, f.nextRing);

    // fill light near the camera so the quad reads clearly in chase/LOS
    this.fill.position.copy(_eye);
    this.fill.intensity = 0.5 * (1 - this.rig.fpvWeight);

    // LED ground glow: the green + red nav LEDs mixed on the floor read as a warm white
    if (f.drone.armed) this.ledColor.setRGB(0.75, 0.7, 0.45);
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

    // pixels per unit of tan(angle): drawing-buffer height / 2 × projection y-scale (per eye in XR)
    r.getDrawingBufferSize(_size);
    const px = (_size.y / 2) * cam.projectionMatrix.elements[5]!;
    this.levelView.update({ time: t, dt, px, drone: f.drone.position, camera: _eye, wash, fanAngle: f.fanAngle });
    this.fx.update(t, px);
    this.soft.update(t, px);
    this.waves.update(dt);

    if (xr) {
      r.render(this.scene, this.xrCam);
    } else if (this.post) {
      const ca = this.rig.fpvWeight * THREE.MathUtils.clamp((f.speed - 5) / 14, 0, 1);
      this.post.setAberration(ca);
      this.bloomPulse = Math.max(0, this.bloomPulse - dt * 2.5);
      this.post.setBloomBoost(1 + this.bloomPulse * 0.8);
      this.post.render(dt);
    } else {
      r.render(this.scene, cam);
    }
  }

  /**
   * Moves the XR dolly for the camera mode. LOS: stand on the pilot's spot facing the room, head
   * free (6-DoF). FPV / chase: horizon-locked (yaw only, never pitch/roll the world) at the mode's
   * target, offset by the head reference so the eye starts at the lens. Mode changes teleport.
   */
  private placeDolly(mode: CameraMode): void {
    const d = this.xrDolly;
    if (this.recenter || mode !== this.xrMode) {
      // (Re)capture the head reference once the headset reports a real pose.
      if (this.xrCam.position.y > 0.3) {
        this.headRef.copy(this.xrCam.position);
        this.recenter = false;
      }
      this.xrMode = mode;
    }
    this.xrPlatform.visible = mode === 'los';
    if (mode === 'los') {
      const yaw = this.rig.losFloorAnchor(d.position);
      d.position.y += this.level.pilotPlatform;
      d.quaternion.setFromAxisAngle(Y_AXIS, yaw);
    } else {
      _ye.setFromQuaternion(this.rig.targetQuat, 'YXZ');
      _yq.setFromAxisAngle(Y_AXIS, _ye.y);
      d.quaternion.copy(_yq);
      d.position.copy(this.headRef).applyQuaternion(_yq).negate().add(this.rig.targetPos);
    }
    this.xrPanel.place(this.headRef);
    d.updateMatrixWorld(true);
  }

  /** Start rendering into an XR session (call from the session request's promise). */
  async startXr(session: XRSession): Promise<void> {
    const r = this.renderer;
    r.xr.setReferenceSpaceType('local-floor');
    this.tierBeforeXr = this.profile.tier;
    this.setQuality(XR_TIER);
    this.headRef.copy(XR_DEFAULT_HEAD);
    this.recenter = true;
    this.xrMode = null;
    this.xrPanel.mesh.visible = true;
    await r.xr.setSession(session);
  }

  /** Session ended (by the user or the browser): restore the flat-screen quality and size. */
  endXr(): void {
    this.xrPanel.mesh.visible = false;
    this.xrPlatform.visible = false;
    if (this.tierBeforeXr) this.setQuality(this.tierBeforeXr);
    this.tierBeforeXr = null;
    this.resize(this.width, this.height);
  }

  /** Re-anchor eye and panel to where the player's head is now. */
  recenterXr(): void {
    this.recenter = true;
    this.xrMode = null;
  }

  /** camera mode actually being rendered (the rig's, after main.ts picks LOS for menus) */
  get renderedCamera(): CameraMode {
    return this.rig.currentMode;
  }

  get presenting(): boolean {
    return this.renderer.xr.isPresenting;
  }

  private updateRingLight(t: number, dt: number, next: number): void {
    const L = this.levelView.ringLight;
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

  /** Render scale pinned at 0.5 for VIEW_SCALE_AFTER s: generated levels shorten fog and streaming radius once. */
  private adaptViewDistance(dt: number): void {
    if (this.viewScaled || !this.levelView.setViewScale) return;
    this.lowScaleFor = this.renderScale <= 0.5 + 1e-3 ? this.lowScaleFor + dt : 0;
    if (this.lowScaleFor < VIEW_SCALE_AFTER) return;
    this.viewScaled = true;
    this.levelView.setViewScale(VIEW_SCALE_STEP);
    this.applyCameraFar();
  }

  /** the level's scenery is still streaming in */
  get levelBusy(): boolean {
    return this.levelView.busy === true;
  }

  /** streaming / instancing numbers of generated levels (debug hook) */
  levelStats(): Record<string, unknown> | null {
    return this.levelView.stats?.() ?? null;
  }

  setQuality(tier: QualityTier): void {
    if (tier === this.profile.tier) return;
    this.profile = qualityProfile(tier, this.form);
    this.applyQuality();
    this.resize(this.width, this.height);
  }

  private applyQuality(): void {
    const p = this.profile;
    const r = this.renderer;
    r.shadowMap.enabled = p.shadows;
    this.levelView.setQuality(p);
    this.levelView.refreshShadows();
    this.applyCameraFar();
    this.scene.environment = p.envMap ? this.levelView.environment : null;
    if (p.post) {
      if (!this.post) this.post = new PostFX(r, this.scene, this.rig.camera);
      this.post.setBloomThreshold(this.levelView.bloomThreshold);
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
    // The XR layer owns the drawing buffer while presenting; endXr() resizes again afterwards.
    if (this.renderer.xr.isPresenting) return;
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    this.renderer.setPixelRatio(Math.min(dpr, this.profile.maxDpr) * this.renderScale);
    this.renderer.setSize(this.width, this.height, false);
    this.rig.camera.aspect = this.width / this.height;
    this.rig.camera.updateProjectionMatrix();
    this.post?.setSize(this.width, this.height);
  }

  /** Effective renderer pixel ratio (DPR cap × render scale). */
  get pixelRatio(): number {
    return this.renderer.getPixelRatio();
  }

  get scale(): number {
    return this.renderScale;
  }

  /** last frame's draw calls / triangles and the live GPU geometries / textures (leak checks across level switches) */
  stats(): { calls: number; triangles: number; geometries: number; textures: number } {
    const i = this.renderer.info;
    return { calls: i.render.calls, triangles: i.render.triangles, geometries: i.memory.geometries, textures: i.memory.textures };
  }

  get levelId(): LevelDef['id'] {
    return this.level.id;
  }

  dispose(): void {
    this.post?.dispose();
    this.post = null;
    this.losMarker.dispose();
    this.xrPanel.dispose();
    this.arrow.dispose();
    this.xrPlatform.geometry.dispose();
    (this.xrPlatform.material as THREE.Material).dispose();
    this.levelView.dispose();
    this.rings.dispose();
    this.drone.dispose();
    this.fx.dispose();
    this.soft.dispose();
    this.waves.dispose();
    this.contact.dispose();
    this.fill.dispose();
    this.mats.dispose();
    this.scene.clear();
    this.renderer.dispose();
  }
}

/** 1.6 m square deck with a glowing edge, top at y = 0 (the VR pilot's feet). */
function xrPlatform(): THREE.Mesh {
  const g = new THREE.BoxGeometry(1.6, 0.08, 1.6);
  g.translate(0, -0.04, 0);
  const mat = new THREE.MeshStandardMaterial({ color: 0x1b2230, roughness: 0.6, metalness: 0.5, emissive: 0x0b3a4a, emissiveIntensity: 0.6 });
  const m = new THREE.Mesh(g, mat);
  m.name = 'xr-platform';
  m.visible = false;
  const edge = new THREE.LineSegments(new THREE.EdgesGeometry(g), new THREE.LineBasicMaterial({ color: 0x7fe3ff, fog: false, toneMapped: false }));
  m.add(edge);
  return m;
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
