/** Collects static geometry per material and merges it into one mesh per material (few draw calls). */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export interface AddOptions {
  /** world-space box-projected UVs with this tile size in metres; omit to keep geometry UVs */
  uvTile?: number;
  /** per-vertex colour (materials with vertexColors) */
  color?: THREE.ColorRepresentation;
  castShadow?: boolean;
}

interface Bucket {
  material: THREE.Material;
  parts: THREE.BufferGeometry[];
  castShadow: boolean;
  receiveShadow: boolean;
}

const _n = new THREE.Vector3();
const _c = new THREE.Color();

export class StaticBatcher {
  private readonly buckets = new Map<string, Bucket>();

  /** Add a geometry (consumed: it is transformed in place and disposed after merging). */
  add(key: string, material: THREE.Material, geometry: THREE.BufferGeometry, matrix: THREE.Matrix4, opts: AddOptions = {}): void {
    const castShadow = opts.castShadow ?? true;
    const bucketKey = `${key}|${castShadow ? 1 : 0}`;
    let b = this.buckets.get(bucketKey);
    if (!b) {
      b = { material, parts: [], castShadow, receiveShadow: true };
      this.buckets.set(bucketKey, b);
    }
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    if (g !== geometry) geometry.dispose();
    g.applyMatrix4(matrix);
    for (const name of Object.keys(g.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
    }
    if (!g.attributes.normal) g.computeVertexNormals();
    if (opts.uvTile !== undefined) boxProjectUV(g, opts.uvTile);
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    if ((material as THREE.MeshStandardMaterial).vertexColors) {
      _c.set(opts.color ?? 0xffffff);
      const n = g.attributes.position.count;
      const arr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        arr[i * 3] = _c.r;
        arr[i * 3 + 1] = _c.g;
        arr[i * 3 + 2] = _c.b;
      }
      g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    }
    g.morphAttributes = {};
    b.parts.push(g);
  }

  /** Merge all buckets into meshes under `parent`. Returns created meshes. */
  build(parent: THREE.Object3D): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const [key, b] of this.buckets) {
      if (b.parts.length === 0) continue;
      const merged = mergeGeometries(b.parts, false);
      for (const p of b.parts) p.dispose();
      if (!merged) throw new Error(`merge failed for ${key}`);
      merged.computeBoundingSphere();
      merged.computeBoundingBox();
      const mesh = new THREE.Mesh(merged, b.material);
      mesh.name = `static:${key}`;
      mesh.castShadow = b.castShadow;
      mesh.receiveShadow = b.receiveShadow;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      parent.add(mesh);
      out.push(mesh);
    }
    this.buckets.clear();
    return out;
  }
}

/** Box-projected UVs in world metres, chosen by dominant normal axis (non-indexed geometry). */
export function boxProjectUV(g: THREE.BufferGeometry, tile: number): void {
  const pos = g.attributes.position;
  const nor = g.attributes.normal;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    _n.set(nor.getX(i), nor.getY(i), nor.getZ(i));
    const ax = Math.abs(_n.x);
    const ay = Math.abs(_n.y);
    const az = Math.abs(_n.z);
    let u: number;
    let v: number;
    if (ay >= ax && ay >= az) {
      u = pos.getX(i);
      v = pos.getZ(i);
    } else if (ax >= az) {
      u = pos.getZ(i) * Math.sign(_n.x || 1);
      v = pos.getY(i);
    } else {
      u = -pos.getX(i) * Math.sign(_n.z || 1);
      v = pos.getY(i);
    }
    uv[i * 2] = u / tile;
    uv[i * 2 + 1] = v / tile;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _e = new THREE.Euler();

/** Compose a TRS matrix (yaw about world Y, then optional local euler) into a shared scratch matrix. */
export function trs(x: number, y: number, z: number, yaw = 0, sx = 1, sy = 1, sz = 1, rx = 0, rz = 0): THREE.Matrix4 {
  _e.set(rx, yaw, rz, 'YXZ');
  _q.setFromEuler(_e);
  _p.set(x, y, z);
  _s.set(sx, sy, sz);
  return _m.compose(_p, _q, _s);
}
