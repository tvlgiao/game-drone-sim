import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { VfxDirector } from '../../src/render/vfx/director';
import { VFX_BUDGETS, vfxBudget, vfxCapacity } from '../../src/render/vfx/budget';
import { SparkStreaks } from '../../src/render/vfx/sparks';
import { createDroneState } from '../../src/physics/physics-world';
import type { QualityTier, RingDef } from '../../src/types';

const TIERS: QualityTier[] = ['ultra', 'high', 'medium', 'low'];
const RING: RingDef = { id: 'r', position: [0, 1.5, 0], direction: [0, 0, -1], radius: 0.75, tube: 0.05 };

/** Ids handed out by three's global counters: a fresh object's id − 1 = how many were ever created. */
function idWatermark(): { object3d: number; geometry: number; material: number; texture: number } {
  const g = new THREE.BufferGeometry();
  const m = new THREE.MeshBasicMaterial();
  const t = new THREE.Texture();
  const w = { object3d: new THREE.Object3D().id, geometry: g.id, material: (m as unknown as { id: number }).id, texture: t.id };
  g.dispose();
  m.dispose();
  t.dispose();
  return w;
}

function frame(d: VfxDirector, i: number, drone = createDroneState(), camera = new THREE.PerspectiveCamera()): void {
  d.update({ dt: 1 / 60, time: i / 60, px: 800, drone, camera, fpvWeight: 1, surfaceY: 0, height: drone.position.y, xr: false });
}

describe('vfx budgets', () => {
  it('per-event caps shrink monotonically from ultra to low, and Quest (low) has no speed lines or wash ripples', () => {
    const keys = ['crashSparks', 'impactSparks', 'debris', 'dust', 'ringParticles', 'ringStreaks', 'washRate', 'speedLines'] as const;
    for (const k of keys) {
      const v = TIERS.map((t) => VFX_BUDGETS[t][k]);
      expect(v).toEqual([...v].sort((a, b) => b - a));
    }
    expect(VFX_BUDGETS.low.speedLines).toBe(0);
    expect(VFX_BUDGETS.low.washDecal).toBe(false);
  });

  it('no tier can emit more per event than the pools hold, on any device class', () => {
    for (const form of ['desktop', 'tablet', 'phone'] as const) {
      const cap = vfxCapacity(form);
      for (const t of TIERS) {
        const b = vfxBudget(t, form);
        expect(b.crashSparks + b.impactSparks + b.ringStreaks).toBeLessThanOrEqual(cap.streaks);
        expect(b.debris).toBeLessThanOrEqual(cap.debris);
        expect(b.ringParticles * 1.3 + b.crashSparks * 0.15).toBeLessThanOrEqual(cap.points);
        expect(b.speedLines).toBeLessThanOrEqual(cap.speedLines);
      }
    }
  });

  it('phones halve the per-event counts', () => {
    expect(vfxBudget('high', 'phone').crashSparks).toBe(Math.round(VFX_BUDGETS.high.crashSparks / 2));
    expect(vfxBudget('high', 'tablet')).toBe(VFX_BUDGETS.high);
  });

  for (const tier of TIERS) {
    it(`a crash on '${tier}' emits within its caps`, () => {
      const d = new VfxDirector('desktop', tier);
      const before = d.emitted();
      d.crash(new THREE.Vector3(0, 0.3, 0), 30, 0);
      const after = d.emitted();
      const b = VFX_BUDGETS[tier];
      expect(after.streaks - before.streaks).toBeLessThanOrEqual(b.crashSparks);
      expect(after.streaks - before.streaks).toBeGreaterThan(0);
      expect(after.debris - before.debris).toBeLessThanOrEqual(b.debris);
      expect(after.soft - before.soft).toBeLessThanOrEqual(b.dust + Math.max(1, Math.round(b.dust * 0.4)));
      d.dispose();
    });
  }

  it('a ring pass emits its tier budget of sparkles and streaks', () => {
    const d = new VfxDirector('desktop', 'medium');
    d.ringPass(RING, new THREE.Color(0, 1, 1), new THREE.Vector3(0, 1.5, 0));
    const e = d.emitted();
    expect(e.streaks).toBe(VFX_BUDGETS.medium.ringStreaks);
    expect(e.points).toBe(VFX_BUDGETS.medium.ringParticles + Math.round(VFX_BUDGETS.medium.ringParticles * 0.27));
    d.dispose();
  });

  it('switching tier at runtime (entering VR) changes caps without reallocating pools', () => {
    const d = new VfxDirector('desktop', 'ultra');
    const pools = [d.fx.points.geometry, d.soft.points.geometry, d.sparks.mesh.geometry, d.debris.mesh.geometry];
    d.setQuality('low');
    expect(d.speedLines.mesh.geometry.instanceCount).toBe(0);
    expect(d.wash.enabled).toBe(false);
    expect([d.fx.points.geometry, d.soft.points.geometry, d.sparks.mesh.geometry, d.debris.mesh.geometry]).toEqual(pools);
    d.setQuality('ultra');
    expect(d.speedLines.mesh.geometry.instanceCount).toBe(VFX_BUDGETS.ultra.speedLines);
    d.dispose();
  });
});

describe('vfx pooling', () => {
  it('1000 frames of flying, washing, crashing and ring passes allocate no three.js objects', () => {
    const d = new VfxDirector('desktop', 'ultra');
    const drone = createDroneState();
    drone.armed = true;
    drone.motors = [0.6, 0.6, 0.6, 0.6];
    drone.position.set(0, 0.15, 0);
    drone.velocity.set(0, 0, -20);
    const camera = new THREE.PerspectiveCamera();
    const pos = new THREE.Vector3(0, 0.3, 0);
    const n = new THREE.Vector3(0, 1, 0);
    const color = new THREE.Color(0, 1, 1);
    // warm up (first event of each kind)
    d.crash(pos, 10, 0);
    d.impact(pos, n, 4, 0);
    d.ringPass(RING, color, pos);
    d.respawn(pos, 0);
    frame(d, 0, drone, camera);
    const children = d.group.children.length;
    const ids = idWatermark();
    for (let i = 1; i <= 1000; i++) {
      if (i % 50 === 0) d.crash(pos, 12, 0);
      if (i % 20 === 0) d.impact(pos, n, 4, 0);
      if (i % 30 === 0) d.ringPass(RING, color, pos);
      if (i % 200 === 0) d.respawn(pos, 0);
      frame(d, i, drone, camera);
    }
    const after = idWatermark();
    // the watermark itself creates exactly one of each
    expect(after.object3d - ids.object3d).toBe(1);
    expect(after.geometry - ids.geometry).toBe(1);
    expect(after.material - ids.material).toBe(1);
    expect(after.texture - ids.texture).toBe(1);
    expect(d.group.children.length).toBe(children);
    d.dispose();
  });

  it('spark streaks recycle their ring buffer: live count never exceeds capacity', () => {
    const s = new SparkStreaks(64);
    for (let i = 0; i < 1000; i++) {
      s.emit(0, 1, 0, 1, 1, 0, 1, 0.5, 0.2, 2, 0.002);
      s.update(i / 60);
      expect(s.alive()).toBeLessThanOrEqual(64);
    }
    expect(s.emitted).toBe(1000);
    s.dispose();
  });

  it('prop wash only runs near the ground with the motors up, and water turns dust into spray', () => {
    const d = new VfxDirector('desktop', 'high');
    const drone = createDroneState();
    drone.armed = true;
    drone.motors = [0.6, 0.6, 0.6, 0.6];
    drone.position.set(0, 2, 0);
    for (let i = 0; i < 60; i++) frame(d, i, drone);
    expect(d.emitted().soft).toBe(0);
    expect(d.wash.mesh.visible).toBe(false);
    drone.position.y = 0.15;
    for (let i = 60; i < 120; i++) frame(d, i, drone);
    expect(d.emitted().soft).toBeGreaterThan(0);
    expect(d.wash.mesh.visible).toBe(true);
    const streaks = d.emitted().streaks;
    d.setWaterProbe(() => true);
    for (let i = 120; i < 180; i++) frame(d, i, drone);
    expect(d.emitted().streaks).toBeGreaterThan(streaks);
    d.dispose();
  });

  it('speed lines appear only in FPV at speed and never on the low tier', () => {
    const d = new VfxDirector('desktop', 'ultra');
    const drone = createDroneState();
    drone.position.set(0, 3, 0);
    drone.velocity.set(0, 0, -25);
    const cam = new THREE.PerspectiveCamera();
    cam.updateMatrixWorld();
    for (let i = 0; i < 60; i++) frame(d, i, drone, cam);
    expect(d.speedLines.mesh.visible).toBe(true);
    d.setQuality('low');
    for (let i = 60; i < 180; i++) frame(d, i, drone, cam);
    expect(d.speedLines.mesh.visible).toBe(false);
    d.dispose();
  });
});
