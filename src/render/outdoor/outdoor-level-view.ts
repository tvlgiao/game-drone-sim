/**
 * Daylight outdoor scenery for flat-ground levels: sky dome + sun, fog into the horizon, meadow, mowed
 * field with painted bounds, landing pad and the level's low-poly set pieces. Static sun shadows.
 */
import * as THREE from 'three';
import type { QualityProfile } from '../../core/quality';
import type { OutdoorLevel, SkyDef } from '../../types';
import type { LevelFrame, LevelView } from '../level-view';
import { fieldGeometry, grassDetailTexture, meadowGeometry, padTexture } from './ground';
import { buildOutdoorProps, lowPolyMaterial, type OutdoorProps } from './outdoor-props';
import { SkyDome, skyEnvironment } from './sky';

const MEADOW_SIZE = 1600;
const GROUND_HAZE = 0x9db58a;
/** half-size of the static sun-shadow box around the field: covers the course and the nearer trees */
const SHADOW_HALF = 95;
const SHADOW_TOP = 16;
const HEMI = 1.15;
const FALLBACK_SKY: SkyDef = { top: 0x2f78d0, horizon: 0xd3e4ec, sunDir: [-0.5, 0.56, 0.66], sunColor: 0xffe2bc, sunIntensity: 6, hemi: [0xcfe2ff, 0x6a6a3c] };

const _v = new THREE.Vector3();

export class OutdoorLevelView implements LevelView {
  readonly group = new THREE.Group();
  readonly background: THREE.Color;
  readonly fog: THREE.FogExp2;
  readonly environment: THREE.Texture;
  readonly environmentIntensity = 0.9;
  /** the sky and sunlit ground sit near 1.0 in linear light: only the sun disc, rings and sparks bloom */
  readonly bloomThreshold = 1.6;
  readonly ringLight = new THREE.PointLight(0x19e6ff, 0, 7, 2);
  private readonly sky: SkyDome;
  private readonly sun: THREE.DirectionalLight;
  private readonly hemi: THREE.HemisphereLight;
  private readonly envTarget: THREE.WebGLRenderTarget;
  private readonly props: OutdoorProps;
  private readonly owned: { dispose(): void }[] = [];
  private readonly windYaw: number;

  constructor(level: OutdoorLevel, renderer: THREE.WebGLRenderer, anisotropy: number) {
    this.group.name = 'world';
    const sky = typeof level.env.sky === 'string' ? FALLBACK_SKY : level.env.sky;
    this.background = new THREE.Color(sky.horizon);
    this.fog = new THREE.FogExp2(level.env.fog.color, 2.15 / level.env.fog.viewDistance);

    this.sky = new SkyDome(sky, GROUND_HAZE);
    this.group.add(this.sky.mesh);
    this.envTarget = skyEnvironment(renderer, sky, GROUND_HAZE);
    this.environment = this.envTarget.texture;

    const sunDir = new THREE.Vector3(...sky.sunDir).normalize();
    this.sun = new THREE.DirectionalLight(sky.sunColor, sky.sunIntensity);
    this.sun.position.copy(sunDir).multiplyScalar(120);
    this.sun.target.position.set(0, 0, 0);
    this.group.add(this.sun, this.sun.target);
    this.fitShadow();
    this.hemi = new THREE.HemisphereLight(sky.hemi[0], sky.hemi[1], HEMI);
    this.group.add(this.hemi, this.ringLight);
    // the sock streams downwind, away from the sun side
    this.windYaw = Math.atan2(sunDir.z, -sunDir.x);

    const grass = grassDetailTexture(256, Math.min(anisotropy, 8));
    const meadowMat = new THREE.MeshStandardMaterial({ vertexColors: true, map: grass, roughness: 1, metalness: 0, envMapIntensity: 0.3 });
    const meadow = new THREE.Mesh(meadowGeometry(MEADOW_SIZE, 96), meadowMat);
    meadow.name = 'meadow';
    meadow.receiveShadow = true;

    const half = level.bounds.max?.[0] ?? 40;
    const fieldMat = new THREE.MeshStandardMaterial({ vertexColors: true, map: grass, roughness: 0.95, metalness: 0, envMapIntensity: 0.3, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    const field = new THREE.Mesh(fieldGeometry(half, 10), fieldMat);
    field.name = 'field';
    field.receiveShadow = true;
    this.group.add(meadow, field);
    this.owned.push(grass, meadowMat, meadow.geometry, fieldMat, field.geometry);

    const pad = level.props.find((p) => p.kind === 'pad');
    if (pad) {
      const tex = padTexture(512);
      const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.75, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      const geo = new THREE.PlaneGeometry(pad.size[0], pad.size[2]);
      geo.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(geo, mat);
      m.name = 'pad';
      m.position.set(pad.position[0], pad.position[1] + pad.size[1], pad.position[2]);
      m.receiveShadow = true;
      this.group.add(m);
      this.owned.push(tex, mat, geo);
    }

    const low = lowPolyMaterial();
    this.owned.push(low);
    this.props = buildOutdoorProps(level.props, low, this.group);
    for (const m of this.props.meshes) {
      m.castShadow = m.name !== 'hills';
      m.receiveShadow = true;
    }
  }

  /** Static shadow camera fitted around the field in light space. */
  private fitShadow(): void {
    const s = this.sun.shadow;
    this.sun.updateMatrixWorld();
    this.sun.target.updateMatrixWorld();
    const view = new THREE.Matrix4().lookAt(this.sun.position, this.sun.target.position, new THREE.Vector3(0, 1, 0));
    view.setPosition(this.sun.position);
    const inv = view.clone().invert();
    const box = new THREE.Box3();
    for (const x of [-SHADOW_HALF, SHADOW_HALF]) for (const y of [0, SHADOW_TOP]) for (const z of [-SHADOW_HALF, SHADOW_HALF]) box.expandByPoint(_v.set(x, y, z).applyMatrix4(inv));
    const cam = s.camera;
    cam.left = box.min.x;
    cam.right = box.max.x;
    cam.bottom = box.min.y;
    cam.top = box.max.y;
    cam.near = Math.max(0.1, -box.max.z - 1);
    cam.far = -box.min.z + 1;
    cam.updateProjectionMatrix();
    s.bias = -0.0004;
    s.normalBias = 0.04;
    s.radius = 2.5;
    s.autoUpdate = false;
  }

  update(f: LevelFrame): void {
    this.sky.follow(f.camera);
    const sock = this.props.sock;
    if (sock) {
      const gust = Math.sin(f.time * 0.7) * 0.5 + Math.sin(f.time * 1.9 + 1.3) * 0.25;
      sock.rotation.set(0, this.windYaw + gust * 0.18, -0.12 - (0.5 - gust * 0.5) * 0.35);
    }
  }

  setQuality(p: QualityProfile): void {
    this.sun.castShadow = p.shadows;
    this.sun.shadow.mapSize.set(p.shadowMapSize, p.shadowMapSize);
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null;
    this.sun.shadow.needsUpdate = true;
    // without shadow maps nothing is shaded by the sun: a little more sky light keeps the contrast even
    this.hemi.intensity = p.shadows ? HEMI : HEMI * 1.2;
  }

  refreshShadows(): void {
    this.sun.shadow.needsUpdate = true;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.sky.dispose();
    this.envTarget.dispose();
    this.sun.shadow.map?.dispose();
    this.sun.dispose();
    this.hemi.dispose();
    this.ringLight.dispose();
    for (const d of this.props.disposables) d.dispose();
    for (const d of this.owned) d.dispose();
    this.group.clear();
  }
}
