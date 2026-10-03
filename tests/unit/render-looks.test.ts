import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { LEVELS, buildLevel } from '../../src/levels/registry';
import { GradeEffect, NEUTRAL_GRADE } from '../../src/render/effects/grade';
import { levelLook } from '../../src/render/looks';
import { DEFAULT_SKY_LOOK, physicalSkyShader } from '../../src/render/outdoor/sky';
import { findSun } from '../../src/render/shadows';

describe('level looks', () => {
  it('every playable level has a look with sane exposure, grade and bloom', () => {
    for (const entry of LEVELS) {
      const look = levelLook(buildLevel(entry.id).def);
      expect(['agx', 'aces', 'neutral']).toContain(look.toneMapping);
      expect(look.exposure).toBeGreaterThan(0.5);
      expect(look.exposure).toBeLessThan(2.5);
      // grades stay subtle: no channel lifted or gained more than a few percent
      for (const v of look.grade.lift) expect(Math.abs(v)).toBeLessThan(0.05);
      for (const v of look.grade.gain) expect(Math.abs(v - 1)).toBeLessThan(0.1);
      for (const v of look.grade.gamma) expect(Math.abs(v - 1)).toBeLessThan(0.1);
      expect(look.grade.saturation).toBeGreaterThan(0.8);
      expect(look.grade.saturation).toBeLessThan(1.3);
      expect(look.bloom.threshold).toBeGreaterThan(0.5);
      expect(look.grain).toBeLessThan(0.08);
      expect(look.vignette.darkness).toBeLessThan(0.7);
    }
  });

  it('rooms get no height fog; the outdoor look hazes the distance without fogging out the course', () => {
    expect(levelLook({ id: 'night-loft', kind: 'indoor' }).aerial).toBeNull();
    const day = levelLook({ id: 'training', kind: 'outdoor' }).aerial!;
    // optical depth along 80 m of ground-level view: visible haze, far from opaque
    const t = 1 - Math.exp(-day.density * 80);
    expect(t).toBeGreaterThan(0.05);
    expect(t).toBeLessThan(0.4);
    expect(day.maxOpacity).toBeLessThan(0.8);
  });

  it('unknown levels fall back by kind', () => {
    expect(levelLook({ id: 'city', kind: 'outdoor' })).toBe(levelLook({ id: 'training', kind: 'outdoor' }));
    expect(levelLook({ id: 'tutorial', kind: 'indoor' })).toBe(levelLook({ id: 'night-loft', kind: 'indoor' }));
  });

  it('grade effect maps the grade onto its uniforms and never divides by a zero gamma', () => {
    const g = new GradeEffect({ ...NEUTRAL_GRADE, lift: [0.01, 0.02, 0.03], gamma: [0, 1, 1.1], contrast: 1.2 });
    expect((g.uniforms.get('gradeLift')!.value as THREE.Vector3).toArray()).toEqual([0.01, 0.02, 0.03]);
    expect((g.uniforms.get('gradeGamma')!.value as THREE.Vector3).x).toBeGreaterThan(0);
    expect(g.uniforms.get('gradeContrast')!.value).toBe(1.2);
    g.dispose();
  });
});

describe('physical sky', () => {
  it('patches three’s Preetham shader (scale, sun cap, ground) and keeps its uniforms', () => {
    const s = physicalSkyShader();
    expect(s.fragmentShader).toContain('texColor * skyScale');
    expect(s.fragmentShader).toContain('skyGround');
    for (const u of ['turbidity', 'rayleigh', 'sunPosition', 'cloudCoverage', 'skyScale', 'sunDiscMax', 'skyGround']) expect(s.uniforms[u], u).toBeDefined();
    expect(DEFAULT_SKY_LOOK.turbidity).toBeGreaterThan(1);
  });
});

describe('sun lookup for cascades', () => {
  it('prefers a light named "sun", else the first directional light', () => {
    const g = new THREE.Group();
    const a = new THREE.DirectionalLight();
    const b = new THREE.DirectionalLight();
    g.add(new THREE.PointLight(), a, b);
    expect(findSun(g)).toBe(a);
    b.name = 'sun';
    expect(findSun(g)).toBe(b);
    expect(findSun(new THREE.Group())).toBeNull();
  });
});
