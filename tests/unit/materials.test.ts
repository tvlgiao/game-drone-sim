import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { QUALITY_PROFILES, type QualityProfile } from '../../src/core/quality';
import { CC0_SETS, LEVEL_TEXTURE_SETS, cc0Url, type Cc0SetId } from '../../src/render/materials/assets';
import { MaterialLibrary, PRESET_NAMES, type TextureFetcher } from '../../src/render/materials/library';
import { generatePbr, PROCEDURAL_KINDS, type PixelMap } from '../../src/render/materials/procedural';

const small: QualityProfile = { ...QUALITY_PROFILES.high, textureSize: 32 };
const noScans: QualityProfile = { ...small, pbrTextures: false };

/** mean absolute RGB step between two texel columns / rows */
function step(px: PixelMap, a: [number, number], b: [number, number]): number {
  const o1 = (a[1] * px.width + a[0]) * 4;
  const o2 = (b[1] * px.width + b[0]) * 4;
  return (Math.abs(px.data[o1]! - px.data[o2]!) + Math.abs(px.data[o1 + 1]! - px.data[o2 + 1]!) + Math.abs(px.data[o1 + 2]! - px.data[o2 + 2]!)) / 3;
}

function seamRatio(px: PixelMap): number {
  const n = px.width;
  let seam = 0;
  let inner = 0;
  for (let y = 0; y < n; y++) {
    seam += step(px, [n - 1, y], [0, y]);
    inner += step(px, [n / 2 - 1, y], [n / 2, y]);
  }
  for (let x = 0; x < n; x++) {
    seam += step(px, [x, n - 1], [x, 0]);
    inner += step(px, [x, n / 2 - 1], [x, n / 2]);
  }
  return seam / Math.max(1, inner);
}

/** fetcher that hands out blank textures and records what it was asked for */
function fakeFetcher(): { fetch: TextureFetcher; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetch: (url) => {
      urls.push(url);
      return Promise.resolve(new THREE.Texture());
    },
  };
}

describe('procedural texture sets', () => {
  it.each(PROCEDURAL_KINDS)('%s: deterministic, seamless, unit normals', (kind) => {
    const a = generatePbr(kind, 64);
    const b = generatePbr(kind, 64);
    expect(a.albedo.data).toEqual(b.albedo.data);
    for (const m of [a.albedo, a.normal, a.arm]) {
      expect(m.width).toBe(64);
      expect(m.data.length).toBe(64 * 64 * 4);
    }
    // wrapping edge no harsher than an interior seam: tiles without a visible line
    expect(seamRatio(a.albedo)).toBeLessThan(2.5);
    for (let i = 0; i < 64 * 64; i += 97) {
      const x = a.normal.data[i * 4]! / 127.5 - 1;
      const y = a.normal.data[i * 4 + 1]! / 127.5 - 1;
      const z = a.normal.data[i * 4 + 2]! / 127.5 - 1;
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 1);
      expect(z).toBeGreaterThan(0);
    }
  });

  it('foliage carries an alpha cut-out; opaque sets are fully opaque', () => {
    const leaf = generatePbr('foliage', 64).albedo.data;
    let clear = 0;
    let solid = 0;
    for (let i = 3; i < leaf.length; i += 4) {
      if (leaf[i] === 0) clear++;
      if (leaf[i] === 255) solid++;
    }
    expect(clear).toBeGreaterThan(200);
    expect(solid).toBeGreaterThan(200);
    const brick = generatePbr('brick', 32).albedo.data;
    for (let i = 3; i < brick.length; i += 4) expect(brick[i]).toBe(255);
  });

  it('metals carry metalness in the ARM blue channel, dielectrics none', () => {
    const blue = (k: 'brushedMetal' | 'concrete') => {
      const d = generatePbr(k, 32).arm.data;
      let s = 0;
      for (let i = 2; i < d.length; i += 4) s += d[i]!;
      return s / (d.length / 4) / 255;
    };
    expect(blue('brushedMetal')).toBeCloseTo(1, 2);
    expect(blue('concrete')).toBe(0);
  });
});

describe('material library', () => {
  it('caches by preset + options: the same request returns the same material', () => {
    const lib = new MaterialLibrary(noScans);
    const a = lib.material('concrete', { uvMeters: 1 });
    expect(lib.material('concrete', { uvMeters: 1 })).toBe(a);
    expect(lib.material('concrete', { uvMeters: 2 })).not.toBe(a);
    expect(lib.material('concrete')).not.toBe(a);
    lib.dispose();
  });

  it('never uploads a texture set twice: every repeat of a preset shares one GPU source per map', () => {
    const lib = new MaterialLibrary(noScans);
    for (const r of [1, 2, 3.5, 8]) lib.material('brick', { repeat: r });
    lib.material('brick', { uvMeters: 4, color: 0xff0000 });
    const s = lib.stats();
    expect(s.materials).toBe(5);
    expect(s.uploads).toBe(3); // albedo, normal, ARM
    expect(s.textures).toBeGreaterThan(s.uploads); // repeat clones, same source
    const m = lib.material('brick', { repeat: 2 });
    expect(m.map!.source).toBe(lib.textures('brick').albedo.source);
    expect(m.map!.repeat.x).toBe(2);
    expect(m.roughnessMap).toBe(m.aoMap); // packed ARM
    lib.dispose();
  });

  it('every preset builds on every tier, glass included', () => {
    for (const tier of ['low', 'medium', 'high', 'ultra'] as const) {
      const lib = new MaterialLibrary({ ...QUALITY_PROFILES[tier], textureSize: 16, pbrTextures: false });
      for (const name of PRESET_NAMES) {
        const m = lib.material(name);
        expect(m).toBeInstanceOf(THREE.MeshStandardMaterial);
        if (name !== 'glass') expect(m.map, name).not.toBeNull();
      }
      lib.dispose();
    }
  });

  it('glass: transmission + IOR on high tiers, a reflective coat on low, switched in place', () => {
    const lib = new MaterialLibrary(small);
    const glass = lib.material('glass') as THREE.MeshPhysicalMaterial;
    expect(glass.transmission).toBe(1);
    expect(glass.ior).toBeCloseTo(1.5);
    expect(glass.thickness).toBeGreaterThan(0);
    expect(glass.transparent).toBe(false);
    lib.setProfile({ ...small, glass: 'reflective' });
    expect(lib.material('glass')).toBe(glass);
    expect(glass.transmission).toBe(0);
    expect(glass.transparent).toBe(true);
    expect(glass.opacity).toBeLessThan(0.3);
    lib.dispose();
  });

  it('upgrades to the scanned CC0 set in place, at the set’s real-world scale, and frees the stand-in', async () => {
    const f = fakeFetcher();
    const lib = new MaterialLibrary(small, { fetcher: f.fetch });
    const floor = lib.material('concrete', { uvMeters: 6 });
    const procedural = floor.map;
    await lib.preload('night-loft');
    expect(f.urls).toHaveLength(LEVEL_TEXTURE_SETS['night-loft']!.length * 3);
    expect(floor.map).not.toBe(procedural);
    expect(floor.map!.repeat.x).toBeCloseTo(6 / CC0_SETS.concrete.tileMeters);
    expect(floor.map!.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(floor.normalMap!.colorSpace).toBe(THREE.NoColorSpace);
    // a second request (or a second preload) does not fetch again
    await lib.preload('night-loft');
    expect(f.urls).toHaveLength(LEVEL_TEXTURE_SETS['night-loft']!.length * 3);
    // concrete's procedural maps are gone from the upload count; only scanned sets remain
    expect(lib.stats().uploads).toBe(LEVEL_TEXTURE_SETS['night-loft']!.length * 3);
    lib.dispose();
  });

  it('a failed download keeps the procedural maps and retries on the next preload', async () => {
    let fail = true;
    const lib = new MaterialLibrary(small, { fetcher: () => (fail ? Promise.reject(new Error('offline')) : Promise.resolve(new THREE.Texture())) });
    const grass = lib.material('grass');
    const before = grass.map;
    await lib.preload('training');
    expect(grass.map).toBe(before);
    fail = false;
    await lib.preload('training');
    expect(grass.map).not.toBe(before);
    lib.dispose();
  });

  it('tiers without pbrTextures fetch nothing', async () => {
    const f = fakeFetcher();
    const lib = new MaterialLibrary(noScans, { fetcher: f.fetch });
    lib.material('grass');
    await lib.preload('training');
    expect(f.urls).toEqual([]);
    lib.dispose();
  });

  it('dispose releases every material and texture it created', () => {
    const lib = new MaterialLibrary(noScans);
    const disposed = new Set<unknown>();
    const mats = PRESET_NAMES.map((n) => lib.material(n, { repeat: 2 }));
    const texs = new Set<THREE.Texture>();
    for (const m of mats) for (const t of [m.map, m.normalMap, m.roughnessMap]) if (t) texs.add(t);
    for (const o of [...mats, ...texs]) o.addEventListener('dispose', () => disposed.add(o));
    lib.dispose();
    for (const o of [...mats, ...texs]) expect(disposed.has(o)).toBe(true);
  });

  it('every CC0 set resolves to built URLs for all three maps', () => {
    for (const id of Object.keys(CC0_SETS) as Cc0SetId[]) {
      for (const map of ['albedo', 'normal', 'arm'] as const) expect(cc0Url(id, map), `${id}/${map}`).toMatch(/\.webp/);
    }
  });
});
