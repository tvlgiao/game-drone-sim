/**
 * Near trees of the generated worlds on the Training field's tree models (trees.ts): the world engine's species map
 * onto the grown archetypes — broadleaf → oak, birch → birch, conifer → pine, scrub → a small oak — and every
 * species is drawn by instancing:
 *
 * - detailed (ultra / high): bark + leaf cards / needle sprays, two draws per archetype;
 * - cheap (medium): the archetype's opaque masses, one draw per archetype;
 * - low / VR: none (the impostors carry every tree; the profile's `treesLod0` is 0 there).
 *
 * The far impostors are baked from the same archetypes (`bakeImpostorAtlas`), so near and far trees share their
 * colours and silhouettes. Instance buffers grow by doubling; positions are relative to the floating origin, like
 * the rest of the scatter.
 */
import * as THREE from 'three';
import { TREE_DIMENSIONS, TREE_SPECIES } from '../../world/scatter';
import { ARCH_CROWN, ARCH_HEIGHT, treeArchetypes, type TreeKind } from './trees';
import { BILLBOARD_SPECIES } from './scatter-models';

/** archetype per world species (TREE_SPECIES order: conifer, broadleaf, scrub, birch) */
export const SPECIES_KIND: readonly TreeKind[] = ['pine', 'oak', 'oak', 'birch'];
const KINDS: readonly TreeKind[] = ['oak', 'birch', 'pine'];
/** impostor width over crown diameter (scatter-view's billboard sizing: 2.1 × the crown radius) */
const BILLBOARD_WIDTH = 2.1;
/** ±3.4° lean per tree, as the old models had */
const LEAN = 0.06;

export interface WorldTreeMaterials {
  bark: THREE.Material;
  cards: THREE.Material;
  needles: THREE.Material;
  lod: THREE.Material;
}

interface KindMeshes {
  bark: THREE.InstancedMesh;
  cards: THREE.InstancedMesh;
  lod: THREE.InstancedMesh;
  /**
   * Shadow caster: the opaque masses, drawn only into the shadow maps (its instance count is 0 except while a
   * shadow pass draws it, so the main pass issues no draw for it). The detailed bark and cards cast nothing: the
   * cascades draw every caster twice more, and the masses cost a fifth of the cards.
   */
  shadow: THREE.InstancedMesh;
  count: number;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _lean = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

/** Per-tree colour jitter from the scatter's 0..1 tint (the old models' TREE_JITTER). */
function jitterColour(t: number, out: THREE.Color): THREE.Color {
  const f = (x: number): number => x - Math.floor(x);
  return out.setRGB(0.84 + 0.3 * t, 0.88 + 0.22 * f(t * 7.31), 0.84 + 0.24 * f(t * 3.17));
}

export class WorldTrees {
  readonly group = new THREE.Group();
  private readonly kinds = new Map<TreeKind, KindMeshes>();
  private detailed = true;
  private shadows = false;

  constructor(private readonly mats: WorldTreeMaterials) {
    this.group.name = 'world-trees';
    for (const k of KINDS) this.kinds.set(k, this.make(k, 64));
  }

  private make(kind: TreeKind, cap: number): KindMeshes {
    const a = treeArchetypes().get(kind)!;
    const mk = (geo: THREE.BufferGeometry, mat: THREE.Material, name: string): THREE.InstancedMesh => {
      const m = new THREE.InstancedMesh(geo, mat, cap);
      m.name = `tree:${kind}:${name}`;
      m.count = 0;
      // instances span the whole streamed area: one draw either way
      m.frustumCulled = false;
      m.receiveShadow = true;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.setColorAt(0, _c.setRGB(1, 1, 1));
      this.group.add(m);
      return m;
    };
    const shadow = mk(a.lod, this.mats.lod, 'shadow');
    shadow.onBeforeShadow = () => {
      shadow.count = this.kinds.get(kind)?.count ?? 0;
    };
    shadow.onAfterShadow = () => {
      shadow.count = 0;
    };
    return { bark: mk(a.bark, this.mats.bark, 'bark'), cards: mk(a.cards, kind === 'pine' ? this.mats.needles : this.mats.cards, 'cards'), lod: mk(a.lod, this.mats.lod, 'lod'), shadow, count: 0 };
  }

  private grow(kind: TreeKind, k: KindMeshes): KindMeshes {
    const cap = k.bark.instanceMatrix.count * 2;
    const next = this.make(kind, cap);
    for (const key of ['bark', 'cards', 'lod', 'shadow'] as const) {
      const from = k[key];
      const to = next[key];
      (to.instanceMatrix.array as Float32Array).set(from.instanceMatrix.array as Float32Array);
      (to.instanceColor!.array as Float32Array).set(from.instanceColor!.array as Float32Array);
      from.removeFromParent();
      from.dispose();
    }
    next.count = k.count;
    this.kinds.set(kind, next);
    return next;
  }

  begin(): void {
    for (const k of this.kinds.values()) k.count = 0;
  }

  /** One tree of world `species` at (x, y, z) relative to the floating origin, its scatter scale, yaw and tint. */
  push(species: number, x: number, y: number, z: number, yaw: number, scale: number, tint: number): void {
    const kind = SPECIES_KIND[species] ?? 'oak';
    let k = this.kinds.get(kind)!;
    if (k.count >= k.bark.instanceMatrix.count) k = this.grow(kind, k);
    const d = TREE_DIMENSIONS[species] ?? TREE_DIMENSIONS[1]!;
    // a slight lean from the position (stable per tree), then the yaw
    const l1 = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
    const a = (l1 - Math.floor(l1) - 0.5) * LEAN;
    const b = (((l1 * 17.31) % 1) + 1) % 1;
    _lean.setFromEuler(_e.set(a, 0, (b - 0.5) * LEAN));
    _q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, yaw).multiply(_lean);
    const r = (d.crownRadius * scale) / ARCH_CROWN;
    _m.compose(_p.set(x, y, z), _q, _s.set(r, (d.height * scale) / ARCH_HEIGHT, r));
    jitterColour(tint, _c);
    for (const mesh of [k.bark, k.cards, k.lod, k.shadow]) {
      mesh.setMatrixAt(k.count, _m);
      mesh.setColorAt(k.count, _c);
    }
    k.count++;
  }

  end(): void {
    for (const k of this.kinds.values()) {
      for (const mesh of [k.bark, k.cards, k.lod, k.shadow]) {
        mesh.count = k.count;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
      k.shadow.count = 0;
    }
    this.apply();
  }

  /** ultra / high: branches and leaf cards; medium: the opaque masses. */
  setDetailed(on: boolean): void {
    this.detailed = on;
    this.apply();
  }

  setShadows(on: boolean): void {
    this.shadows = on;
    this.apply();
  }

  private apply(): void {
    for (const k of this.kinds.values()) {
      const any = k.count > 0;
      k.bark.visible = k.cards.visible = any && this.detailed;
      k.lod.visible = any && !this.detailed;
      k.bark.castShadow = k.cards.castShadow = false;
      k.lod.castShadow = this.shadows;
      k.shadow.visible = k.shadow.castShadow = any && this.detailed && this.shadows;
    }
  }

  /** instances per archetype (stats / tests) */
  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [kind, k] of this.kinds) out[`tree-${kind}`] = k.count;
    return out;
  }

  /** draw calls this layer adds now */
  get draws(): number {
    let n = 0;
    for (const k of this.kinds.values()) if (k.count > 0) n += this.detailed ? 2 : 1;
    return n;
  }

  dispose(): void {
    // archetype geometry is shared (treeArchetypes)
    for (const k of this.kinds.values()) for (const mesh of [k.bark, k.cards, k.lod, k.shadow]) mesh.dispose();
    this.kinds.clear();
    this.group.removeFromParent();
    this.group.clear();
  }
}

/** Atlas column size (px): one column per world species, as scatter-view's billboard shader expects. */
export const IMPOSTOR_W = 128;
export const IMPOSTOR_H = 256;

/**
 * Bakes the impostor atlas from the archetypes: per world species an orthographic side view of the detailed model
 * (bark + leaf cards, albedo only: the impostor is lit in the scene), framed exactly like the billboard quad
 * (width 2.1 × crown radius, full height, ground at the bottom), so a tree swapping LOD keeps its colour and outline.
 * `cards` / `needles` are the leaf textures (alpha-cut). The caller owns the returned target.
 */
export function bakeImpostorAtlas(renderer: THREE.WebGLRenderer, cards: THREE.Texture, needles: THREE.Texture): THREE.WebGLRenderTarget {
  const rt = new THREE.WebGLRenderTarget(IMPOSTOR_W * BILLBOARD_SPECIES, IMPOSTOR_H, { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true });
  rt.texture.wrapS = rt.texture.wrapT = THREE.ClampToEdgeWrapping;
  const scene = new THREE.Scene();
  const bark = new THREE.MeshBasicMaterial({ vertexColors: true });
  const leaf = new THREE.MeshBasicMaterial({ vertexColors: true, map: cards, alphaTest: 0.5, side: THREE.DoubleSide });
  const needle = new THREE.MeshBasicMaterial({ vertexColors: true, map: needles, alphaTest: 0.45, side: THREE.DoubleSide });
  const cam = new THREE.OrthographicCamera(-1, 1, 1, 0, 0.1, 100);
  const prevTarget = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  const prevTone = renderer.toneMapping;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setClearColor(0x000000, 0);
  try {
    renderer.setRenderTarget(rt);
    renderer.clear(true, true, true);
    const arch = treeArchetypes();
    for (let sp = 0; sp < BILLBOARD_SPECIES && sp < TREE_SPECIES.length; sp++) {
      const kind = SPECIES_KIND[sp]!;
      const a = arch.get(kind)!;
      const d = TREE_DIMENSIONS[sp]!;
      // the archetype at the species' proportions, seen from the side (the billboard is stretched the same way)
      const sx = d.crownRadius / ARCH_CROWN;
      const sy = d.height / ARCH_HEIGHT;
      const group = new THREE.Group();
      group.add(new THREE.Mesh(a.bark, bark), new THREE.Mesh(a.cards, kind === 'pine' ? needle : leaf));
      group.scale.set(sx, sy, sx);
      scene.add(group);
      const half = (BILLBOARD_WIDTH * d.crownRadius) / 2;
      cam.left = -half;
      cam.right = half;
      cam.bottom = 0;
      cam.top = d.height;
      cam.position.set(0, 0, 50);
      cam.lookAt(0, 0, 0);
      cam.updateProjectionMatrix();
      // a render target draws into its own viewport / scissor (re-bound to take effect)
      rt.viewport.set(sp * IMPOSTOR_W, 0, IMPOSTOR_W, IMPOSTOR_H);
      rt.scissor.set(sp * IMPOSTOR_W, 0, IMPOSTOR_W, IMPOSTOR_H);
      rt.scissorTest = true;
      renderer.setRenderTarget(null);
      renderer.setRenderTarget(rt);
      renderer.render(scene, cam);
      scene.remove(group);
    }
  } finally {
    rt.viewport.set(0, 0, rt.width, rt.height);
    rt.scissor.set(0, 0, rt.width, rt.height);
    rt.scissorTest = false;
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.toneMapping = prevTone;
    bark.dispose();
    leaf.dispose();
    needle.dispose();
  }
  return rt;
}
