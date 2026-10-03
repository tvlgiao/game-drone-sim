/**
 * Materials for generated terrain beside the library's terrain ground (materials/library.ts `terrain()`): the
 * procedural detail texture (City facades, roads), road ribbons with painted lines, and the shared instancing
 * transform used by trees, rocks, houses and bridges. Textures are DataTextures (no canvas), so the
 * module also builds in Node tests.
 */
import * as THREE from 'three';
import { fbmField } from '../textures';

/**
 * RGBA detail: R fine grain (grass / soil), G stretched strata (rock faces), B medium blotches, A macro
 * variation. Tileable, mipmapped, values around 0.5.
 */
export function terrainDetailTexture(size = 256, anisotropy = 4): THREE.DataTexture {
  const fine = fbmField(size, 32, 3, 101, 0.55);
  const strata = fbmField(size, 8, 4, 202, 0.5);
  const mid = fbmField(size, 8, 4, 303, 0.6);
  const macro = fbmField(size, 4, 3, 404, 0.5);
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      // strata: the same noise squashed vertically reads as layered rock
      const sy = (Math.floor(y / 4) * 4) % size;
      const s = strata[sy * size + x]! * 0.6 + strata[i]! * 0.4;
      data[i * 4] = Math.round(fine[i]! * 255);
      data[i * 4 + 1] = Math.round(s * 255);
      data[i * 4 + 2] = Math.round(mid[i]! * 255);
      data[i * 4 + 3] = Math.round(macro[i]! * 255);
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = anisotropy;
  t.needsUpdate = true;
  return t;
}

/** sRGB-authored vertex colours (the world engine's palette) to linear, before lighting. */
const COLOR_VERTEX_SRGB = /* glsl */ `
#include <color_vertex>
#if defined( USE_COLOR )
  vColor.rgb = pow( vColor.rgb, vec3( 2.2 ) );
#endif`;

const ROAD_VARYINGS = /* glsl */ `
varying vec2 vRoad;
varying vec3 vRoadPos;`;

/**
 * Road ribbons: asphalt grain, a crisp dashed centre line and solid edge lines from the per-vertex `aRoad`
 * (across −1..1, dash 0/1), gravel shoulders at the very edge.
 */
export function roadMaterial(detail: THREE.Texture): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.82, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, envMapIntensity: 0.5 });
  m.name = 'road';
  m.onBeforeCompile = (s) => {
    s.uniforms.uDetail = { value: detail };
    s.vertexShader = s.vertexShader
      .replace('#include <common>', `#include <common>\nattribute vec2 aRoad;\n${ROAD_VARYINGS}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n  vRoad = aRoad;\n  vRoadPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;`);
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform sampler2D uDetail;\n${ROAD_VARYINGS}`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
  float a = abs( vRoad.x );
  float grain = texture2D( uDetail, vRoadPos.xz * 0.5 ).r;
  vec3 asphalt = vec3( 0.052, 0.054, 0.058 ) * ( 0.8 + 0.4 * grain );
  float aa = fwidth( vRoad.x ) * 1.5;
  float centre = ( 1.0 - smoothstep( 0.035 - aa, 0.035 + aa, a ) ) * step( 0.5, vRoad.y );
  float edge = smoothstep( 0.83 - aa, 0.83 + aa, a ) * ( 1.0 - smoothstep( 0.88 - aa, 0.88 + aa, a ) );
  vec3 paint = vec3( 0.78, 0.76, 0.68 );
  vec3 shoulder = vec3( 0.2, 0.18, 0.14 ) * ( 0.7 + 0.6 * grain );
  vec3 col = mix( asphalt, paint, max( centre, edge ) );
  col = mix( col, shoulder, smoothstep( 0.92, 0.99, a ) );
  diffuseColor.rgb = col;`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = mix( 0.86, 0.6, max( centre, edge ) );');
  };
  m.customProgramCacheKey = () => 'road-v1';
  return m;
}

/**
 * Vertex transform for packed instances: `aInst` (x, y, z relative to the floating origin, yaw) and `aInstB`
 * (scale x, y, z, tint). Houses (INST_ROOF) add `aInstC.x` = roof height: model vertices above y = 1 are the roof
 * and stretch by it instead of the wall height. Normals follow the inverse scale.
 */
export const INSTANCE_PARS = /* glsl */ `
attribute vec4 aInst;
attribute vec4 aInstB;
#ifdef INST_ROOF
attribute vec4 aInstC;
#endif
uniform float uTime;
uniform float uSway;
varying float vTint;`;

const INSTANCE_SCALE = /* glsl */ `
vec3 instScale = aInstB.xyz;
#ifdef INST_ROOF
  if ( position.y > 1.0001 ) instScale.y = aInstC.x;
#endif`;

export const INSTANCE_NORMAL = /* glsl */ `
${INSTANCE_SCALE}
vec3 objectNormal = normalize( vec3( normal ) / instScale );
{
  float c = cos( aInst.w );
  float s = sin( aInst.w );
  objectNormal = vec3( c * objectNormal.x + s * objectNormal.z, objectNormal.y, -s * objectNormal.x + c * objectNormal.z );
}
#ifdef USE_TANGENT
  vec3 objectTangent = vec3( tangent.xyz );
#endif`;

export const INSTANCE_BEGIN = /* glsl */ `
vec3 transformed = vec3( position ) * aInstB.xyz;
#ifdef INST_ROOF
  if ( position.y > 1.0001 ) transformed.y = aInstB.y + ( position.y - 1.0 ) * aInstC.x;
#endif
// crowns sway with height (uSway = 0 for rigid objects)
transformed.xz += uSway * transformed.y * transformed.y * 0.0006 * vec2( sin( uTime * 1.3 + aInst.x * 0.21 + aInst.z * 0.17 ), cos( uTime * 1.1 + aInst.z * 0.19 ) );
{
  float c = cos( aInst.w );
  float s = sin( aInst.w );
  transformed = vec3( c * transformed.x + s * transformed.z, transformed.y, -s * transformed.x + c * transformed.z );
}
transformed += aInst.xyz;
vTint = aInstB.w;`;

export interface InstancedMaterialOptions {
  roughness?: number;
  /** share of the captured environment (diffuse IBL / reflections); default 0.4 */
  envMapIntensity?: number;
  /** model has a roof part stretched by aInstC.x (houses) */
  roof?: boolean;
  sway?: number;
  /** extra fragment code after color_fragment (vTint, diffuseColor available) */
  fragment?: string;
  /** extra fragment uniforms / functions */
  fragmentPars?: string;
  /** fragment code after roughnessmap_fragment / metalnessmap_fragment (set roughnessFactor / metalnessFactor) */
  afterRoughness?: string;
  afterMetalness?: string;
  /** fragment code after lights_fragment_maps (e.g. scale `radiance`, the environment reflection) */
  afterLightMaps?: string;
  defines?: Record<string, string>;
  /** extra vertex varyings assigned after INSTANCE_BEGIN */
  vertex?: string;
  vertexPars?: string;
  uniforms?: Record<string, THREE.IUniform>;
  key: string;
}

/** Shared uniforms of every instanced material (time drives the crown sway). */
export interface InstanceUniforms {
  uTime: THREE.IUniform<number>;
}

function patchInstanced(s: THREE.WebGLProgramParametersWithUniforms, o: InstancedMaterialOptions, shared: InstanceUniforms, depth: boolean): void {
  s.uniforms.uTime = shared.uTime;
  s.uniforms.uSway = { value: o.sway ?? 0 };
  if (o.uniforms) Object.assign(s.uniforms, o.uniforms);
  s.vertexShader = s.vertexShader
    .replace('#include <common>', `#include <common>\n${INSTANCE_PARS}\n${o.vertexPars ?? ''}`)
    .replace('#include <beginnormal_vertex>', INSTANCE_NORMAL)
    .replace('#include <begin_vertex>', `${INSTANCE_BEGIN}\n${o.vertex ?? ''}`);
  if (depth) return;
  s.vertexShader = s.vertexShader.replace('#include <color_vertex>', COLOR_VERTEX_SRGB);
  s.fragmentShader = s.fragmentShader
    .replace('#include <common>', `#include <common>\nvarying float vTint;\n${o.fragmentPars ?? ''}`)
    .replace('#include <color_fragment>', `#include <color_fragment>\n${o.fragment ?? ''}`)
    .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${o.afterRoughness ?? ''}`)
    .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n${o.afterMetalness ?? ''}`)
    .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>\n${o.afterLightMaps ?? ''}`);
}

/** MeshStandardMaterial (vertex colours) with the packed instance transform, plus the matching shadow depth material. */
export function instancedMaterials(o: InstancedMaterialOptions, shared: InstanceUniforms): { material: THREE.MeshStandardMaterial; depth: THREE.MeshDepthMaterial } {
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: o.roughness ?? 0.9, metalness: 0, envMapIntensity: o.envMapIntensity ?? 0.4 });
  material.name = o.key;
  material.defines = { ...(o.roof ? { INST_ROOF: '' } : {}), ...o.defines };
  material.onBeforeCompile = (s) => patchInstanced(s, o, shared, false);
  material.customProgramCacheKey = () => `inst-${o.key}`;
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  if (o.roof) depth.defines = { INST_ROOF: '' };
  depth.onBeforeCompile = (s) => patchInstanced(s, o, shared, true);
  depth.customProgramCacheKey = () => `inst-depth-${o.key}`;
  return { material, depth };
}
