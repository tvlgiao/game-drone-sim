/**
 * Hero quad (3" freestyle, true-X): procedural airframe in two LODs, instanced 3-blade props with
 * rpm-driven motion-blur discs, tilting FPV camera with a glass lens, RGB LED strips, nav glows.
 * LOD0 ≈ 8 draw calls (carbon, hard surfaces, camera ×2, props, blur, LEDs, nav glows); LOD1 = 5.
 * Body frame: -Z forward, +X right, +Y up; motor placement/spin from MOTOR_LAYOUT.
 */
import * as THREE from 'three';
import { MOTOR_LAYOUT } from '../physics/drone-params';
import type { DroneState, QualityTier } from '../types';
import { StaticBatcher } from './batcher';
import { DroneMaterials } from './drone/materials';
import { lodPolicy, selectLod, type DroneLod, type LodPolicy } from './drone/lod';
import { buildAirframe, buildFpvCamera, fpvGlass, ledGeometry, propGeometry, PROP_R, type Detail, type PartSink } from './drone/parts';
import { SWATCH, setSwatch, toLabelUV } from './drone/textures';

const VIS_MAX_SPIN = 95; // rad/s visual prop speed at full rpm (beyond this it aliases anyway)
/** metres per carbon weave tile (8 tows → ~1.5 mm tows at this scale) */
const WEAVE_TILE = 0.012;
/** FPV lens position in body frame before tilt (camera pivot). */
export const CAMERA_PIVOT = new THREE.Vector3(0, 0.041, -0.037);
export const LENS_OFFSET = 0.016; // metres ahead of pivot along camera -Z
/** LOD1 has no tilting camera: it bakes the camera at this tilt */
const LITE_TILT_DEG = 25;

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _up = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
const _mirror = new THREE.Matrix4();

/**
 * Orientation colours, like aircraft nav lights: the front half (−Z, camera side) is green, the rear
 * red, on LEDs, props, blur discs and the two nav-light glows — readable from across the loft.
 */
export const FRONT_COLOR = new THREE.Color(0.1, 1, 0.32);
export const REAR_COLOR = new THREE.Color(1, 0.12, 0.08);
/** screen-space size of the nav-light glows (fraction of the view height × tan(fov/2)) */
const NAV_GLOW_SIZE = 0.022;

const BLUR_VERT = /* glsl */ `
attribute float aRpm;
attribute vec3 aTint;
varying vec2 vP;
varying float vRpm;
varying vec3 vTint;
#include <common>
#include <fog_pars_vertex>
void main() {
  vP = position.xz / ${PROP_R.toFixed(4)};
  vRpm = aRpm;
  vTint = aTint;
  vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

/**
 * Motion-blurred prop: blade ghosts (they turn with the instance, so at real rpm they alias into a
 * slow wagon-wheel drift), concentric streaks from blade edges, a bright tip ring, tinted by the
 * prop colour. Fades in with rpm while the solid blades fade out.
 */
const BLUR_FRAG = /* glsl */ `
varying vec2 vP;
varying float vRpm;
varying vec3 vTint;
#include <common>
#include <fog_pars_fragment>
void main() {
  float r = length(vP);
  if (r > 1.0) discard;
  float a = atan(vP.y, vP.x);
  // blade ghosts lag behind the leading edge like a rolling-shutter smear
  float ghosts = pow(0.5 + 0.5 * cos(3.0 * a + r * 1.4), 5.0);
  float radial = smoothstep(0.14, 0.26, r) * (1.0 - smoothstep(0.93, 1.0, r));
  float streaks = 0.88 + 0.12 * sin(r * 47.0 + sin(a * 3.0) * 0.6);
  float tip = smoothstep(0.88, 0.955, r) * (1.0 - smoothstep(0.965, 1.0, r));
  float hub = 1.0 - smoothstep(0.1, 0.16, r);
  float alpha = vRpm * (radial * (0.06 + ghosts * 0.2) * streaks + tip * 0.22 + hub * 0.12);
  if (alpha < 0.003) discard;
  vec3 col = vTint * (0.5 + 0.7 * ghosts) * streaks + vec3(0.9) * tip * 0.35;
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

const LED_VERT = /* glsl */ `
varying vec3 vBody;
#include <common>
#include <fog_pars_vertex>
void main() {
  vBody = position;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const LED_FRAG = /* glsl */ `
uniform float uTime;
uniform float uArmed;
uniform float uBoost;
uniform vec3 uFront;
uniform vec3 uRear;
varying vec3 vBody;
#include <common>
#include <fog_pars_fragment>
void main() {
  // front (−Z) green, rear red: disarmed breathes, armed is solid with a running chase
  float rad = length(vBody.xz) / 0.05;
  vec3 side = vBody.z < 0.0 ? uFront : uRear;
  float breathe = 0.35 + 0.65 * (0.5 + 0.5 * sin(uTime * 2.6));
  float chase = 0.7 + 0.3 * smoothstep(0.3, 0.0, abs(fract(rad * 1.5 - uTime * 3.0) - 0.5));
  vec3 col = side * mix(breathe, chase, uArmed) * (3.2 + uBoost);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

const NAV_VERT = /* glsl */ `
attribute vec3 color;
uniform float uSize;
uniform float uViewH;
varying vec3 vColor;
void main() {
  vColor = color;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSize * projectionMatrix[1][1] * 0.5 * uViewH;
}`;

const NAV_FRAG = /* glsl */ `
varying vec3 vColor;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  float core = exp(-d * d * 14.0);
  float halo = pow(1.0 - d, 2.0) * 0.45;
  gl_FragColor = vec4(vColor * (core * 2.4 + halo) + vec3(core * 0.6), 1.0);
  #include <colorspace_fragment>
}`;

/** Soft radial glow as a DataTexture (lens glint). */
function glintTexture(size = 64): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size - 0.5;
      const dy = (y + 0.5) / size - 0.5;
      const d = Math.min(1, Math.hypot(dx, dy) * 2);
      const streak = Math.exp(-Math.abs(dy) * 60) * (1 - Math.abs(dx) * 2) * 0.6;
      const v = Math.min(1, Math.exp(-d * d * 9) + streak);
      const k = (y * size + x) * 4;
      data[k] = data[k + 1] = data[k + 2] = 255;
      data[k + 3] = Math.round(v * 255);
    }
  }
  const t = new THREE.DataTexture(data, size, size);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

interface LodSet {
  group: THREE.Group;
  props: THREE.InstancedMesh;
  fade: THREE.InstancedBufferAttribute;
}

export class DroneModel {
  readonly root = new THREE.Group();
  /** tilting FPV camera assembly (hidden in FPV view) */
  readonly camera = new THREE.Group();
  /** front (green) / rear (red) glows of constant screen size; hidden from the FPV lens */
  readonly navLights = new THREE.Group();
  private readonly mats: DroneMaterials;
  private readonly lods: [LodSet, LodSet];
  private readonly blur: THREE.InstancedMesh;
  private readonly blurRpm: THREE.InstancedBufferAttribute;
  private readonly ledMat: THREE.ShaderMaterial;
  private readonly blurMat: THREE.ShaderMaterial;
  private readonly navMat: THREE.ShaderMaterial;
  private readonly glint: THREE.Sprite;
  private readonly glintTex: THREE.DataTexture;
  private readonly camParts: THREE.Object3D[] = [];
  private readonly angles = [0, 0, 0, 0];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly ownMaterials: THREE.Material[] = [];
  private policy: LodPolicy = lodPolicy('high');
  private lodLevel: DroneLod = 0;
  private armedBlend = 0;
  private tiltDeg = NaN;

  /** Materials are the drone's own (procedural, node-safe); the shared library is not needed. */
  constructor(_shared?: unknown, anisotropy = 4) {
    this.root.name = 'drone';
    this.mats = new DroneMaterials(anisotropy);
    const lod0 = new THREE.Group();
    lod0.name = 'drone-lod0';
    const lod1 = new THREE.Group();
    lod1.name = 'drone-lod1';
    lod1.visible = false;
    this.root.add(lod0, lod1);

    this.buildStatic(lod0, 0);
    this.buildStatic(lod1, 1);
    this.buildCamera();

    this.lods = [this.buildProps(lod0, 0), this.buildProps(lod1, 1)];

    const discG = new THREE.CircleGeometry(PROP_R + 0.001, 40);
    discG.rotateX(-Math.PI / 2);
    this.geometries.push(discG);
    this.blurRpm = new THREE.InstancedBufferAttribute(new Float32Array(MOTOR_LAYOUT.length), 1);
    this.blurRpm.setUsage(THREE.DynamicDrawUsage);
    discG.setAttribute('aRpm', this.blurRpm);
    const tints = new Float32Array(MOTOR_LAYOUT.length * 3);
    MOTOR_LAYOUT.forEach((m, i) => (m.position[2] < 0 ? FRONT_COLOR : REAR_COLOR).toArray(tints, i * 3));
    discG.setAttribute('aTint', new THREE.InstancedBufferAttribute(tints, 3));
    this.blurMat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
      vertexShader: BLUR_VERT,
      fragmentShader: BLUR_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
    });
    this.blurMat.forceSinglePass = true;
    this.ownMaterials.push(this.blurMat);
    this.blur = new THREE.InstancedMesh(discG, this.blurMat, MOTOR_LAYOUT.length);
    this.blur.name = 'drone-blur';
    this.blur.renderOrder = 2;
    this.blur.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.blur.frustumCulled = false;
    this.root.add(this.blur);

    const ledG = ledGeometry();
    this.geometries.push(ledG);
    this.ledMat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 }, uArmed: { value: 0 }, uBoost: { value: 0 }, uFront: { value: FRONT_COLOR.clone() }, uRear: { value: REAR_COLOR.clone() } }]),
      vertexShader: LED_VERT,
      fragmentShader: LED_FRAG,
      fog: true,
    });
    this.ownMaterials.push(this.ledMat);
    const led = new THREE.Mesh(ledG, this.ledMat);
    led.name = 'drone-leds';
    this.root.add(led);

    const navG = new THREE.BufferGeometry();
    navG.setAttribute('position', new THREE.Float32BufferAttribute([0, 0.012, -0.056, 0, 0.012, 0.05], 3));
    const fc = FRONT_COLOR.clone().multiplyScalar(1.1);
    const rc = REAR_COLOR.clone().multiplyScalar(1.1);
    navG.setAttribute('color', new THREE.Float32BufferAttribute([fc.r, fc.g, fc.b, rc.r, rc.g, rc.b], 3));
    this.geometries.push(navG);
    this.navMat = new THREE.ShaderMaterial({
      uniforms: { uSize: { value: NAV_GLOW_SIZE }, uViewH: { value: 1080 } },
      vertexShader: NAV_VERT,
      fragmentShader: NAV_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.ownMaterials.push(this.navMat);
    const nav = new THREE.Points(navG, this.navMat);
    nav.frustumCulled = false;
    nav.renderOrder = 5;
    const viewport = new THREE.Vector4();
    nav.onBeforeRender = (renderer) => {
      renderer.getCurrentViewport(viewport);
      this.navMat.uniforms.uViewH.value = viewport.w;
    };
    this.navLights.add(nav);
    this.navLights.name = 'nav-lights';
    this.root.add(this.navLights);

    this.glintTex = glintTexture();
    const glintMat = new THREE.SpriteMaterial({ map: this.glintTex, color: new THREE.Color(3, 3.4, 4), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 });
    this.ownMaterials.push(glintMat);
    this.glint = new THREE.Sprite(glintMat);
    this.glint.scale.setScalar(0.014);
    this.glint.position.z = -0.0185;
    this.glint.visible = false;
    this.camera.add(this.glint);

    this.updateProps([0, 0, 0, 0]);
  }

  private buildStatic(parent: THREE.Group, detail: Detail): void {
    const batch = new StaticBatcher();
    const opts = { castShadow: false };
    const mats = this.mats;
    const sink: PartSink =
      detail === 0
        ? {
            carbon: (g, m) => batch.add('carbon', mats.carbon, g, m, { ...opts, uvTile: WEAVE_TILE }),
            hard: (g, m, sw, color) => batch.add('hard', mats.hard, setSwatch(g, sw), m, { ...opts, color }),
            label: (g, m) => batch.add('hard', mats.hard, toLabelUV(g), m, { ...opts, color: 0xffffff }),
          }
        : {
            carbon: (g, m) => batch.add('lite', mats.lite, setSwatch(g, SWATCH.gloss), m, { ...opts, color: 0x1c1d21 }),
            hard: (g, m, sw, color) => batch.add('lite', mats.lite, setSwatch(g, sw), m, { ...opts, color }),
            label: (g, m) => batch.add('lite', mats.lite, toLabelUV(g), m, { ...opts, color: 0xffffff }),
          };
    buildAirframe(sink, detail);
    if (detail === 1) {
      // the lite model bakes the FPV camera at a typical uptilt
      const cam = new THREE.Matrix4().compose(CAMERA_PIVOT, _q.setFromAxisAngle(_v.set(1, 0, 0), THREE.MathUtils.degToRad(LITE_TILT_DEG)), _s);
      const baked: PartSink = {
        carbon: (g, m) => sink.carbon(g, m.clone().premultiply(cam)),
        hard: (g, m, sw, color) => sink.hard(g, m.clone().premultiply(cam), sw, color),
        label: (g, m) => sink.label(g, m.clone().premultiply(cam)),
      };
      buildFpvCamera(baked, 1);
      baked.hard(fpvGlass(1), new THREE.Matrix4(), SWATCH.glass, 0x05070c);
    }
    for (const mesh of batch.build(parent)) {
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      this.geometries.push(mesh.geometry);
    }
  }

  private buildCamera(): void {
    const cam = this.camera;
    cam.name = 'drone-fpv-camera';
    cam.position.copy(CAMERA_PIVOT);
    const batch = new StaticBatcher();
    buildFpvCamera(
      {
        carbon: (g, m) => batch.add('hard', this.mats.hard, setSwatch(g, SWATCH.gloss), m, { castShadow: false, color: 0x1c1d21 }),
        hard: (g, m, sw, color) => batch.add('hard', this.mats.hard, setSwatch(g, sw), m, { castShadow: false, color }),
        label: (g, m) => batch.add('hard', this.mats.hard, toLabelUV(g), m, { castShadow: false }),
      },
      0,
    );
    for (const mesh of batch.build(cam)) {
      mesh.castShadow = false;
      this.geometries.push(mesh.geometry);
      this.camParts.push(mesh);
    }
    const glassG = fpvGlass(0);
    this.geometries.push(glassG);
    const glass = new THREE.Mesh(glassG, this.mats.lens);
    glass.name = 'drone-fpv-lens';
    cam.add(glass);
    this.camParts.push(glass);
    this.root.add(cam);
  }

  private buildProps(parent: THREE.Group, detail: Detail): LodSet {
    const g = propGeometry(detail);
    const mirror = new Float32Array(MOTOR_LAYOUT.length);
    MOTOR_LAYOUT.forEach((m, i) => (mirror[i] = m.spin));
    g.setAttribute('aMirror', new THREE.InstancedBufferAttribute(mirror, 1));
    const fade = new THREE.InstancedBufferAttribute(new Float32Array(MOTOR_LAYOUT.length).fill(1), 1);
    fade.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aFade', fade);
    this.geometries.push(g);
    const props = new THREE.InstancedMesh(g, detail === 0 ? this.mats.prop : this.mats.propLite, MOTOR_LAYOUT.length);
    props.name = `drone-props-lod${detail}`;
    MOTOR_LAYOUT.forEach((m, i) => props.setColorAt(i, m.position[2] < 0 ? FRONT_COLOR : REAR_COLOR));
    props.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    props.frustumCulled = false;
    props.renderOrder = 1;
    parent.add(props);
    return { group: parent, props, fade };
  }

  /** Quality tier → LOD policy (low tier, incl. Quest 2, always draws LOD1). */
  setQuality(tier: QualityTier): void {
    this.policy = lodPolicy(tier);
  }

  /** LOD currently drawn. */
  get lod(): DroneLod {
    return this.lodLevel;
  }

  private setLod(l: DroneLod): void {
    if (l === this.lodLevel) return;
    this.lodLevel = l;
    this.lods[0].group.visible = l === 0;
    this.lods[1].group.visible = l === 1;
    for (const p of this.camParts) p.visible = l === 0;
  }

  /** Sync pose, prop spin, blur, LEDs, camera tilt and LOD. `eye` = active camera world position. */
  update(state: DroneState, dt: number, time: number, cameraTiltDeg: number, eye: THREE.Vector3): void {
    this.root.position.copy(state.position);
    this.root.quaternion.copy(state.orientation);
    this.root.updateMatrixWorld();
    this.setLod(selectLod(eye.distanceTo(state.position), this.lodLevel, this.policy));

    for (let i = 0; i < 4; i++) {
      const m = state.motors[i];
      this.angles[i] = (this.angles[i] + MOTOR_LAYOUT[i].spin * m * VIS_MAX_SPIN * dt) % (Math.PI * 2);
    }
    this.updateProps(state.motors);

    this.armedBlend += ((state.armed ? 1 : 0) - this.armedBlend) * Math.min(1, dt * 6);
    this.ledMat.uniforms.uTime.value = time;
    this.ledMat.uniforms.uArmed.value = this.armedBlend;
    this.ledMat.uniforms.uBoost.value = Math.max(0, this.ledMat.uniforms.uBoost.value - dt * 4);

    if (cameraTiltDeg !== this.tiltDeg) {
      this.tiltDeg = cameraTiltDeg;
      this.camera.rotation.x = THREE.MathUtils.degToRad(cameraTiltDeg);
    }
    // lens glint: bright when the viewer is near the lens axis
    const gm = this.glint.material;
    if (this.lodLevel === 0) {
      this.camera.updateMatrixWorld();
      this.glint.getWorldPosition(_p);
      _v.copy(eye).sub(_p).normalize();
      _p.set(0, 0, -1).transformDirection(this.camera.matrixWorld);
      const facing = Math.max(0, _v.dot(_p));
      gm.opacity = Math.pow(facing, 12) * (0.6 + 0.4 * Math.sin(time * 3.1));
    } else {
      gm.opacity = 0;
    }
    this.glint.visible = gm.opacity > 0.01;
  }

  /** Flash LEDs (ring pass / respawn). */
  flash(amount = 4): void {
    this.ledMat.uniforms.uBoost.value = amount;
  }

  private updateProps(motors: readonly number[]): void {
    const set = this.lods[this.lodLevel];
    let anyBlur = false;
    for (let i = 0; i < MOTOR_LAYOUT.length; i++) {
      const pos = MOTOR_LAYOUT[i].position;
      _q.setFromAxisAngle(_up, this.angles[i]);
      _p.set(pos[0], pos[1], pos[2]);
      _m.compose(_p, _q, _s);
      set.props.setMatrixAt(i, _m);
      _p.y += 0.0015;
      _mirror.compose(_p, _q, _s);
      this.blur.setMatrixAt(i, _mirror);
      const rpm = Math.min(1, Math.max(0, (motors[i] - 0.04) * 2.2));
      this.blurRpm.setX(i, rpm);
      set.fade.setX(i, 1 - rpm * 0.82);
      if (rpm > 0.01) anyBlur = true;
    }
    set.props.instanceMatrix.needsUpdate = true;
    set.fade.needsUpdate = true;
    this.blur.instanceMatrix.needsUpdate = true;
    this.blurRpm.needsUpdate = true;
    this.blur.visible = anyBlur;
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.ownMaterials) m.dispose();
    this.glintTex.dispose();
    this.mats.dispose();
    for (const l of this.lods) l.props.dispose();
    this.blur.dispose();
  }
}
