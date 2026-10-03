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
import { PostFX } from './post';
import { RingsView } from './rings-view';
import { ContactShadow } from './vfx/contact-shadow';
import { VfxDirector } from './vfx/director';
import { XrPanel } from './xr-panel';
import { HeadingArrow } from './heading-arrow';
import { captureEnvironment } from './ibl';
import { levelLook, type LevelLook, type ToneMapper } from './looks';
import { MaterialLibrary } from './materials/library';
import { findSun, SunCascades } from './shadows';

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

const TONE_MAPPING: Record<ToneMapper, THREE.ToneMapping> = {
  agx: THREE.AgXToneMapping,
  aces: THREE.ACESFilmicToneMapping,
  neutral: THREE.NeutralToneMapping,
};

const _v = new THREE.Vector3();
const _size = new THREE.Vector2();
const _eye = new THREE.Vector3();
const _focus = new THREE.Vector3();
const _yq = new THREE.Quaternion();
const _ye = new THREE.Euler(0, 0, 0, 'YXZ');
const Y_AXIS = new THREE.Vector3(0, 1, 0);
/** Quest 2 budget (72 Hz, two eyes on a mobile GPU): no post FX, no shadow maps, small particle pools. */
const XR_TIER: QualityTier = 'low';
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
  /** shared PBR presets + procedural / CC0 texture sets for scenery and drone code (see docs/10-render-pipeline.md) */
  readonly library: MaterialLibrary;
  private rings: RingsView;
  private readonly drone: DroneModel;
  private readonly rig: CameraRig;
  private readonly vfx: VfxDirector;
  private readonly contact: ContactShadow;
  private readonly fill: THREE.PointLight;
  private readonly losMarker: LosMarker;
  private post: PostFX | null = null;
  private profile: QualityProfile;
  private look: Readonly<LevelLook>;
  /** look-test override of the level's tone mapper (render preview) */
  private toneOverride: ToneMapper | null = null;
  private readonly cascades = new SunCascades();
  /** PMREM capture of the current level (null until a tier with environment maps asks for it) */
  private envCapture: THREE.WebGLRenderTarget | null = null;
  private readonly sunDir = new THREE.Vector3(0, 1, 0);
  private renderScale = 1;
  private width = 1;
  private height = 1;
  private pendingRespawn = false;
  private bloomPulse = 0;
  private ringFlash = 0;
  private readonly ledColor = new THREE.Color();

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
    // r18x PCF: hardware-filtered Vogel-disk taps, soft edges scaled by each light's shadow.radius
    r.shadowMap.type = THREE.PCFShadowMap;
    r.shadowMap.autoUpdate = true; // per-light autoUpdate=false keeps static maps static
    r.info.autoReset = false;
    r.xr.enabled = opts.xr === true;

    const scene = this.scene;
    this.mats = new Materials(r.capabilities.getMaxAnisotropy(), mobile ? MOBILE_MAX_TEXTURE : 2048);
    this.library = new MaterialLibrary(this.profile, { anisotropy: r.capabilities.getMaxAnisotropy() });

    this.drone = new DroneModel(this.mats, r.capabilities.getMaxAnisotropy());
    scene.add(this.drone.root);

    this.rig = new CameraRig(level.def.pilot, null);
    this.losMarker = new LosMarker();
    scene.add(this.losMarker.sprite);
    this.fill = new THREE.PointLight(0xcfe0ff, 0.5, 3.5, 2);
    scene.add(this.fill);

    this.vfx = new VfxDirector(form, tier);
    scene.add(this.vfx.group);

    this.contact = new ContactShadow(level.surfaces, this.mats.radial);
    scene.add(this.contact.group);

    this.xrPlatform = xrPlatform();
    this.xrDolly.name = 'xr-dolly';
    this.xrDolly.add(this.xrCam, this.xrPanel.mesh, this.xrPlatform);
    scene.add(this.arrow.mesh);
    scene.add(this.xrDolly);

    this.level = level.def;
    this.look = levelLook(level.def);
    void this.library.preload(level.def.id);
    this.levelView = this.buildLevelView(level.def);
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
    this.cascades.detach();
    this.envCapture?.dispose();
    this.envCapture = null;
    this.scene.environment = null;
    this.levelView.dispose();
    this.rings.group.removeFromParent();
    this.rings.dispose();
    this.level = level.def;
    this.look = levelLook(level.def);
    void this.library.preload(level.def.id);
    this.levelView = this.buildLevelView(level.def);
    this.rings = new RingsView(level.def.rings);
    this.attachLevel(level);
    this.applyQuality();
  }

  private buildLevelView(def: LevelDef): LevelView {
    return def.kind === 'indoor'
      ? new IndoorLevelView(def, this.renderer, this.mats, this.form)
      : new OutdoorLevelView(def, this.renderer, this.renderer.capabilities.getMaxAnisotropy());
  }

  private attachLevel(level: LevelRuntime): void {
    const v = this.levelView;
    this.scene.add(v.group, this.rings.group);
    this.scene.background = v.background;
    this.scene.fog = v.fog;
    this.scene.environmentIntensity = v.environmentIntensity;
    this.contact.surfaces = level.surfaces;
    this.vfx.setDustColor(level.def.kind === 'indoor' ? 0xbab2a6 : 0xc8c8b0);
    this.rig.setLevel(level.def);
    this.xrCam.far = this.rig.camera.far;
    this.xrCam.updateProjectionMatrix();
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
      this.drone.flash(5);
      this.vfx.respawn(f.drone.position, this.contact.surfaceY);
      this.rig.snap();
    }

    const xr = r.xr.isPresenting;
    // outdoor LOS: the pilot watches the next ring, the course overview between laps
    this.rig.setFocus(f.nextRing >= 0 && f.nextRing < this.rings.count ? this.rings.ringPosition(f.nextRing, _focus) : null);
    this.rig.shake = !xr;
    this.rig.update({ dt, time: t, drone: f.drone, mode: f.cameraMode, cameraTiltDeg: f.cameraTiltDeg, fovDeg: f.fovDeg, speed: f.speed, instant: f.still });
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
    this.arrow.update(f.drone.position, f.drone.orientation, _eye, f.headingArrow === true && this.rig.fpvWeight < 0.5, t);

    this.rings.update(t, dt, f.nextRing, _eye);
    this.updateRingLight(t, dt, f.nextRing);

    // fill light near the camera so the quad reads clearly in chase/LOS
    this.fill.position.copy(_eye);
    this.fill.intensity = 0.5 * (1 - this.rig.fpvWeight);

    let motors = 0;
    for (let i = 0; i < 4; i++) motors += f.drone.motors[i];
    motors *= 0.25;
    // LED ground glow: the green + red nav LEDs mixed on the floor read as a warm white
    if (f.drone.armed) this.ledColor.setRGB(0.75, 0.7, 0.45);
    else this.ledColor.setRGB(1, 0.3, 0.07);
    _ye.setFromQuaternion(f.drone.orientation, 'YXZ');
    this.contact.update(f.drone.position, this.ledColor, f.drone.armed ? 1 : 0.35, _ye.y, f.drone.armed ? motors : 0);
    const h = this.contact.height;
    const wash = f.drone.armed ? motors * Math.max(0, 1 - h / 2) : 0;

    // pixels per unit of tan(angle): drawing-buffer height / 2 × projection y-scale (per eye in XR)
    r.getDrawingBufferSize(_size);
    const px = (_size.y / 2) * cam.projectionMatrix.elements[5]!;
    this.levelView.update({ time: t, dt, px, drone: f.drone.position, camera: _eye, wash, fanAngle: f.fanAngle });
    this.vfx.update({ dt, time: t, px, drone: f.drone, camera: cam, fpvWeight: this.rig.fpvWeight, surfaceY: this.contact.surfaceY, height: h, xr });

    if (xr) {
      r.render(this.scene, this.xrCam);
    } else if (this.post) {
      const fast = this.rig.fpvWeight * THREE.MathUtils.clamp((f.speed - 5) / 14, 0, 1);
      this.post.setAberration(f.still ? 0 : fast);
      this.post.setMotionBlur(f.still ? 0 : 0.5 * fast * fast);
      this.post.setStill(f.still ? f.drone.position : null);
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
    switch (e.type) {
      case 'ring-passed':
        this.ringBurst(e.index, e.position);
        break;
      case 'crash':
        this.rig.addTrauma(0.9);
        this.bloomPulse = 0.6;
        this.vfx.crash(e.position, e.speed, this.contact.surfaceY);
        break;
      case 'collision':
        if (e.contact.impactSpeed > 1.5) {
          this.rig.addTrauma(Math.min(0.35, e.contact.impactSpeed * 0.06));
          this.vfx.impact(e.contact.point, e.contact.normal, e.contact.impactSpeed, this.contact.surfaceY);
        }
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

  private ringBurst(index: number, pos: THREE.Vector3): void {
    const def = this.level.rings[index];
    if (!def) return;
    this.rings.passed(index);
    this.drone.flash(4);
    this.ringFlash = 1;
    this.bloomPulse = 1;
    this.vfx.ringPass(def, this.rings.ringColor(index), pos);
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
    const look = this.toneOverride ? { ...this.look, toneMapping: this.toneOverride } : this.look;
    r.shadowMap.enabled = p.shadows;
    this.library.setProfile(p);
    this.drone.setQuality(p.tier);
    this.vfx.setQuality(p.tier);
    this.levelView.setQuality(p);
    this.cascades.apply(this.levelView.group, p);
    this.levelView.refreshShadows();
    const sun = findSun(this.levelView.group);
    if (sun) this.sunDir.setFromMatrixPosition(sun.matrixWorld).sub(_v.setFromMatrixPosition(sun.target.matrixWorld)).normalize();
    this.scene.environment = p.envMap ? this.environmentFor(p) : null;
    this.scaleHemiLights(this.scene.environment !== null && this.envCapture !== null ? look.hemiWithIbl : 1);
    if (p.post) {
      if (!this.post) this.post = new PostFX(r, this.scene, this.rig.camera);
      this.post.setBloomThreshold(Math.max(this.levelView.bloomThreshold, look.bloom.threshold));
      this.post.setSunDirection(this.sunDir);
      this.post.configure(p, look);
      this.post.setSize(this.width, this.height);
      r.toneMapping = THREE.NoToneMapping;
      r.toneMappingExposure = 1;
    } else {
      this.post?.dispose();
      this.post = null;
      r.toneMapping = TONE_MAPPING[look.toneMapping];
      r.toneMappingExposure = look.exposure;
    }
  }

  /**
   * Captured environment of the current level, made on first use: the room or meadow as lit, seen
   * from the middle of the course. Falls back to the level view's stand-in if the capture fails.
   */
  private environmentFor(p: QualityProfile): THREE.Texture {
    if (!this.envCapture) {
      const def = this.level;
      const pos = def.kind === 'indoor' ? new THREE.Vector3(0, Math.min(2.6, def.room.size[1] * 0.45), 0) : new THREE.Vector3(0, 4, 0);
      this.levelView.group.updateMatrixWorld(true);
      try {
        this.envCapture = captureEnvironment(this.renderer, this.scene, [this.levelView.group], {
          position: pos,
          size: p.envSize,
          near: def.kind === 'indoor' ? 0.05 : 0.5,
          far: def.kind === 'indoor' ? 60 : 1200,
        });
      } catch {
        return this.levelView.environment;
      }
      // the capture rendered the static shadow maps from its own views; redraw them for the game camera
      this.levelView.refreshShadows();
    }
    return this.envCapture.texture;
  }

  /**
   * Scales the level's hemisphere lights against their own last setting (level views may reset them
   * on a quality change; a value this method wrote is recognised and not compounded).
   */
  private scaleHemiLights(k: number): void {
    this.levelView.group.traverse((o) => {
      const h = o as THREE.HemisphereLight;
      if (!h.isHemisphereLight) return;
      const ud = h.userData as { iblBase?: number; iblSet?: number };
      const base = ud.iblSet !== undefined && h.intensity === ud.iblSet ? ud.iblBase! : h.intensity;
      ud.iblBase = base;
      h.intensity = base * k;
      ud.iblSet = h.intensity;
    });
  }

  /** Look-test hook: force a tone mapper (null = the level's), rebuilding the post stack. */
  setToneMapping(mode: ToneMapper | null): void {
    this.toneOverride = mode;
    this.applyQuality();
  }

  /** The level look in use (tone mapper reflects a look-test override). */
  get currentLook(): Readonly<LevelLook> {
    return this.toneOverride ? { ...this.look, toneMapping: this.toneOverride } : this.look;
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
    this.cascades.detach();
    this.envCapture?.dispose();
    this.envCapture = null;
    this.losMarker.dispose();
    this.xrPanel.dispose();
    this.arrow.dispose();
    this.xrPlatform.geometry.dispose();
    (this.xrPlatform.material as THREE.Material).dispose();
    this.levelView.dispose();
    this.rings.dispose();
    this.drone.dispose();
    this.vfx.dispose();
    this.contact.dispose();
    this.fill.dispose();
    this.mats.dispose();
    this.library.dispose();
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
