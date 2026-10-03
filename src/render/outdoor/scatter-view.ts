/**
 * Instanced scenery of the shown chunks (design 07 §2.4): conifer / broadleaf / scrub trees at two LODs, rocks,
 * four house archetypes (windows lit at dusk) and bridges. Each kind is one draw with packed per-instance
 * attributes (aInst x y z yaw, aInstB scale x y z tint; houses aInstC roof height) instead of 64-byte matrices.
 * Buffers are rebuilt only when the chunk set (or the floating origin) changes, nearest chunks first until the
 * profile's tree budgets are spent.
 */
import * as THREE from 'three';
import { BRIDGE_STRIDE, HOUSE_STRIDE, ROCK_STRIDE, TREE_STRIDE } from '../../world/scatter';
import type { ShownChunk } from './terrain-view';
import { instancedMaterials, type InstanceUniforms } from './terrain-materials';
import { bridgeModel, broadleafLod0, broadleafLod1, coniferLod0, coniferLod1, houseModel, rockModel, scrubModel } from './scatter-models';
import type { WorldOrigin } from './world-origin';

/** One instanced draw: a model plus growable packed attributes. */
export class InstanceLayer {
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private a!: THREE.InstancedBufferAttribute;
  private b!: THREE.InstancedBufferAttribute;
  private c: THREE.InstancedBufferAttribute | null = null;
  private cap = 0;
  count = 0;

  constructor(
    model: THREE.BufferGeometry,
    material: THREE.Material,
    depth: THREE.Material | null,
    name: string,
    private readonly roof = false,
  ) {
    const g = new THREE.InstancedBufferGeometry();
    for (const k of ['position', 'normal', 'color'] as const) g.setAttribute(k, model.getAttribute(k));
    g.instanceCount = 0;
    this.geometry = g;
    this.grow(64);
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.name = name;
    // instances span the whole streamed area; one draw either way
    this.mesh.frustumCulled = false;
    if (depth) {
      this.mesh.customDepthMaterial = depth;
      this.mesh.castShadow = true;
    }
    this.mesh.receiveShadow = true;
  }

  get capacity(): number {
    return this.cap;
  }

  private grow(n: number): void {
    const mk = (k: number): THREE.InstancedBufferAttribute => new THREE.InstancedBufferAttribute(new Float32Array(n * k), k).setUsage(THREE.DynamicDrawUsage);
    const a = mk(4);
    const b = mk(4);
    if (this.cap > 0) {
      a.array.set(this.a.array);
      b.array.set(this.b.array);
      this.geometry.dispose();
    }
    this.a = a;
    this.b = b;
    this.geometry.setAttribute('aInst', a);
    this.geometry.setAttribute('aInstB', b);
    if (this.roof) {
      const c = mk(4);
      if (this.c) c.array.set(this.c.array);
      this.c = c;
      this.geometry.setAttribute('aInstC', c);
    }
    this.cap = n;
  }

  begin(): void {
    this.count = 0;
  }

  push(x: number, y: number, z: number, yaw: number, sx: number, sy: number, sz: number, tint: number, roofH = 0): void {
    if (this.count >= this.cap) this.grow(this.cap * 2);
    const i = this.count++;
    const a = this.a.array as Float32Array;
    const b = this.b.array as Float32Array;
    a[i * 4] = x;
    a[i * 4 + 1] = y;
    a[i * 4 + 2] = z;
    a[i * 4 + 3] = yaw;
    b[i * 4] = sx;
    b[i * 4 + 1] = sy;
    b[i * 4 + 2] = sz;
    b[i * 4 + 3] = tint;
    if (this.c) (this.c.array as Float32Array)[i * 4] = roofH;
  }

  end(): void {
    this.geometry.instanceCount = this.count;
    this.a.needsUpdate = true;
    this.b.needsUpdate = true;
    if (this.c) this.c.needsUpdate = true;
    this.mesh.visible = this.count > 0;
  }

  dispose(): void {
    this.geometry.dispose();
  }
}

/** Hash 0..1 from a position (per-instance tint). */
function tintOf(x: number, z: number): number {
  const s = Math.sin(x * 0.1731 + z * 0.3197) * 9631.17;
  return s - Math.floor(s);
}

const HOUSE_WINDOWS = /* glsl */ `
uniform float uDusk;
varying vec3 vHouseLocal;
varying vec3 vHouseN;
varying vec3 vHouseSize;
float houseHash( vec3 p ) { return fract( sin( dot( p, vec3( 12.9898, 78.233, 37.719 ) ) ) * 43758.5453 ); }`;

/** Walls take the instance colour; wall faces get windows (glass by day, some lit warm at dusk). */
const HOUSE_FRAGMENT = (cols: number, floors: number): string => /* glsl */ `
if ( vColor.r > 0.98 && vColor.g > 0.98 && vColor.b > 0.98 ) {
  float c = vTint;
  vec3 wall = vec3( floor( c / 65536.0 ), mod( floor( c / 256.0 ), 256.0 ), mod( c, 256.0 ) ) / 255.0;
  diffuseColor.rgb = pow( wall, vec3( 2.2 ) );
}
float isWall = step( abs( vHouseN.y ), 0.3 ) * step( vHouseLocal.y, 0.999 ) * step( 0.06, vHouseLocal.y );
if ( isWall > 0.5 && ${cols}.0 > 0.0 ) {
  bool alongX = abs( vHouseN.z ) > abs( vHouseN.x );
  float u = ( alongX ? vHouseLocal.x * vHouseSize.x : vHouseLocal.z * vHouseSize.z );
  float span = alongX ? vHouseSize.x : vHouseSize.z;
  float v = vHouseLocal.y * vHouseSize.y;
  float cell = span / ${cols}.0;
  float fu = fract( u / cell + 0.5 );
  float floorH = vHouseSize.y / ${floors}.0;
  float fv = fract( v / floorH );
  float win = step( 0.32, fu ) * step( fu, 0.68 ) * step( 0.32, fv ) * step( fv, 0.78 );
  // no window over the door
  win *= 1.0 - step( 0.5, vHouseN.z ) * step( abs( u ), 0.9 ) * step( v, 2.2 );
  if ( win > 0.5 ) {
    vec3 id = vec3( floor( u / cell + 0.5 ), floor( v / floorH ), vTint + vHouseN.x * 3.0 + vHouseN.z * 7.0 );
    float lit = step( houseHash( id ), uDusk * 0.75 );
    diffuseColor.rgb = vec3( 0.03, 0.035, 0.04 );
    totalEmissiveRadiance += vec3( 1.0, 0.62, 0.3 ) * lit * 1.6;
  }
}`;

export interface ScatterCaps {
  treesLod0: number;
  treesLod1: number;
}

export class ScatterView {
  readonly group = new THREE.Group();
  private readonly layers: InstanceLayer[] = [];
  private readonly treeLayers: InstanceLayer[][];
  private readonly rocks: InstanceLayer;
  private readonly houses: InstanceLayer[];
  private readonly bridges: InstanceLayer;
  private readonly owned: { dispose(): void }[] = [];
  private readonly duskUniform = { value: 0 };
  private readonly order: ShownChunk[] = [];
  caps: ScatterCaps;

  constructor(
    private readonly origin: WorldOrigin,
    shared: InstanceUniforms,
    caps: ScatterCaps,
  ) {
    this.group.name = 'scatter';
    this.caps = caps;
    const mk = (model: THREE.BufferGeometry, key: string, opts: { sway?: number; roughness?: number; shadow?: boolean } = {}): InstanceLayer => {
      const { material, depth } = instancedMaterials({ key, sway: opts.sway, roughness: opts.roughness }, shared);
      const layer = new InstanceLayer(model, material, opts.shadow === false ? null : depth, key);
      this.owned.push(model, material, depth);
      this.add(layer);
      return layer;
    };
    // [species][lod]: conifer, broadleaf, scrub
    this.treeLayers = [
      [mk(coniferLod0(), 'conifer0', { sway: 1 }), mk(coniferLod1(), 'conifer1', { shadow: false })],
      [mk(broadleafLod0(), 'broadleaf0', { sway: 1 }), mk(broadleafLod1(), 'broadleaf1', { shadow: false })],
      [mk(scrubModel(0), 'scrub0', { sway: 0.6 }), mk(scrubModel(1), 'scrub1', { shadow: false })],
    ];
    this.rocks = mk(rockModel(), 'rocks', { roughness: 0.85 });
    this.houses = [0, 1, 2, 3].map((arch) => {
      const model = houseModel(arch);
      const cols = arch === 2 ? 0 : arch === 3 ? 1 : 3;
      const floors = arch === 1 ? 2 : arch === 3 ? 3 : 1;
      const { material, depth } = instancedMaterials(
        {
          key: `house${arch}`,
          roof: true,
          roughness: 0.85,
          vertexPars: 'varying vec3 vHouseLocal;\nvarying vec3 vHouseN;\nvarying vec3 vHouseSize;',
          vertex: 'vHouseLocal = position;\nvHouseN = normal;\nvHouseSize = aInstB.xyz;',
          fragmentPars: HOUSE_WINDOWS,
          fragment: HOUSE_FRAGMENT(cols, floors),
          uniforms: { uDusk: this.duskUniform },
        },
        shared,
      );
      const layer = new InstanceLayer(model, material, depth, `houses-${arch}`, true);
      this.owned.push(model, material, depth);
      this.add(layer);
      return layer;
    });
    this.bridges = mk(bridgeModel(), 'bridges', { roughness: 0.8 });
  }

  private add(l: InstanceLayer): void {
    this.layers.push(l);
    this.group.add(l.mesh);
  }

  /** 0 by day .. 1 at dusk: share of lit house windows. */
  setDusk(k: number): void {
    this.duskUniform.value = k;
  }

  /** instance counts per layer (stats / tests) */
  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const l of this.layers) out[l.mesh.name] = l.count;
    return out;
  }

  get drawCount(): number {
    let n = 0;
    for (const l of this.layers) if (l.count > 0) n++;
    return n;
  }

  /**
   * Refills every layer from the shown chunks, nearest first: LOD0 chunks put trees on the detailed models
   * until `treesLod0` is spent, everything else on the LOD1 models until `treesLod1`.
   */
  rebuild(chunks: ReadonlyMap<number, ShownChunk>, extraTrees?: Float32Array): void {
    this.group.position.set(this.origin.x, 0, this.origin.z);
    for (const l of this.layers) l.begin();
    const order = this.order;
    order.length = 0;
    for (const c of chunks.values()) order.push(c);
    order.sort((a, b) => a.dist - b.dist);
    let n0 = 0;
    let n1 = 0;
    const ox0 = this.origin.x;
    const oz0 = this.origin.z;
    for (const c of order) {
      const d = c.data;
      const ox = d.originX - ox0;
      const oz = d.originZ - oz0;
      const t = d.trees;
      for (let k = 0; k < t.length; k += TREE_STRIDE) {
        const near = c.lod === 0 && n0 < this.caps.treesLod0;
        if (!near && n1 >= this.caps.treesLod1) break;
        const x = t[k]! + ox;
        const z = t[k + 2]! + oz;
        const s = t[k + 3]!;
        const sp = Math.min(2, Math.max(0, t[k + 5]! | 0));
        this.treeLayers[sp]![near ? 0 : 1]!.push(x, t[k + 1]!, z, t[k + 4]!, s, s, s, tintOf(x + ox0, z + oz0));
        if (near) n0++;
        else n1++;
      }
      if (c.lod <= 1) {
        const r = d.rocks;
        for (let k = 0; k < r.length; k += ROCK_STRIDE) {
          const s = r[k + 3]!;
          this.rocks.push(r[k]! + ox, r[k + 1]!, r[k + 2]! + oz, r[k + 4]!, s, s, s, 0);
        }
      }
      const h = d.houses;
      for (let k = 0; k < h.length; k += HOUSE_STRIDE) {
        const arch = Math.min(3, Math.max(0, h[k + 7]! | 0));
        this.houses[arch]!.push(h[k]! + ox, h[k + 1]!, h[k + 2]! + oz, h[k + 6]!, h[k + 3]!, h[k + 4]!, h[k + 5]!, h[k + 8]!, h[k + 9]!);
      }
      const b = d.bridges;
      for (let k = 0; k < b.length; k += BRIDGE_STRIDE) this.bridges.push(b[k]! + ox, b[k + 1]!, b[k + 2]! + oz, b[k + 5]!, b[k + 4]!, 1, b[k + 3]!, 0);
    }
    if (extraTrees) this.pushAbsoluteTrees(extraTrees);
    order.length = 0;
    for (const l of this.layers) l.end();
  }

  /** Trees in absolute coordinates (City park), detailed models first. */
  private pushAbsoluteTrees(t: Float32Array): void {
    for (let k = 0; k < t.length; k += TREE_STRIDE) {
      const sp = Math.min(2, Math.max(0, t[k + 5]! | 0));
      const s = t[k + 3]!;
      const x = t[k]! - this.origin.x;
      const z = t[k + 2]! - this.origin.z;
      this.treeLayers[sp]![0]!.push(x, t[k + 1]!, z, t[k + 4]!, s, s, s, tintOf(t[k]!, t[k + 2]!));
    }
  }

  /** Sets the shadow casting of the detailed layers (sun-follow shadows on high tiers only). */
  setShadows(on: boolean): void {
    for (const l of this.layers) if (l.mesh.customDepthMaterial) l.mesh.castShadow = on;
  }

  dispose(): void {
    for (const l of this.layers) l.dispose();
    for (const d of this.owned) d.dispose();
    this.group.removeFromParent();
    this.group.clear();
  }
}
