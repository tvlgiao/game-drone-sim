/**
 * Daylight countryside for flat-ground levels: sky dome + sun, fog into the horizon, a flat meadow under
 * the course rolling into farmland and hazy mountain ridges, the mowed flying field, an asphalt pad on a
 * gravel apron, swaying trees / hedges / flags, grass blades around the camera (tier-gated), the field
 * set pieces and the visual-only countryside dressing. Static sun shadows.
 */
import * as THREE from 'three';
import { QUALITY_PROFILES, type QualityProfile } from '../../core/quality';
import type { OutdoorLevel, SkyDef } from '../../types';
import { StaticBatcher } from '../batcher';
import type { LevelFrame, LevelProbe, LevelView } from '../level-view';
import type { MaterialLibrary, MaterialScope } from '../materials/library';
import type { WindUniforms } from '../materials/patches';
import { mountainBackdrop } from './backdrop';
import { VegBuilder } from './foliage';
import { Grass } from './grass';
import { Forest } from './trees';
import { GRASS_TILE, fieldGeometry, meadowGeometry, padTexture, terrainHeight } from './ground';
import { buildOutdoorProps, lowPolyMaterial, type OutdoorProps } from './outdoor-props';
import { buildScenery } from './scenery';
import { SkyDome, skyEnvironment } from './sky';
import { applyEnvPatch } from '../materials/patches';
import type { LevelRuntime } from '../../levels/runtime';
import { TrainingLife } from '../life/training-life';
import { TERRAIN_GUST } from '../life/gust';

const MEADOW_RADIUS = 1150;
const GROUND_HAZE = 0x9db58a;
/** half-size of the static sun-shadow box around the field: covers the course, the treeline and the fence */
const SHADOW_HALF = 95;
const SHADOW_TOP = 16;
const HEMI = 1.15;
const FIELD_STRIPES = 10;
const FALLBACK_SKY: SkyDef = { top: 0x2f78d0, horizon: 0xd3e4ec, sunDir: [-0.5, 0.56, 0.66], sunColor: 0xffe2bc, sunIntensity: 6, hemi: [0xcfe2ff, 0x6a6a3c] };

/** grass tufts and patch half-size per tier (desktop; phones and tablets scale with their particle budget) */
const GRASS: Record<QualityProfile['tier'], { tufts: number; half: number }> = {
  ultra: { tufts: 30000, half: 16 },
  high: { tufts: 20000, half: 14 },
  medium: { tufts: 10000, half: 11 },
  low: { tufts: 0, half: 10 },
};
const GRASS_MAX = GRASS.ultra.tufts;

const _v = new THREE.Vector3();
/** meadow: grass detail under the vertex colours, travelling gusts over it (one object: the library caches by identity) */
const MEADOW_PATCH = { detail: 0.7, gust: true };

export class OutdoorLevelView implements LevelView {
  readonly group = new THREE.Group();
  readonly background: THREE.Color;
  readonly fog: THREE.FogExp2;
  readonly environment: THREE.Texture;
  readonly environmentIntensity = 0.9;
  readonly probe: LevelProbe = { position: new THREE.Vector3(0, 4, 0), near: 0.5, far: 1200, minSize: 64, always: false };
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
  private readonly wind: WindUniforms;
  private readonly grass: Grass;
  private readonly cards: THREE.Mesh | null;
  private readonly forest: Forest;
  private readonly scope: MaterialScope;
  /** birds, turbines, cows, the tractor, chimney smoke, farm-road cars (docs/12) */
  private readonly life: TrainingLife;
  private readonly lifeClock = { uTime: { value: 0 } };

  constructor(level: OutdoorLevel, renderer: THREE.WebGLRenderer, library: MaterialLibrary, rt: LevelRuntime | null = null) {
    this.group.name = 'world';
    this.scope = library.scope(level.id);
    const lib = this.scope;
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
    // the sock streams downwind, away from the sun side; grass and trees lean the same way
    this.windYaw = Math.atan2(sunDir.z, -sunDir.x);
    const windDir = new THREE.Vector2(Math.cos(this.windYaw), -Math.sin(this.windYaw));
    this.wind = { uTime: { value: 0 }, uWind: { value: windDir } };

    const half = level.bounds.max?.[0] ?? 40;
    const batch = new StaticBatcher();
    const low = lib.custom('training:lowpoly', () => lowPolyMaterial());
    const veg = new VegBuilder(terrainHeight);
    this.props = buildOutdoorProps(level.props, low, this.group, veg, batch);
    const trunks = level.props.filter((p) => p.kind === 'tree').map((p) => [p.position[0], p.position[2], 2.5] as [number, number, number]);
    buildScenery(batch, low, veg, { avoid: trunks });

    // meadow and mowed field: the palette rides on vertex colours, the grass set (procedural, CC0 where
    // loaded) only adds texture through the detail patch
    const meadowMat = lib.material('grass', { uvMeters: GRASS_TILE, vertexColors: true, normalScale: 0.5, roughness: 1.4, envMapIntensity: 0.3, patch: MEADOW_PATCH });
    const groundGeo = meadowGeometry(MEADOW_RADIUS);
    if (this.props.hills) {
      const hills = this.props.hills;
      const merged = mergeGround(groundGeo, hills);
      groundGeo.dispose();
      hills.dispose();
      this.owned.push(merged);
      this.addMesh(new THREE.Mesh(merged, meadowMat), 'meadow', false, true);
    } else {
      this.owned.push(groundGeo);
      this.addMesh(new THREE.Mesh(groundGeo, meadowMat), 'meadow', false, true);
    }
    const fieldMat = lib.material('grass', {
      uvMeters: GRASS_TILE,
      vertexColors: true,
      normalScale: 0.4,
      roughness: 1.4,
      envMapIntensity: 0.3,
      polygonOffset: -1,
      patch: { detail: 0.7, stripes: { half, width: (half * 2) / FIELD_STRIPES, strength: 0.16 }, gust: true },
    });
    const field = fieldGeometry(half, FIELD_STRIPES);
    this.addMesh(new THREE.Mesh(field, fieldMat), 'field', false, true);
    this.owned.push(field);

    // gravel apron under the pad and the pilot's spot (UVs in metres)
    const apronShape = roundedRect(7.4, 9.6, 1.2);
    const apron = new THREE.ShapeGeometry(apronShape, 6);
    apron.rotateX(-Math.PI / 2);
    const auv = apron.attributes.uv as THREE.BufferAttribute;
    const apos = apron.attributes.position;
    for (let i = 0; i < auv.count; i++) auv.setXY(i, apos.getX(i), apos.getZ(i));
    const gravelMat = lib.material('gravel', { uvMeters: 1, roughness: 0.95, polygonOffset: -2 });
    const apronMesh = new THREE.Mesh(apron, gravelMat);
    apronMesh.position.set(0, 0.003, 34.3);
    this.addMesh(apronMesh, 'gravel', false, true);
    this.owned.push(apron);

    const pad = level.props.find((p) => p.kind === 'pad');
    if (pad) {
      const [px, py, pz] = pad.position;
      const [w, h, d] = pad.size;
      const art = lib.texture('training:pad-art', () => padTexture(512));
      const overlay = { texture: art, min: new THREE.Vector2(px - w / 2, pz - d / 2), size: new THREE.Vector2(w, d) };
      const mat = lib.material('asphalt', { uvMeters: 1, roughness: 0.9, polygonOffset: -3, patch: { overlay } });
      const geo = new THREE.PlaneGeometry(w, d);
      geo.rotateX(-Math.PI / 2);
      const puv = geo.attributes.uv as THREE.BufferAttribute;
      for (let i = 0; i < puv.count; i++) puv.setXY(i, geo.attributes.position.getX(i), geo.attributes.position.getZ(i));
      const m = new THREE.Mesh(geo, mat);
      m.position.set(px, py + h, pz);
      this.addMesh(m, 'pad', false, true);
      this.owned.push(geo);
    }

    for (const m of batch.build(this.group)) {
      m.castShadow = true;
      m.receiveShadow = true;
      this.owned.push(m.geometry);
    }

    const barkMat = lib.material('bark', { uvMeters: 1, vertexColors: true, albedo: 0x8a7a6a, roughness: 0.95, envMapIntensity: 0.8, patch: { wind: { uniforms: this.wind, flutter: false } } });
    const leavesMat = lib.custom('training:leaves', () =>
      applyEnvPatch(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0, side: THREE.DoubleSide, envMapIntensity: 0.5 }), { wind: { uniforms: this.wind, flutter: true } }),
    );
    const cardMat = lib.material('foliage', { vertexColors: true, roughness: 0.8, envMapIntensity: 0.5, patch: { wind: { uniforms: this.wind, flutter: true } } });
    const vegMeshes = veg.build(this.group, { bark: barkMat, leaves: leavesMat, cards: cardMat });
    for (const m of [vegMeshes.bark, vegMeshes.leaves]) {
      if (!m) continue;
      m.castShadow = true;
      m.receiveShadow = true;
      this.owned.push(m.geometry);
    }
    const lodMat = lib.custom('training:tree-lod', () =>
      applyEnvPatch(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0, envMapIntensity: 0.5 }), { wind: { uniforms: this.wind, flutter: false } }),
    );
    const needleMat = lib.material('needles', { vertexColors: true, roughness: 0.85, envMapIntensity: 0.5, patch: { wind: { uniforms: this.wind, flutter: true } } });
    this.forest = new Forest(veg.trees, { bark: barkMat, cards: cardMat, needles: needleMat, lod: lodMat }, this.group);
    this.cards = vegMeshes.cards;
    if (this.cards) {
      this.cards.castShadow = false;
      this.cards.receiveShadow = true;
      this.owned.push(this.cards.geometry);
    }

    const mountains = mountainBackdrop(sky.horizon);
    this.group.add(mountains);
    this.owned.push(mountains.geometry, mountains.material as THREE.Material);

    this.grass = new Grass({ fieldHalf: half, bare: [[-3.8, 29.4, 3.8, 39.2], [-1.7, 43.3, 1.7, 46.7]], wind: windDir, maxTufts: GRASS_MAX });
    this.group.add(this.grass.mesh);

    this.life = new TrainingLife(rt, this.lifeClock, windDir, this.fog, library.profile.tier);
    this.group.add(this.life.group);
  }

  private addMesh(m: THREE.Mesh, name: string, cast: boolean, receive: boolean): void {
    m.name = name;
    m.castShadow = cast;
    m.receiveShadow = receive;
    this.group.add(m);
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
    this.sky.update(f.time);
    this.wind.uTime.value = f.time;
    this.lifeClock.uTime.value = f.time;
    TERRAIN_GUST.uGustTime.value = f.time;
    TERRAIN_GUST.uGustWind.value.copy(this.wind.uWind.value);
    TERRAIN_GUST.uGustOrigin.value.set(0, 0);
    this.life.update(f.time, f.dt, f.drone);
    this.grass.update(f.time, f.camera);
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
    // phones / tablets run a reduced particle budget for the same tier: scale the grass with it
    const device = QUALITY_PROFILES[p.tier].particles > 0 ? p.particles / QUALITY_PROFILES[p.tier].particles : 1;
    const g = GRASS[p.tier];
    this.grass.setDensity(g.tufts * device, g.half);
    const detailed = p.tier === 'ultra' || p.tier === 'high';
    if (this.cards) this.cards.visible = detailed;
    this.forest.setDetailed(detailed);
    this.life.setQuality(p.tier);
  }

  stats(): Record<string, unknown> {
    return { life: this.life.stats() };
  }

  /** grass tufts drawn this tier (tests / budget probes) */
  get grassTufts(): number {
    return this.grass.count;
  }

  refreshShadows(): void {
    this.sun.shadow.needsUpdate = true;
  }

  /** Outdoors nothing env-maps itself: the GameView's capture only feeds scene.environment / the SH probe. */
  setEnvironment(_env: THREE.Texture): void {}

  dispose(): void {
    this.group.removeFromParent();
    this.sky.dispose();
    this.envTarget.dispose();
    this.sun.shadow.map?.dispose();
    this.sun.dispose();
    this.hemi.dispose();
    this.ringLight.dispose();
    this.grass.dispose();
    this.forest.dispose();
    this.life.dispose();
    for (const d of this.props.disposables) d.dispose();
    for (const d of this.owned) d.dispose();
    this.scope.dispose();
    this.group.clear();
  }
}

/** Ground + hills share the meadow material: same attribute set, both indexed. */
function mergeGround(ground: THREE.BufferGeometry, hills: THREE.BufferGeometry): THREE.BufferGeometry {
  const parts = [ground, hills].map((g) => {
    const c = g.clone();
    for (const name of Object.keys(c.attributes)) if (!['position', 'normal', 'color', 'uv'].includes(name)) c.deleteAttribute(name);
    if (!c.index) c.setIndex([...Array(c.attributes.position.count).keys()]);
    return c;
  });
  const out = mergeIndexed(parts);
  for (const p of parts) p.dispose();
  return out;
}

function mergeIndexed(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const names = ['position', 'normal', 'color', 'uv'] as const;
  const out = new THREE.BufferGeometry();
  let vtx = 0;
  const idx: number[] = [];
  const data: Record<string, number[]> = { position: [], normal: [], color: [], uv: [] };
  for (const p of parts) {
    for (const n of names) {
      const src = p.attributes[n]!.array as ArrayLike<number>;
      const dst = data[n]!;
      for (let i = 0; i < src.length; i++) dst.push(src[i]!);
    }
    const ix = p.index!;
    for (let i = 0; i < ix.count; i++) idx.push(ix.getX(i) + vtx);
    vtx += p.attributes.position.count;
  }
  out.setAttribute('position', new THREE.Float32BufferAttribute(data.position!, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(data.normal!, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(data.color!, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(data.uv!, 2));
  out.setIndex(idx);
  out.computeBoundingSphere();
  return out;
}

function roundedRect(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}
