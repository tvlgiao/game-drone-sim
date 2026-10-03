/**
 * Sun shadow upgrade for high tiers: the level's static DirectionalLight is swapped for three's
 * SunLight, which renders two cascades fitted to the view frustum every frame (bounding-sphere fit,
 * texel-snapped, faded across the split). The near cascade gives centimetre texels around the camera
 * (the quad's own shadow, crisp contact under cones); the far one keeps the treeline shaded. Lower
 * tiers keep the level's single static map; low and VR keep only the contact blob.
 */
import * as THREE from 'three';
import { SunLight } from 'three/addons/lights/SunLight.js';
import type { QualityProfile } from '../core/quality';

/** view distance covered by the cascades; beyond it the sun casts no shadow (haze hides the loss) */
export const CASCADE_FAR = 150;
/** per-cascade map edge cap: the atlas is two maps wide */
const MAX_CASCADE_MAP = 2048;

/** Finds the key sun: a DirectionalLight named "sun", else the first one. */
export function findSun(root: THREE.Object3D): THREE.DirectionalLight | null {
  let named: THREE.DirectionalLight | null = null;
  let first: THREE.DirectionalLight | null = null;
  root.traverse((o) => {
    const l = o as THREE.DirectionalLight;
    if (!l.isDirectionalLight) return;
    first ??= l;
    if (l.name === 'sun') named ??= l;
  });
  return named ?? first;
}

export class SunCascades {
  private sun: SunLight | null = null;
  private replaced: THREE.DirectionalLight | null = null;

  get active(): boolean {
    return this.sun !== null;
  }

  get light(): SunLight | null {
    return this.sun;
  }

  /**
   * Cascades on when the tier asks for them and the level has a directional sun; otherwise the
   * level's own light is restored. Safe to call on every quality change.
   */
  apply(root: THREE.Object3D | null, p: QualityProfile, far = CASCADE_FAR): void {
    const want = p.shadows && p.sunCascades && root !== null;
    const dl = want ? findSun(root) : null;
    if (!dl) {
      this.detach();
      return;
    }
    if (this.replaced !== dl) this.detach();
    if (!this.sun) {
      const sun = new SunLight(dl.color, dl.intensity);
      sun.name = 'sun-cascades';
      sun.castShadow = true;
      this.sun = sun;
      this.replaced = dl;
      dl.parent?.add(sun);
      dl.visible = false;
    }
    const sun = this.sun;
    dl.updateMatrixWorld();
    dl.target.updateMatrixWorld();
    const toSun = new THREE.Vector3().setFromMatrixPosition(dl.matrixWorld).sub(new THREE.Vector3().setFromMatrixPosition(dl.target.matrixWorld)).normalize();
    sun.position.copy(toSun).multiplyScalar(100);
    sun.color.copy(dl.color);
    sun.intensity = dl.intensity;
    const size = Math.min(MAX_CASCADE_MAP, p.shadowMapSize);
    if (sun.shadow.mapSize.x !== size) {
      sun.shadow.mapSize.set(size, size);
      sun.shadow.map?.dispose();
      sun.shadow.map = null;
    }
    sun.shadow.camera.near = 0.5;
    sun.shadow.camera.far = far;
    sun.shadow.bias = -0.0002;
    sun.shadow.normalBias = 0.025;
    sun.shadow.radius = 2.5;
  }

  /** Restores the level's light and frees the cascade atlas. */
  detach(): void {
    if (this.sun) {
      this.sun.removeFromParent();
      this.sun.dispose();
    }
    if (this.replaced) this.replaced.visible = true;
    this.sun = null;
    this.replaced = null;
  }
}
