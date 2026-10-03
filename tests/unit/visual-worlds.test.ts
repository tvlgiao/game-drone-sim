/**
 * Generated worlds on the visual pipeline: the library terrain the chunks draw with (rock / wet / soil / snow /
 * world UVs, scans swapped into its layers), chunk surface attributes and shore foam, the water material, time of
 * day (skies, looks, haze colour), view distance, the water probe and the wind volume.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { QUALITY_PROFILES, type QualityProfile } from '../../src/core/quality';
import { worldField } from '../../src/levels/runtime';
import { levelTime, outdoorEnv, SKIES } from '../../src/levels/skies';
import { levelLook } from '../../src/render/looks';
import { MaterialLibrary, type TextureFetcher } from '../../src/render/materials/library';
import { OUTDOOR_PROFILES, scaledProfile, VIEW_DISTANCE_SCALE } from '../../src/render/outdoor/outdoor-profile';
import { addSurfaceAttributes, fillChunkGeometry, shoreFoam } from '../../src/render/outdoor/terrain-view';
import { rippleTexture, setWaterSky, waterMaterial } from '../../src/render/outdoor/water';
import { waterSurface } from '../../src/render/vfx/director';
import { CHUNK_SIZE, type ChunkData } from '../../src/world/chunk-gen';
import { SURFACE_STRIDE } from '../../src/world/chunk-gen-v2';
import { GameAudio } from '../../src/audio/audio';
import { cityRuntime } from '../../src/levels/city';
import { createRuntime } from '../../src/levels/runtime';
import { TRAINING_LEVEL } from '../../src/levels/training';

const small: QualityProfile = { ...QUALITY_PROFILES.high, textureSize: 32 };
const noScans: QualityProfile = { ...small, pbrTextures: false };

function compiled(mat: THREE.MeshStandardMaterial): { vertex: string; fragment: string } {
  const lib = THREE.ShaderLib.physical;
  const shader = { uniforms: THREE.UniformsUtils.clone(lib.uniforms), vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader } as THREE.WebGLProgramParametersWithUniforms;
  mat.onBeforeCompile(shader, undefined as unknown as THREE.WebGLRenderer);
  return { vertex: shader.vertexShader, fragment: shader.fragmentShader };
}

const WORLD_TERRAIN = { base: 'grass', rockAttribute: 'aRock', wetAttribute: 'aWet', slopeRock: 0.16, rockMeters: 11, rockMacroMeters: 61, rockTint: 0x6c6c6a, soil: true, srgbColors: true, snow: true, worldUv: true } as const;

describe('world terrain material', () => {
  it('compiles every world layer: tinted two-scale rock with bump, soil, snow, sRGB vertex colours, world UVs', () => {
    const lib = new MaterialLibrary(noScans);
    const t = lib.terrain(WORLD_TERRAIN);
    const d = t.defines!;
    for (const k of ['ENV_ROCK_TINT', 'ENV_ROCK_MACRO', 'ENV_SOIL', 'ENV_SRGB_COLOR', 'ENV_SNOW', 'ENV_WORLD_UV']) expect(d[k], k).toBe('');
    const src = compiled(t);
    expect(src.vertex).toContain('vColor.rgb = pow( vColor.rgb, vec3( 2.2 ) )');
    expect(src.vertex).toContain('vMapUv = ( mapTransform * vec3( vEnvWorld.xz, 1.0 ) ).xy');
    expect(src.fragment).toContain('envTriplanar( uRockMap, vEnvWorld * uRockMacro, tn )');
    expect(src.fragment).toContain('envBump( -vViewPosition, normal');
    expect(src.fragment).toContain('texture2D( uSoilMap');
    const u = t.userData.envUniforms as Record<string, THREE.IUniform>;
    expect(u.uRockScale!.value).toBeCloseTo(1 / 11);
    expect(u.uRockMacro!.value).toBeCloseTo(1 / 61);
    expect((u.uRockTint!.value as THREE.Color).getHex()).toBe(new THREE.Color(0x6c6c6a).getHex());
    // the soil stand-in is the procedural gravel until the scan arrives
    expect(u.uSoilMap!.value).toBe(lib.textures('gravel').albedo);
    // each feature changes the program key, so a plain terrain keeps its own program
    expect(t.customProgramCacheKey()).not.toBe(lib.terrain({ rockAttribute: 'aRock', wetAttribute: 'aWet' }).customProgramCacheKey());
    lib.dispose();
  });

  it('rock and soil scans swap into the terrain layers when they arrive (tiers with CC0 sets)', async () => {
    const loaded: string[] = [];
    const fetcher: TextureFetcher = (url) => {
      loaded.push(url);
      return Promise.resolve(new THREE.Texture());
    };
    const lib = new MaterialLibrary(small, { fetcher });
    const t = lib.terrain(WORLD_TERRAIN);
    const u = t.userData.envUniforms as Record<string, THREE.IUniform>;
    const procRock = u.uRockMap!.value;
    await lib.preload('alpine');
    await new Promise((r) => setTimeout(r, 0));
    expect(loaded.some((x) => x.includes('aerial_rocks_02'))).toBe(true);
    expect(loaded.some((x) => x.includes('forest_ground_04'))).toBe(true);
    expect(u.uRockMap!.value).not.toBe(procRock);
    expect(u.uSoilScale!.value).toBeCloseTo(1 / 3.15);
    lib.dispose();
  });

  it('watchSet hands out the procedural maps now and the scan later; a released scope stops listening', async () => {
    let resolve!: () => void;
    const gate = new Promise<void>((r) => (resolve = r));
    const fetcher: TextureFetcher = () => gate.then(() => new THREE.Texture());
    const lib = new MaterialLibrary(small, { fetcher });
    const a = lib.scope('city');
    const b = lib.scope('other');
    const seenA: number[] = [];
    const seenB: number[] = [];
    a.watchSet('brick', (_s, tile) => seenA.push(tile));
    b.watchSet('brick', (_s, tile) => seenB.push(tile));
    expect(seenA).toHaveLength(1);
    b.dispose();
    resolve();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(seenA).toEqual([seenA[0], 1.4]);
    expect(seenB).toHaveLength(1);
    a.dispose();
    lib.dispose();
  });
});

function chunk(heights: number[], surface: Uint8Array): ChunkData {
  const side = Math.sqrt(heights.length);
  const positions = new Float32Array(heights.length * 3);
  const step = CHUNK_SIZE / (side - 1);
  heights.forEach((h, v) => {
    positions[v * 3] = (v % side) * step;
    positions[v * 3 + 1] = h;
    positions[v * 3 + 2] = Math.floor(v / side) * step;
  });
  return { gridSize: side, positions, normals: new Int8Array(heights.length * 3), colors: new Uint8Array(heights.length * 3), surface, minY: 0, maxY: 10 } as unknown as ChunkData;
}

describe('chunk surface and shore', () => {
  it('surface weights reach the geometry as normalised aRock / aWet bytes; v1 chunks read 0', () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(4 * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Int8Array(4 * 3), 3, true));
    g.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(4 * 3), 3, true));
    addSurfaceAttributes(g, 4);
    fillChunkGeometry(g, chunk([0, 0, 0, 0], Uint8Array.from([255, 0, 128, 64, 0, 255, 10, 20])));
    const rock = g.getAttribute('aRock') as THREE.InterleavedBufferAttribute;
    const wet = g.getAttribute('aWet') as THREE.InterleavedBufferAttribute;
    expect(rock.normalized && wet.normalized).toBe(true);
    expect([rock.getX(0), rock.getX(1), rock.getX(2)]).toEqual([1, 128 / 255, 0]);
    expect(wet.getX(2)).toBe(1);
    expect(rock.data.stride).toBe(SURFACE_STRIDE);
    fillChunkGeometry(g, chunk([0, 0, 0, 0], new Uint8Array(0)));
    expect(rock.getX(0)).toBe(0);
  });

  it('shore foam: full where the bank rises over the water, fading out by ~1 m of depth', () => {
    const d = chunk([0, 0, 5, 5], new Uint8Array(0));
    expect(shoreFoam(d, 0, 4, CHUNK_SIZE)).toBe(1);
    expect(shoreFoam(d, 0, 0.55, 0)).toBeCloseTo(0.5);
    expect(shoreFoam(d, 0, 3, 0)).toBe(0);
  });
});

describe('water', () => {
  it('a lit standard material: ripples on the normal, foam on aShore, sky fallback without an env map', () => {
    const m = waterMaterial(SKIES.afternoon, rippleTexture(16), true);
    expect(m).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(m.roughness).toBeLessThan(0.1);
    const src = compiled(m);
    expect(src.vertex).toContain('vShore = aShore');
    expect(src.fragment).toContain('waterFoam');
    expect(src.fragment).toContain('!defined( USE_ENVMAP )');
    const top = (m.userData.water.uSkyTop.value as THREE.Color).clone();
    setWaterSky(m, SKIES.dusk);
    expect((m.userData.water.uSkyTop.value as THREE.Color).equals(top)).toBe(false);
  });

  it('the wash reads the water surface over a river, the ground elsewhere', () => {
    expect(waterSurface(null, 0, 0, 2)).toBeNull();
    expect(waterSurface(() => true, 0, 0, 2)).toBe(2);
    expect(waterSurface(() => -Infinity, 0, 0, 2)).toBeNull();
    expect(waterSurface(() => 4.5, 0, 0, 2)).toBe(4.5);
    expect(waterSurface(() => 1, 0, 0, 2)).toBe(2);
  });

  it('generated levels expose their field (water, biomes); authored ones do not', () => {
    const city = cityRuntime();
    const f = worldField(city);
    expect(f?.preset).toBe('city');
    expect(worldField(createRuntime(TRAINING_LEVEL))).toBeNull();
  });
});

describe('time of day and view distance', () => {
  it('Auto keeps the level’s own time; a pick replaces it (Alpine golden stays the thin-air preset)', () => {
    const alpine = outdoorEnv('alpine', 5000);
    expect(levelTime(alpine, 'auto')).toBe('alpine');
    expect(levelTime(alpine, 'golden')).toBe('alpine');
    expect(levelTime(alpine, 'dusk')).toBe('dusk');
    expect(levelTime(outdoorEnv('dusk', 2400), 'auto')).toBe('dusk');
    expect(levelTime({}, 'auto')).toBe('afternoon');
  });

  it('each time of day has its own look; the haze matches the fog colour', () => {
    const def = { id: 'alpine' as const, kind: 'outdoor' as const };
    const golden = levelLook(def, 'alpine');
    const dusk = levelLook(def, 'dusk');
    expect(golden).not.toBe(dusk);
    expect(dusk.aerial!.color).toBe(SKIES.dusk.haze);
    expect(levelLook(def, 'afternoon').aerial!.color).toBe(SKIES.afternoon.horizon);
    expect(outdoorEnv('dusk', 100).fog.color).toBe(SKIES.dusk.haze);
    // authored levels keep their looks whatever the setting
    expect(levelLook({ id: 'training', kind: 'outdoor' }, 'dusk')).toBe(levelLook({ id: 'training', kind: 'outdoor' }));
  });

  it('View distance scales fog and the far backdrop; Long never grows the streamed radius', () => {
    const p = OUTDOOR_PROFILES.high;
    const long = scaledProfile(p, VIEW_DISTANCE_SCALE.long);
    expect(long.fog).toBeCloseTo(p.fog * 1.3);
    expect(long.farRadius).toBe(Math.round(p.farRadius * 1.3));
    expect(long.stream.radius).toBe(p.stream.radius);
    expect(scaledProfile(p, VIEW_DISTANCE_SCALE.short).stream.radius).toBeLessThan(p.stream.radius);
    expect(scaledProfile(OUTDOOR_PROFILES.low, 1.3).farRadius).toBe(0);
  });
});

describe('wind volume', () => {
  it('scales the wind voice; motors and the master volume are untouched', () => {
    const a = new GameAudio();
    a.setAmbience('wind', 0.6);
    const full = a.windLevel(10, 3);
    a.setWindVolume(0.25);
    expect(a.windLevel(10, 3)).toBeCloseTo(full * 0.25);
    a.setWindVolume(0);
    expect(a.windLevel(30, 3)).toBe(0);
  });
});
