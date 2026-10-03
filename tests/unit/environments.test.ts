/**
 * Environment budgets and "what you see is what you hit", checked on the scene graph (no GPU):
 * draw calls = meshes the builders produce, triangles counted from their geometry; loft wall dressing
 * stays flush with the shell; props stay inside their colliders; trees inside their canopy colliders;
 * the countryside relief never rises under the course.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { StaticBatcher } from '../../src/render/batcher';
import type { LoftMaterials } from '../../src/render/env-materials/loft-materials';
import { buildCity } from '../../src/render/loft/city';
import { Halos } from '../../src/render/loft/halos';
import { MoonPools } from '../../src/render/loft/moon-pools';
import { MOON_DIR } from '../../src/render/lights';
import { buildProps } from '../../src/render/props';
import { buildRoom } from '../../src/render/room';
import { mountainBackdrop } from '../../src/render/outdoor/backdrop';
import { VegBuilder } from '../../src/render/outdoor/foliage';
import { Grass } from '../../src/render/outdoor/grass';
import { FLAT_RADIUS, fieldGeometry, meadowGeometry, terrainHeight } from '../../src/render/outdoor/ground';
import { buildOutdoorProps, lowPolyMaterial } from '../../src/render/outdoor/outdoor-props';
import { buildScenery } from '../../src/render/outdoor/scenery';
import { NIGHT_LOFT } from '../../src/levels/night-loft';
import { TRAINING_LEVEL } from '../../src/levels/training';
import type { PropDef } from '../../src/types';

/** Untextured stand-ins with the flags the batcher reads (vertex colours, per-vertex roughness / metalness). */
function stubLoftMaterials(): LoftMaterials {
  const std = (o: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial(o);
  const basic = (o: THREE.MeshBasicMaterialParameters = {}) => new THREE.MeshBasicMaterial(o);
  const props = std({ vertexColors: true });
  props.userData.vertexRM = true;
  const [sx, sy, sz] = NIGHT_LOFT.room.size;
  return {
    floor: std(),
    brick: std(),
    paintedBrick: std(),
    concrete: std(),
    wood: std({ vertexColors: true }),
    props,
    leather: new THREE.MeshPhysicalMaterial(),
    fabric: new THREE.MeshPhysicalMaterial(),
    leaf: std(),
    rug: std(),
    glass: std({ transparent: true }),
    glow: basic({ vertexColors: true }),
    bulbShell: basic(),
    neon: basic({ vertexColors: true }),
    spill: basic({ vertexColors: true }),
    decals: std({ transparent: true }),
    cookie: new THREE.Texture(),
    radial: new THREE.Texture(),
    box: { min: new THREE.Vector3(-sx / 2, 0, -sz / 2), max: new THREE.Vector3(sx / 2, sy, sz / 2), probe: new THREE.Vector3(0, 2.2, 0) },
  } as unknown as LoftMaterials;
}

function triangles(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const g = m.geometry;
    const per = g.index ? g.index.count / 3 : g.attributes.position.count / 3;
    const inst = (g as THREE.InstancedBufferGeometry).isInstancedBufferGeometry ? (g as THREE.InstancedBufferGeometry).instanceCount : (m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh).count : 1;
    n += per * (Number.isFinite(inst) ? inst : 1);
  });
  return n;
}

function drawables(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh || (o as THREE.Points).isPoints) n++;
  });
  return n;
}

function worldVertices(meshes: readonly THREE.Mesh[], each: (p: THREE.Vector3, mesh: THREE.Mesh) => void): void {
  const p = new THREE.Vector3();
  for (const m of meshes) {
    m.updateMatrixWorld(true);
    const pos = m.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) each(p.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld), m);
  }
}

describe('Night Loft scenery', () => {
  const [sx, sy, sz] = NIGHT_LOFT.room.size;

  it('draws in a few dozen calls and well under the triangle budget', () => {
    const mats = stubLoftMaterials();
    const group = new THREE.Group();
    const batch = new StaticBatcher();
    const windows = buildRoom(NIGHT_LOFT.room, mats, batch);
    const live = buildProps(NIGHT_LOFT.props, mats, batch, group);
    buildCity(windows, NIGHT_LOFT.room.size, MOON_DIR, mats, batch, group, 512);
    batch.build(group);
    group.add(new Halos(live.lamps).mesh, new MoonPools(windows, MOON_DIR).mesh);
    // + light shafts and dust (two more draws, added by the view)
    const draws = drawables(group) + 2;
    const tris = triangles(group);
    expect(draws).toBeLessThanOrEqual(40);
    expect(tris).toBeLessThanOrEqual(200_000);
    expect(live.lamps.length).toBe(NIGHT_LOFT.props.filter((p) => p.kind === 'bulb-hanging' || p.kind === 'lamp-floor').length);
  });

  it('wall, floor and ceiling dressing stays within 6.5 cm of the shell (the room planes are hard in physics)', () => {
    const mats = stubLoftMaterials();
    const batch = new StaticBatcher();
    buildRoom(NIGHT_LOFT.room, mats, batch);
    const meshes = batch.build(new THREE.Group());
    const m = 0.065;
    const bad: string[] = [];
    worldVertices(meshes, (p, mesh) => {
      const inside = p.x > -sx / 2 + m && p.x < sx / 2 - m && p.z > -sz / 2 + m && p.z < sz / 2 - m && p.y > m && p.y < sy - m;
      if (inside && bad.length < 5) bad.push(`${mesh.name} @ ${p.toArray().map((v) => v.toFixed(2)).join(',')}`);
    });
    expect(bad).toEqual([]);
  });

  // thin cords (bulbs, TV, fan downrod) and the beam / duct hangers up to the slab are deliberate exceptions
  const CHECKED: PropDef['kind'][] = ['sofa', 'table', 'shelf', 'crate', 'plant', 'pillar', 'lamp-floor'];
  for (const kind of CHECKED) {
    it(`${kind}: every vertex inside the prop's collider (±2 cm)`, () => {
      const mats = stubLoftMaterials();
      const tol = 0.02;
      for (const p of NIGHT_LOFT.props.filter((q) => q.kind === kind)) {
        const batch = new StaticBatcher();
        buildProps([p], mats, batch, new THREE.Group());
        const meshes = batch.build(new THREE.Group()).filter((mesh) => !mesh.name.includes('decals'));
        const shape = p.colliders[0]!.shape;
        const out: string[] = [];
        worldVertices(meshes, (v) => {
          if (shape.kind === 'box') {
            const yaw = shape.yaw ?? 0;
            const dx = v.x - shape.center[0];
            const dz = v.z - shape.center[2];
            const lx = dx * Math.cos(yaw) - dz * Math.sin(yaw);
            const lz = dx * Math.sin(yaw) + dz * Math.cos(yaw);
            const ly = v.y - shape.center[1];
            // small things standing on a table top (mug, books, transmitter) may rise a hand's width above it
            const top = kind === 'table' ? 0.11 : tol;
            if (Math.abs(lx) > shape.half[0] + tol || ly > shape.half[1] + top || ly < -shape.half[1] - tol || Math.abs(lz) > shape.half[2] + tol) out.push(`${p.id} ${v.toArray().map((x) => x.toFixed(2))}`);
          } else if (shape.kind === 'cylinder') {
            const r = Math.hypot(v.x - shape.center[0], v.z - shape.center[2]);
            if (r > shape.radius + tol || Math.abs(v.y - shape.center[1]) > shape.halfHeight + tol) out.push(`${p.id} ${v.toArray().map((x) => x.toFixed(2))}`);
          }
        });
        expect(out.slice(0, 3)).toEqual([]);
      }
    });
  }
});

describe('Training Field scenery', () => {
  const half = TRAINING_LEVEL.bounds.max![0];

  it('the countryside relief is flat under the course, the treeline and its colliders', () => {
    for (let x = -FLAT_RADIUS; x <= FLAT_RADIUS; x += 5) {
      for (let z = -FLAT_RADIUS; z <= FLAT_RADIUS; z += 5) if (Math.hypot(x, z) <= FLAT_RADIUS) expect(terrainHeight(x, z)).toBe(0);
    }
    for (const p of TRAINING_LEVEL.props.filter((q) => q.kind === 'tree')) expect(terrainHeight(p.position[0], p.position[2])).toBe(0);
    // and it does roll further out
    let relief = 0;
    for (let a = 0; a < Math.PI * 2; a += 0.3) relief = Math.max(relief, Math.abs(terrainHeight(Math.sin(a) * 400, Math.cos(a) * 400)));
    expect(relief).toBeGreaterThan(2);
  });

  it('tree trunks and crowns (leaf masses + cards) stay inside the trunk / canopy colliders', () => {
    for (const p of TRAINING_LEVEL.props.filter((q) => q.kind === 'tree')) {
      const veg = new VegBuilder(() => 0);
      veg.tree(p);
      const group = new THREE.Group();
      const m = veg.build(group, { bark: new THREE.MeshStandardMaterial(), leaves: new THREE.MeshStandardMaterial(), cards: new THREE.MeshStandardMaterial() });
      const [x, , z] = p.position;
      const [crown, h] = p.size;
      const canopy = p.colliders[1]!.shape as { radius: number };
      const out: string[] = [];
      worldVertices([m.bark, m.leaves, m.cards].filter((q): q is THREE.Mesh => !!q), (v) => {
        const r = Math.hypot(v.x - x, v.z - z);
        if (v.y > h * 0.24 && r > canopy.radius + 0.05) out.push(`${p.id} r=${r.toFixed(2)} > ${canopy.radius.toFixed(2)}`);
        if (v.y > h + 0.05) out.push(`${p.id} y=${v.y.toFixed(2)} > ${h.toFixed(2)}`);
      });
      expect(crown / 2).toBeCloseTo(canopy.radius, 5);
      expect(out.slice(0, 3)).toEqual([]);
    }
  });

  function buildOutdoor(): { group: THREE.Group; grass: Grass; cards: THREE.Mesh | null } {
    const group = new THREE.Group();
    const batch = new StaticBatcher();
    const veg = new VegBuilder(terrainHeight);
    const low = lowPolyMaterial();
    const props = buildOutdoorProps(TRAINING_LEVEL.props, low, group, veg, batch);
    buildScenery(batch, low, veg, { avoid: [] });
    batch.build(group);
    const m = veg.build(group, { bark: new THREE.MeshStandardMaterial(), leaves: new THREE.MeshStandardMaterial(), cards: new THREE.MeshStandardMaterial() });
    group.add(new THREE.Mesh(meadowGeometry(1150)), new THREE.Mesh(fieldGeometry(half, 10)), mountainBackdrop(0xbfd8ea));
    if (props.hills) group.add(new THREE.Mesh(props.hills));
    const grass = new Grass({ fieldHalf: half, bare: [], wind: new THREE.Vector2(1, 0), maxTufts: 30000 });
    group.add(grass.mesh);
    return { group, grass, cards: m.cards };
  }

  it('ultra: ≤ 20 scenery draws and ≤ 1 M triangles with the grass on', () => {
    const { group, grass } = buildOutdoor();
    grass.setDensity(30000, 16);
    expect(drawables(group) + 3).toBeLessThanOrEqual(20); // + sky, pad, gravel
    expect(triangles(group)).toBeLessThanOrEqual(1_000_000);
  });

  it('low (Quest): no grass, no leaf cards, ≤ 150 k scenery triangles', () => {
    const { group, grass, cards } = buildOutdoor();
    grass.setDensity(0, 10);
    if (cards) cards.visible = false;
    let tris = 0;
    group.traverseVisible((o) => {
      if (o !== group) tris += triangles(o) * ((o as THREE.Mesh).isMesh ? 1 : 0);
    });
    expect(grass.count).toBe(0);
    expect(tris).toBeLessThanOrEqual(150_000);
  });
});
