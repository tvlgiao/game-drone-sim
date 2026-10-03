import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { DroneModel } from '../../src/render/drone-model';
import { DRONE_BUDGET, LOD_FAR, LOD_HYSTERESIS, lodPolicy, selectLod } from '../../src/render/drone/lod';
import { createDroneState } from '../../src/physics/physics-world';
import type { QualityTier } from '../../src/types';

function tris(g: THREE.BufferGeometry): number {
  return (g.index ? g.index.count : g.attributes.position.count) / 3;
}

/** Draw calls and triangles the renderer would issue for `root` (visible meshes / points; DoubleSide transparents count twice unless single-pass). */
function drawCost(root: THREE.Object3D): { calls: number; triangles: number } {
  let calls = 0;
  let triangles = 0;
  const visit = (o: THREE.Object3D): void => {
    if (!o.visible) return;
    if (o instanceof THREE.Mesh || o instanceof THREE.Points || o instanceof THREE.Sprite) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats as THREE.Material[]) {
        const passes = m.transparent && m.side === THREE.DoubleSide && !m.forceSinglePass ? 2 : 1;
        calls += passes;
        if (o instanceof THREE.Mesh) {
          const n = o instanceof THREE.InstancedMesh ? o.count : 1;
          triangles += tris(o.geometry) * n * passes;
        }
      }
    }
    for (const c of o.children) visit(c);
  };
  visit(root);
  return { calls, triangles };
}

function viewFrom(drone: DroneModel, distance: number, frames = 3): void {
  const state = createDroneState();
  state.armed = true;
  state.motors = [0.5, 0.5, 0.5, 0.5];
  const eye = new THREE.Vector3(0, distance * 0.3, distance);
  for (let i = 0; i < frames; i++) drone.update(state, 1 / 60, i / 60, 25, eye);
}

describe('drone LOD selection', () => {
  const high = lodPolicy('high');
  it('uses LOD0 close up and LOD1 beyond the far distance', () => {
    expect(selectLod(1, 0, high)).toBe(0);
    expect(selectLod(LOD_FAR * high.scale + 0.01, 0, high)).toBe(1);
  });
  it('has hysteresis: LOD1 holds until well inside the switch distance', () => {
    const far = LOD_FAR * high.scale;
    expect(selectLod(far - 0.01, 1, high)).toBe(1);
    expect(selectLod(far * LOD_HYSTERESIS - 0.01, 1, high)).toBe(0);
  });
  it('the low tier (Quest 2) always draws LOD1, higher tiers keep LOD0 further out', () => {
    expect(selectLod(0.3, 0, lodPolicy('low'))).toBe(1);
    const tiers: QualityTier[] = ['medium', 'high', 'ultra'];
    const scales = tiers.map((t) => lodPolicy(t).scale);
    expect(scales).toEqual([...scales].sort((a, b) => a - b));
  });
  it('the model switches LOD with viewing distance and tier', () => {
    const d = new DroneModel();
    d.setQuality('high');
    viewFrom(d, 1);
    expect(d.lod).toBe(0);
    viewFrom(d, 12);
    expect(d.lod).toBe(1);
    viewFrom(d, 1);
    expect(d.lod).toBe(0);
    d.setQuality('low');
    viewFrom(d, 0.5);
    expect(d.lod).toBe(1);
    d.dispose();
  });
});

describe('drone render budget', () => {
  it(`LOD0 stays within ${DRONE_BUDGET.lod0.triangles} triangles and ${DRONE_BUDGET.lod0.drawCalls} draw calls`, () => {
    const d = new DroneModel();
    d.setQuality('ultra');
    viewFrom(d, 1);
    expect(d.lod).toBe(0);
    const cost = drawCost(d.root);
    expect(cost.triangles).toBeLessThanOrEqual(DRONE_BUDGET.lod0.triangles);
    expect(cost.calls).toBeLessThanOrEqual(DRONE_BUDGET.lod0.drawCalls);
    // detailed enough to be a hero asset, not a placeholder
    expect(cost.triangles).toBeGreaterThan(DRONE_BUDGET.lod0.triangles * 0.4);
    d.dispose();
  });
  it(`LOD1 stays within ${DRONE_BUDGET.lod1.triangles} triangles and ${DRONE_BUDGET.lod1.drawCalls} draw calls`, () => {
    const d = new DroneModel();
    d.setQuality('low');
    viewFrom(d, 1);
    const cost = drawCost(d.root);
    expect(cost.triangles).toBeLessThanOrEqual(DRONE_BUDGET.lod1.triangles);
    expect(cost.calls).toBeLessThanOrEqual(DRONE_BUDGET.lod1.drawCalls);
    d.dispose();
  });
  it('both LODs share the airframe footprint (same visual size, collision unchanged)', () => {
    const d = new DroneModel();
    const box = (name: string) => {
      const b = new THREE.Box3();
      for (const c of d.root.getObjectByName(name)!.children) if (c.name.startsWith('static:')) b.expandByObject(c, true);
      return b;
    };
    const a = box('drone-lod0');
    const b = box('drone-lod1');
    for (const k of ['x', 'y', 'z'] as const) {
      expect(Math.abs(a.min[k] - b.min[k])).toBeLessThan(0.01);
      expect(Math.abs(a.max[k] - b.max[k])).toBeLessThan(0.01);
    }
    d.dispose();
  });
  it('prop rpm fades the blades as the blur discs take over, and an idle quad draws no blur', () => {
    const d = new DroneModel();
    const state = createDroneState();
    const eye = new THREE.Vector3(0, 0.3, 1);
    state.motors = [0, 0, 0, 0];
    d.update(state, 1 / 60, 0, 25, eye);
    expect(d.root.getObjectByName('drone-blur')!.visible).toBe(false);
    state.motors = [1, 1, 1, 1];
    d.update(state, 1 / 60, 0, 25, eye);
    const blur = d.root.getObjectByName('drone-blur') as THREE.InstancedMesh;
    expect(blur.visible).toBe(true);
    const props = d.root.getObjectByName('drone-props-lod0') as THREE.InstancedMesh;
    const fade = props.geometry.getAttribute('aFade') as THREE.InstancedBufferAttribute;
    expect(fade.getX(0)).toBeLessThan(0.3);
    d.dispose();
  });
});
