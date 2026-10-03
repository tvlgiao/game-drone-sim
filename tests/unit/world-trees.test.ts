/**
 * Near trees of the generated worlds on the Training models (world-trees.ts), the City's roof detail and the
 * softer crop furrows.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { QUALITY_PROFILES } from '../../src/core/quality';
import { cityRuntime } from '../../src/levels/city';
import { MaterialLibrary } from '../../src/render/materials/library';
import { CityView } from '../../src/render/outdoor/city-view';
import { ScatterView } from '../../src/render/outdoor/scatter-view';
import { terrainDetailTexture } from '../../src/render/outdoor/terrain-materials';
import { SPECIES_KIND, WorldTrees } from '../../src/render/outdoor/world-trees';
import { WorldOrigin } from '../../src/render/outdoor/world-origin';
import { treeArchetypes } from '../../src/render/outdoor/trees';
import { TREE_DIMENSIONS } from '../../src/world/scatter';

const mats = (): ConstructorParameters<typeof WorldTrees>[0] => ({ bark: new THREE.MeshStandardMaterial(), cards: new THREE.MeshStandardMaterial(), needles: new THREE.MeshStandardMaterial(), lod: new THREE.MeshStandardMaterial() });
const meshes = (t: WorldTrees): THREE.InstancedMesh[] => t.group.children as THREE.InstancedMesh[];
const named = (t: WorldTrees, name: string): THREE.InstancedMesh => meshes(t).find((m) => m.name === name)!;

describe('world trees', () => {
  it('maps the species onto the archetypes: conifer → pine, broadleaf → oak, scrub → small oak, birch → birch', () => {
    expect(SPECIES_KIND).toEqual(['pine', 'oak', 'oak', 'birch']);
    const t = new WorldTrees(mats());
    t.begin();
    for (let sp = 0; sp < 4; sp++) t.push(sp, sp * 10, 0, 0, 0, 1, 0.5);
    t.end();
    expect(t.counts()).toEqual({ 'tree-oak': 2, 'tree-birch': 1, 'tree-pine': 1 });
    // the scrub is an oak scaled to the scrub's size
    const oak = named(t, 'tree:oak:bark');
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    oak.getMatrixAt(1, m);
    m.decompose(p, q, s);
    expect(s.y).toBeCloseTo(TREE_DIMENSIONS[2]!.height / 10, 5);
    t.dispose();
  });

  it('at most two draws per species detailed, one on medium; the shadow masses draw only inside a shadow pass', () => {
    const t = new WorldTrees(mats());
    t.begin();
    for (let i = 0; i < 200; i++) t.push(1, i, 0, 0, 0, 1, 0.3);
    t.end();
    t.setShadows(true);
    const visible = (): string[] => meshes(t).filter((m) => m.visible && m.count > 0).map((m) => m.name);
    expect(visible()).toEqual(['tree:oak:bark', 'tree:oak:cards']);
    expect(t.draws).toBe(2);
    const shadow = named(t, 'tree:oak:shadow');
    expect(shadow.visible && shadow.castShadow).toBe(true);
    expect(shadow.count).toBe(0);
    shadow.onBeforeShadow(undefined as never, undefined as never, undefined as never, undefined as never, shadow.geometry, undefined as never, null as never);
    expect(shadow.count).toBe(200);
    shadow.onAfterShadow(undefined as never, undefined as never, undefined as never, undefined as never, shadow.geometry, undefined as never, null as never);
    expect(shadow.count).toBe(0);
    expect(named(t, 'tree:oak:bark').castShadow || named(t, 'tree:oak:cards').castShadow).toBe(false);
    // the buffers grew past their first 64 and kept the earlier instances
    const m = new THREE.Matrix4();
    named(t, 'tree:oak:bark').getMatrixAt(5, m);
    expect(new THREE.Vector3().setFromMatrixPosition(m).x).toBeCloseTo(5);
    t.setDetailed(false);
    expect(visible()).toEqual(['tree:oak:lod']);
    expect(t.draws).toBe(1);
    t.dispose();
  });

  it('the scatter puts its near trees on the models and the rest on the impostors', () => {
    const near = new WorldTrees(mats());
    const s = new ScatterView(new WorldOrigin(), { uTime: { value: 0 } }, { treesLod0: 2, treesLod1: 10 }, near);
    const trees = new Float32Array([0, 0, 0, 1, 0, 1, 5, 0, 5, 1, 0, 0, 9, 0, 9, 1, 0, 3, 20, 0, 20, 1, 0, 1]);
    s.rebuild(new Map(), trees, { x: 0, z: 0 });
    const c = s.counts();
    expect(c['tree-oak']! + c['tree-pine']! + c['tree-birch']!).toBe(2);
    expect(c.broadleaf0).toBe(0);
    expect(c.billboards).toBe(2);
    s.dispose();
  });

  it('archetypes stay the shared Training models (one geometry per kind)', () => {
    const t = new WorldTrees(mats());
    expect(named(t, 'tree:oak:bark').geometry).toBe(treeArchetypes().get('oak')!.bark);
    t.dispose();
  });
});

describe('City roof detail', () => {
  it('parapets and vents near the drone or the camera on low / mid-rise roofs only, nothing when off', () => {
    const rt = cityRuntime();
    const c = rt.content!;
    if (c.kind !== 'city') throw new Error('city');
    const lib = new MaterialLibrary({ ...QUALITY_PROFILES.high, textureSize: 32, pbrTextures: false });
    const view = new CityView(c.city, c.outskirts, c.furniture, rt.terrain!, terrainDetailTexture(16), { uTime: { value: 0 } }, lib, { outskirts: 0, facadeDetail: true });
    const layer = (name: string): THREE.Mesh => view.group.children.find((m) => m.name === name) as THREE.Mesh;
    const count = (name: string): number => (layer(name).geometry as THREE.InstancedBufferGeometry).instanceCount;
    const [px, , pz] = c.city.pilot;
    view.setRoofDetail(true, 5000, 5000, px, pz);
    const nearPilot = count('roof-parapets');
    expect(nearPilot).toBeGreaterThan(0);
    expect(nearPilot % 4).toBe(0);
    expect(count('roof-vents')).toBeGreaterThanOrEqual((nearPilot / 4) * 2);
    view.setRoofDetail(true, 5000, 5000, 5000, 5000);
    expect(count('roof-parapets')).toBe(0);
    view.setRoofDetail(false, px, pz, px, pz);
    expect(count('roof-parapets') + count('roof-vents')).toBe(0);
    expect(layer('roof-parapets').visible).toBe(false);
    view.dispose();
    lib.dispose();
  });
});
