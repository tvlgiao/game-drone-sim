/**
 * Image-based lighting, one mechanism for every level: the level itself is captured once from its probe
 * point (`LevelView.probe`) into
 *
 * - a PMREM cube: `scene.environment` on tiers with envMap (metal, glass and clear-coat reflect the actual
 *   room or meadow), and the box-projected reflections of the loft's floor and windows on every tier;
 * - an L2 spherical-harmonics `LightProbe` of the same view: the diffuse ambient on tiers without envMap
 *   (low, VR), so their ambient light matches what the PMREM gives the higher tiers instead of falling back
 *   to a flat hemisphere colour.
 *
 * Everything that is not scenery (drone, particles, markers, VR furniture) is hidden for the capture.
 */
import * as THREE from 'three';

export interface CaptureOptions {
  /** probe position (world) */
  position: THREE.Vector3;
  /** cube face size */
  size: number;
  near: number;
  far: number;
  /** blur applied before prefiltering, in radians; softens tiny hot spots (bulbs, sun) */
  sigma?: number;
  /**
   * Called with a blank PMREM of the same size before the capture renders: materials that point at the
   * environment themselves (box-projected floors) set it, so their programs compile once, with the
   * env-map defines they keep afterwards.
   */
  standIn?: (env: THREE.Texture) => void;
  /** the scene's own environment is the stand-in during the capture too (tiers that keep scene.environment) */
  sceneStandIn?: boolean;
}

/**
 * Hides every top-level child of `scene` but `keep` (and points and sprites inside `keep`), as a capture sees it;
 * returns the undo. A loading screen compiles the capture's programs under the same view (its light set differs).
 */
export function showSceneryOnly(scene: THREE.Scene, keep: readonly THREE.Object3D[]): () => void {
  const hidden: THREE.Object3D[] = [];
  const hide = (o: THREE.Object3D): void => {
    if (o.visible) {
      o.visible = false;
      hidden.push(o);
    }
  };
  for (const child of scene.children) if (!keep.includes(child)) hide(child);
  for (const k of keep) {
    k.traverse((o) => {
      if ((o as THREE.Points).isPoints || (o as THREE.Sprite).isSprite) hide(o);
    });
  }
  return () => {
    for (const o of hidden) o.visible = true;
  };
}

/** Renders `keep` with every other top-level child of `scene` hidden (points and sprites inside `keep` too). */
function withScenery<T>(scene: THREE.Scene, keep: readonly THREE.Object3D[], env: THREE.Texture | null, fn: () => T): T {
  const restore = showSceneryOnly(scene, keep);
  const before = scene.environment;
  scene.environment = env;
  try {
    return fn();
  } finally {
    scene.environment = before;
    restore();
  }
}

/**
 * Renders `keep` (and the scene's lights inside it) into a PMREM render target. The scene's environment
 * is the blank stand-in (or null) during the capture, so the probe does not see a previous capture.
 */
export function captureEnvironment(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  keep: readonly THREE.Object3D[],
  opts: CaptureOptions,
): THREE.WebGLRenderTarget {
  const pmrem = new THREE.PMREMGenerator(renderer);
  let stand: THREE.WebGLRenderTarget | null = null;
  if (opts.standIn || opts.sceneStandIn) {
    stand = pmrem.fromScene(new THREE.Scene(), 0, 0.1, 1, { size: opts.size });
    opts.standIn?.(stand.texture);
  }
  try {
    return withScenery(scene, keep, opts.sceneStandIn ? stand!.texture : null, () =>
      pmrem.fromScene(scene, opts.sigma ?? 0.02, opts.near, opts.far, { size: opts.size, position: opts.position }),
    );
  } finally {
    pmrem.dispose();
    stand?.dispose();
  }
}

const FACE = 16;
const _coord = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _basis = new Array<number>(9).fill(0);

/**
 * Diffuse ambient of the level as seen from `position`: a 16² HDR cube render projected onto L2 spherical
 * harmonics (synchronous, ~6 tiny renders + readbacks). `environment` is what the scenery's own
 * env-mapped materials should see during the render (the PMREM, or null).
 */
export function captureLightProbe(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  keep: readonly THREE.Object3D[],
  position: THREE.Vector3,
  near: number,
  far: number,
  environment: THREE.Texture | null,
): THREE.LightProbe {
  const rt = new THREE.WebGLCubeRenderTarget(FACE, { type: THREE.HalfFloatType, generateMipmaps: false });
  const cam = new THREE.CubeCamera(near, far, rt);
  cam.position.copy(position);
  const tone = renderer.toneMapping;
  renderer.toneMapping = THREE.NoToneMapping;
  try {
    withScenery(scene, keep, environment, () => cam.update(renderer, scene));
  } finally {
    renderer.toneMapping = tone;
  }
  const sh = new THREE.SphericalHarmonics3();
  const coef = sh.coefficients;
  const data = new Uint16Array(FACE * FACE * 4);
  const px = 2 / FACE;
  const flip = renderer.coordinateSystem === THREE.WebGLCoordinateSystem ? -1 : 1;
  let total = 0;
  for (let face = 0; face < 6; face++) {
    renderer.readRenderTargetPixels(rt, 0, 0, FACE, FACE, data, face);
    for (let i = 0; i < FACE * FACE; i++) {
      const r = THREE.DataUtils.fromHalfFloat(data[i * 4]!);
      const g = THREE.DataUtils.fromHalfFloat(data[i * 4 + 1]!);
      const b = THREE.DataUtils.fromHalfFloat(data[i * 4 + 2]!);
      if (!Number.isFinite(r + g + b)) continue;
      const col = (1 - ((i % FACE) + 0.5) * px) * flip;
      const row = 1 - (Math.floor(i / FACE) + 0.5) * px;
      switch (face) {
        case 0: _coord.set(-1 * flip, row, col * flip); break;
        case 1: _coord.set(1 * flip, row, -col * flip); break;
        case 2: _coord.set(col, 1, -row); break;
        case 3: _coord.set(col, -1, row); break;
        case 4: _coord.set(col, row, 1); break;
        default: _coord.set(-col, row, -1); break;
      }
      const l2 = _coord.lengthSq();
      const w = 4 / (Math.sqrt(l2) * l2);
      total += w;
      _dir.copy(_coord).normalize();
      THREE.SphericalHarmonics3.getBasisAt(_dir, _basis);
      for (let j = 0; j < 9; j++) {
        coef[j]!.x += _basis[j]! * r * w;
        coef[j]!.y += _basis[j]! * g * w;
        coef[j]!.z += _basis[j]! * b * w;
      }
    }
  }
  const norm = (4 * Math.PI) / Math.max(total, 1e-6);
  for (const c of coef) c.multiplyScalar(norm);
  rt.dispose();
  const probe = new THREE.LightProbe(sh, 1);
  probe.name = 'ibl-probe';
  return probe;
}
