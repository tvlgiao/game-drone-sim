/**
 * Moonlight pools for tiers without shadow maps (Quest, low): the window shapes, mullions included,
 * projected along the moon direction onto the floor as soft additive quads. With shadow maps the real
 * moon shadow draws them, so this mesh is hidden there.
 */
import * as THREE from 'three';
import type { WindowInfo } from '../room';
import { dataTexture, rgba, smooth } from '../materials/texgen';

/** one glazed pane: bright centre, dark mullion border, soft falloff */
function paneTexture(size: number): THREE.DataTexture {
  const data = rgba(size, size, (_i, x, y, c) => {
    const u = (x + 0.5) / size;
    const v = (y + 0.5) / size;
    const e = Math.min(u, 1 - u, v, 1 - v);
    const k = smooth(0.03, 0.09, e);
    c[0] = k;
    c[1] = k;
    c[2] = k;
  });
  return dataTexture(data, size, size, { srgb: false });
}

export class MoonPools {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;

  constructor(windows: readonly WindowInfo[], moonDir: THREE.Vector3) {
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const onFloor = (c: THREE.Vector3) => c.clone().addScaledVector(moonDir, c.y / -moonDir.y);
    for (const w of windows) {
      if (w.inward.dot(moonDir) <= 0.15) continue;
      const cols = Math.max(2, Math.round(w.width / 0.75));
      const rows = Math.max(2, Math.round(w.height / 0.62));
      const base = pos.length / 3;
      const uvs = [
        [0, 0],
        [cols, 0],
        [cols, rows],
        [0, rows],
      ];
      w.corners.forEach((c, k) => {
        const p = onFloor(c);
        pos.push(p.x, 0.006, p.z);
        uv.push(uvs[k]![0]!, uvs[k]![1]!);
      });
      idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeBoundingSphere();
    const mat = new THREE.MeshBasicMaterial({
      map: paneTexture(64),
      color: new THREE.Color(0.011, 0.013, 0.019),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.name = 'moon-pools';
    this.mesh.renderOrder = 2;
    this.mesh.visible = false;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.map?.dispose();
    this.mesh.material.dispose();
  }
}
