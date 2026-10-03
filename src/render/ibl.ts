/**
 * Image-based lighting: the level itself is captured once into a PMREM cube (six renders from a probe
 * point), so metal, glass and clear-coat reflect the actual room or meadow instead of a stand-in.
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
}

/**
 * Renders `keep` (and the scene's lights inside it) into a PMREM render target. Other top-level
 * children of `scene`, point sprites and sprites inside `keep` are hidden during the capture, and
 * `scene.environment` is cleared so the probe does not see a previous capture.
 */
export function captureEnvironment(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  keep: readonly THREE.Object3D[],
  opts: CaptureOptions,
): THREE.WebGLRenderTarget {
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
  const env = scene.environment;
  scene.environment = null;
  const pmrem = new THREE.PMREMGenerator(renderer);
  try {
    return pmrem.fromScene(scene, opts.sigma ?? 0.02, opts.near, opts.far, { size: opts.size, position: opts.position });
  } finally {
    pmrem.dispose();
    scene.environment = env;
    for (const o of hidden) o.visible = true;
  }
}
