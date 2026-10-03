/**
 * The unified material system: per-level scopes, custom / texture entries, shader patches riding on library
 * presets across a CC0 swap, the terrain hook, and the loft palette built entirely from the library.
 */
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { QUALITY_PROFILES, type QualityProfile } from '../../src/core/quality';
import { LoftMaterials } from '../../src/render/loft/materials';
import { MaterialLibrary, type TextureFetcher } from '../../src/render/materials/library';
import { applyEnvPatch, patchKey } from '../../src/render/materials/patches';
import { NIGHT_LOFT } from '../../src/levels/night-loft';

// the loft's canvas art (decal / neon atlases) needs a DOM: blank stand-ins here
vi.mock('../../src/render/loft/art', () => ({ decalAtlas: () => new THREE.Texture(), neonAtlas: () => new THREE.Texture(), DECAL: {}, decalRect: () => [0, 0, 1, 1] }));
vi.mock('../../src/render/textures', async (orig) => ({ ...(await orig<typeof import('../../src/render/textures')>()), radialTexture: () => new THREE.Texture() }));

const small: QualityProfile = { ...QUALITY_PROFILES.high, textureSize: 32 };
const noScans: QualityProfile = { ...small, pbrTextures: false };
const blank: TextureFetcher = () => Promise.resolve(new THREE.Texture());

/** Compiles the patched program text the way three would (onBeforeCompile on the stock shader). */
function compiled(mat: THREE.MeshStandardMaterial): { vertex: string; fragment: string } {
  const lib = THREE.ShaderLib.physical;
  const shader = { uniforms: THREE.UniformsUtils.clone(lib.uniforms), vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader } as THREE.WebGLProgramParametersWithUniforms;
  mat.onBeforeCompile(shader, undefined as unknown as THREE.WebGLRenderer);
  return { vertex: shader.vertexShader, fragment: shader.fragmentShader };
}

function watchDispose(...objs: { addEventListener(t: 'dispose', f: () => void): void }[]): Set<unknown> {
  const gone = new Set<unknown>();
  for (const o of objs) o.addEventListener('dispose', () => gone.add(o));
  return gone;
}

describe('material scopes', () => {
  it('a scope frees what only it holds and keeps what another owner shares', () => {
    const lib = new MaterialLibrary(noScans);
    const a = lib.scope('night-loft');
    const b = lib.scope('training');
    const own = a.material('brick', { uvMeters: 1.2 });
    const shared = a.material('asphalt', { uvMeters: 1 });
    expect(b.material('asphalt', { uvMeters: 1 })).toBe(shared);
    const custom = a.custom('loft:test', (track) => new THREE.MeshBasicMaterial({ map: track(new THREE.Texture()) }));
    const tex = a.texture('loft:macro', () => new THREE.Texture());
    const gone = watchDispose(own, shared, custom, custom.map!, tex);
    a.dispose();
    expect(gone.has(own)).toBe(true);
    expect(gone.has(custom)).toBe(true);
    expect(gone.has(custom.map)).toBe(true);
    expect(gone.has(tex)).toBe(true);
    expect(gone.has(shared)).toBe(false);
    // asking again after the release builds a fresh material
    expect(lib.material('brick', { uvMeters: 1.2 })).not.toBe(own);
    b.dispose();
    lib.dispose();
  });

  it('a released scope leaves no materials behind; the library itself still owns its own', () => {
    const lib = new MaterialLibrary(noScans);
    const root = lib.material('rubber');
    const s = lib.scope('x');
    s.material('plaster');
    s.terrain();
    expect(lib.stats().materials).toBe(3);
    s.dispose();
    expect(lib.stats().materials).toBe(1);
    expect(lib.material('rubber')).toBe(root);
    lib.dispose();
  });
});

describe('patches on library presets', () => {
  it('a patch is part of the cache key by identity and survives the CC0 swap', async () => {
    const lib = new MaterialLibrary(small, { fetcher: blank });
    const grime = { texture: new THREE.Texture(), scale: 0.2, low: 0.7, top: 6 };
    const patch = { grime };
    const wall = lib.material('brick', { uvMeters: 1.2, patch });
    expect(lib.material('brick', { uvMeters: 1.2, patch })).toBe(wall);
    expect(lib.material('brick', { uvMeters: 1.2, patch: { grime } })).not.toBe(wall);
    expect(lib.material('brick', { uvMeters: 1.2 })).not.toBe(wall);
    const before = wall.map;
    await lib.preload('night-loft');
    expect(wall.map).not.toBe(before);
    expect(wall.defines?.ENV_GRIME).toBe('');
    expect(compiled(wall).fragment).toContain('uGrimeTop');
    lib.dispose();
  });

  it('albedo: the map becomes a detail layer under an authored mean colour', () => {
    const lib = new MaterialLibrary(noScans);
    const floor = lib.material('slab', { albedo: 0x67635e });
    expect(floor.color.getHex()).toBe(new THREE.Color(0x67635e).getHex());
    expect(floor.defines?.ENV_DETAIL).toBe('');
    expect(compiled(floor).fragment).toContain('sampledDiffuseColor.rgb / max( texture2D( map, vec2( 0.5 ), 16.0 ).rgb');
    lib.dispose();
  });

  it('paintedBrick is the brick set under a paint coat; polygonOffset and vertexColors are options', () => {
    const lib = new MaterialLibrary(noScans);
    const painted = lib.material('paintedBrick');
    expect(painted.map!.source).toBe(lib.textures('brick').albedo.source);
    expect(painted.defines?.ENV_PAINT).toBe('');
    const decal = lib.material('gravel', { polygonOffset: -2, vertexColors: true });
    expect(decal.polygonOffset).toBe(true);
    expect(decal.polygonOffsetFactor).toBe(-2);
    expect(decal.vertexColors).toBe(true);
    lib.dispose();
  });

  it('program keys follow the feature set, not the uniform values', () => {
    const t = new THREE.Texture();
    expect(patchKey({ grime: { texture: t, scale: 1, low: 1, top: 1 } })).toBe(patchKey({ grime: { texture: t, scale: 2, low: 3, top: 4 } }));
    expect(patchKey({ detail: true })).not.toBe(patchKey({ detail: true, stripes: { half: 1, width: 1, strength: 1 } }));
    const wind = { uTime: { value: 0 }, uWind: { value: new THREE.Vector2(1, 0) } };
    const m = applyEnvPatch(new THREE.MeshStandardMaterial(), { wind: { uniforms: wind, flutter: true } });
    const src = compiled(m);
    expect(src.vertex).toContain('attribute float aSway');
    expect(src.vertex).toContain('ENV_FLUTTER');
    expect(m.customProgramCacheKey()).toBe('envwf');
  });
});

describe('terrain hook', () => {
  it('blends triplanar rock and wet banks on the named attributes over the base preset', () => {
    const lib = new MaterialLibrary(noScans);
    const t = lib.terrain({ rockAttribute: 'aRock', wetAttribute: 'aBankWet', slopeRock: 0.6, rockMeters: 4 });
    expect(t.name).toBe('lib:terrain');
    expect(t.vertexColors).toBe(true);
    expect(t.defines?.ENV_ROCK_ATTR).toBe('aRock');
    expect(t.defines?.ENV_WET_ATTR).toBe('aBankWet');
    const src = compiled(t);
    // the attribute names reach GLSL through the defines (the preprocessor renames the declarations)
    expect(src.vertex).toContain('attribute float ENV_ROCK_ATTR');
    expect(src.vertex).toContain('attribute float ENV_WET_ATTR');
    expect(src.fragment).toContain('envTriplanar( uRockMap');
    const u = t.userData.envUniforms as Record<string, THREE.IUniform>;
    expect(u.uRockScale!.value).toBeCloseTo(0.25);
    expect(u.uSlopeRock!.value).toBe(0.6);
    expect(u.uRockMap!.value).toBe(lib.textures('rock').albedo);
    // same options, same material; no attributes → no attribute declarations
    expect(lib.terrain({ rockAttribute: 'aRock', wetAttribute: 'aBankWet', slopeRock: 0.6, rockMeters: 4 })).toBe(t);
    const dry = lib.terrain({ rockAttribute: null, wetAttribute: null });
    expect(dry.defines?.ENV_ROCK_ATTR).toBeUndefined();
    expect(dry.defines?.ENV_WET_ATTR).toBeUndefined();
    lib.dispose();
  });
});

describe('loft palette', () => {
  it('every lit loft surface comes from the library; scanned presets carry their loft patches', () => {
    const lib = new MaterialLibrary(noScans);
    const scope = lib.scope('night-loft');
    const mats = new LoftMaterials(scope, { anisotropy: 4, maxTexture: 64, room: NIGHT_LOFT.room.size, puddles: [] });
    expect(mats.floor.name).toBe('lib:slab');
    expect(mats.brick.name).toBe('lib:brick');
    expect(mats.paintedBrick.name).toBe('lib:paintedBrick');
    expect(mats.plaster.name).toBe('lib:plaster');
    expect(mats.concrete.name).toBe('lib:concrete');
    expect(mats.wood.name).toBe('lib:wood');
    expect(mats.floor.defines).toMatchObject({ ENV_BOX: '', ENV_MACRO: '', ENV_DETAIL: '' });
    expect(mats.brick.defines).toMatchObject({ ENV_GRIME: '' });
    expect(mats.glass.defines).toMatchObject({ ENV_BOX: '', ENV_GLASS: '' });
    const names = lib.materialNames();
    for (const k of ['loft:props', 'loft:leather', 'loft:decals', 'loft:neon']) expect(names).toContain(k);
    const before = lib.stats().materials;
    scope.dispose();
    expect(before).toBeGreaterThan(10);
    expect(lib.stats().materials).toBe(0);
    lib.dispose();
  });
});
